use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::coordination::bridge_auth::{
    ADVISOR_BINDING_ENV, ADVISOR_RESULT_ENV, ADVISOR_TOKEN_ENV, ROOT_BINDING_ENV, ROOT_TOKEN_ENV,
};
use crate::coordination::root_bridge::RootIdentity;
use crate::profiles::model_pricing::ModelPricingCatalog;
use crate::runtimes::codex::{tool_evidence::NativeTool, usage::UsageTokens};
use crate::runtimes::headless;

// The prompt observation vocabulary is shared by every harness; each native
// runtime maps its own evidence onto it.
pub use crate::runtimes::codex::role_prompt::WorkerPurpose;
pub use crate::runtimes::codex::runtime::{DispatchState, PromptObservation, PromptState};
pub use crate::runtimes::codex::session_reader::session_directory as task_session_runtime_directory;

/// The Standard roles the task host runs.
#[derive(Clone, Copy)]
pub enum TaskRole<'a> {
    Root(&'a RootIdentity),
    Worker(WorkerPurpose),
}

/// TypeScript `scope.workflow`, `workerMode`, and `advisorRole` for a
/// non-Standard workflow role. The default is the Standard role.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WorkflowLaunch {
    /// A Coordinator of a non-Standard workflow.
    pub workflow_root: bool,
    /// A Direct build implementation Worker.
    pub direct: bool,
    /// A read-only Advisor that runs in a Worker session.
    pub advisor: Option<crate::coordination::advisor_bridge::AdvisorRole>,
}

impl WorkflowLaunch {
    /// TypeScript `scope.role`: "root", "worker", or "advisor".
    pub fn role_name(self, role: TaskRole<'_>) -> &'static str {
        match (role, self.advisor) {
            (TaskRole::Root(_), _) => "root",
            (TaskRole::Worker(_), Some(_)) => "advisor",
            (TaskRole::Worker(_), None) => "worker",
        }
    }

    /// TypeScript `scope.role !== "worker" && scope.workflow !== "standard"`:
    /// the session reads the pinned workflow evidence directory.
    pub fn reads_evidence(self, role: TaskRole<'_>) -> bool {
        self.workflow_root || (matches!(role, TaskRole::Worker(_)) && self.advisor.is_some())
    }

    /// TypeScript `taskRolePrompt(scope.role, { workflow, workerMode, purpose })`.
    pub fn role_prompt(self, role: TaskRole<'_>) -> &'static str {
        use crate::coordination::root_prompts::{
            ADVISOR_ROLE_PROMPT, ROOT_WORKFLOW_ROLE_PROMPT, WORKER_DIRECT_ROLE_PROMPT,
        };
        use crate::runtimes::codex::role_prompt;
        match role {
            TaskRole::Root(_) if self.workflow_root => ROOT_WORKFLOW_ROLE_PROMPT,
            TaskRole::Root(_) => role_prompt::ROOT_STANDARD,
            TaskRole::Worker(_) if self.advisor.is_some() => ADVISOR_ROLE_PROMPT,
            TaskRole::Worker(WorkerPurpose::Implementation) if self.direct => {
                WORKER_DIRECT_ROLE_PROMPT
            }
            TaskRole::Worker(purpose) => role_prompt::worker_standard_role(purpose),
        }
    }
}

/// TypeScript `TaskScope`: one native session launch, resolved by the host.
pub struct TaskScope<'a> {
    pub workflow: WorkflowLaunch,
    pub database_path: &'a Path,
    pub artifact_root: &'a Path,
    pub task_id: &'a str,
    pub session_id: &'a str,
    pub native_session_id: &'a str,
    pub role: TaskRole<'a>,
    pub worktree: &'a Path,
    pub model: &'a str,
    pub reasoning_effort: &'a str,
    pub instance_home_directory: Option<&'a Path>,
    /// Project `execution.mcp`, when the project configures execution.
    pub project_mcp: Option<&'a Value>,
    pub project_context_path: Option<&'a Path>,
    pub project_environment: &'a HashMap<String, String>,
    pub excluded_environment_keys: &'a [String],
    /// Test override for the native CLI executable.
    pub executable: Option<&'a Path>,
    pub inherited_environment: &'a HashMap<String, String>,
}

impl TaskScope<'_> {
    pub fn runtime_directory(&self) -> io::Result<PathBuf> {
        task_session_runtime_directory(self.database_path, self.session_id)
    }

