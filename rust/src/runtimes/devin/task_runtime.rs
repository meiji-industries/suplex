use crate::shared::fs::read_optional;
use std::{
    collections::HashMap,
    error::Error,
    fs,
    io::{self},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};

use super::{advisor_evidence, mcp_config, transcript};
use crate::{
    coordination::{
        advisor_bridge::{self, AdvisorRole},
        bridge_auth::{
            ADVISOR_BINDING_ENV, ADVISOR_RESULT_ENV, ADVISOR_TOKEN_ENV, ROOT_BINDING_ENV,
            ROOT_TOKEN_ENV,
        },
        root_bridge::{self, RootIdentity},
    },
    profiles::agent_profiles::home_directory,
    runtimes::{
        codex::{
            runtime::{DispatchState, PromptObservation, PromptState},
            session_reader,
            tool_evidence::NativeTool,
        },
        headless::{self, DispatchInput, HeadlessTurnRecord},
        process::{IdentityMatch, compare_identity, inspect_process},
        task_harness::{self, ExecutableSpec, GH_EXECUTABLE, resolve_executable},
    },
};

pub enum DevinRole<'a> {
    Root {
        identity: &'a RootIdentity,
        artifact_root: &'a Path,
    },
    Worker,
    Advisor(AdvisorRole),
}

pub struct DevinScope<'a> {
    pub database_path: &'a Path,
    /// The Suplex task session id; it names the private runtime directory.
    pub session_id: &'a str,
    pub worktree: &'a Path,
    pub role: DevinRole<'a>,
    pub model: &'a str,
    pub executable: Option<&'a Path>,
    pub project_environment: &'a HashMap<String, String>,
    pub excluded_environment_keys: &'a [String],
    pub inherited_environment: &'a HashMap<String, String>,
}

impl DevinScope<'_> {
    pub fn runtime_directory(&self) -> io::Result<PathBuf> {
        session_reader::session_directory(self.database_path, self.session_id)
    }
}

pub const DEVIN_EXECUTABLE: ExecutableSpec = ExecutableSpec {
    label: "Devin CLI",
    binary: "devin",
    env_var: "SUPLEX_DEVIN_COMMAND",
    home_paths: &[".local/bin/devin", ".devin/bin/devin"],
    fallback_paths: &[],
};

fn process_environment() -> HashMap<String, String> {
    std::env::vars().collect()
}

pub fn resolve_devin_executable(configured: Option<&Path>) -> io::Result<PathBuf> {
    resolve_executable(
        &DEVIN_EXECUTABLE,
        configured,
        &process_environment(),
        home_directory().as_deref(),
    )
}

/// The GitHub CLI is optional for task bridges; an unresolved CLI is omitted.
fn resolved_gh_command() -> Option<String> {
    resolve_executable(
        &GH_EXECUTABLE,
        None,
        &process_environment(),
        home_directory().as_deref(),
    )
    .ok()
    .map(|path| path.to_string_lossy().into_owned())
}

fn suplex_executable() -> io::Result<String> {
    Ok(std::env::current_exe()?.to_string_lossy().into_owned())
}

pub fn read_session_id(runtime_directory: &Path) -> io::Result<Option<String>> {
    let text = match fs::read_to_string(runtime_directory.join("session.json")) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let value: Value = serde_json::from_str(&text).map_err(io::Error::other)?;
    Ok(value
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned))
}

// A missing or malformed export yields None so observe() reports the turn
// rather than failing on every poll; the next turn writes a fresh export.
fn read_export_session_id(path: &Path) -> io::Result<Option<String>> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(None);
    };
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
        .and_then(|value| {
            value
                .get("session_id")?
                .as_str()
                .map(str::trim)
                .map(str::to_owned)
        })
        .filter(|id| !id.is_empty()))
}

fn persist_session_id(runtime_directory: &Path, session_id: &str) -> io::Result<()> {
    crate::shared::fs::write_private(
        &runtime_directory.join("session.json"),
        json!({ "sessionId": session_id }).to_string().as_bytes(),
    )
}

fn recover_session_id(runtime_directory: &Path) -> io::Result<Option<String>> {
    if let Some(stored) = read_session_id(runtime_directory)? {
        return Ok(Some(stored));
    }
    let turn = headless::read_record(&runtime_directory.join("turn.json"))?;
    let candidates = turn
        .map(|turn| runtime_directory.join(format!("turn-{}.export.json", turn.turn_id)))
        .into_iter()
        .chain([runtime_directory.join("warmup.export.json")]);
    for path in candidates {
        if let Some(session_id) = read_export_session_id(&path)? {
            persist_session_id(runtime_directory, &session_id)?;
            return Ok(Some(session_id));
        }
    }
    Ok(None)
}

