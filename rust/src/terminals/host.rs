//! Terminals this process owns: one PTY for each task Shell, session Mirror,
//! or provider sign-in while the host terminal experiment is on. A `vt100`
//! emulator keeps each screen, so a viewer that connects late or falls behind
//! starts from a replay of the screen and scrollback. The replay comes from
//! emulator state only, so it never repeats the child's terminal queries.
//!
//! The registry is the only authority for these terminals. An empty registry
//! after a restart means the next open starts a new terminal.

use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Child,
    sync::{
        broadcast::{self, error::RecvError},
        mpsc,
    },
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use super::{BridgeEvent, clamp, exit_reason};

// ponytail: fixed scrollback (about 5 MiB at 80 columns, 32 MiB at 500);
// size it by width if wide terminals use too much memory.
const SCROLLBACK_LINES: usize = 2_000;
/// Bounds the output a slow viewer can queue: 256 reads of up to 16 KiB.
const BACKLOG: usize = 256;
const READ_BYTES: usize = 16 * 1024;
/// A Mirror stays open this long after its last viewer leaves.
const LINGER: Duration = Duration::from_secs(5);
/// Time between SIGHUP and SIGKILL when a terminal closes.
const HANGUP_GRACE: Duration = Duration::from_secs(1);
const KEPT_ENVIRONMENT: [&str; 7] = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "LANG",
    "SSH_AUTH_SOCK",
];

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How to start a terminal.
pub struct Spec {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    task_id: Option<String>,
    linger: bool,
}

/// `$SHELL`, else `/bin/zsh`, else `/bin/sh`.
fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| Path::new(shell).is_absolute() && Path::new(shell).is_file())
        .or_else(|| {
            Path::new("/bin/zsh")
                .is_file()
                .then(|| "/bin/zsh".to_owned())
        })
        .unwrap_or_else(|| "/bin/sh".to_owned())
}

impl Spec {
    /// The task Shell: an interactive login shell, as Terminal.app opens.
    pub fn shell(task_id: &str, cwd: PathBuf) -> Self {
        Self {
            program: login_shell(),
            args: vec!["-l".into()],
            cwd,
            task_id: Some(task_id.to_owned()),
            linger: false,
        }
    }

    /// A read-only session display. It closes shortly after its last viewer.
    pub fn mirror(task_id: &str, command: &str, cwd: PathBuf) -> Self {
        Self {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), command.to_owned()],
            cwd,
            task_id: Some(task_id.to_owned()),
            linger: true,
        }
    }

    /// A provider sign-in command in a login shell, so it sees the profile
    /// that a Herdr pane would.
    pub fn sign_in(command: &str, cwd: PathBuf) -> Self {
        Self {
            program: login_shell(),
            args: vec!["-l".into(), "-c".into(), command.to_owned()],
            cwd,
            task_id: None,
            linger: false,
        }
    }

    /// Only the variables a user shell needs. Suplex credentials, provider
    /// keys, and Herdr or Conductor variables do not reach the terminal.
    fn environment(&self) -> Vec<(OsString, OsString)> {
        let mut kept = std::env::vars_os()
            .filter(|(key, _)| {
                key.to_str()
                    .is_some_and(|key| KEPT_ENVIRONMENT.contains(&key) || key.starts_with("LC_"))
            })
            .collect::<Vec<_>>();
        for (key, value) in [
            ("SHELL", login_shell()),
            ("TERM", "xterm-256color".into()),
            ("COLORTERM", "truecolor".into()),
        ] {
            kept.push((key.into(), value.into()));
        }
        kept
    }
}

#[derive(Clone)]
enum Event {
    Output(Arc<[u8]>, u16, u16),
    Resized(u16, u16),
    Exited(Arc<str>),
}

enum Command {
    Input(Vec<u8>),
    Resize(u16, u16),
}

struct Screen {
    parser: vt100::Parser,
    exited: Option<String>,
}

