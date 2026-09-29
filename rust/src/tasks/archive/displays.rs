//! Cleanup of Herdr task displays after archive or terminal lifecycle changes.
//! Only panes whose live Herdr metadata proves task ownership are signalled or
//! closed. A missing, reassigned, or unobservable pane is left alone.

use std::{
    error::Error,
    path::Path,
    time::{Duration, Instant},
};

use nix::{errno::Errno, sys::signal::Signal, unistd::Pid};

use crate::{
    integrations::herdr::{ForegroundProcess, Herdr, HerdrFailure, Pane, ProcessInfo},
    platform::database::{DatabaseResult, SuplexDatabase},
    runtimes::task_display::{is_shell_process, task_shell_pane_binding},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
pub type Kill = fn(i32, Signal) -> nix::Result<()>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveSession {
    pub id: String,
    pub task_id: String,
    pub pane_id: Option<String>,
}

pub struct DisplayCleanup {
    herdr: Herdr,
    kill: Kill,
    owned: Vec<(String, ArchiveSession)>,
    workspaces: Vec<String>,
}

fn system_kill(pid: i32, signal: Signal) -> nix::Result<()> {
    nix::sys::signal::kill(Pid::from_raw(pid), signal)
}

fn matches(pane: &Pane, session: &ArchiveSession) -> bool {
    pane.token("suplex_task_id") == Some(session.task_id.as_str())
        && pane.token("suplex_binding_id") == Some(session.id.as_str())
}

fn active(info: &ProcessInfo) -> Vec<&ForegroundProcess> {
    info.foreground_processes
        .iter()
        .filter(|process| !is_shell_process(process.pid, &process.name, info.shell_pid))
        .collect()
}

fn uninspectable() -> Box<dyn Error> {
    "The task terminal could not be inspected.".into()
}

impl DisplayCleanup {
    fn still_owned(&self, pane_id: &str, session: &ArchiveSession) -> Result<bool> {
        Ok(self
            .herdr
            .get_pane(pane_id)?
            .is_some_and(|pane| matches(&pane, session)))
    }

    fn signal(
        &self,
        pane: &Pane,
        session: &ArchiveSession,
        info: &ProcessInfo,
        signal: Signal,
    ) -> Result<bool> {
        if !self.still_owned(&pane.pane_id, session)? {
            return Ok(false);
        }
        let outcome = match info.foreground_process_group_id {
            Some(group) if Some(group) != info.shell_pid => (self.kill)(-(group as i32), signal),
            _ => active(info)
                .iter()
                .try_for_each(|process| (self.kill)(process.pid as i32, signal)),
        };
        match outcome {
            Ok(()) | Err(Errno::ESRCH) => Ok(true),
            Err(error) => Err(error.into()),
        }
    }

    /// Waits for the pane to return to its shell. Returns the last observation
    /// when a command still runs at the deadline.
    fn wait_for_shell(
        &self,
        pane: &Pane,
        info: &ProcessInfo,
        timeout: Duration,
    ) -> Result<Option<ProcessInfo>> {
        let deadline = Instant::now() + timeout;
        let mut current = info.clone();
        while !active(&current).is_empty() {
            if Instant::now() >= deadline {
                return Ok(Some(current));
            }
            std::thread::sleep(Duration::from_millis(100));
            current = self.herdr.get_pane_process_info(&pane.pane_id)?;
            if current.foreground_processes.is_empty() {
                return Err(uninspectable());
            }
        }
        Ok(None)
    }

    /// Proves ownership, then stops a running terminal command so the pane
    /// can close. Returns false when the pane is not this session's display.
    fn inspect_owned(&self, pane: &Pane, session: &ArchiveSession) -> Result<bool> {
        if !matches(pane, session) {
            return Ok(false);
        }
        let info = self.herdr.get_pane_process_info(&pane.pane_id)?;
        if !self.still_owned(&pane.pane_id, session)? {
            return Ok(false);
        }
        if info.foreground_processes.is_empty() {
            return Err(uninspectable());
        }
        if active(&info).is_empty() {
            return Ok(true);
        }
        if !self.signal(pane, session, &info, Signal::SIGTERM)? {
            return Ok(false);
        }
        let Some(after_term) = self.wait_for_shell(pane, &info, Duration::from_secs(5))? else {
            return Ok(true);
        };
        if !self.signal(pane, session, &after_term, Signal::SIGKILL)? {
            return Ok(false);
        }
        if self
            .wait_for_shell(pane, &info, Duration::from_secs(2))?
            .is_none()
        {
            return Ok(true);
        }
        Err("The task terminal command could not be stopped.".into())
    }

    fn owned_session(&self, pane_id: &str) -> Option<&ArchiveSession> {
        self.owned
            .iter()
            .find(|(owned, _)| owned == pane_id)
            .map(|(_, session)| session)
    }

    fn discover(&mut self, sessions: &[ArchiveSession]) -> Result<()> {
        for session in sessions {
            let Some(pane_id) = &session.pane_id else {
                continue;
            };
            let Some(pane) = self.herdr.get_pane(pane_id)? else {
                continue;
            };
            if !self.inspect_owned(&pane, session)? {
                continue;
            }
            self.owned.push((pane.pane_id.clone(), session.clone()));
            if let Some(workspace) = pane.workspace_id
                && !self.workspaces.contains(&workspace)
            {
                self.workspaces.push(workspace);
            }
        }
        for workspace in self.herdr.list_workspaces()? {
            if sessions
                .iter()
                .any(|session| workspace.label == format!("suplex-{}", session.task_id))
                && !self.workspaces.contains(&workspace.workspace_id)
            {
                self.workspaces.push(workspace.workspace_id);
            }
        }
        Ok(())
    }

    /// Closes the owned panes, and the task workspace when every pane in it
    /// is an owned display. Safe to call again after a partial failure.
    pub fn close(&self) -> Result<()> {
        for workspace_id in &self.workspaces {
            let Some(workspace) = self.herdr.get_workspace(workspace_id)? else {
                continue;
            };
            let mut inspected = Vec::new();
            for pane in self.herdr.list_panes(workspace_id)? {
                if let Some(session) = self.owned_session(&pane.pane_id)
                    && self.inspect_owned(&pane, session)?
                {
                    inspected.push(pane.pane_id);
                }
            }
            let current = self.herdr.list_panes(workspace_id)?;
            let owner = |pane: &Pane| {
                self.owned_session(&pane.pane_id)
                    .filter(|session| matches(pane, session))
            };
            let task_id = current
                .iter()
                .find_map(|pane| owner(pane).map(|session| &session.task_id));
            let may_close = !current.is_empty()
                && current
                    .iter()
                    .all(|pane| owner(pane).is_some() && inspected.contains(&pane.pane_id));
            let Some(task_id) = task_id else { continue };
            if workspace.label != format!("suplex-{task_id}") || !may_close {
                continue;
            }
            let closed = self
                .herdr
                .close_workspace(workspace_id)
                .map_err(Box::<dyn Error>::from)
                .and_then(|()| {
                    if self.herdr.get_workspace(workspace_id)?.is_some() {
                        return Err("Herdr did not close the task workspace.".into());
                    }
                    Ok(())
                });
            if let Err(error) = closed {
                if error
                    .downcast_ref::<HerdrFailure>()
                    .is_none_or(|failure| failure.code != "workspace_group_close_required")
                {
                    return Err(error);
                }
                let anchor = current.first().ok_or(
                    "The task workspace needs a replacement pane before cleanup, but it has no pane.",
                )?;
                let cwd = std::env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned());
                let cwd = [
                    workspace.raw["worktree"]["repo_root"].as_str().map(str::to_owned),
                    anchor.foreground_cwd.clone(),
                    anchor.cwd.clone(),
                    cwd,
                ]
                .into_iter()
                .flatten()
                .find(|candidate| Path::new(candidate).is_dir())
                .ok_or("The task workspace needs a replacement pane before cleanup, but no safe directory is available.")?;
                self.herdr
                    .split_pane(&anchor.pane_id, "right", None, &cwd)?;
            }
        }
        for (pane_id, session) in &self.owned {
            let Some(pane) = self.herdr.get_pane(pane_id)? else {
                continue;
            };
            if !self.inspect_owned(&pane, session)? || !self.still_owned(pane_id, session)? {
                continue;
            }
            self.herdr.close_pane(pane_id)?;
        }
        Ok(())
    }
}