pub(super) fn turn_running(record: &HeadlessTurnRecord) -> bool {
    compare_identity(
        &record.owned_identity(),
        inspect_process(record.pid).as_ref(),
    ) == IdentityMatch::Exact
}

pub fn session_busy(runtime_directory: &Path) -> io::Result<bool> {
    session_reader::busy(runtime_directory)
}

/// Arguments are restricted to the documented Devin CLI flags.
pub fn arguments(
    model: &str,
    resume_session_id: Option<&str>,
    prompt_file: &Path,
    export_file: &Path,
) -> Vec<String> {
    let mut args = vec!["--print".to_owned()];
    if let Some(resume) = resume_session_id {
        args.extend(["--resume".to_owned(), resume.to_owned()]);
    }
    args.extend([
        "--prompt-file".to_owned(),
        prompt_file.to_string_lossy().into_owned(),
        "--export".to_owned(),
        export_file.to_string_lossy().into_owned(),
        "--model".to_owned(),
        model.to_owned(),
        "--permission-mode".to_owned(),
        "dangerous".to_owned(),
        "--respect-workspace-trust".to_owned(),
        "false".to_owned(),
    ]);
    args
}

/// Writes the current bridge binding and returns the environment that serves it.
fn bridge(
    scope: &DevinScope<'_>,
    runtime_directory: &Path,
) -> io::Result<Option<HashMap<String, String>>> {
    let suplex = suplex_executable()?;
    let (binding_env, token_env, binding_path, token) = match scope.role {
        DevinRole::Worker => return Ok(None),
        DevinRole::Root {
            identity,
            artifact_root,
        } => {
            let binding = root_bridge::write_binding(
                runtime_directory,
                identity,
                scope.database_path,
                artifact_root,
                &suplex,
            )?;
            (
                ROOT_BINDING_ENV,
                ROOT_TOKEN_ENV,
                binding.binding_path,
                binding.token,
            )
        }
        DevinRole::Advisor(role) => {
            let binding = advisor_bridge::write_binding(runtime_directory, role, &suplex)?;
            (
                ADVISOR_BINDING_ENV,
                ADVISOR_TOKEN_ENV,
                binding.binding_path,
                binding.token,
            )
        }
    };
    let mut environment = HashMap::from([
        (
            binding_env.to_owned(),
            binding_path.to_string_lossy().into_owned(),
        ),
        (token_env.to_owned(), token),
    ]);
    if let Some(gh) = resolved_gh_command() {
        environment.insert("SUPLEX_GH_COMMAND".into(), gh);
    }
    Ok(Some(environment))
}

fn prepare(
    scope: &DevinScope<'_>,
    runtime_directory: &Path,
) -> io::Result<Option<HashMap<String, String>>> {
    let bridge = bridge(scope, runtime_directory)?;
    if bridge.is_some() {
        mcp_config::ensure(
            scope.worktree,
            &suplex_executable()?,
            resolved_gh_command().as_deref(),
        )?;
    }
    Ok(bridge)
}

pub fn ensure_session(
    scope: &DevinScope<'_>,
    native_session_id: Option<&str>,
) -> io::Result<String> {
    let directory = scope.runtime_directory()?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)?;
    resolve_devin_executable(scope.executable)?;
    prepare(scope, &directory)?;
    recover_session_id(&directory)?;
    Ok(native_session_id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("devin-{}", uuid::Uuid::new_v4())))
}

fn observation(
    state: PromptState,
    admission_observed: bool,
    retry_allowed: bool,
    reason: &'static str,
) -> PromptObservation {
    PromptObservation {
        state,
        admission_observed,
        retry_allowed,
        reason,
        unsettled_tool_ids: Vec::new(),
        native_final_observed: state == PromptState::Completed,
        process_running: state == PromptState::Running,
        // TypeScript marks only an output log without its dispatch record as uncertain.
        execution_uncertain: reason == "dispatch_identity_missing",
    }
}