    /// TypeScript `taskEvidenceRoot(databasePath)/<taskId>`.
    pub fn evidence_root(&self) -> PathBuf {
        self.database_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("runtime/task-evidence")
            .join(self.task_id)
    }
}

pub type DispatchClaim<'a> = &'a mut dyn FnMut(&str) -> Result<bool, Box<dyn Error>>;

/// The native session a reader observes.
pub struct ReaderSession<'a> {
    pub database_path: &'a Path,
    pub session_id: &'a str,
    pub native_session_id: &'a str,
    /// TypeScript `session.profile?.instanceHomeDirectory`.
    pub instance_home_directory: Option<&'a Path>,
}

impl ReaderSession<'_> {
    pub fn runtime_directory(&self) -> io::Result<PathBuf> {
        task_session_runtime_directory(self.database_path, self.session_id)
    }
}

/// One native usage record (TypeScript `TaskUsage` without its task role).
#[derive(Clone, Debug, PartialEq)]
pub struct UsageEntry {
    pub message_id: String,
    pub turn_id: String,
    pub provider: &'static str,
    pub model: String,
    pub started_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub failed: bool,
    pub tokens: UsageTokens,
    pub cost_usd: f64,
}

/// TypeScript `NativeSessionReader.timeline`.
#[derive(Debug, Default, PartialEq)]
pub struct NativeTimeline {
    pub usage: Vec<UsageEntry>,
    pub live_message_id: Option<String>,
}

