//! Passive Codex display. The Herdr pane runs `suplex codex-display <dir>`,
//! which follows the turn output files in the private runtime directory. It
//! never owns or replays the native turn.

use std::{
    collections::HashMap,
    error::Error,
    fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};

use serde_json::Value;

use super::{session_reader, transcript};
use crate::{
    coordination::bridge_auth::{
        ADVISOR_BINDING_ENV, ADVISOR_RESULT_ENV, ADVISOR_TOKEN_ENV, ROOT_BINDING_ENV,
        ROOT_TOKEN_ENV,
    },
    integrations::herdr::Herdr,
    runtimes::task_display::{self, SessionDisplay},
};

const WAITING_LABEL: &str = "Waiting for Codex output...\n";
pub const SUBCOMMAND: &str = "codex-display";

pub struct DisplayCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub command: String,
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn display_command(runtime_directory: &Path) -> io::Result<DisplayCommand> {
    let executable = std::env::current_exe()?.to_string_lossy().into_owned();
    let args = vec![
        SUBCOMMAND.to_owned(),
        runtime_directory.to_string_lossy().into_owned(),
    ];
    let mut command = vec!["/usr/bin/env".to_owned()];
    for key in [
        ROOT_BINDING_ENV,
        ROOT_TOKEN_ENV,
        ADVISOR_BINDING_ENV,
        ADVISOR_TOKEN_ENV,
        ADVISOR_RESULT_ENV,
    ] {
        command.extend(["-u".to_owned(), key.to_owned()]);
    }
    command.push(executable.clone());
    command.extend(args.iter().cloned());
    Ok(DisplayCommand {
        command: command
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" "),
        executable,
        args,
    })
}

pub fn display_attached(runtime_directory: &Path, argv: &[String]) -> bool {
    display_command(runtime_directory).is_ok_and(|expected| {
        argv.len() == expected.args.len() + 1
            && argv[0] == expected.executable
            && argv[1..] == expected.args[..]
    })
}