pub fn observe(
    runtime_directory: &Path,
    native_session_id: &str,
    turn_id: &str,
    dispatch: DispatchState,
    generation: Option<&str>,
) -> io::Result<PromptObservation> {
    let fenced = generation
        .map(|generation| {
            headless::read_record(&runtime_directory.join(format!("dispatch-{generation}.json")))
        })
        .transpose()?
        .flatten();
    let record = match fenced {
        Some(record) => Some(record),
        None => headless::read_record(&runtime_directory.join("turn.json"))?,
    }
    .filter(|record| record.turn_id == turn_id);
    let log_path = headless::turn_file(runtime_directory, turn_id, "jsonl");
    let Some(record) = record else {
        let log = read_optional(&log_path)?;
        let replayable = matches!(
            dispatch,
            DispatchState::NotSubmitted | DispatchState::Rejected
        );
        return Ok(match (&log, replayable) {
            (None, true) => observation(PromptState::Unknown, false, true, "message_not_observed"),
            (None, false) => observation(PromptState::Unknown, false, false, "admission_ambiguous"),
            (Some(_), _) => observation(
                PromptState::Unknown,
                false,
                false,
                "dispatch_identity_missing",
            ),
        });
    };
    if record.session_id != native_session_id {
        return Ok(observation(
            PromptState::Unknown,
            false,
            false,
            "session_identity_conflict",
        ));
    }
    if turn_running(&record) {
        return Ok(observation(
            PromptState::Running,
            true,
            false,
            "dispatch_process_running",
        ));
    }
    let Some(exit) = read_optional(&headless::turn_file(runtime_directory, turn_id, "exit"))?
    else {
        return Ok(observation(
            PromptState::Interrupted,
            true,
            false,
            "dispatch_process_stopped",
        ));
    };
    // Read output only after the process is known to have stopped, so a turn
    // that finishes between the two checks is not mistaken for a startup failure.
    let log = read_optional(&log_path)?;
    if log.as_deref().is_none_or(|log| log.trim().is_empty()) {
        return Ok(observation(
            PromptState::Error,
            true,
            false,
            "native_startup_failed",
        ));
    }
    if exit.trim() != "0" {
        return Ok(observation(PromptState::Error, true, false, "native_error"));
    }
    if read_session_id(runtime_directory)?.is_none()
        && let Some(session_id) =
            read_export_session_id(&runtime_directory.join(format!("turn-{turn_id}.export.json")))?
    {
        persist_session_id(runtime_directory, &session_id)?;
    }
    Ok(observation(
        PromptState::Completed,
        true,
        false,
        "native_turn_completed",
    ))
}

/// Dispatches one Devin turn after the prompt is proven absent. The durable
/// claim runs inside the headless dispatch before the process starts.
pub fn dispatch<F>(
    scope: &DevinScope<'_>,
    native_session_id: &str,
    turn_id: &str,
    role_prompt: &str,
    prompt: &str,
    claim: F,
) -> Result<PromptObservation, Box<dyn Error>>
where
    F: FnOnce(&str) -> Result<bool, Box<dyn Error>>,
{
    let directory = scope.runtime_directory()?;
    let before = observe(
        &directory,
        native_session_id,
        turn_id,
        DispatchState::NotSubmitted,
        None,
    )?;
    if !before.retry_allowed {
        return Err(
            io::Error::other("Devin prompt was not proven absent; replay is blocked").into(),
        );
    }
    let executable = resolve_devin_executable(scope.executable)?;
    let bridge = prepare(scope, &directory)?;
    let prompt_file = headless::turn_file(&directory, turn_id, "prompt");
    let export_file = directory.join(format!("turn-{turn_id}.export.json"));
    let resume = recover_session_id(&directory)?;
    let mut additions = HashMap::new();
    if matches!(scope.role, DevinRole::Advisor(_)) {
        additions.insert(
            ADVISOR_RESULT_ENV.to_owned(),
            advisor_bridge::advisor_result_path(&directory, turn_id)?
                .to_string_lossy()
                .into_owned(),
        );
    }
    let environment = task_harness::task_bridge_environment(
        scope.inherited_environment,
        bridge.as_ref(),
        &additions,
    );
    let environment = task_harness::task_scope_environment(
        environment,
        scope.worktree,
        scope.project_environment,
    );
    let args = arguments(scope.model, resume.as_deref(), &prompt_file, &export_file);
    let record = headless::dispatch_with_exclusions(
        DispatchInput {
            directory: &directory,
            worktree: scope.worktree,
            session_id: native_session_id,
            turn_id,
            executable: &executable,
            args: &args,
            prompt: &format!("{role_prompt}\n\n{prompt}"),
            environment: &environment,
        },
        scope.excluded_environment_keys,
        claim,
    )?;
    Ok(observe(
        &directory,
        native_session_id,
        turn_id,
        DispatchState::Ambiguous,
        Some(&record.generation),
    )?)
}