/// TypeScript `NativeSessionReader`: read-only observation of a native
/// session for the UI, analytics, limits, and Archive.
pub trait NativeSessionReader {
    /// The authoritative native conversation snapshot.
    fn history(&self, session: &ReaderSession<'_>) -> io::Result<Vec<Value>>;
    /// Native tools and the current plan.
    fn execution(&self, session: &ReaderSession<'_>) -> io::Result<(Vec<NativeTool>, Value)>;
    /// One admitted native turn; `None` when its log is missing.
    fn turn_evidence(
        &self,
        session: &ReaderSession<'_>,
        turn_id: &str,
    ) -> io::Result<Option<Vec<NativeTool>>>;
    fn timeline(
        &self,
        session: &ReaderSession<'_>,
        pricing: Option<&ModelPricingCatalog>,
    ) -> io::Result<NativeTimeline>;
    fn busy(&self, session: &ReaderSession<'_>) -> io::Result<bool>;
}

/// TypeScript `TaskHarness`. The registry selects one implementation by the
/// profile provider or the native session identity; the same runtime reads
/// its native sessions.
pub trait TaskHarness: NativeSessionReader + Sync {
    /// Reserve a new native session identity.
    fn new_session_id(&self) -> String;
    /// TypeScript `ensureSession`: prepare what the native session needs, such
    /// as its server, before the host observes or dispatches a turn.
    fn ensure_session(&self, _scope: &TaskScope<'_>) -> Result<(), Box<dyn Error>> {
        Ok(())
    }
    fn observe(
        &self,
        directory: &Path,
        native_session_id: &str,
        turn_id: &str,
        dispatch: DispatchState,
        generation: Option<&str>,
    ) -> io::Result<PromptObservation>;
    /// Claim the prompt inside the native dispatch, then start it once.
    fn dispatch(
        &self,
        scope: &TaskScope<'_>,
        turn_id: &str,
        prompt: &str,
        claim: DispatchClaim<'_>,
    ) -> Result<PromptObservation, Box<dyn Error>>;
    /// Stop a fenced execution, then observe it as not submitted.
    fn recover_dispatch(
        &self,
        directory: &Path,
        native_session_id: &str,
        turn_id: &str,
        generation: &str,
    ) -> io::Result<PromptObservation>;
    fn result_text(&self, directory: &Path, turn_id: &str) -> io::Result<String>;
    /// TypeScript `observation.native`, completed from native evidence.
    fn native(&self, _directory: &Path, _turn_id: &str, base: Value) -> io::Result<Value> {
        Ok(base)
    }
    fn stop(&self, directory: &Path, native_session_id: Option<&str>) -> io::Result<()>;
}

/// TypeScript `recoverHeadlessDispatch`: stop the fenced generation only.
pub fn recover_headless_dispatch(directory: &Path, generation: &str) -> io::Result<()> {
    let record_path = directory.join(format!("dispatch-{generation}.json"));
    if let Some(record) = headless::read_record(&record_path)? {
        headless::stop_owned(&record)?;
    }
    headless::stop_execution(directory, generation)
}

/// TypeScript `ExecutableSpec`.
pub struct ExecutableSpec {
    pub label: &'static str,
    pub binary: &'static str,
    pub env_var: &'static str,
    pub home_paths: &'static [&'static str],
    pub fallback_paths: &'static [&'static str],
}

pub const GH_EXECUTABLE: ExecutableSpec = ExecutableSpec {
    label: "GitHub CLI",
    binary: "gh",
    env_var: "SUPLEX_GH_COMMAND",
    home_paths: &[],
    fallback_paths: &["/opt/homebrew/bin/gh", "/usr/local/bin/gh"],
};

fn executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

/// TypeScript `resolveExecutable`: override or environment variable, then
/// PATH, fallback paths, and home install locations.
pub fn resolve_executable(
    spec: &ExecutableSpec,
    override_path: Option<&Path>,
    environment: &HashMap<String, String>,
    home: Option<&Path>,
) -> io::Result<PathBuf> {
    if let Some(path) = override_path.or_else(|| environment.get(spec.env_var).map(Path::new)) {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "{} executable must be an absolute path. Check {}.",
                    spec.label, spec.env_var
                ),
            ));
        }
        if !executable_file(path) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "{} executable cannot be executed. Check {}.",
                    spec.label, spec.env_var
                ),
            ));
        }
        return Ok(path.to_owned());
    }
    let search = environment
        .get("PATH")
        .map(String::as_str)
        .unwrap_or_default();
    std::env::split_paths(search)
        .filter(|path| path.is_absolute())
        .map(|directory| directory.join(spec.binary))
        .chain(spec.fallback_paths.iter().map(PathBuf::from))
        .chain(
            home.into_iter()
                .flat_map(|home| spec.home_paths.iter().map(move |path| home.join(path))),
        )
        .find(|candidate| executable_file(candidate))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "Install {} or set {} to its absolute executable path.",
                    spec.label, spec.env_var
                ),
            )
        })
}