fn safe_terminal_text(text: &str) -> String {
    text.replace('\r', "\n")
        .chars()
        .filter(|character| {
            !matches!(*character as u32, 0..=8 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f..=0x9f)
        })
        .collect()
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub fn render_event(event: &Value) -> String {
    match text(event, "type").unwrap_or_default() {
        "turn.completed" => return "\n".into(),
        "turn.failed" => {
            return format!(
                "error: {}\n",
                event["error"]["message"].as_str().unwrap_or_default()
            );
        }
        "error" => return format!("error: {}\n", text(event, "message").unwrap_or_default()),
        "item.started" | "item.completed" => {}
        _ => return String::new(),
    }
    let item = &event["item"];
    let started = event["type"] == "item.started";
    match (text(item, "type").unwrap_or_default(), started) {
        ("agent_message", false) => {
            text(item, "text").map_or_else(String::new, |text| format!("{text}\n"))
        }
        ("reasoning", false) => text(item, "text").map_or_else(String::new, |text| {
            format!(
                "{}\n",
                text.split('\n')
                    .map(|line| format!("  · {line}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        }),
        ("command_execution", true) => {
            text(item, "command").map_or_else(String::new, |command| format!("$ {command}\n"))
        }
        ("command_execution", false) => match item["exit_code"].as_number() {
            Some(code) if code.as_f64() != Some(0.0) => format!("exit {code}\n"),
            _ => String::new(),
        },
        ("file_change", false) => item["changes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|change| change["path"].as_str())
            .map(|path| format!("edit {path}\n"))
            .collect(),
        ("mcp_tool_call", true) => match (text(item, "server"), text(item, "tool")) {
            (Some(server), Some(tool)) => format!("tool {server}.{tool}\n"),
            _ => String::new(),
        },
        ("error", false) => {
            text(item, "message").map_or_else(String::new, |message| format!("error: {message}\n"))
        }
        _ => String::new(),
    }
}

#[derive(Default)]
struct Cursor {
    offset: u64,
    pending_bytes: Vec<u8>,
    pending_line: String,
}

/// Decodes complete UTF-8 sequences; a split character waits for the next read.
fn decode(cursor: &mut Cursor, bytes: &[u8]) -> String {
    cursor.pending_bytes.extend_from_slice(bytes);
    let mut decoded = String::new();
    loop {
        match std::str::from_utf8(&cursor.pending_bytes) {
            Ok(text) => {
                decoded.push_str(text);
                cursor.pending_bytes.clear();
                return decoded;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                decoded.push_str(
                    std::str::from_utf8(&cursor.pending_bytes[..valid]).expect("valid prefix"),
                );
                match error.error_len() {
                    None => {
                        cursor.pending_bytes.drain(..valid);
                        return decoded;
                    }
                    Some(length) => {
                        decoded.push('\u{fffd}');
                        cursor.pending_bytes.drain(..valid + length);
                    }
                }
            }
        }
    }
}

/// Renders the complete lines in `text`; a partial trailing line waits for the next append.
fn render_appended(cursor: &mut Cursor, text: &str) -> String {
    let remaining = std::mem::take(&mut cursor.pending_line) + text;
    let mut rendered = String::new();
    let mut lines = remaining.split('\n').collect::<Vec<_>>();
    cursor.pending_line = lines.pop().unwrap_or_default().to_owned();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        match transcript::parse_events(line).first() {
            Some(event) => rendered.push_str(&render_event(event.value())),
            None => {
                rendered.push_str(line);
                rendered.push('\n');
            }
        }
    }
    rendered
}

fn output_files(runtime_directory: &Path) -> io::Result<Vec<(PathBuf, bool)>> {
    let entries = match fs::read_dir(runtime_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let turn_output = name.starts_with("turn-")
            && name.len() > "turn-".len()
            && (name.ends_with(".jsonl") || name.ends_with(".stderr.log"));
        if !turn_output || !entry.file_type()?.is_file() {
            continue;
        }
        let details = match entry.metadata() {
            Ok(details) => details,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let created = details
            .created()
            .or_else(|_| details.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        files.push((
            created,
            name.clone(),
            entry.path(),
            name.ends_with(".jsonl"),
        ));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(files
        .into_iter()
        .map(|(_, _, path, events)| (path, events))
        .collect())
}

fn read_appended(path: &Path, cursor: &mut Cursor) -> io::Result<String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error),
    };
    let size = file.metadata()?.len();
    if size < cursor.offset {
        *cursor = Cursor::default();
    }
    if size == cursor.offset {
        return Ok(String::new());
    }
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut bytes = Vec::new();
    file.take(size - cursor.offset).read_to_end(&mut bytes)?;
    cursor.offset += bytes.len() as u64;
    Ok(decode(cursor, &bytes))
}

fn scan(
    runtime_directory: &Path,
    cursors: &mut HashMap<PathBuf, Cursor>,
    output: &mut impl Write,
) -> io::Result<bool> {
    let mut wrote = false;
    for (path, events) in output_files(runtime_directory)? {
        let cursor = cursors.entry(path.clone()).or_default();
        let appended = read_appended(&path, cursor)?;
        if appended.is_empty() {
            continue;
        }
        let text = safe_terminal_text(&if events {
            render_appended(cursor, &appended)
        } else {
            appended
        });
        if text.is_empty() {
            continue;
        }
        output.write_all(text.as_bytes())?;
        output.flush()?;
        wrote = true;
    }
    Ok(wrote)
}

/// Follows the runtime directory until `stopped` returns true.
pub fn run_display(
    runtime_directory: &Path,
    output: &mut impl Write,
    poll_interval: Duration,
    stopped: impl Fn() -> bool,
) -> io::Result<()> {
    let mut cursors = HashMap::new();
    if !scan(runtime_directory, &mut cursors, output)? {
        output.write_all(WAITING_LABEL.as_bytes())?;
        output.flush()?;
    }
    while !stopped() {
        std::thread::sleep(poll_interval);
        if stopped() {
            break;
        }
        scan(runtime_directory, &mut cursors, output)?;
    }
    Ok(())
}

/// Entry point for `suplex codex-display <runtime directory>`.
pub async fn serve(runtime_directory: &str) -> Result<(), Box<dyn Error>> {
    let directory = PathBuf::from(runtime_directory);
    if !directory.is_absolute() {
        return Err("A private runtime directory is required".into());
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
        flag.store(true, Ordering::Relaxed);
    });
    tokio::task::spawn_blocking(move || {
        run_display(
            &directory,
            &mut io::stdout(),
            Duration::from_millis(250),
            || stopped.load(Ordering::Relaxed),
        )
    })
    .await??;
    Ok(())
}

/// Dispatch shows the session in Herdr first. The display is an observation;
/// its failure never blocks native work.
pub fn show(database_path: &Path, session: &str, native: &str, worktree: &Path, model: &str) {
    let Ok(runtime_directory) = session_reader::session_directory(database_path, session) else {
        return;
    };
    let Ok(display) = display_command(&runtime_directory) else {
        return;
    };
    let _ = task_display::attach_session(
        &Herdr::default(),
        &SessionDisplay {
            database_path,
            session_id: session,
            native_session_id: native,
            worktree,
            model,
            provider: "codex",
            command: &display.command,
            is_attached: &|argv| display_attached(&runtime_directory, argv),
        },
    );
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn renders_codex_events_for_the_passive_display() {
        let cases = [
            (
                json!({"type":"item.started","item":{"id":"i","type":"command_execution","command":"make test-local","exit_code":null}}),
                "$ make test-local\n",
            ),
            (
                json!({"type":"item.completed","item":{"id":"i","type":"command_execution","command":"x","exit_code":2}}),
                "exit 2\n",
            ),
            (
                json!({"type":"item.completed","item":{"id":"i","type":"command_execution","command":"x","exit_code":0}}),
                "",
            ),
            (
                json!({"type":"item.completed","item":{"id":"i","type":"error","message":"context window exceeded"}}),
                "error: context window exceeded\n",
            ),
            (
                json!({"type":"item.completed","item":{"id":"i","type":"reasoning","text":"a\nb"}}),
                "  · a\n  · b\n",
            ),
            (
                json!({"type":"item.completed","item":{"id":"i","type":"file_change","changes":[{"path":"a.rs","kind":"update"}]}}),
                "edit a.rs\n",
            ),
            (
                json!({"type":"item.started","item":{"id":"i","type":"mcp_tool_call","server":"suplex","tool":"report"}}),
                "tool suplex.report\n",
            ),
            (
                json!({"type":"turn.failed","error":{"message":"stream disconnected"}}),
                "error: stream disconnected\n",
            ),
            (json!({"type":"turn.completed"}), "\n"),
            (json!({"type":"thread.started","thread_id":"t"}), ""),
        ];
        for (event, expected) in cases {
            assert_eq!(render_event(&event), expected, "{event}");
        }
    }

    #[test]
    fn the_display_follows_turn_output_without_owning_the_turn() {
        let directory =
            std::env::temp_dir().join(format!("suplex-codex-display-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let mut output = Vec::new();
        let mut cursors = HashMap::new();
        assert!(!scan(&directory, &mut cursors, &mut output).unwrap());
        let events = directory.join("turn-1.jsonl");
        fs::write(&events, "{\"type\":\"item.started\",\"item\":{\"id\":\"item_0\",\"type\":\"command_execution\",\"command\":\"pnpm test\",\"status\":\"in_progress\"}}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_2\",\"type\":\"agent_").unwrap();
        fs::write(directory.join("turn-1.stderr.log"), "plain stderr line\n").unwrap();
        fs::write(directory.join("other.txt"), "ignored\n").unwrap();
        assert!(scan(&directory, &mut cursors, &mut output).unwrap());
        let mut file = fs::OpenOptions::new().append(true).open(&events).unwrap();
        file.write_all(
            "message\",\"text\":\"Reviewed the change. 界\"}}\n{\"type\":\"turn.completed\"}\n"
                .as_bytes(),
        )
        .unwrap();
        scan(&directory, &mut cursors, &mut output).unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains("$ pnpm test\n"));
        assert!(output.contains("plain stderr line\n"));
        assert!(output.contains("Reviewed the change. 界\n"));
        assert!(!output.contains("item.completed"));
        assert!(!output.contains("ignored"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn the_display_command_clears_bridge_capabilities_and_matches_only_its_directory() {
        let directory = Path::new("/private/runtime/session");
        let display = display_command(directory).unwrap();
        assert!(
            display
                .command
                .starts_with("'/usr/bin/env' '-u' 'SUPLEX_ROOT_BINDING'")
        );
        assert!(display.command.contains("'-u' 'SUPLEX_ADVISOR_RESULT'"));
        let argv = std::iter::once(display.executable.clone())
            .chain(display.args.iter().cloned())
            .collect::<Vec<_>>();
        assert!(display_attached(directory, &argv));
        assert!(!display_attached(
            Path::new("/private/runtime/other"),
            &argv
        ));
        assert!(!display_attached(
            directory,
            &["codex".into(), "exec".into(), "--json".into()]
        ));
        assert_eq!(decode(&mut Cursor::default(), &[0xe7, 0x95]), "");
    }
}