/// Stops a stale fenced dispatch, then reports whether the prompt may be replayed.
pub fn recover_dispatch(
    runtime_directory: &Path,
    native_session_id: &str,
    turn_id: &str,
    generation: &str,
) -> io::Result<PromptObservation> {
    task_harness::recover_headless_dispatch(runtime_directory, generation)?;
    observe(
        runtime_directory,
        native_session_id,
        turn_id,
        DispatchState::NotSubmitted,
        Some(generation),
    )
}

pub fn stop(runtime_directory: &Path, native_session_id: Option<&str>) -> io::Result<()> {
    headless::stop_session(runtime_directory, native_session_id)
}

pub fn result_text(runtime_directory: &Path, turn_id: &str) -> io::Result<String> {
    let log = read_optional(&headless::turn_file(runtime_directory, turn_id, "jsonl"))?;
    let text = transcript::result_text(log.as_deref().unwrap_or_default());
    if !text.is_empty() {
        return Ok(text.to_owned());
    }
    let stderr = read_optional(&headless::turn_file(
        runtime_directory,
        turn_id,
        "stderr.log",
    ))?
    .unwrap_or_default();
    let stderr = stderr.trim();
    let start = stderr
        .char_indices()
        .rev()
        .nth(1_999)
        .map_or(0, |(index, _)| index);
    Ok(stderr[start..].to_owned())
}

