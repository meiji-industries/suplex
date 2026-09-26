//! Streams one Herdr pane to a browser terminal. Control mode owns a
//! `herdr terminal session control` child that accepts input. Observe mode is
//! read only: it paints a viewport snapshot, then follows a
//! `herdr terminal session observe` child, and replaces the child when the
//! pane grows or the child stops.

use std::{process::Stdio, time::Duration};

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use super::{
    herdr::{Herdr, Viewport},
    provider_http::{lenient, optional_metadata},
};

#[derive(Debug, Clone, PartialEq)]
pub enum BridgeEvent {
    Frame {
        seq: u64,
        full: bool,
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    },
    Closed(String),
    Error(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Observe,
    Control,
}

#[derive(Debug)]
enum Request {
    Input(Vec<u8>),
    Resize(f64, f64),
    Scroll(&'static str, f64),
}

/// Handle to an open bridge. Dropping it releases the Herdr child.
pub struct Bridge {
    requests: UnboundedSender<Request>,
    release: CancellationToken,
}

impl Bridge {
    pub fn input(&self, bytes: Vec<u8>) {
        let _ = self.requests.send(Request::Input(bytes));
    }

    pub fn resize(&self, cols: f64, rows: f64) {
        let _ = self.requests.send(Request::Resize(cols, rows));
    }

    pub fn scroll(&self, direction: &'static str, lines: f64) {
        let _ = self.requests.send(Request::Scroll(direction, lines));
    }

