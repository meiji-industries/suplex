//! Herdr display panes for task sessions and the task Shell. Display
//! attachment is an observation: a missing or recreated pane is rediscovered or
//! replaced, and a display failure never gates native work.

use std::{
    collections::HashSet,
    error::Error,
    path::Path,
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use rusqlite::{OptionalExtension, params};

use crate::{
    integrations::herdr::{Herdr, HerdrFailure, MetadataReport, Pane, ProcessInfo},
    platform::database::{OpenMode, SuplexDatabase},
    tasks::pane_layout::split_balanced_pane_row,
};

const SHELLS: [&str; 6] = ["zsh", "bash", "sh", "fish", "nu", "pwsh"];

pub const TASK_SHELL_PANE_TITLE: &str = "Shell";

pub type DisplayResult<T> = Result<T, Box<dyn Error>>;
/// Records a pane binding. A failed write aborts the display attachment.
pub type Persist<'a> = &'a mut dyn FnMut(&str) -> DisplayResult<()>;

pub fn is_shell_process(pid: u32, name: &str, shell_pid: Option<u32>) -> bool {
    let base = Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(name);
    Some(pid) == shell_pid && SHELLS.contains(&base)
}

pub fn is_interactive_shell(info: &ProcessInfo) -> bool {
    matches!(info.foreground_processes.as_slice(), [only]
        if info.foreground_process_group_id == info.shell_pid
            && is_shell_process(only.pid, &only.name, info.shell_pid))
}

/// Stable binding token that marks a pane as the task's interactive Shell.
pub fn task_shell_pane_binding(task_id: &str) -> String {
    format!("{task_id}:shell")
}

fn display_failure(message: &str) -> HerdrFailure {
    HerdrFailure {
        code: "display_unavailable".into(),
        retryable: false,
        message: message.into(),
    }
}

/// Title writes and metadata writes are independent and best effort.
fn publish(herdr: &Herdr, pane: &Pane, title: &str, tokens: Vec<(String, String)>, fresh: bool) {
    if fresh || pane.label.as_deref() != Some(title) {
        let _ = herdr.rename_pane(&pane.pane_id, title);
    }
    if fresh
        || pane.title.as_deref() != Some(title)
        || tokens
            .iter()
            .any(|(key, value)| pane.token(key) != Some(value.as_str()))
    {
        let _ = herdr.report_pane_metadata(&MetadataReport {
            pane_id: pane.pane_id.clone(),
            source: "suplex".into(),
            title: Some(title.to_owned()),
            tokens,
            ..MetadataReport::default()
        });
    }
}

fn shell_tokens(task_id: &str) -> Vec<(String, String)> {
    [
        ("suplex_binding_id", task_shell_pane_binding(task_id)),
        ("suplex_task_id", task_id.to_owned()),
        ("suplex_task", task_id.to_owned()),
        ("suplex_role", "shell".to_owned()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

pub struct ShellPaneRequest<'a> {
    pub task_id: &'a str,
    pub cwd: &'a str,
    pub pane_id: Option<&'a str>,
    pub exclude_pane_ids: &'a [Option<String>],
    pub create: bool,
}

/// Resolves the task's interactive Shell pane. The persisted binding is only a
/// hint: Herdr decides which panes still exist. A bound pane that is gone is
/// rediscovered from the `suplex-<taskId>` workspace by token, title, or an
/// interactive shell; an exhausted workspace gets a fresh shell row. When
/// `create` is true and no workspace exists, a new workspace's root pane
/// becomes the Shell.
pub fn ensure_task_shell_pane(
    herdr: &Herdr,
    request: &ShellPaneRequest<'_>,
    persist: Persist<'_>,
) -> DisplayResult<Option<Pane>> {
    let task_id = request.task_id;
    let mut adopt = |pane: Pane, fresh: bool| -> DisplayResult<Option<Pane>> {
        persist(&pane.pane_id)?;
        publish(
            herdr,
            &pane,
            TASK_SHELL_PANE_TITLE,
            shell_tokens(task_id),
            fresh,
        );
        Ok(Some(pane))
    };
    let persisted = match request.pane_id {
        Some(pane_id) => herdr.get_pane(pane_id)?,
        None => None,
    };
    if let Some(persisted) = persisted
        && persisted
            .token("suplex_task_id")
            .is_none_or(|owner| owner == task_id)
    {
        return adopt(persisted, false);
    }
    let excluded = request
        .exclude_pane_ids
        .iter()
        .flatten()
        .collect::<HashSet<_>>();
    let binding = task_shell_pane_binding(task_id);
    let label = format!("suplex-{task_id}");
    let mut all = Vec::new();
    for workspace in herdr.list_workspaces()? {
        if workspace.label == label {
            all.extend(herdr.list_panes(&workspace.workspace_id)?);
        }
    }
    let panes = all
        .iter()
        .filter(|pane| !excluded.contains(&pane.pane_id))
        .filter(|pane| {
            pane.token("suplex_binding_id")
                .is_none_or(|bound| bound == binding)
        })
        .collect::<Vec<_>>();
    let tokened = panes.iter().find(|pane| {
        pane.token("suplex_task_id") == Some(task_id) && pane.token("suplex_role") == Some("shell")
    });
    let named = panes.iter().find(|pane| {
        pane.label.as_deref() == Some(TASK_SHELL_PANE_TITLE)
            || pane.title.as_deref() == Some(TASK_SHELL_PANE_TITLE)
    });
    if let Some(pane) = tokened.or(named) {
        return adopt((*pane).clone(), false);
    }
    for pane in &panes {
        if herdr
            .get_pane_process_info(&pane.pane_id)
            .is_ok_and(|info| is_interactive_shell(&info))
        {
            return adopt((*pane).clone(), false);
        }
    }
    if let Some(anchor) = all.first() {
        let cwd = anchor.cwd.as_deref().unwrap_or(request.cwd);
        return adopt(split_balanced_pane_row(herdr, &anchor.pane_id, cwd)?, true);
    }
    if !request.create {
        return Ok(None);
    }
    adopt(herdr.create_workspace(&label, request.cwd)?.1, true)
}

pub struct AttachRequest<'a> {
    pub task_id: &'a str,
    /// The task session id; it binds the display pane to this session.
    pub binding_id: &'a str,
    pub directory: &'a str,
    /// "Coordinator", "Worker", or an Advisor label.
    pub role: &'a str,
    pub model: &'a str,
    pub provider: &'a str,
    pub native_session_id: &'a str,
    pub generation: &'a str,
    pub pane_id: Option<&'a str>,
    pub root_pane_id: Option<&'a str>,
    pub shell_pane_id: Option<&'a str>,
    pub command: &'a str,
    pub is_attached: &'a dyn Fn(&[String]) -> bool,
}

/// Reuses a pane that already shows this native session, or opens a display
/// row and starts `command` in it. Returns the display pane id.
pub fn attach_task_display(
    herdr: &Herdr,
    request: &AttachRequest<'_>,
    persist_pane: Persist<'_>,
    persist_shell_pane: Persist<'_>,
) -> DisplayResult<String> {
    let title = format!("{} {}", request.task_id, request.role);
    let tokens = || {
        [
            ("suplex_binding_id", request.binding_id),
            ("suplex_task_id", request.task_id),
            ("suplex_native_session_id", request.native_session_id),
            ("suplex_server_generation", request.generation),
            ("suplex_task", request.task_id),
            ("suplex_role", request.role),
            ("suplex_model", request.model),
            ("suplex_provider", request.provider),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect::<Vec<_>>()
    };
    let mut pane = match request.pane_id {
        Some(pane_id) => herdr.get_pane(pane_id)?,
        None => None,
    };
    if let Some(current) = &pane {
        let info = herdr.get_pane_process_info(&current.pane_id)?;
        if info.foreground_processes.iter().any(|process| {
            process
                .argv
                .as_deref()
                .is_some_and(|argv| (request.is_attached)(argv))
        }) {
            persist_pane(&current.pane_id)?;
            publish(herdr, current, &title, tokens(), false);
            return Ok(current.pane_id.clone());
        }
        let owned = match current.token("suplex_binding_id") {
            Some(binding) => binding == request.binding_id,
            None => current.cwd.as_deref() == Some(request.directory),
        };
        if owned && info.foreground_processes.is_empty() {
            return Err(display_failure("The task display process could not be inspected").into());
        }
        if !owned || !is_interactive_shell(&info) {
            pane = None;
        }
    }
    let pane = match pane {
        Some(pane) => pane,
        None => match request
            .root_pane_id
            .map(|id| herdr.get_pane(id))
            .transpose()?
            .flatten()
        {
            Some(anchor) => split_balanced_pane_row(herdr, &anchor.pane_id, request.directory)?,
            None => {
                // The workspace root pane is the task Shell; the session pane opens below it.
                let exclude = [
                    request.pane_id.map(str::to_owned),
                    request.root_pane_id.map(str::to_owned),
                ];
                let shell = ensure_task_shell_pane(
                    herdr,
                    &ShellPaneRequest {
                        task_id: request.task_id,
                        cwd: request.directory,
                        pane_id: request.shell_pane_id,
                        exclude_pane_ids: &exclude,
                        create: true,
                    },
                    persist_shell_pane,
                )
                .ok()
                .flatten();
                match shell {
                    Some(shell) => {
                        split_balanced_pane_row(herdr, &shell.pane_id, request.directory)?
                    }
                    None => {
                        herdr
                            .create_workspace(
                                &format!("suplex-{}", request.task_id),
                                request.directory,
                            )?
                            .1
                    }
                }
            }
        },
    };
    persist_pane(&pane.pane_id)?;
    publish(herdr, &pane, &title, tokens(), true);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if is_interactive_shell(&herdr.get_pane_process_info(&pane.pane_id)?) {
            break;
        }
        if Instant::now() >= deadline {
            return Err(display_failure("The task display is not at an interactive shell").into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    herdr.run_pane_command(&pane.pane_id, request.command)?;
    Ok(pane.pane_id)
}

/// One native session's display, bound in the task database.
pub struct SessionDisplay<'a> {
    pub database_path: &'a Path,
    pub session_id: &'a str,
    pub native_session_id: &'a str,
    pub worktree: &'a Path,
    pub model: &'a str,
    pub provider: &'a str,
    /// Shell command that runs the passive display in the pane.
    pub command: &'a str,
    pub is_attached: &'a dyn Fn(&[String]) -> bool,
}

/// Opens or refreshes the Herdr display for one task session and records the
/// pane bindings. Callers ignore its failure and continue native work.
pub fn attach_session(herdr: &Herdr, display: &SessionDisplay<'_>) -> DisplayResult<String> {
    let database = SuplexDatabase::open(display.database_path, OpenMode::ReadWrite)?;
    let (task_id, kind, generation, pane_id) = database.connection().query_row(
        "SELECT task_id, kind, generation, pane_id FROM suplex_task_sessions WHERE id = ?1",
        [display.session_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        },
    )?;
    let shell_pane_id = database
        .connection()
        .query_row(
            "SELECT shell_pane_id FROM suplex_task_controls WHERE task_id = ?1",
            [&task_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let root_pane_id = if kind == "worker" {
        database
            .connection()
            .query_row(
                "SELECT pane_id FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1",
                [&task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
    } else {
        None
    };
    let now = || Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let directory = display.worktree.to_string_lossy();
    attach_task_display(
        herdr,
        &AttachRequest {
            task_id: &task_id,
            binding_id: display.session_id,
            directory: &directory,
            role: if kind == "root" {
                "Coordinator"
            } else {
                "Worker"
            },
            model: display.model,
            provider: display.provider,
            native_session_id: display.native_session_id,
            generation: display.native_session_id,
            pane_id: pane_id.as_deref(),
            root_pane_id: root_pane_id.as_deref(),
            shell_pane_id: shell_pane_id.as_deref(),
            command: display.command,
            is_attached: display.is_attached,
        },
        &mut |pane| {
            let changed = database.connection().execute(
                "UPDATE suplex_task_sessions SET pane_id = ?1, updated_at = ?2 WHERE id = ?3 AND generation = ?4 AND is_current = 1 AND lifecycle <> 'cancelled'",
                params![pane, now(), display.session_id, generation],
            )?;
            if changed == 1 {
                Ok(())
            } else {
                Err("stale_generation".into())
            }
        },
        &mut |pane| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET shell_pane_id = ?1, updated_at = ?2 WHERE task_id = ?3",
                params![pane, now(), task_id],
            )?;
            Ok(())
        },
    )
}

/// Shows a harness session in Herdr before dispatch. The display is an
/// observation; its failure never blocks native work.
pub fn show_scope(
    scope: &crate::runtimes::task_harness::TaskScope<'_>,
    provider: &str,
    command: &str,
    is_attached: &dyn Fn(&[String]) -> bool,
) {
    let _ = attach_session(
        &Herdr::default(),
        &SessionDisplay {
            database_path: scope.database_path,
            session_id: scope.session_id,
            native_session_id: scope.native_session_id,
            worktree: scope.worktree,
            model: scope.model,
            provider,
            command,
            is_attached,
        },
    );
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    };

    use serde_json::{Value, json};

    use super::*;
    use crate::integrations::herdr::fake;

    /// Scripted Herdr state shared by display and pane-route tests.
    #[derive(Default)]
    pub(crate) struct FakeHerdr {
        pub panes: BTreeMap<String, Pane>,
        pub info: BTreeMap<String, Value>,
        pub workspaces: Vec<(String, String)>,
        pub list_fails: bool,
        pub fail_metadata: bool,
        pub fail_rename: bool,
        pub create_fails: bool,
        pub missing_default: bool,
    }

    pub(crate) fn shell_info(id: &str) -> Value {
        json!({"pane_id":id,"shell_pid":10,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"zsh","argv":["/bin/zsh"]}]})
    }

    pub(crate) fn scripted(state: Arc<Mutex<FakeHerdr>>) -> (Herdr, Arc<Mutex<Vec<Vec<String>>>>) {
        fake::herdr(move |args| {
            let mut state = state.lock().unwrap();
            let unavailable = || fake::failed(json!({"error":{"code":"unavailable"}}));
            let missing = || fake::failed(json!({"error":{"code":"pane_not_found"}}));
            match (args[0].as_str(), args[1].as_str()) {
                ("pane", "get") => match state.panes.get(&args[2]) {
                    Some(pane) => fake::envelope(json!({"pane": fake::pane_value(pane)})),
                    None if state.missing_default || args[2] == "pane-gone" => missing(),
                    None => fake::envelope(json!({"pane":{"pane_id":args[2],"cwd":"/repo"}})),
                },
                ("pane", "process-info") => fake::envelope(json!({"process_info": state
                    .info
                    .get(&args[3])
                    .cloned()
                    .unwrap_or_else(|| shell_info(&args[3]))})),
                ("workspace", "create") if state.create_fails => unavailable(),
                ("workspace", "create") => {
                    let pane = Pane {
                        pane_id: "pane-new".into(),
                        workspace_id: Some("workspace".into()),
                        cwd: Some(args[5].clone()),
                        ..Pane::default()
                    };
                    state.panes.insert(pane.pane_id.clone(), pane);
                    fake::envelope(
                        json!({"workspace":{"workspace_id":"workspace","label":args[3]},
                        "tab":{"tab_id":"tab"},"root_pane":{"pane_id":"pane-new","cwd":args[5]}}),
                    )
                }
                ("pane", "split") => {
                    fake::envelope(json!({"pane":{"pane_id":"pane-split","cwd":"/repo"}}))
                }
                ("pane", "layout") => unavailable(),
                ("pane", "rename") if state.fail_rename => unavailable(),
                ("pane", "report-metadata") if state.fail_metadata => unavailable(),
                ("pane", "rename" | "report-metadata" | "run" | "close") => {
                    fake::envelope(json!({}))
                }
                ("workspace", "list") if state.list_fails => unavailable(),
                ("workspace", "list") => fake::envelope(json!({"workspaces": state
                    .workspaces
                    .iter()
                    .map(|(id, label)| json!({"workspace_id": id, "label": label}))
                    .collect::<Vec<_>>()})),
                ("pane", "list") if state.list_fails => unavailable(),
                ("pane", "list") => fake::envelope(json!({"panes": state
                    .panes
                    .values()
                    .filter(|pane| pane.workspace_id.as_deref() == Some(args[3].as_str()))
                    .map(fake::pane_value)
                    .collect::<Vec<_>>()})),
                _ => panic!("unexpected Herdr call {args:?}"),
            }
        })
    }

    fn count(calls: &Mutex<Vec<Vec<String>>>, verb: &str) -> usize {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|args| args[1] == verb)
            .count()
    }

    fn call(calls: &Mutex<Vec<Vec<String>>>, verb: &str) -> Option<Vec<String>> {
        calls
            .lock()
            .unwrap()
            .iter()
            .find(|args| args[1] == verb)
            .cloned()
    }

    const ARGV: [&str; 3] = ["native", "attach", "worker-session"];

    fn attached(argv: &[String]) -> bool {
        argv == ARGV
    }

    fn detached(_: &[String]) -> bool {
        false
    }

    fn request<'a>(
        pane_id: Option<&'a str>,
        is_attached: &'a dyn Fn(&[String]) -> bool,
    ) -> AttachRequest<'a> {
        AttachRequest {
            task_id: "task-123",
            binding_id: "worker-session",
            directory: "/repo",
            role: "Worker",
            model: "openai/gpt-5.6-sol",
            provider: "opencode",
            native_session_id: "native-session",
            generation: "generation",
            pane_id,
            root_pane_id: None,
            shell_pane_id: None,
            command: "native attach",
            is_attached,
        }
    }

    fn native_state() -> FakeHerdr {
        let mut state = FakeHerdr::default();
        state.info.insert(
            "pane".into(),
            json!({"pane_id":"pane","shell_pid":10,"foreground_process_group_id":11,"foreground_processes":[{"pid":11,"name":"native","argv":ARGV}]}),
        );
        state
    }

    fn desired_pane() -> Pane {
        let mut pane = Pane {
            pane_id: "pane".into(),
            cwd: Some("/repo".into()),
            label: Some("task-123 Worker".into()),
            title: Some("task-123 Worker".into()),
            ..Pane::default()
        };
        for (key, value) in [
            ("suplex_binding_id", "worker-session"),
            ("suplex_task_id", "task-123"),
            ("suplex_native_session_id", "native-session"),
            ("suplex_server_generation", "generation"),
            ("suplex_task", "task-123"),
            ("suplex_role", "Worker"),
            ("suplex_model", "openai/gpt-5.6-sol"),
            ("suplex_provider", "opencode"),
            ("foreign_token", "kept"),
        ] {
            pane.tokens.insert(key.into(), value.into());
        }
        pane
    }

    #[test]
    fn refreshes_lost_metadata_on_a_matching_display() {
        let state = Arc::new(Mutex::new(native_state()));
        let (herdr, calls) = scripted(state);
        let mut persisted = Vec::new();
        let pane = attach_task_display(
            &herdr,
            &request(Some("pane"), &attached),
            &mut |id| {
                persisted.push(id.to_owned());
                Ok(())
            },
            &mut |_| Ok(()),
        )
        .unwrap();
        assert_eq!(
            (pane.as_str(), persisted),
            ("pane", vec!["pane".to_owned()])
        );
        assert_eq!(
            call(&calls, "rename").unwrap(),
            ["pane", "rename", "pane", "task-123 Worker"]
        );
        assert_eq!(
            call(&calls, "report-metadata").unwrap(),
            [
                "pane",
                "report-metadata",
                "pane",
                "--source",
                "suplex",
                "--title",
                "task-123 Worker",
                "--token",
                "suplex_binding_id=worker-session",
                "--token",
                "suplex_task_id=task-123",
                "--token",
                "suplex_native_session_id=native-session",
                "--token",
                "suplex_server_generation=generation",
                "--token",
                "suplex_task=task-123",
                "--token",
                "suplex_role=Worker",
                "--token",
                "suplex_model=openai/gpt-5.6-sol",
                "--token",
                "suplex_provider=opencode"
            ]
        );
        assert_eq!(count(&calls, "run"), 0);
    }

    #[test]
    fn an_unchanged_attachment_needs_no_writes_and_stale_fields_are_repaired_without_replay() {
        type Change = fn(&mut Pane);
        let cases: [(Option<Change>, usize, usize); 6] = [
            (None, 0, 0),
            (
                Some(|pane| {
                    pane.title = None;
                    pane.tokens.clear();
                }),
                0,
                1,
            ),
            (
                Some(|pane| {
                    pane.tokens
                        .insert("suplex_native_session_id".into(), "old".into());
                }),
                0,
                1,
            ),
            (
                Some(|pane| {
                    pane.tokens
                        .insert("suplex_server_generation".into(), "old".into());
                }),
                0,
                1,
            ),
            (Some(|pane| pane.title = Some("old title".into())), 0, 1),
            (Some(|pane| pane.label = Some("old label".into())), 1, 0),
        ];
        for (change, renames, reports) in cases {
            let mut state = native_state();
            let mut pane = desired_pane();
            if let Some(change) = change {
                change(&mut pane);
            }
            state.panes.insert("pane".into(), pane);
            let (herdr, calls) = scripted(Arc::new(Mutex::new(state)));
            for _ in 0..2 {
                attach_task_display(
                    &herdr,
                    &request(Some("pane"), &attached),
                    &mut |_| Ok(()),
                    &mut |_| Ok(()),
                )
                .unwrap();
            }
            assert_eq!(count(&calls, "rename"), renames * 2);
            assert_eq!(count(&calls, "report-metadata"), reports * 2);
            assert_eq!(count(&calls, "run"), 0);
        }
    }

    #[test]
    fn display_write_failures_do_not_gate_native_attachment() {
        let mut state = native_state();
        state.fail_metadata = true;
        state.fail_rename = true;
        let (herdr, calls) = scripted(Arc::new(Mutex::new(state)));
        assert_eq!(
            attach_task_display(
                &herdr,
                &request(Some("pane"), &attached),
                &mut |_| Ok(()),
                &mut |_| Ok(())
            )
            .unwrap(),
            "pane"
        );
        let mut persisted = Vec::new();
        assert_eq!(
            attach_task_display(
                &herdr,
                &request(None, &detached),
                &mut |id| {
                    persisted.push(id.to_owned());
                    Ok(())
                },
                &mut |_| Ok(())
            )
            .unwrap(),
            "pane-split"
        );
        assert_eq!(persisted, ["pane-split"]);
        assert_eq!(
            call(&calls, "run").unwrap(),
            ["pane", "run", "pane-split", "native attach"]
        );
    }

    #[test]
    fn metadata_does_not_make_a_different_native_attachment_reusable() {
        let (herdr, calls) = scripted(Arc::new(Mutex::new(native_state())));
        attach_task_display(
            &herdr,
            &request(Some("pane"), &detached),
            &mut |_| Ok(()),
            &mut |_| Ok(()),
        )
        .unwrap();
        assert!(calls.lock().unwrap().iter().all(|args| args[1] == "get"
            || args[1] == "process-info"
            || args.get(2).map(String::as_str) != Some("pane")));
        assert_eq!(
            call(&calls, "run").unwrap(),
            ["pane", "run", "pane-split", "native attach"]
        );
    }

    #[test]
    fn an_unchanged_shell_display_needs_no_writes_but_lost_metadata_is_restored() {
        let mut pane = Pane {
            pane_id: "pane-shell".into(),
            cwd: Some("/repo".into()),
            label: Some("Shell".into()),
            title: Some("Shell".into()),
            ..Pane::default()
        };
        for (key, value) in shell_tokens("task-123") {
            pane.tokens.insert(key, value);
        }
        pane.tokens.insert("foreign_token".into(), "kept".into());
        let state = Arc::new(Mutex::new(FakeHerdr::default()));
        state
            .lock()
            .unwrap()
            .panes
            .insert("pane-shell".into(), pane);
        let (herdr, calls) = scripted(state.clone());
        let request = ShellPaneRequest {
            task_id: "task-123",
            cwd: "/repo",
            pane_id: Some("pane-shell"),
            exclude_pane_ids: &[],
            create: true,
        };
        ensure_task_shell_pane(&herdr, &request, &mut |_| Ok(())).unwrap();
        assert_eq!(
            (count(&calls, "rename"), count(&calls, "report-metadata")),
            (0, 0)
        );
        state
            .lock()
            .unwrap()
            .panes
            .get_mut("pane-shell")
            .unwrap()
            .tokens
            .clear();
        ensure_task_shell_pane(&herdr, &request, &mut |_| Ok(())).unwrap();
        assert_eq!(
            (count(&calls, "rename"), count(&calls, "report-metadata")),
            (0, 1)
        );
    }

    #[test]
    fn a_fresh_attachment_establishes_the_shell_pane_before_the_session_pane() {
        let (herdr, calls) = scripted(Arc::new(Mutex::new(native_state())));
        let mut shell = Vec::new();
        assert_eq!(
            attach_task_display(
                &herdr,
                &request(None, &detached),
                &mut |_| Ok(()),
                &mut |id| {
                    shell.push(id.to_owned());
                    Ok(())
                }
            )
            .unwrap(),
            "pane-split"
        );
        assert_eq!(shell, ["pane-new"]);
        let calls = calls.lock().unwrap();
        assert!(
            calls.contains(
                &[
                    "workspace",
                    "create",
                    "--label",
                    "suplex-task-123",
                    "--cwd",
                    "/repo",
                    "--no-focus"
                ]
                .map(String::from)
                .to_vec()
            )
        );
        assert!(
            calls.contains(
                &["pane", "rename", "pane-new", "Shell"]
                    .map(String::from)
                    .to_vec()
            )
        );
        assert!(calls.iter().any(|args| args[1] == "report-metadata"
            && args[2] == "pane-new"
            && args.contains(&"suplex_role=shell".to_owned())
            && args.contains(&"suplex_binding_id=task-123:shell".to_owned())));
        assert!(
            calls
                .iter()
                .any(|args| args[1] == "split" && args[2] == "pane-new" && args[4] == "down")
        );
        assert!(
            !calls
                .iter()
                .any(|args| args[1] == "run" && args[2] == "pane-new")
        );
    }

    #[test]
    fn a_stale_shell_binding_is_rediscovered_from_the_task_workspace() {
        let mut state = native_state();
        state
            .workspaces
            .push(("workspace".into(), "suplex-task-123".into()));
        let mut shell = Pane {
            pane_id: "pane-shell".into(),
            workspace_id: Some("workspace".into()),
            cwd: Some("/repo".into()),
            ..Pane::default()
        };
        for (key, value) in shell_tokens("task-123") {
            shell.tokens.insert(key, value);
        }
        state.panes.insert("pane-shell".into(), shell);
        let (herdr, calls) = scripted(Arc::new(Mutex::new(state)));
        let mut persisted = Vec::new();
        let mut input = request(None, &detached);
        input.shell_pane_id = Some("pane-gone");
        assert_eq!(
            attach_task_display(&herdr, &input, &mut |_| Ok(()), &mut |id| {
                persisted.push(id.to_owned());
                Ok(())
            })
            .unwrap(),
            "pane-split"
        );
        assert_eq!(persisted, ["pane-shell"]);
        assert_eq!(count(&calls, "create"), 0);
        assert_eq!(call(&calls, "split").unwrap()[2], "pane-shell");
    }

    #[test]
    fn a_missing_shell_pane_never_blocks_a_session_attachment() {
        let mut state = native_state();
        state.list_fails = true;
        let (herdr, calls) = scripted(Arc::new(Mutex::new(state)));
        let mut input = request(None, &detached);
        input.shell_pane_id = Some("pane-gone");
        assert_eq!(
            attach_task_display(&herdr, &input, &mut |_| Ok(()), &mut |_| Ok(())).unwrap(),
            "pane-new"
        );
        assert_eq!(
            call(&calls, "run").unwrap(),
            ["pane", "run", "pane-new", "native attach"]
        );
    }
}
