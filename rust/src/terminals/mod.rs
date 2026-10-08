//! Browser terminals for the task Shell, the read-only session Mirror, and
//! provider sign-in. Herdr owns them by default. With the host terminal
//! experiment on, this process owns them as PTYs (see [`host`]). The setting
//! is read for each operation: open connections keep their backend.
//!
//! Host terminal ids are derived from the task or session and never stored,
//! so a restart or a backend switch leads to a new terminal, not an error.

pub mod host;

use std::{
    error::Error,
    path::{Path, PathBuf},
};

use tokio::sync::mpsc::UnboundedReceiver;

use crate::http::contracts::typed::tasks::TaskPaneRole;
use crate::{
    coordination::root_session_store,
    integrations::herdr_bridge,
    platform::{database::SuplexDatabase, environment_settings},
    runtimes::{native, task_harness_registry},
    shared::wire_enum,
    tasks::{
        control::{HarnessKind, SessionRow},
        repository,
    },
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
    /// Host terminals only: a replay of the screen and its scrollback.
    Snapshot {
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

wire_enum! {
    /// Who keeps terminal scrollback: Herdr (`remote`) or the browser (`local`).
    pub enum ScrollMode {
        Remote = "remote",
        Local = "local",
    }
}

wire_enum! {
    pub enum ReplayState {
        Start = "start",
        End = "end",
    }
}

pub(crate) fn clamp(value: f64, minimum: i64, maximum: i64) -> i64 {
    (value.round() as i64).clamp(minimum, maximum)
}

pub(crate) fn exit_reason(status: std::io::Result<std::process::ExitStatus>) -> String {
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

/// One browser connection to a terminal on either backend.
pub enum Bridge {
    Herdr(herdr_bridge::Connection, UnboundedReceiver<BridgeEvent>),
    Host(host::Viewer),
}

impl Bridge {
    pub fn scroll_mode(&self) -> ScrollMode {
        match self {
            Self::Herdr(..) => ScrollMode::Remote,
            Self::Host(_) => ScrollMode::Local,
        }
    }

    pub fn input(&self, bytes: Vec<u8>) {
        match self {
            Self::Herdr(connection, _) => connection.input(bytes),
            Self::Host(viewer) => viewer.input(bytes),
        }
    }

    pub fn resize(&self, cols: f64, rows: f64) {
        match self {
            Self::Herdr(connection, _) => connection.resize(cols, rows),
            Self::Host(viewer) => viewer.resize(cols, rows),
        }
    }

    /// The browser keeps host scrollback, so only Herdr scrolls.
    pub fn scroll(&self, direction: &'static str, lines: f64) {
        if let Self::Herdr(connection, _) = self {
            connection.scroll(direction, lines);
        }
    }

    /// A host viewer detaches when it is dropped.
    pub fn release(&self) {
        if let Self::Herdr(connection, _) = self {
            connection.release();
        }
    }

    /// Cancel safe.
    pub async fn next(&mut self) -> Option<BridgeEvent> {
        match self {
            Self::Herdr(_, events) => events.recv().await,
            Self::Host(viewer) => viewer.next().await,
        }
    }
}

pub fn host_enabled(database: &SuplexDatabase) -> bool {
    environment_settings::read(database).is_ok_and(|settings| settings.host_terminal_enabled)
}

pub fn shell_id(task_id: &str) -> String {
    format!("host-shell-{task_id}")
}

pub fn session_id(session_id: &str) -> String {
    format!("host-session-{session_id}")
}

/// The terminal id a browser shows for `session`: the stored Herdr pane, or
/// the derived host Mirror id. OpenCode has no passive display.
pub fn session_pane(host: bool, session: &SessionRow, provider: HarnessKind) -> Option<String> {
    if !host {
        return session.pane_id.clone();
    }
    (session.current && provider != HarnessKind::Opencode).then(|| session_id(&session.id))
}

/// The task Shell id a browser shows. A host Shell starts in the task
/// worktree, so it shows while that directory exists or while it runs.
pub fn shell_pane(
    host: Option<&host::HostTerminals>,
    task_id: &str,
    worktree: Option<&str>,
    stored: Option<&String>,
) -> Option<String> {
    let Some(terminals) = host else {
        return stored.cloned();
    };
    let id = shell_id(task_id);
    (worktree.is_some_and(|path| Path::new(path).is_dir()) || terminals.contains(&id)).then_some(id)
}

/// The host terminal that the task pane route for `role` currently binds:
/// its id and how to start it. `None` when the role has nothing to show.
pub fn task_terminal(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
    role: &str,
) -> Result<Option<(String, host::Spec)>, Box<dyn Error + Send + Sync>> {
    let (_, worktree) = repository::task_worktree(database, user_id, task_id)?;
    if role == TaskPaneRole::Shell.as_str() {
        let Some(cwd) = worktree.map(PathBuf::from).filter(|path| path.is_dir()) else {
            return Ok(None);
        };
        return Ok(Some((shell_id(task_id), host::Spec::shell(task_id, cwd))));
    }
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let Some(session) = rows
        .sessions
        .iter()
        .find(|session| session.current && session.kind.as_str() == role)
    else {
        return Ok(None);
    };
    let database_path = database
        .connection()
        .path()
        .ok_or("Task database has no file path")?;
    let directory = native::session_directory(Path::new(database_path), &session.id)?;
    let Some(command) =
        task_harness_registry::display_command(rows.profile_of(session).provider, &directory)
    else {
        return Ok(None);
    };
    // The Mirror only reads session files, so it needs no worktree.
    let cwd = directory
        .ancestors()
        .find(|path| path.is_dir())
        .unwrap_or(Path::new("/"))
        .to_path_buf();
    Ok(Some((
        session_id(&session.id),
        host::Spec::mirror(task_id, &command, cwd),
    )))
}

/// The id [`task_terminal`] binds now, without the cost of building its spec.
/// A running Shell keeps its id when its worktree is removed: only a new
/// Shell needs the directory.
pub fn task_terminal_id(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
    role: &str,
) -> Result<Option<String>, Box<dyn Error + Send + Sync>> {
    if role == TaskPaneRole::Shell.as_str() {
        crate::tasks::authorize_task(database, user_id, task_id)?;
        return Ok(Some(shell_id(task_id)));
    }
    Ok(repository::current_session(database, user_id, task_id, role)?.map(|id| session_id(&id)))
}