    pub fn release(&self) {
        self.release.cancel();
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.release.cancel();
    }
}

fn clamp(value: f64, minimum: i64, maximum: i64) -> i64 {
    (value.round() as i64).clamp(minimum, maximum)
}

/// One `herdr pane bridge` JSON line.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum BridgeRecord {
    #[serde(rename = "terminal.frame")]
    Frame {
        bytes: String,
        #[serde(default, deserialize_with = "lenient")]
        seq: u64,
        #[serde(default, deserialize_with = "lenient")]
        full: bool,
        #[serde(default, deserialize_with = "lenient")]
        width: u64,
        #[serde(default, deserialize_with = "lenient")]
        height: u64,
    },
    #[serde(rename = "terminal.closed")]
    Closed {
        #[serde(default, deserialize_with = "optional_metadata")]
        reason: Option<String>,
    },
}

pub fn parse_bridge_record(line: &str) -> Option<BridgeEvent> {
    match serde_json::from_str(line).ok()? {
        BridgeRecord::Frame {
            bytes,
            seq,
            full,
            width,
            height,
        } => Some(BridgeEvent::Frame {
            seq,
            full,
            width: width as u32,
            height: height as u32,
            bytes: base64::engine::general_purpose::STANDARD
                .decode(bytes)
                .ok()?,
        }),
        BridgeRecord::Closed { reason } => Some(BridgeEvent::Closed(
            reason.unwrap_or_else(|| "closed".to_owned()),
        )),
    }
}

fn exit_reason(status: std::io::Result<std::process::ExitStatus>) -> String {
    use std::os::unix::process::ExitStatusExt;
    let reason = status.ok().and_then(|status| {
        status
            .signal()
            .and_then(|signal| nix::sys::signal::Signal::try_from(signal).ok())
            .map(|signal| signal.as_str().to_owned())
            .or_else(|| status.code().map(|code| code.to_string()))
    });
    format!("exited:{}", reason.unwrap_or_else(|| "unknown".into()))
}

/// SIGTERM, then SIGKILL after half a second.
async fn stop(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
    if tokio::time::timeout(Duration::from_millis(500), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}

pub fn open(
    herdr: Herdr,
    pane_id: String,
    cols: Option<f64>,
    rows: Option<f64>,
    mode: Mode,
) -> (Bridge, UnboundedReceiver<BridgeEvent>) {
    let (requests, requested) = unbounded_channel();
    let (events, received) = unbounded_channel();
    let release = CancellationToken::new();
    match mode {
        Mode::Control => {
            tokio::spawn(control(
                herdr,
                pane_id,
                clamp(cols.unwrap_or(80.0), 20, 500),
                clamp(rows.unwrap_or(24.0), 5, 200),
                requested,
                events,
                release.clone(),
            ));
        }
        Mode::Observe => {
            tokio::spawn(observe(herdr, pane_id, 1_000, events, release.clone()));
        }
    }
    (Bridge { requests, release }, received)
}

async fn write(stdin: &mut Option<ChildStdin>, record: Value) {
    if let Some(input) = stdin.as_mut()
        && input
            .write_all(format!("{record}\n").as_bytes())
            .await
            .is_err()
    {
        *stdin = None;
    }
}

async fn control(
    herdr: Herdr,
    pane_id: String,
    cols: i64,
    rows: i64,
    mut requests: UnboundedReceiver<Request>,
    events: UnboundedSender<BridgeEvent>,
    release: CancellationToken,
) {
    let spawned = Command::new(&herdr.binary)
        .args(["terminal", "session", "control", &pane_id, "--takeover"])
        .args(["--cols", &cols.to_string(), "--rows", &rows.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let _ = events.send(BridgeEvent::Error(format!(
                "Herdr terminal controller could not start: {error}"
            )));
            let _ = events.send(BridgeEvent::Closed("spawn error".into()));
            return;
        }
    };
    let mut stdin = child.stdin.take();
    let mut output = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut errors = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
    let error_line = regex::Regex::new(r"(?i)input ignored|error").expect("error pattern");
    let mut settled = false;
    let mut requests_open = true;
    let mut output_open = true;
    let mut errors_open = true;
    loop {
        tokio::select! {
            // Requests sent before a release still reach the controller in order.
            biased;
            request = requests.recv(), if !settled && requests_open => {
                let record = match request {
                    Some(Request::Input(bytes)) => json!({"type":"terminal.input","bytes":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                    Some(Request::Resize(cols, rows)) => json!({"type":"terminal.resize","cols":clamp(cols, 20, 500),"rows":clamp(rows, 5, 200)}),
                    Some(Request::Scroll(direction, lines)) => json!({"type":"terminal.scroll","direction":direction,"lines":clamp(lines, 1, 65_535)}),
                    None => {
                        requests_open = false;
                        continue;
                    }
                };
                write(&mut stdin, record).await;
            }
            // A settled controller already closed; dropping the child stops it.
            _ = release.cancelled() => {
                if !settled {
                    write(&mut stdin, json!({"type":"terminal.release"})).await;
                    drop(stdin.take());
                    if tokio::time::timeout(Duration::from_millis(500), child.wait()).await.is_err() {
                        stop(&mut child).await;
                    }
                }
                return;
            }
            line = output.next_line(), if output_open => match line {
                Ok(Some(line)) => if let Some(event) = parse_bridge_record(&line) {
                    settled = matches!(event, BridgeEvent::Closed(_));
                    let _ = events.send(event);
                },
                _ => output_open = false,
            },
            line = errors.next_line(), if errors_open => match line {
                Ok(Some(message)) if !settled && !message.trim().is_empty() && error_line.is_match(&message) => {
                    let _ = events.send(BridgeEvent::Error(message));
                }
                Ok(Some(_)) => {}
                _ => errors_open = false,
            },
            status = child.wait() => {
                if !settled {
                    let _ = events.send(BridgeEvent::Closed(exit_reason(status)));
                }
                return;
            }
        }
    }
}

fn snapshot_bytes(ansi: &str) -> Vec<u8> {
    let trimmed = ansi
        .strip_suffix("\r\n")
        .or_else(|| ansi.strip_suffix('\n'))
        .unwrap_or(ansi);
    let normalized = trimmed.replace("\r\n", "\n").replace('\n', "\r\n");
    format!("\u{1b}[?2026h\u{1b}[0m\u{1b}[2J\u{1b}[H{normalized}\u{1b}[0m\u{1b}[?2026l")
        .into_bytes()
}

enum Observed {
    Line(u64, String),
    Error(u64, String),
    Exit(u64),
}

struct Observer {
    generation: u64,
    cols: u32,
    rows: u32,
    stop: CancellationToken,
}

fn start_observer(
    herdr: &Herdr,
    pane_id: &str,
    generation: u64,
    cols: u32,
    rows: u32,
    observed: &UnboundedSender<Observed>,
) -> std::io::Result<Observer> {
    let mut child = Command::new(&herdr.binary)
        .args(["terminal", "session", "observe", pane_id])
        .args(["--cols", &cols.to_string(), "--rows", &rows.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stop_token = CancellationToken::new();
    let token = stop_token.clone();
    let observed = observed.clone();
    tokio::spawn(async move {
        let mut output = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        let mut errors = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
        let (mut output_open, mut errors_open) = (true, true);
        loop {
            tokio::select! {
                _ = token.cancelled() => {
                    stop(&mut child).await;
                    return;
                }
                line = output.next_line(), if output_open => match line {
                    Ok(Some(line)) => { let _ = observed.send(Observed::Line(generation, line)); }
                    _ => output_open = false,
                },
                line = errors.next_line(), if errors_open => match line {
                    Ok(Some(line)) => { let _ = observed.send(Observed::Error(generation, line)); }
                    _ => errors_open = false,
                },
                _ = child.wait() => {
                    let _ = observed.send(Observed::Exit(generation));
                    return;
                }
            }
        }
    });
    Ok(Observer {
        generation,
        cols,
        rows,
        stop: stop_token,
    })
}

async fn observe(
    herdr: Herdr,
    pane_id: String,
    refresh_ms: u64,
    events: UnboundedSender<BridgeEvent>,
    release: CancellationToken,
) {
    let (observed, mut observations) = unbounded_channel();
    let mut current: Option<Observer> = None;
    let mut retry: Option<Instant> = None;
    let mut generation = 0;
    let mut maximum_cols = 1;
    let mut sequence = 0;
    let mut has_snapshot = false;
    let mut interval = tokio::time::interval(Duration::from_millis(refresh_ms.max(100)));
    let schedule = |retry: &mut Option<Instant>, delay: u64| {
        if retry.is_none() {
            *retry = Some(Instant::now() + Duration::from_millis(delay));
        }
    };
    loop {
        let refresh = tokio::select! {
            _ = release.cancelled() => break,
            _ = interval.tick() => true,
            _ = tokio::time::sleep_until(retry.unwrap_or_else(Instant::now)), if retry.is_some() => {
                retry = None;
                true
            }
            observation = observations.recv() => {
                let Some(observation) = observation else { continue };
                let active = |id: u64| current.as_ref().is_some_and(|observer| observer.generation == id);
                match observation {
                    Observed::Line(id, line) if active(id) => match parse_bridge_record(&line) {
                        Some(BridgeEvent::Frame { full, width, height, bytes, .. }) => {
                            let _ = events.send(BridgeEvent::Frame { seq: sequence, full, width, height, bytes });
                            sequence += 1;
                        }
                        Some(BridgeEvent::Closed(_)) => {
                            if let Some(observer) = current.take() {
                                observer.stop.cancel();
                            }
                            schedule(&mut retry, 0);
                        }
                        _ => {}
                    },
                    Observed::Error(id, message) if active(id) && !message.trim().is_empty() => {
                        let _ = events.send(BridgeEvent::Error(message));
                    }
                    Observed::Exit(id) if active(id) => {
                        current = None;
                        schedule(&mut retry, 250);
                    }
                    _ => {}
                }
                false
            }
        };
        if !refresh {
            continue;
        }
        let reader = herdr.clone();
        let pane = pane_id.clone();
        let snapshot: Result<Viewport, String> = tokio::select! {
            _ = release.cancelled() => break,
            snapshot = tokio::task::spawn_blocking(move || reader.read_pane_viewport(&pane)) => {
                snapshot.map_err(|error| error.to_string()).and_then(|result| result.map_err(|failure| failure.message))
            }
        };
        let snapshot = match snapshot {
            Ok(snapshot) => snapshot,
            Err(message) => {
                if !has_snapshot {
                    let _ = events.send(BridgeEvent::Error(format!(
                        "Herdr could not read this pane: {message}"
                    )));
                }
                continue;
            }
        };
        maximum_cols = maximum_cols.max(snapshot.cols);
        if current
            .as_ref()
            .is_some_and(|observer| observer.cols == maximum_cols && observer.rows == snapshot.rows)
        {
            continue;
        }
        if let Some(observer) = current.take() {
            observer.stop.cancel();
        }
        let _ = events.send(BridgeEvent::Frame {
            seq: sequence,
            full: true,
            width: maximum_cols,
            height: snapshot.rows,
            bytes: snapshot_bytes(&snapshot.ansi),
        });
        sequence += 1;
        has_snapshot = true;
        generation += 1;
        match start_observer(
            &herdr,
            &pane_id,
            generation,
            maximum_cols,
            snapshot.rows,
            &observed,
        ) {
            Ok(observer) => current = Some(observer),
            Err(error) => {
                let _ = events.send(BridgeEvent::Error(format!(
                    "Herdr observer could not start: {error}"
                )));
                schedule(&mut retry, 250);
            }
        }
    }
    if let Some(observer) = current.take() {
        observer.stop.cancel();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
    };

    use super::*;
    use crate::integrations::herdr::{RunOutput, fake};

    /// A fake Herdr CLI for terminal sessions. It records argv and stdin under
    /// `directory` and prints `frames` before it waits on stdin.
    pub(crate) fn fake_terminal(directory: &Path, frames: &[&str]) -> PathBuf {
        std::fs::create_dir_all(directory).unwrap();
        let script = directory.join("herdr");
        let printed = frames
            .iter()
            .map(|frame| format!("printf '%s\\n' '{frame}'\n"))
            .collect::<String>();
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"$@\" >> '{dir}/argv'\n{printed}while IFS= read -r line; do printf '%s\\n' \"$line\" >> '{dir}/stdin'; done\nsleep 30\n",
                dir = directory.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        script
    }

    fn frame(text: &str) -> String {
        json!({"type":"terminal.frame","seq":9,"encoding":"ansi","full":false,"width":80,"height":24,
            "bytes":base64::engine::general_purpose::STANDARD.encode(text)})
        .to_string()
    }

    async fn next(events: &mut UnboundedReceiver<BridgeEvent>) -> BridgeEvent {
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("bridge event")
            .expect("open bridge")
    }

    async fn file_lines(path: &Path, count: usize) -> Vec<String> {
        for _ in 0..100 {
            let lines = std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if lines.len() >= count {
                return lines;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("{} did not receive {count} lines", path.display());
    }

    #[test]
    fn parses_herdr_terminal_bridge_records() {
        let frame = parse_bridge_record(
            r#"{"type":"terminal.frame","seq":1,"encoding":"ansi","full":true,"width":80,"height":24,"bytes":"G1s/MjAyNmgbWzJKG1sxOzFI"}"#,
        );
        let Some(BridgeEvent::Frame {
            seq,
            full,
            width,
            height,
            bytes,
        }) = frame
        else {
            panic!("frame record was not parsed");
        };
        assert_eq!((seq, full, width, height), (1, true, 80, 24));
        assert!(bytes.starts_with(b"\x1b[?2026h"));
        assert_eq!(
            parse_bridge_record(r#"{"type":"terminal.closed","reason":"detached"}"#),
            Some(BridgeEvent::Closed("detached".into()))
        );
        assert_eq!(parse_bridge_record(r#"{"type":"x"}"#), None);
        assert_eq!(parse_bridge_record("not json"), None);
    }

    #[tokio::test]
    async fn control_mode_writes_ndjson_commands_and_releases_the_controller() {
        let directory =
            std::env::temp_dir().join(format!("suplex-bridge-{}", uuid::Uuid::new_v4()));
        let script = fake_terminal(&directory, &[&frame("ready")]);
        let (bridge, mut events) = open(
            Herdr::new(script.to_string_lossy()),
            "pane".into(),
            Some(80.0),
            Some(24.0),
            Mode::Control,
        );
        assert!(
            matches!(next(&mut events).await, BridgeEvent::Frame { ref bytes, .. } if bytes == b"ready")
        );
        assert_eq!(
            file_lines(&directory.join("argv"), 1).await,
            ["terminal session control pane --takeover --cols 80 --rows 24"]
        );
        bridge.input(b"ls -la\n".to_vec());
        bridge.resize(120.0, 40.0);
        bridge.scroll("up", 12.0);
        bridge.release();
        assert_eq!(
            file_lines(&directory.join("stdin"), 4).await,
            [
                json!({"type":"terminal.input","bytes":base64::engine::general_purpose::STANDARD.encode("ls -la\n")}).to_string(),
                r#"{"type":"terminal.resize","cols":120,"rows":40}"#.to_owned(),
                r#"{"type":"terminal.scroll","direction":"up","lines":12}"#.to_owned(),
                r#"{"type":"terminal.release"}"#.to_owned(),
            ]
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn control_mode_reports_takeover_and_spawn_failures() {
        let directory =
            std::env::temp_dir().join(format!("suplex-bridge-{}", uuid::Uuid::new_v4()));
        let script = fake_terminal(
            &directory,
            &[r#"{"type":"terminal.closed","reason":"terminal attach taken over"}"#],
        );
        let (_bridge, mut events) = open(
            Herdr::new(script.to_string_lossy()),
            "pane".into(),
            None,
            None,
            Mode::Control,
        );
        assert_eq!(
            next(&mut events).await,
            BridgeEvent::Closed("terminal attach taken over".into())
        );
        let (_bridge, mut events) = open(
            Herdr::new(directory.join("missing").to_string_lossy()),
            "pane".into(),
            None,
            None,
            Mode::Control,
        );
        assert!(
            matches!(next(&mut events).await, BridgeEvent::Error(message) if message.starts_with("Herdr terminal controller could not start"))
        );
        assert_eq!(
            next(&mut events).await,
            BridgeEvent::Closed("spawn error".into())
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn observation_paints_a_snapshot_then_renumbers_live_frames() {
        let directory =
            std::env::temp_dir().join(format!("suplex-bridge-{}", uuid::Uuid::new_v4()));
        let script = fake_terminal(&directory, &[&frame("live")]);
        let herdr = Herdr::with_runner(
            script.to_string_lossy(),
            std::sync::Arc::new(|args: &[String]| match args[1].as_str() {
                "get" => {
                    fake::envelope(json!({"pane":{"pane_id":"pane","scroll":{"viewport_rows":24}}}))
                }
                "layout" => fake::failed(json!({"error":{"code":"unavailable"}})),
                _ => Ok(RunOutput {
                    status: Some(0),
                    stdout: "screen\nbottom reply\n".into(),
                    stderr: String::new(),
                }),
            }),
        );
        let (bridge, mut events) = open(herdr, "pane".into(), None, None, Mode::Observe);
        let BridgeEvent::Frame {
            seq,
            full,
            width,
            height,
            bytes,
        } = next(&mut events).await
        else {
            panic!("snapshot frame expected");
        };
        assert_eq!((seq, full, width, height), (0, true, 12, 24));
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "\u{1b}[?2026h\u{1b}[0m\u{1b}[2J\u{1b}[Hscreen\r\nbottom reply\u{1b}[0m\u{1b}[?2026l"
        );
        assert!(
            matches!(next(&mut events).await, BridgeEvent::Frame { seq: 1, ref bytes, .. } if bytes == b"live")
        );
        assert_eq!(
            file_lines(&directory.join("argv"), 1).await,
            ["terminal session observe pane --cols 12 --rows 24"]
        );
        bridge.release();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(std::fs::read_to_string(directory.join("stdin")).is_err());
        let _ = std::fs::remove_dir_all(directory);
    }
}