struct Terminal {
    task_id: Option<String>,
    linger: bool,
    /// Output is parsed and broadcast under this lock, and a viewer takes its
    /// snapshot and subscribes under it, so no output is lost or repeated.
    screen: Mutex<Screen>,
    events: broadcast::Sender<Event>,
    commands: mpsc::UnboundedSender<Command>,
    viewers: AtomicUsize,
    close: CancellationToken,
    finished: CancellationToken,
}

type Registry = Arc<Mutex<HashMap<String, Arc<Terminal>>>>;

#[derive(Default)]
pub struct HostTerminals {
    terminals: Registry,
}

impl HostTerminals {
    /// Attaches to terminal `id`, and starts it from `spec` when it is not
    /// running. Must run inside a Tokio runtime.
    pub fn open(&self, id: &str, spec: Spec, cols: i64, rows: i64) -> pty_process::Result<Viewer> {
        let mut terminals = lock(&self.terminals);
        let terminal = match terminals
            .get(id)
            .filter(|terminal| !terminal.close.is_cancelled())
        {
            Some(terminal) => terminal.clone(),
            None => {
                let terminal = spawn(&self.terminals, id, spec, cols, rows)?;
                terminals.insert(id.to_owned(), terminal.clone());
                terminal
            }
        };
        drop(terminals);
        Ok(Viewer::attach(terminal))
    }

    /// Attaches to terminal `id` only when it is running.
    pub fn attach(&self, id: &str) -> Option<Viewer> {
        let terminal = lock(&self.terminals)
            .get(id)
            .filter(|terminal| !terminal.close.is_cancelled())
            .cloned()?;
        Some(Viewer::attach(terminal))
    }

    pub fn contains(&self, id: &str) -> bool {
        lock(&self.terminals)
            .get(id)
            .is_some_and(|terminal| !terminal.close.is_cancelled())
    }

    pub fn close(&self, id: &str) {
        if let Some(terminal) = lock(&self.terminals).remove(id) {
            terminal.close.cancel();
        }
    }

    /// Closes the task's terminals. `idle_only` keeps the ones a browser shows.
    pub fn close_task(&self, task_id: &str, idle_only: bool) {
        lock(&self.terminals).retain(|_, terminal| {
            let close = terminal.task_id.as_deref() == Some(task_id)
                && (!idle_only || terminal.viewers.load(Ordering::SeqCst) == 0);
            if close {
                terminal.close.cancel();
            }
            !close
        });
    }