pub fn prepare_archive_displays(
    herdr: &Herdr,
    sessions: &[ArchiveSession],
    kill: Kill,
) -> Result<DisplayCleanup> {
    let mut cleanup = DisplayCleanup {
        herdr: herdr.clone(),
        kill,
        owned: Vec::new(),
        workspaces: Vec::new(),
    };
    if let Err(error) = cleanup.discover(sessions) {
        // An unreachable Herdr proves nothing about ownership: leave displays alone.
        if error
            .downcast_ref::<HerdrFailure>()
            .is_some_and(|failure| failure.retryable)
        {
            cleanup.owned.clear();
            cleanup.workspaces.clear();
            return Ok(cleanup);
        }
        return Err(error);
    }
    for workspace_id in cleanup.workspaces.clone() {
        for pane in cleanup.herdr.list_panes(&workspace_id)? {
            let Some(session) = sessions.iter().find(|session| matches(&pane, session)) else {
                continue;
            };
            if cleanup.owned_session(&pane.pane_id).is_some()
                || !cleanup.inspect_owned(&pane, session)?
            {
                continue;
            }
            cleanup.owned.push((pane.pane_id.clone(), session.clone()));
        }
    }
    Ok(cleanup)
}

/// The task's session displays plus its Shell, whose binding id is the
/// stable shell token. Herdr is observed whatever the host terminal setting
/// says, since the task may have panes from before the setting changed. An
/// unreachable Herdr leaves them alone and does not block the caller.
pub fn prepare_task_displays(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<DisplayCleanup> {
    let sessions = task_display_sessions(database, task_id)?;
    prepare_archive_displays(&Herdr::default(), &sessions, system_kill)
}

pub(crate) fn task_display_sessions(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Vec<ArchiveSession>> {
    let mut statement = database.connection().prepare(
        "SELECT id, pane_id FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY created_at, id",
    )?;
    let mut sessions = statement
        .query_map([task_id], |row| {
            Ok(ArchiveSession {
                id: row.get(0)?,
                task_id: task_id.to_owned(),
                pane_id: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let shell_pane_id = database.connection().query_row(
        "SELECT shell_pane_id FROM suplex_task_controls WHERE task_id = ?1",
        [task_id],
        |row| row.get::<_, Option<String>>(0),
    )?;
    sessions.push(ArchiveSession {
        id: task_shell_pane_binding(task_id),
        task_id: task_id.to_owned(),
        pane_id: shell_pane_id,
    });
    Ok(sessions)
}

pub(crate) fn close_task_displays(herdr: &Herdr, sessions: &[ArchiveSession]) -> Result<()> {
    prepare_archive_displays(herdr, sessions, system_kill)?.close()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use serde_json::{Value, json};

    use super::*;
    use crate::integrations::herdr::fake;

    #[derive(Default)]
    struct State {
        panes: Vec<Pane>,
        workspace_open: bool,
        repo_root: Option<String>,
        close_workspace: Option<&'static str>,
        fail_close_pane_once: Option<String>,
        get_pane_fails: bool,
        reassign_on_close: bool,
        running: Option<&'static AtomicBool>,
        split_calls: usize,
    }

    fn shell(id: &str) -> Value {
        json!({"pane_id":id,"shell_pid":1,"foreground_process_group_id":1,"foreground_processes":[{"pid":1,"name":"zsh","argv":["/bin/zsh"]}]})
    }

    fn owned_pane(id: &str, binding: &str) -> Pane {
        let mut pane = Pane {
            pane_id: id.into(),
            workspace_id: Some("w1".into()),
            cwd: std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned()),
            ..Pane::default()
        };
        pane.tokens.insert("suplex_task_id".into(), "task".into());
        pane.tokens
            .insert("suplex_binding_id".into(), binding.into());
        pane
    }

    fn foreign_pane(id: &str) -> Pane {
        let mut pane = Pane {
            pane_id: id.into(),
            workspace_id: Some("w1".into()),
            ..Pane::default()
        };
        pane.tokens.insert("suplex_task_id".into(), "other".into());
        pane
    }

    fn fixture(shared: bool) -> Arc<Mutex<State>> {
        let mut state = State {
            workspace_open: true,
            ..State::default()
        };
        state.panes.push(owned_pane("w1:p1", "session"));
        if shared {
            state.panes.push(foreign_pane("w1:p2"));
        }
        Arc::new(Mutex::new(state))
    }

    fn herdr(state: Arc<Mutex<State>>) -> Herdr {
        fake::herdr(move |args| {
            let mut state = state.lock().unwrap();
            let failure = |code: &str| fake::failed(json!({"error":{"code":code,"message":code}}));
            let args = args.iter().map(String::as_str).collect::<Vec<_>>();
            match args.as_slice() {
                ["pane", "get", ..] if state.get_pane_fails => failure("unavailable"),
                ["pane", "get", id] => match state.panes.iter().find(|pane| pane.pane_id == *id) {
                    Some(pane) => fake::envelope(json!({"pane": fake::pane_value(pane)})),
                    None => failure("pane_not_found"),
                },
                ["pane", "list", ..] => fake::envelope(json!({"panes": state.panes.iter().map(fake::pane_value).collect::<Vec<_>>()})),
                ["workspace", "get", _] if state.workspace_open => fake::envelope(json!({"workspace":{"workspace_id":"w1","label":"suplex-task","worktree":{"repo_root":state.repo_root}}})),
                ["workspace", "get", _] => failure("workspace_not_found"),
                ["workspace", "list"] => fake::envelope(json!({"workspaces": if state.workspace_open { json!([{"workspace_id":"w1","label":"suplex-task"}]) } else { json!([]) }})),
                ["pane", "process-info", _, id] => match &state.running {
                    Some(running) if running.load(Ordering::SeqCst) => fake::envelope(json!({"process_info":{"pane_id":id,"shell_pid":1,"foreground_process_group_id":2,"foreground_processes":[{"pid":2,"name":"git","argv":["git","commit"]}]}})),
                    _ => fake::envelope(json!({"process_info": shell(id)})),
                },
                ["pane", "split", _, "--direction", "right", "--cwd", cwd, "--no-focus"] => {
                    state.split_calls += 1;
                    state.panes.push(Pane { pane_id: "w1:replacement".into(), workspace_id: Some("w1".into()), cwd: Some((*cwd).into()), ..Pane::default() });
                    fake::envelope(json!({"pane":{"pane_id":"w1:replacement"}}))
                }
                ["pane", "close", id] => {
                    if state.fail_close_pane_once.as_deref() == Some(*id) {
                        state.fail_close_pane_once = None;
                        return failure("transport");
                    }
                    let id = (*id).to_owned();
                    state.panes.retain(|pane| pane.pane_id != id);
                    if state.reassign_on_close {
                        state.panes.insert(0, foreign_pane(&id));
                    }
                    fake::envelope(json!({}))
                }
                ["workspace", "close", _] => match state.close_workspace {
                    Some(code) => failure(code),
                    None => {
                        state.panes.clear();
                        state.workspace_open = false;
                        fake::envelope(json!({}))
                    }
                },
                other => panic!("unexpected Herdr call {other:?}"),
            }
        })
        .0
    }

    fn sessions() -> Vec<ArchiveSession> {
        vec![ArchiveSession {
            id: "session".into(),
            task_id: "task".into(),
            pane_id: Some("w1:p1".into()),
        }]
    }

    fn shell_session(pane: &str) -> ArchiveSession {
        ArchiveSession {
            id: "task:shell".into(),
            task_id: "task".into(),
            pane_id: Some(pane.into()),
        }
    }

    fn no_kill(_: i32, _: Signal) -> nix::Result<()> {
        panic!("no process may be signalled")
    }

    fn ids(state: &Mutex<State>) -> Vec<String> {
        state
            .lock()
            .unwrap()
            .panes
            .iter()
            .map(|pane| pane.pane_id.clone())
            .collect()
    }

    fn archive(state: &Arc<Mutex<State>>, sessions: &[ArchiveSession]) -> Result<()> {
        prepare_archive_displays(&herdr(state.clone()), sessions, no_kill)?.close()
    }

    #[test]
    fn archive_closes_a_task_only_workspace_including_historical_attachments() {
        let state = fixture(false);
        state
            .lock()
            .unwrap()
            .panes
            .push(owned_pane("w1:p3", "session"));
        let cleanup =
            prepare_archive_displays(&herdr(state.clone()), &sessions(), no_kill).unwrap();
        assert!(state.lock().unwrap().workspace_open);
        cleanup.close().unwrap();
        assert!(!state.lock().unwrap().workspace_open);
        assert!(ids(&state).is_empty());
        cleanup.close().unwrap();
    }

    #[test]
    fn archive_preserves_unrelated_and_unproven_panes() {
        let state = fixture(true);
        archive(&state, &sessions()).unwrap();
        assert!(state.lock().unwrap().workspace_open);
        assert_eq!(ids(&state), ["w1:p2"]);
        for pane in [
            foreign_pane("w1:p1"),
            Pane {
                pane_id: "w1:p1".into(),
                workspace_id: Some("w1".into()),
                ..Pane::default()
            },
        ] {
            let state = fixture(false);
            state.lock().unwrap().panes[0] = pane;
            archive(&state, &sessions()).unwrap();
            assert!(state.lock().unwrap().workspace_open);
            assert_eq!(ids(&state), ["w1:p1"]);
        }
    }

    #[test]
    fn archive_discovers_leftover_and_shell_displays_by_live_tokens() {
        let state = fixture(false);
        state.lock().unwrap().panes = vec![owned_pane("w1:p3", "session")];
        archive(&state, &sessions()).unwrap();
        assert!(!state.lock().unwrap().workspace_open);
        for recorded in ["w1:shell", "w1:shell-old", "w1:missing"] {
            let state = fixture(false);
            state
                .lock()
                .unwrap()
                .panes
                .push(owned_pane("w1:shell", "task:shell"));
            let mut all = sessions();
            all.push(shell_session(recorded));
            archive(&state, &all).unwrap();
            assert!(ids(&state).is_empty(), "{recorded}");
        }
    }

    #[test]
    fn archive_discovers_an_owned_display_when_every_cached_pane_id_is_missing() {
        let state = fixture(false);
        let sessions = vec![ArchiveSession {
            id: "session".into(),
            task_id: "task".into(),
            pane_id: None,
        }];
        archive(&state, &sessions).unwrap();
        assert!(!state.lock().unwrap().workspace_open);
        assert!(ids(&state).is_empty());
    }

    #[test]
    fn missing_or_unavailable_displays_never_block_archive() {
        let state = fixture(false);
        state.lock().unwrap().panes.clear();
        archive(&state, &sessions()).unwrap();
        let state = fixture(false);
        state.lock().unwrap().get_pane_fails = true;
        archive(&state, &sessions()).unwrap();
        assert_eq!(ids(&state), ["w1:p1"]);
    }

    #[test]
    fn archive_terminates_an_active_command_then_closes_its_workspace() {
        static RUNNING: AtomicBool = AtomicBool::new(true);
        static SIGNALS: AtomicUsize = AtomicUsize::new(0);
        #[expect(clippy::unnecessary_wraps, reason = "stands in for the signal sender")]
        fn kill(pid: i32, signal: Signal) -> nix::Result<()> {
            assert_eq!((pid, signal), (-2, Signal::SIGTERM));
            SIGNALS.fetch_add(1, Ordering::SeqCst);
            RUNNING.store(false, Ordering::SeqCst);
            Ok(())
        }
        let state = fixture(false);
        state.lock().unwrap().running = Some(&RUNNING);
        prepare_archive_displays(&herdr(state.clone()), &sessions(), kill)
            .unwrap()
            .close()
            .unwrap();
        assert_eq!(SIGNALS.load(Ordering::SeqCst), 1);
        assert!(ids(&state).is_empty());
    }

    #[test]
    fn archive_escalates_an_owned_command_that_ignores_term() {
        static RUNNING: AtomicBool = AtomicBool::new(true);
        static TERM: AtomicUsize = AtomicUsize::new(0);
        static KILL: AtomicUsize = AtomicUsize::new(0);
        #[expect(clippy::unnecessary_wraps, reason = "stands in for the signal sender")]
        fn signal(pid: i32, signal: Signal) -> nix::Result<()> {
            assert_eq!(pid, -2);
            match signal {
                Signal::SIGTERM => {
                    TERM.fetch_add(1, Ordering::SeqCst);
                }
                Signal::SIGKILL => {
                    KILL.fetch_add(1, Ordering::SeqCst);
                    RUNNING.store(false, Ordering::SeqCst);
                }
                other => panic!("unexpected signal {other:?}"),
            }
            Ok(())
        }
        RUNNING.store(true, Ordering::SeqCst);
        TERM.store(0, Ordering::SeqCst);
        KILL.store(0, Ordering::SeqCst);
        let state = fixture(false);
        state.lock().unwrap().running = Some(&RUNNING);
        prepare_archive_displays(&herdr(state.clone()), &sessions(), signal)
            .unwrap()
            .close()
            .unwrap();
        assert_eq!(TERM.load(Ordering::SeqCst), 1);
        assert_eq!(KILL.load(Ordering::SeqCst), 1);
        assert!(ids(&state).is_empty());
    }

    #[test]
    fn archive_never_signals_a_command_in_an_unowned_pane() {
        static RUNNING: AtomicBool = AtomicBool::new(true);
        RUNNING.store(true, Ordering::SeqCst);
        let state = fixture(false);
        {
            let mut state = state.lock().unwrap();
            state.panes[0] = foreign_pane("w1:p1");
            state.running = Some(&RUNNING);
        }
        archive(&state, &sessions()).unwrap();
        assert!(RUNNING.load(Ordering::SeqCst));
        assert_eq!(ids(&state), ["w1:p1"]);
    }

    #[test]
    #[ignore = "requires HERDR_ENV=1 and a live Herdr installation"]
    fn archive_closes_a_real_owned_herdr_workspace_and_its_process() {
        use crate::integrations::herdr::MetadataReport;

        assert_eq!(std::env::var("HERDR_ENV").ok().as_deref(), Some("1"));
        let directory = std::env::temp_dir().join(format!(
            "suplex-archive-display-proof-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let task_id = format!("task_archive_proof_{}", uuid::Uuid::new_v4());
        let herdr = Herdr::default();
        let (workspace, root) = herdr
            .create_workspace(&format!("suplex-{task_id}"), directory.to_str().unwrap())
            .unwrap();
        struct Cleanup<'a> {
            herdr: &'a Herdr,
            workspace: String,
            directory: PathBuf,
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                if self
                    .herdr
                    .get_workspace(&self.workspace)
                    .ok()
                    .flatten()
                    .is_some()
                {
                    let _ = self.herdr.close_workspace(&self.workspace);
                }
                let _ = fs::remove_dir_all(&self.directory);
            }
        }
        let _cleanup = Cleanup {
            herdr: &herdr,
            workspace: workspace.workspace_id.clone(),
            directory,
        };
        let worker = herdr
            .split_pane(
                &root.pane_id,
                "right",
                None,
                _cleanup.directory.to_str().unwrap(),
            )
            .unwrap();
        for pane in [&root, &worker] {
            herdr
                .report_pane_metadata(&MetadataReport {
                    pane_id: pane.pane_id.clone(),
                    source: "suplex".into(),
                    title: Some("Archive cleanup proof".into()),
                    tokens: vec![
                        ("suplex_task_id".into(), task_id.clone()),
                        ("suplex_binding_id".into(), "proof-session".into()),
                    ],
                    ..MetadataReport::default()
                })
                .unwrap();
            herdr
                .run_pane_command(&pane.pane_id, "exec /bin/zsh -f")
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let info = herdr.get_pane_process_info(&pane.pane_id).unwrap();
                if !info.foreground_processes.is_empty()
                    && info.foreground_processes.iter().all(|process| {
                        Some(process.pid) == info.shell_pid
                            && process.name == "zsh"
                            && process
                                .argv
                                .as_ref()
                                .is_some_and(|argv| argv.iter().any(|arg| arg == "-f"))
                    })
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "pane did not reach a clean shell"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        herdr
            .run_pane_command(&worker.pane_id, "sleep 300")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let sleep_pid = loop {
            let info = herdr.get_pane_process_info(&worker.pane_id).unwrap();
            if let Some(pid) = info
                .foreground_processes
                .iter()
                .find(|process| process.name == "sleep")
                .map(|process| process.pid)
            {
                break pid;
            }
            assert!(Instant::now() < deadline, "sleep process was not found");
            std::thread::sleep(Duration::from_millis(100));
        };
        let close = prepare_archive_displays(
            &herdr,
            &[ArchiveSession {
                id: "proof-session".into(),
                task_id,
                pane_id: Some(root.pane_id.clone()),
            }],
            system_kill,
        )
        .unwrap();
        close.close().unwrap();
        assert!(
            herdr
                .get_workspace(&workspace.workspace_id)
                .unwrap()
                .is_none()
        );
        assert!(herdr.get_pane(&root.pane_id).unwrap().is_none());
        assert!(herdr.get_pane(&worker.pane_id).unwrap().is_none());
        assert_eq!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(sleep_pid as i32), None),
            Err(nix::errno::Errno::ESRCH)
        );
        close.close().unwrap();
    }

    #[test]
    fn ownership_lost_after_preparation_preserves_the_pane() {
        let state = fixture(false);
        let cleanup =
            prepare_archive_displays(&herdr(state.clone()), &sessions(), no_kill).unwrap();
        state.lock().unwrap().panes[0].tokens.clear();
        cleanup.close().unwrap();
        assert!(state.lock().unwrap().workspace_open);
        assert_eq!(ids(&state), ["w1:p1"]);
        let state = fixture(false);
        let cleanup =
            prepare_archive_displays(&herdr(state.clone()), &sessions(), no_kill).unwrap();
        state
            .lock()
            .unwrap()
            .panes
            .push(owned_pane("w1:p3", "session"));
        cleanup.close().unwrap();
        assert!(state.lock().unwrap().workspace_open);
        assert_eq!(ids(&state), ["w1:p3"]);
    }

    #[test]
    fn a_pane_id_reused_after_close_is_preserved() {
        let state = fixture(true);
        state.lock().unwrap().reassign_on_close = true;
        archive(&state, &sessions()).unwrap();
        assert_eq!(ids(&state), ["w1:p1", "w1:p2"]);
    }

    #[test]
    fn a_workspace_group_refusal_falls_back_to_verified_pane_closure_and_retries() {
        let state = fixture(false);
        state.lock().unwrap().close_workspace = Some("workspace_group_close_required");
        archive(&state, &sessions()).unwrap();
        assert_eq!(ids(&state), ["w1:replacement"]);
        let state = fixture(false);
        {
            let mut state = state.lock().unwrap();
            state.close_workspace = Some("workspace_group_close_required");
            state.panes.push(owned_pane("w1:p3", "session"));
            state.fail_close_pane_once = Some("w1:p3".into());
        }
        let cleanup =
            prepare_archive_displays(&herdr(state.clone()), &sessions(), no_kill).unwrap();
        assert!(cleanup.close().is_err());
        assert_eq!(ids(&state), ["w1:p3", "w1:replacement"]);
        cleanup.close().unwrap();
        assert_eq!(ids(&state), ["w1:replacement"]);
        assert_eq!(state.lock().unwrap().split_calls, 1);
    }

    #[test]
    fn workspace_close_failures_other_than_group_refusal_propagate() {
        let state = fixture(false);
        state.lock().unwrap().close_workspace = Some("unavailable");
        assert!(archive(&state, &sessions()).is_err());
        assert_eq!(ids(&state), ["w1:p1"]);
    }

    #[test]
    fn group_fallback_does_not_reuse_a_removed_worktree_directory() {
        let removed = std::env::temp_dir().join(format!("suplex-removed-{}", uuid::Uuid::new_v4()));
        let parent = std::env::temp_dir().join(format!("suplex-parent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&removed).unwrap();
        std::fs::create_dir_all(&parent).unwrap();
        let state = fixture(false);
        {
            let mut state = state.lock().unwrap();
            state.panes[0].cwd = Some(removed.to_string_lossy().into_owned());
            state.repo_root = Some(parent.to_string_lossy().into_owned());
            state.close_workspace = Some("workspace_group_close_required");
        }
        let cleanup =
            prepare_archive_displays(&herdr(state.clone()), &sessions(), no_kill).unwrap();
        std::fs::remove_dir_all(&removed).unwrap();
        cleanup.close().unwrap();
        let replacement = state
            .lock()
            .unwrap()
            .panes
            .iter()
            .find(|pane| pane.pane_id == "w1:replacement")
            .cloned()
            .unwrap();
        assert_eq!(
            replacement.cwd.as_deref(),
            Some(parent.to_string_lossy().as_ref())
        );
        let _ = std::fs::remove_dir_all(parent);
    }
}