/// Build one native task process environment. A recovered task must not inherit
/// another task's bridge capability from the API process environment.
pub fn task_bridge_environment(
    inherited: &HashMap<String, String>,
    server: Option<&HashMap<String, String>>,
    additions: &HashMap<String, String>,
) -> HashMap<String, String> {
    let blocked = [
        ROOT_BINDING_ENV,
        ROOT_TOKEN_ENV,
        ADVISOR_BINDING_ENV,
        ADVISOR_TOKEN_ENV,
        ADVISOR_RESULT_ENV,
    ];
    let mut clean = inherited
        .iter()
        .filter(|(name, _)| !blocked.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<HashMap<_, _>>();
    if let Some(server) = server {
        clean.extend(
            server
                .iter()
                .map(|(name, value)| (name.clone(), value.clone())),
        );
    }
    clean.extend(
        additions
            .iter()
            .map(|(name, value)| (name.clone(), value.clone())),
    );
    clean
}

pub fn task_scope_environment(
    mut environment: HashMap<String, String>,
    worktree: &Path,
    project_environment: &HashMap<String, String>,
) -> HashMap<String, String> {
    let worktree = worktree.to_string_lossy();
    let trusted = match environment.get("MISE_TRUSTED_CONFIG_PATHS") {
        Some(existing) if !existing.is_empty() => format!("{existing}:{}", worktree),
        _ => worktree.into_owned(),
    };
    environment.insert("MISE_TRUSTED_CONFIG_PATHS".into(), trusted);
    environment.extend(project_environment.clone());
    environment
}

pub fn task_context_prompt(
    prompt: &str,
    project_context: Option<&str>,
    project_context_path: Option<&Path>,
) -> String {
    let prepared = project_context_path.map(|path| {
        std::fs::read_to_string(path).unwrap_or_else(|_| {
            "Prepared project context is unavailable. Inspect the actual worktree and configured skill sources before continuing.".into()
        })
    });
    let context = [project_context, prepared.as_deref()]
        .into_iter()
        .flatten()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if context.is_empty() {
        prompt.to_owned()
    } else {
        format!("{context}\n\n{prompt}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::headless::{self, DispatchInput};
    use std::{path::Path, process::Command, thread, time::Duration};

    #[test]
    fn task_environment_removes_stale_bridge_capabilities_then_applies_current_binding() {
        let inherited = HashMap::from([
            ("PATH".into(), "/bin".into()),
            (ROOT_TOKEN_ENV.into(), "old-root-token".into()),
            (ADVISOR_RESULT_ENV.into(), "old-result".into()),
        ]);
        let server = HashMap::from([
            (ADVISOR_TOKEN_ENV.into(), "current-token".into()),
            (ADVISOR_BINDING_ENV.into(), "/current/binding".into()),
        ]);
        let additions = HashMap::from([("PATH".into(), "/guard:/bin".into())]);
        let result = task_bridge_environment(&inherited, Some(&server), &additions);
        assert_eq!(result.get("PATH").map(String::as_str), Some("/guard:/bin"));
        assert_eq!(
            result.get(ADVISOR_TOKEN_ENV).map(String::as_str),
            Some("current-token")
        );
        assert_eq!(
            result.get(ADVISOR_BINDING_ENV).map(String::as_str),
            Some("/current/binding")
        );
        assert!(!result.contains_key(ROOT_TOKEN_ENV));
        assert!(!result.contains_key(ADVISOR_RESULT_ENV));
    }

    #[test]
    fn detached_child_receives_only_its_current_bridge_capability() {
        if std::env::var_os("SUPLEX_HARNESS_ENV_PROBE").is_none() {
            let result = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "runtimes::task_harness::tests::detached_child_receives_only_its_current_bridge_capability",
                    "--nocapture",
                ])
                .env("SUPLEX_HARNESS_ENV_PROBE", "1")
                .env(ROOT_TOKEN_ENV, "stale-root-capability")
                .output()
                .unwrap();
            assert!(result.status.success(), "nested test failed");
            return;
        }

        let directory =
            std::env::temp_dir().join(format!("suplex-bridge-env-{}", uuid::Uuid::new_v4()));
        let inherited = std::env::vars().collect::<HashMap<_, _>>();
        let server = HashMap::from([(ADVISOR_TOKEN_ENV.to_owned(), "current-token".to_owned())]);
        let environment = task_bridge_environment(&inherited, Some(&server), &HashMap::new());
        let args = vec![
            "-c".to_owned(),
            "test -z \"$SUPLEX_ROOT_TOKEN\" && test \"$SUPLEX_ADVISOR_TOKEN\" = current-token"
                .to_owned(),
        ];
        headless::dispatch(
            DispatchInput {
                directory: &directory,
                worktree: Path::new("/tmp"),
                session_id: "bridge-env-session",
                turn_id: "bridge-env-turn",
                executable: Path::new("/bin/sh"),
                args: &args,
                prompt: "probe",
                environment: &environment,
            },
            |_| Ok(true),
        )
        .unwrap();
        let exit_file = headless::turn_file(&directory, "bridge-env-turn", "exit");
        for _ in 0..40 {
            if let Ok(status) = std::fs::read_to_string(&exit_file) {
                assert_eq!(status.trim(), "0");
                std::fs::remove_dir_all(&directory).unwrap();
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("bridge probe child did not finish");
    }
}