    /// Tasks that have a terminal.
    pub fn task_ids(&self) -> Vec<String> {
        let mut ids = lock(&self.terminals)
            .values()
            .filter_map(|terminal| terminal.task_id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Closes every terminal and waits for their processes to end.
    pub async fn close_all(&self) {
        let terminals = lock(&self.terminals)
            .drain()
            .map(|(_, terminal)| terminal)
            .collect::<Vec<_>>();
        for terminal in &terminals {
            terminal.close.cancel();
        }
        for terminal in terminals {
            let _ = tokio::time::timeout(HANGUP_GRACE * 3, terminal.finished.cancelled()).await;
        }
    }
}

fn spawn(
    registry: &Registry,
    id: &str,
    spec: Spec,
    cols: i64,
    rows: i64,
) -> pty_process::Result<Arc<Terminal>> {
    let cols = clamp(cols as f64, 20, 500) as u16;
    let rows = clamp(rows as f64, 5, 200) as u16;
    let (pty, pts) = pty_process::open()?;
    pty.resize(pty_process::Size::new(rows, cols))?;
    let environment = spec.environment();
    let child = pty_process::Command::new(&spec.program)
        .args(&spec.args)
        .env_clear()
        .envs(environment)
        .current_dir(&spec.cwd)
        .spawn(pts)?;
    let (reader, writer) = pty.into_split();
    let (commands, received) = mpsc::unbounded_channel();
    let terminal = Arc::new(Terminal {
        task_id: spec.task_id,
        linger: spec.linger,
        screen: Mutex::new(Screen {
            parser: vt100::Parser::new(rows, cols, SCROLLBACK_LINES),
            exited: None,
        }),
        events: broadcast::channel(BACKLOG).0,
        commands,
        viewers: AtomicUsize::new(0),
        close: CancellationToken::new(),
        finished: CancellationToken::new(),
    });
    tokio::spawn(write(terminal.clone(), writer, received));
    tokio::spawn(run(
        registry.clone(),
        id.to_owned(),
        terminal.clone(),
        reader,
        child,
    ));
    Ok(terminal)
}

/// Signals the process group of a child that this task still owns. The child
/// leads its own session, so its pid is the group id. After the child is
/// reaped its pid can belong to another process, so it is never signalled.
fn signal(child: &mut Child, pid: Option<Pid>, signal: Signal) {
    if let (Some(pid), Ok(None)) = (pid, child.try_wait()) {
        let _ = killpg(pid, signal);
    }
}

/// Owns the child: reads its output into the emulator and viewers, reaps it,
/// and ends it when the terminal closes.
async fn run(
    registry: Registry,
    id: String,
    terminal: Arc<Terminal>,
    mut reader: pty_process::OwnedReadPty,
    mut child: Child,
) {
    let pid = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .map(Pid::from_raw);
    let mut buffer = vec![0; READ_BYTES];
    let mut reading = true;
    let mut hangup: Option<Instant> = None;
    let mut killed = false;
    let status = loop {
        tokio::select! {
            // Output that is already buffered reaches viewers before the exit.
            biased;
            read = reader.read(&mut buffer), if reading => match read {
                Ok(count) if count > 0 => terminal.publish(&buffer[..count]),
                _ => reading = false,
            },
            status = child.wait() => break status,
            () = terminal.close.cancelled(), if hangup.is_none() => {
                signal(&mut child, pid, Signal::SIGHUP);
                hangup = Some(Instant::now());
            }
            () = tokio::time::sleep_until(hangup.unwrap_or_else(Instant::now) + HANGUP_GRACE),
                if hangup.is_some() && !killed => {
                signal(&mut child, pid, Signal::SIGKILL);
                killed = true;
            }
        }
    };
    let reason = exit_reason(status);
    {
        let mut screen = lock(&terminal.screen);
        screen.exited = Some(reason.clone());
        let _ = terminal.events.send(Event::Exited(reason.into()));
    }
    let mut terminals = lock(&registry);
    if terminals
        .get(&id)
        .is_some_and(|current| Arc::ptr_eq(current, &terminal))
    {
        terminals.remove(&id);
    }
    drop(terminals);
    terminal.close.cancel();
    terminal.finished.cancel();
}

/// Owns the PTY write half, so a child that does not read its input cannot
/// stop output from reaching viewers.
async fn write(
    terminal: Arc<Terminal>,
    mut writer: pty_process::OwnedWritePty,
    mut commands: mpsc::UnboundedReceiver<Command>,
) {
    loop {
        let command = tokio::select! {
            () = terminal.close.cancelled() => return,
            command = commands.recv() => command,
        };
        match command {
            Some(Command::Input(bytes)) => {
                if writer.write_all(&bytes).await.is_err() {
                    return;
                }
            }
            Some(Command::Resize(cols, rows)) => {
                let mut screen = lock(&terminal.screen);
                if screen.parser.screen().size() == (rows, cols)
                    || writer.resize(pty_process::Size::new(rows, cols)).is_err()
                {
                    continue;
                }
                screen.parser.screen_mut().set_size(rows, cols);
                let _ = terminal.events.send(Event::Resized(cols, rows));
            }
            None => return,
        }
    }
}

impl Terminal {
    fn publish(&self, bytes: &[u8]) {
        let mut screen = lock(&self.screen);
        screen.parser.process(bytes);
        let (rows, cols) = screen.parser.screen().size();
        let _ = self.events.send(Event::Output(bytes.into(), cols, rows));
    }

    /// The replay and a subscription to the output after it.
    fn subscribe(&self) -> (BridgeEvent, broadcast::Receiver<Event>, Option<String>) {
        let mut screen = lock(&self.screen);
        let bytes = replay(&mut screen.parser);
        let (rows, cols) = screen.parser.screen().size();
        (
            BridgeEvent::Snapshot {
                width: cols.into(),
                height: rows.into(),
                bytes,
            },
            self.events.subscribe(),
            screen.exited.clone(),
        )
    }
}

/// Bytes that reproduce the emulator screen on a reset xterm. On the normal
/// screen, the scrollback rows go first and scroll up into the browser
/// scrollback. On the alternate screen only that screen is reproduced.
fn replay(parser: &mut vt100::Parser) -> Vec<u8> {
    let screen = parser.screen_mut();
    let (rows, cols) = screen.size();
    let mut bytes = Vec::new();
    if screen.alternate_screen() {
        bytes.extend_from_slice(b"\x1b[?1049h");
    } else {
        screen.set_scrollback(usize::MAX);
        let history = screen.scrollback();
        let mut line = 0;
        while line < history {
            screen.set_scrollback(history - line);
            let count = (history - line).min(rows.into());
            for row in screen.rows_formatted(0, cols).take(count) {
                bytes.extend(row);
                bytes.extend_from_slice(b"\x1b[m\r\n");
            }
            line += count;
        }
        screen.set_scrollback(0);
        if history > 0 {
            bytes.extend("\r\n".repeat(usize::from(rows) - 1).into_bytes());
        }
    }
    bytes.extend(screen.contents_formatted());
    bytes.extend(screen.input_mode_formatted());
    bytes
}

/// One browser view of a host terminal. Dropping it detaches the view.
pub struct Viewer {
    terminal: Arc<Terminal>,
    events: broadcast::Receiver<Event>,
    snapshot: Option<BridgeEvent>,
    exited: Option<String>,
}

impl Viewer {
    fn attach(terminal: Arc<Terminal>) -> Self {
        terminal.viewers.fetch_add(1, Ordering::SeqCst);
        let (snapshot, events, exited) = terminal.subscribe();
        Self {
            terminal,
            events,
            snapshot: Some(snapshot),
            exited,
        }
    }

    pub fn input(&self, bytes: Vec<u8>) {
        let _ = self.terminal.commands.send(Command::Input(bytes));
    }

    pub fn resize(&self, cols: f64, rows: f64) {
        let _ = self.terminal.commands.send(Command::Resize(
            clamp(cols, 20, 500) as u16,
            clamp(rows, 5, 200) as u16,
        ));
    }

    /// Cancel safe: it awaits only the broadcast receiver.
    pub async fn next(&mut self) -> Option<BridgeEvent> {
        if let Some(snapshot) = self.snapshot.take() {
            return Some(snapshot);
        }
        if let Some(reason) = self.exited.take() {
            return Some(BridgeEvent::Closed(reason));
        }
        Some(match self.events.recv().await {
            Ok(Event::Output(bytes, cols, rows)) => BridgeEvent::Frame {
                seq: 0,
                full: false,
                width: cols.into(),
                height: rows.into(),
                bytes: bytes.to_vec(),
            },
            Ok(Event::Resized(cols, rows)) => BridgeEvent::Frame {
                seq: 0,
                full: false,
                width: cols.into(),
                height: rows.into(),
                bytes: Vec::new(),
            },
            Ok(Event::Exited(reason)) => BridgeEvent::Closed(reason.to_string()),
            // A viewer that fell behind starts again from a replay.
            Err(RecvError::Lagged(_)) => {
                let (snapshot, events, exited) = self.terminal.subscribe();
                self.events = events;
                self.exited = exited;
                snapshot
            }
            Err(RecvError::Closed) => BridgeEvent::Closed("closed".into()),
        })
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        let last = self.terminal.viewers.fetch_sub(1, Ordering::SeqCst) == 1;
        if last
            && self.terminal.linger
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let terminal = self.terminal.clone();
            runtime.spawn(async move {
                tokio::time::sleep(LINGER).await;
                if terminal.viewers.load(Ordering::SeqCst) == 0 {
                    terminal.close.cancel();
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(script: &str) -> Spec {
        Spec::mirror("task-host-test", script, std::env::temp_dir())
    }

    fn unique() -> String {
        format!("host-test-{}", uuid::Uuid::new_v4())
    }

    /// Feeds viewer events into `parser` until its screen satisfies `done`,
    /// or returns the close reason.
    async fn follow(
        viewer: &mut Viewer,
        parser: &mut vt100::Parser,
        done: impl Fn(&str) -> bool,
    ) -> Option<String> {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if done(&parser.screen().contents()) {
                    return None;
                }
                match viewer.next().await {
                    Some(BridgeEvent::Frame {
                        width,
                        height,
                        bytes,
                        ..
                    }) => {
                        parser.screen_mut().set_size(height as u16, width as u16);
                        parser.process(&bytes);
                    }
                    Some(BridgeEvent::Snapshot {
                        width,
                        height,
                        bytes,
                    }) => {
                        *parser = vt100::Parser::new(height as u16, width as u16, SCROLLBACK_LINES);
                        parser.process(&bytes);
                    }
                    Some(BridgeEvent::Closed(reason)) => return Some(reason),
                    other => panic!("unexpected event {other:?}"),
                }
            }
        })
        .await
        .expect("terminal event")
    }

    fn parser() -> vt100::Parser {
        vt100::Parser::new(24, 80, SCROLLBACK_LINES)
    }

    fn terminal(terminals: &HostTerminals, id: &str) -> Arc<Terminal> {
        lock(&terminals.terminals)
            .get(id)
            .cloned()
            .expect("running terminal")
    }

    #[tokio::test]
    async fn input_and_resize_reach_the_child_and_output_reaches_the_viewer() {
        let terminals = HostTerminals::default();
        let id = unique();
        let mut viewer = terminals
            .open(
                &id,
                command("read line; echo \"got:$line\"; stty size; cat"),
                80,
                24,
            )
            .unwrap();
        let mut screen = parser();
        viewer.resize(100.0, 30.0);
        viewer.input(b"hello\n".to_vec());
        assert_eq!(
            follow(&mut viewer, &mut screen, |text| text.contains("30 100")).await,
            None
        );
        assert!(screen.screen().contents().contains("got:hello"));
        assert_eq!(screen.screen().size(), (30, 100));
        terminals.close_all().await;
    }

    #[tokio::test]
    async fn a_late_viewer_replays_the_screen_and_scrollback_without_terminal_queries() {
        let terminals = HostTerminals::default();
        let id = unique();
        let script = "printf '\\033[c\\033[6n\\033]10;?\\007\\033[>q'; \
            for i in $(seq 1 60); do printf '\\033[1;32mline %s\\033[m\\n' $i; done; \
            printf 'ready'; cat";
        let mut first = terminals.open(&id, command(script), 80, 24).unwrap();
        let mut live = parser();
        follow(&mut first, &mut live, |text| text.contains("ready")).await;
        let mut late = terminals.attach(&id).unwrap();
        let Some(BridgeEvent::Snapshot {
            bytes,
            width,
            height,
        }) = late.next().await
        else {
            panic!("replay expected");
        };
        assert_eq!((width, height), (80, 24));
        for query in [&b"\x1b[c"[..], b"\x1b[6n", b"\x1b]10;?", b"\x1b[>q"] {
            assert!(!bytes.windows(query.len()).any(|window| window == query));
        }
        let mut replayed = parser();
        replayed.process(&bytes);
        {
            let terminal = terminal(&terminals, &id);
            let mut screen = lock(&terminal.screen);
            let original = screen.parser.screen_mut();
            assert_eq!(replayed.screen().contents(), original.contents());
            assert_eq!(
                replayed.screen().contents_formatted(),
                original.contents_formatted()
            );
            original.set_scrollback(usize::MAX);
            replayed.screen_mut().set_scrollback(usize::MAX);
            assert_eq!(replayed.screen().scrollback(), original.scrollback());
            assert_eq!(replayed.screen().contents(), original.contents());
            original.set_scrollback(0);
        }
        drop(first);
        terminal(&terminals, &id).publish(b"after");
        let mut after = replayed;
        after.screen_mut().set_scrollback(0);
        follow(&mut late, &mut after, |text| text.contains("readyafter")).await;
        terminals.close_all().await;
    }

    #[tokio::test]
    async fn scrollback_stays_bounded() {
        let terminals = HostTerminals::default();
        let id = unique();
        let mut viewer = terminals
            .open(&id, command("seq 1 50000; printf finished; cat"), 80, 24)
            .unwrap();
        follow(&mut viewer, &mut parser(), |text| text.contains("finished")).await;
        {
            let terminal = terminal(&terminals, &id);
            let mut screen = lock(&terminal.screen);
            screen.parser.screen_mut().set_scrollback(usize::MAX);
            assert_eq!(screen.parser.screen().scrollback(), SCROLLBACK_LINES);
            screen.parser.screen_mut().set_scrollback(0);
        }
        terminals.close_all().await;
    }

    #[tokio::test]
    async fn a_viewer_that_falls_behind_restarts_from_a_replay() {
        let terminals = HostTerminals::default();
        let id = unique();
        let mut slow = terminals.open(&id, command("cat"), 80, 24).unwrap();
        let mut fast = terminals.attach(&id).unwrap();
        assert!(matches!(
            slow.next().await,
            Some(BridgeEvent::Snapshot { .. })
        ));
        assert!(matches!(
            fast.next().await,
            Some(BridgeEvent::Snapshot { .. })
        ));
        let terminal = terminal(&terminals, &id);
        for _ in 0..BACKLOG {
            terminal.publish(b"x");
            assert!(
                matches!(fast.next().await, Some(BridgeEvent::Frame { bytes, .. }) if bytes == b"x")
            );
        }
        terminal.publish(b"y");
        assert!(matches!(
            slow.next().await,
            Some(BridgeEvent::Snapshot { .. })
        ));
        assert!(
            matches!(fast.next().await, Some(BridgeEvent::Frame { bytes, .. }) if bytes == b"y")
        );
        terminal.publish(b"z");
        assert!(
            matches!(slow.next().await, Some(BridgeEvent::Frame { bytes, .. }) if bytes == b"z")
        );
        terminals.close_all().await;
    }

    #[tokio::test]
    async fn an_exited_terminal_closes_its_viewers_and_the_next_open_starts_again() {
        let terminals = HostTerminals::default();
        let id = unique();
        let mut pids = Vec::new();
        for _ in 0..2 {
            let mut viewer = terminals
                .open(&id, command("echo pid:$$; exit 0"), 80, 24)
                .unwrap();
            let terminal = terminal(&terminals, &id);
            let mut screen = parser();
            assert_eq!(
                follow(&mut viewer, &mut screen, |_| false).await.as_deref(),
                Some("exited:0")
            );
            tokio::time::timeout(Duration::from_secs(5), terminal.finished.cancelled())
                .await
                .unwrap();
            assert!(!terminals.contains(&id));
            pids.push(screen.screen().contents());
        }
        assert!(pids[0].contains("pid:"));
        assert_ne!(pids[0], pids[1]);
    }

    #[tokio::test]
    async fn closing_a_task_ends_its_process_group() {
        let terminals = HostTerminals::default();
        let id = unique();
        let seconds = 90_000 + uuid::Uuid::new_v4().as_u128() % 9_000;
        let pattern = format!("sleep {seconds}");
        let mut viewer = terminals
            .open(
                &id,
                command(&format!("{pattern} & echo started; wait")),
                80,
                24,
            )
            .unwrap();
        follow(&mut viewer, &mut parser(), |text| text.contains("started")).await;
        let running = || {
            std::process::Command::new("pgrep")
                .args(["-f", &pattern])
                .output()
                .unwrap()
                .status
                .success()
        };
        assert!(running());
        let terminal = terminal(&terminals, &id);
        terminals.close_task("task-host-test", false);
        assert!(!terminals.contains(&id));
        assert!(
            follow(&mut viewer, &mut parser(), |_| false)
                .await
                .is_some_and(|reason| reason.starts_with("exited:"))
        );
        tokio::time::timeout(Duration::from_secs(5), terminal.finished.cancelled())
            .await
            .unwrap();
        for _ in 0..50 {
            if !running() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("{pattern} is still running");
    }
}