pub fn turn_evidence(
    runtime_directory: &Path,
    turn_id: &str,
) -> io::Result<(Vec<NativeTool>, &'static str)> {
    let evidence = advisor_evidence::read(runtime_directory, turn_id)?;
    Ok((evidence.tools, evidence.limitation))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::coordination::bridge_auth;
    use std::{thread, time::Duration};

    pub(in crate::runtimes::devin) const SESSION: &str =
        "devin-71618050-0d31-428e-a547-d6c4a2eca88f";

    pub(in crate::runtimes::devin) struct Fixture {
        pub root: PathBuf,
        pub worktree: PathBuf,
        pub database: PathBuf,
        pub executable: PathBuf,
        pub inherited: HashMap<String, String>,
        pub project: HashMap<String, String>,
    }

    impl Fixture {
        pub fn new(behaviour: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("suplex-devin-runtime-{}", uuid::Uuid::new_v4()));
            let worktree = root.join("worktree");
            fs::create_dir_all(&worktree).unwrap();
            let script = match behaviour {
                "complete" => "echo 'Reviewed the change.'",
                "hang" => "echo 'Working'\nsleep 30",
                "silent_hang" => "sleep 30",
                "crash" => "echo 'Working'\nexit 1",
                "startup_failure" => "echo 'Error: Not logged in' >&2\nexit 1",
                other => panic!("unknown behaviour {other}"),
            };
            let executable = root.join("devin");
            Self::write_executable(
                &executable,
                &format!(
                    "#!/bin/sh\nprintf '%s\\n' '--TURN--' \"$@\" >> \"$SUPLEX_TEST_ARGS\"\nprintf '%s\\n' \"$MISE_TRUSTED_CONFIG_PATHS\" > \"$SUPLEX_TEST_MISE\"\nprintf '%s|%s|%s|%s|%s\\n' \"$SUPLEX_ROOT_BINDING\" \"$SUPLEX_ROOT_TOKEN\" \"$SUPLEX_ADVISOR_BINDING\" \"$SUPLEX_ADVISOR_TOKEN\" \"$SUPLEX_ADVISOR_RESULT\" >> \"$SUPLEX_TEST_BRIDGE_ENV\"\n{script}\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --export ]; then shift; printf '%s\\n' '{{\"schema_version\":\"ATIF-v1.7\",\"session_id\":\"assigned-session\"}}' > \"$1\"; fi\n  shift\ndone\n"
                ),
            );
            let path = |name: &str| root.join(name).display().to_string();
            let inherited = HashMap::from([
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("SUPLEX_TEST_ARGS".to_owned(), path("args.txt")),
                ("SUPLEX_TEST_MISE".to_owned(), path("mise.txt")),
                ("SUPLEX_TEST_BRIDGE_ENV".to_owned(), path("bridge-env.txt")),
                (ROOT_BINDING_ENV.to_owned(), "/contaminated/root".to_owned()),
                (
                    ROOT_TOKEN_ENV.to_owned(),
                    "contaminated-root-token".to_owned(),
                ),
                (
                    ADVISOR_RESULT_ENV.to_owned(),
                    "/contaminated/result".to_owned(),
                ),
            ]);
            Self {
                database: root.join("suplex.sqlite"),
                root,
                worktree,
                executable,
                inherited,
                project: HashMap::new(),
            }
        }

        pub fn write_executable(path: &Path, content: &str) {
            fs::write(path, content).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }

        pub fn scope<'a>(&'a self, id: &'a str, role: DevinRole<'a>) -> DevinScope<'a> {
            DevinScope {
                database_path: &self.database,
                session_id: id,
                worktree: &self.worktree,
                role,
                model: "swe",
                executable: Some(&self.executable),
                project_environment: &self.project,
                excluded_environment_keys: &[],
                inherited_environment: &self.inherited,
            }
        }

        pub fn worker(&self) -> DevinScope<'_> {
            self.scope("session-devin", DevinRole::Worker)
        }

        pub fn directory(&self, id: &str) -> PathBuf {
            session_reader::session_directory(&self.database, id).unwrap()
        }

        pub fn read(&self, name: &str) -> String {
            fs::read_to_string(self.root.join(name)).unwrap_or_default()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    pub(in crate::runtimes::devin) fn eventually(
        directory: &Path,
        native: &str,
        turn: &str,
    ) -> PromptObservation {
        let observe_now =
            || observe(directory, native, turn, DispatchState::Ambiguous, None).unwrap();
        let mut observed = observe_now();
        for _ in 0..50 {
            if observed.state != PromptState::Running {
                break;
            }
            thread::sleep(Duration::from_millis(100));
            observed = observe_now();
        }
        observed
    }

    pub(in crate::runtimes::devin) fn dispatch_turn(
        scope: &DevinScope<'_>,
        native: &str,
        turn: &str,
        prompt: &str,
    ) {
        dispatch(scope, native, turn, "ROLE PROMPT", prompt, |_| Ok(true)).unwrap();
    }

    fn init_repository(path: &Path) -> git2::Repository {
        let repository = git2::Repository::init_opts(
            path,
            git2::RepositoryInitOptions::new().initial_head("main"),
        )
        .unwrap();
        {
            let signature = git2::Signature::now("Suplex test", "suplex@example.invalid").unwrap();
            let tree = repository
                .find_tree(repository.index().unwrap().write_tree().unwrap())
                .unwrap();
            repository
                .commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
                .unwrap();
        }
        repository
    }

    fn keys(value: &Value) -> Vec<&str> {
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn devin_starts_without_resume_persists_its_assigned_id_then_resumes() {
        let f = Fixture::new("complete");
        let scope = f.worker();
        let directory = f.directory("session-devin");
        assert_eq!(ensure_session(&scope, Some(SESSION)).unwrap(), SESSION);
        assert!(!f.worktree.join(".devin").exists());
        assert!(!directory.join("root.binding.json").exists());
        assert!(!directory.join("advisor.binding.json").exists());
        dispatch_turn(&scope, SESSION, "msg_first", "Implement the change");
        assert_eq!(
            eventually(&directory, SESSION, "msg_first").state,
            PromptState::Completed
        );
        assert_eq!(
            read_session_id(&directory).unwrap().as_deref(),
            Some("assigned-session")
        );
        fs::remove_file(directory.join("session.json")).unwrap();
        ensure_session(&scope, Some(SESSION)).unwrap();
        assert_eq!(
            read_session_id(&directory).unwrap().as_deref(),
            Some("assigned-session")
        );
        dispatch_turn(&scope, SESSION, "msg_second", "Check the change");
        assert_eq!(
            eventually(&directory, SESSION, "msg_second").state,
            PromptState::Completed
        );
        let args = f.read("args.txt");
        let turns = args
            .split("--TURN--\n")
            .filter(|turn| !turn.is_empty())
            .map(|turn| turn.trim().lines().collect::<Vec<_>>())
            .collect::<Vec<_>>();
        for expected in [
            "--print",
            "--prompt-file",
            "--model",
            "swe",
            "--permission-mode",
            "dangerous",
            "--respect-workspace-trust",
            "false",
        ] {
            assert!(turns[0].contains(&expected), "{expected}");
        }
        assert!(!turns[0].contains(&"--resume"));
        let resume = turns[1].iter().position(|arg| *arg == "--resume").unwrap();
        assert_eq!(turns[1][resume + 1], "assigned-session");
        assert!(
            f.read("mise.txt")
                .contains(&f.worktree.display().to_string())
        );
        assert_eq!(
            fs::read_to_string(headless::turn_file(&directory, "msg_first", "prompt")).unwrap(),
            "ROLE PROMPT\n\nImplement the change"
        );
        // A Worker never inherits a stale bridge capability from the API process.
        assert_eq!(
            f.read("bridge-env.txt").trim().lines().collect::<Vec<_>>(),
            ["||||", "||||"]
        );
        // A prompt that already has native evidence is not replayed.
        assert!(dispatch(&scope, SESSION, "msg_first", "ROLE", "again", |_| Ok(true)).is_err());
    }

    #[test]
    fn a_hanging_devin_turn_is_busy_until_stopped() {
        let f = Fixture::new("hang");
        let scope = f.worker();
        let directory = f.directory("session-devin");
        ensure_session(&scope, Some(SESSION)).unwrap();
        dispatch_turn(&scope, SESSION, "msg_hang", "Implement the change");
        assert!(session_busy(&directory).unwrap());
        assert_eq!(
            super::super::session_reader::archive(&directory)
                .unwrap_err()
                .to_string(),
            "An agent is still active. Retry after it stops."
        );
        stop(&directory, Some(SESSION)).unwrap();
        assert!(!session_busy(&directory).unwrap());
        super::super::session_reader::archive(&directory).unwrap();
    }

    #[test]
    fn non_zero_turns_are_errors_and_startup_failures_retain_stderr() {
        let crash = Fixture::new("crash");
        let scope = crash.worker();
        let directory = crash.directory("session-devin");
        ensure_session(&scope, Some(SESSION)).unwrap();
        dispatch_turn(&scope, SESSION, "msg_crash", "Implement the change");
        let observed = eventually(&directory, SESSION, "msg_crash");
        assert_eq!(
            (observed.state, observed.reason),
            (PromptState::Error, "native_error")
        );
        let failed = Fixture::new("startup_failure");
        let scope = failed.worker();
        let directory = failed.directory("session-devin");
        ensure_session(&scope, Some(SESSION)).unwrap();
        dispatch_turn(&scope, SESSION, "msg_failed", "Implement the change");
        let observed = eventually(&directory, SESSION, "msg_failed");
        assert_eq!(
            (observed.state, observed.reason),
            (PromptState::Error, "native_startup_failed")
        );
        assert!(
            result_text(&directory, "msg_failed")
                .unwrap()
                .contains("Not logged in")
        );
    }

    #[test]
    fn missing_and_ambiguous_admission_follow_native_evidence() {
        let f = Fixture::new("complete");
        let directory = f.directory("session-devin");
        fs::create_dir_all(&directory).unwrap();
        let observe_x = |dispatch| observe(&directory, SESSION, "msg_x", dispatch, None).unwrap();
        let absent = observe_x(DispatchState::NotSubmitted);
        assert!(absent.retry_allowed);
        assert_eq!(absent.reason, "message_not_observed");
        let ambiguous = observe_x(DispatchState::Ambiguous);
        assert!(!ambiguous.retry_allowed);
        assert_eq!(ambiguous.reason, "admission_ambiguous");
        fs::write(headless::turn_file(&directory, "msg_x", "jsonl"), "output").unwrap();
        let missing = observe_x(DispatchState::NotSubmitted);
        assert!(!missing.retry_allowed);
        assert_eq!(missing.reason, "dispatch_identity_missing");
        assert!(missing.execution_uncertain && !absent.execution_uncertain);
        dispatch_turn(&f.worker(), SESSION, "msg_y", "Implement the change");
        assert_eq!(
            observe(
                &directory,
                "devin-other",
                "msg_y",
                DispatchState::Ambiguous,
                None
            )
            .unwrap()
            .reason,
            "session_identity_conflict"
        );
        let generation = fs::read_dir(&directory)
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .find_map(|name| {
                name.strip_prefix("dispatch-")?
                    .strip_suffix(".json")
                    .map(str::to_owned)
            })
            .unwrap();
        eventually(&directory, SESSION, "msg_y");
        let recovered = recover_dispatch(&directory, SESSION, "msg_y", &generation).unwrap();
        assert_eq!(recovered.state, PromptState::Completed);
    }

    #[test]
    fn devin_routing_admits_an_authenticated_coordinator() {
        let f = Fixture::new("complete");
        init_repository(&f.worktree);
        let identity = RootIdentity {
            task_id: "t".into(),
            session_id: "s".into(),
            generation: 1,
        };
        let root = f.scope(
            "session-devin",
            DevinRole::Root {
                identity: &identity,
                artifact_root: &f.root,
            },
        );
        assert!(ensure_session(&root, None).unwrap().starts_with("devin-"));
        let config = read_json(&f.worktree.join(".devin/mcp_config.local.json"));
        assert_eq!(
            keys(&config["mcpServers"]),
            ["suplex_root", "suplex_advisor"]
        );
        let args = arguments(
            "swe",
            None,
            Path::new("/tmp/prompt"),
            Path::new("/tmp/export"),
        );
        assert!(!args.contains(&"--resume".to_owned()));
    }

    #[test]
    fn root_and_concurrent_advisor_sessions_converge_on_one_ignored_invariant_config() {
        let f = Fixture::new("complete");
        let repository = init_repository(&f.root.join("repository"));
        let worktree = f.root.join("linked");
        repository.worktree("task", &worktree, None).unwrap();
        fs::create_dir_all(worktree.join(".devin")).unwrap();
        let config_path = worktree.join(".devin/mcp_config.local.json");
        fs::write(
            &config_path,
            r#"{"mcpServers":{"custom":{"command":"/custom"},"suplex_root":{"command":"/stale"}},"customSetting":true}"#,
        )
        .unwrap();
        let executable = f.root.join("devin-linked");
        Fixture::write_executable(
            &executable,
            "#!/bin/sh\nexport_path=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --export ]; then shift; export_path=$1; fi\n  shift\ndone\nsession_id=$(basename \"$(dirname \"$export_path\")\")\nprintf '%s\\n' 'Plain completion prose.'\nprintf '{\"schema_version\":\"ATIF-v1.7\",\"session_id\":\"%s\"}\\n' \"$session_id\" > \"$export_path\"\n",
        );
        let identity = RootIdentity {
            task_id: "task".into(),
            session_id: "root-session".into(),
            generation: 1,
        };
        let artifacts = f.root.join("artifacts");
        let linked = |id: &'static str| {
            let role = match id {
                "root-session" => DevinRole::Root {
                    identity: &identity,
                    artifact_root: &artifacts,
                },
                "advisor-a" => DevinRole::Advisor(AdvisorRole::PlannerA),
                _ => DevinRole::Advisor(AdvisorRole::PlannerB),
            };
            DevinScope {
                worktree: &worktree,
                executable: Some(&executable),
                ..f.scope(id, role)
            }
        };
        let sessions = [
            ("root-session", "devin-root", "msg_root"),
            ("advisor-a", "devin-a", "msg_a"),
            ("advisor-b", "devin-b", "msg_b"),
        ];
        thread::scope(|threads| {
            for (id, _, _) in sessions {
                threads.spawn(move || ensure_session(&linked(id), None).unwrap());
            }
        });
        let binding_path = f.directory("root-session").join("root.binding.json");
        let first = read_json(&binding_path);
        ensure_session(&linked("root-session"), None).unwrap();
        assert_eq!(read_json(&binding_path)["token"], first["token"]);
        let text = fs::read_to_string(&config_path).unwrap();
        let config: Value = serde_json::from_str(&text).unwrap();
        let servers = &config["mcpServers"];
        assert_eq!(config["customSetting"], true);
        assert_eq!(servers["custom"], json!({"command":"/custom"}));
        assert_eq!(keys(servers), ["custom", "suplex_root", "suplex_advisor"]);
        assert_eq!(
            servers["suplex_root"]["env"]["SUPLEX_ROOT_BINDING"],
            "${SUPLEX_ROOT_BINDING}"
        );
        assert_eq!(
            servers["suplex_root"]["env"]["SUPLEX_ROOT_TOKEN"],
            "${SUPLEX_ROOT_TOKEN}"
        );
        assert_eq!(
            servers["suplex_advisor"]["env"]["SUPLEX_ADVISOR_BINDING"],
            "${SUPLEX_ADVISOR_BINDING}"
        );
        assert_eq!(
            servers["suplex_advisor"]["env"]["SUPLEX_ADVISOR_TOKEN"],
            "${SUPLEX_ADVISOR_TOKEN}"
        );
        assert_eq!(
            servers["suplex_root"]["env"].get("SUPLEX_GH_COMMAND"),
            servers["suplex_advisor"]["env"].get("SUPLEX_GH_COMMAND")
        );
        assert!(!text.contains(first["token"].as_str().unwrap()));
        for (id, role) in [("advisor-a", "planner_a"), ("advisor-b", "planner_b")] {
            let binding = read_json(&f.directory(id).join("advisor.binding.json"));
            assert_eq!(binding["role"], role);
        }
        thread::scope(|threads| {
            for (id, native, turn) in sessions {
                threads.spawn(move || dispatch_turn(&linked(id), native, turn, "Coordinate"));
            }
        });
        for (id, native, turn) in sessions {
            let directory = f.directory(id);
            assert_eq!(
                eventually(&directory, native, turn).state,
                PromptState::Completed
            );
            assert_eq!(read_session_id(&directory).unwrap().as_deref(), Some(id));
        }
        fs::remove_file(&config_path).unwrap();
        ensure_session(&linked("advisor-a"), None).unwrap();
        assert_eq!(
            keys(&read_json(&config_path)["mcpServers"]),
            ["suplex_root", "suplex_advisor"]
        );
        fs::write(
            format!("{}.interrupted.pending", config_path.display()),
            "partial",
        )
        .unwrap();
        fs::write(worktree.join("unrelated.txt"), "dirty").unwrap();
        let linked_repository = git2::Repository::open(&worktree).unwrap();
        let mut options = git2::StatusOptions::new();
        options.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = linked_repository.statuses(Some(&mut options)).unwrap();
        let paths = statuses
            .iter()
            .filter_map(|entry| entry.path().ok().map(str::to_owned))
            .collect::<Vec<_>>();
        assert_eq!(paths, ["unrelated.txt"]);
        let exclude = fs::read_to_string(repository.commondir().join("info/exclude")).unwrap();
        assert_eq!(
            exclude
                .lines()
                .filter(|line| *line == "/.devin/mcp_config.local.json*")
                .count(),
            1
        );
    }

    #[test]
    fn a_captured_advisor_result_completes_a_turn_with_prose_and_survives_reader_recovery() {
        let f = Fixture::new("complete");
        init_repository(&f.worktree);
        let scope = f.scope("session-devin", DevinRole::Advisor(AdvisorRole::Rater));
        let directory = f.directory("session-devin");
        ensure_session(&scope, Some(SESSION)).unwrap();
        dispatch_turn(&scope, SESSION, "msg_rate", "Rate the change");
        assert_eq!(
            eventually(&directory, SESSION, "msg_rate").state,
            PromptState::Completed
        );
        let environment = f.read("bridge-env.txt");
        let fields = environment.trim().split('|').collect::<Vec<_>>();
        let result_path = advisor_bridge::advisor_result_path(&directory, "msg_rate").unwrap();
        assert_eq!(fields[0], "");
        assert_eq!(fields[1], "");
        assert_eq!(
            fields[2],
            directory.join("advisor.binding.json").display().to_string()
        );
        assert!(bridge_auth::valid_token(fields[3]));
        assert_eq!(fields[4], result_path.display().to_string());
        let report = advisor_bridge::validate_submission(
            AdvisorRole::Rater,
            json!({"rating":10,"blockingFindings":[],"verification":"passed",
                "verificationSummary":"Focused tests passed","summary":"Ready"}),
        )
        .unwrap();
        crate::shared::fs::write_private(&result_path, report.to_string().as_bytes()).unwrap();
        assert_eq!(
            result_text(&directory, "msg_rate").unwrap(),
            "Reviewed the change."
        );
        let (tools, limitation) = turn_evidence(&directory, "msg_rate").unwrap();
        assert_eq!(
            limitation,
            "Devin CLI does not expose other machine-readable tool evidence."
        );
        let output: Value = serde_json::from_str(tools[0].output.as_deref().unwrap()).unwrap();
        assert_eq!(output["structuredContent"]["rating"], 10);
        let retained = super::super::session_reader::turn_evidence(&directory, "msg_rate").unwrap();
        assert_eq!(retained.tools[0].output, tools[0].output);
    }
}
