//! Pi Coordinator, Worker, and Advisor launches over the shared headless
//! turn runtime.

use std::{collections::HashMap, error::Error, io, path::PathBuf};

use super::{display, executable, invocation, runtime};
use crate::{
    coordination::{advisor_bridge, bridge_auth, root_bridge},
    runtimes::{
        git_guard,
        native::{DispatchState, PromptObservation},
        task_harness::{self, TaskRole, TaskScope},
    },
};

/// The extension file that registers the role's bridge, in the private
/// session runtime directory.
pub const BRIDGE_EXTENSION: &str = "suplex-bridge.ts";

/// Prepare the role's bridge capability and guarded shell, then make the
/// durable prompt claim inside the native dispatch operation before spawning.
pub fn dispatch<F>(
    scope: &TaskScope<'_>,
    turn_id: &str,
    prompt: &str,
    claim: F,
) -> Result<PromptObservation, Box<dyn Error + Send + Sync>>
where
    F: FnOnce(&str) -> Result<bool, Box<dyn Error + Send + Sync>>,
{
    let directory = scope.runtime_directory()?;
    let before = runtime::observe(
        &directory,
        scope.native_session_id,
        turn_id,
        DispatchState::NotSubmitted,
        None,
    )?;
    if !before.retry_allowed {
        return Err(io::Error::other("Pi prompt was not proven absent; replay is blocked").into());
    }
    let pi = executable::resolve_pi_executable(scope.executable, scope.inherited_environment)?;
    let (git, gh) = git_guard::resolve_guard_binaries(scope.inherited_environment)?;
    let guard = git_guard::create_git_command_guard(
        &directory,
        &git,
        gh.as_deref(),
        scope.inherited_environment,
    )?;
    let suplex = std::env::current_exe()?;
    let suplex = suplex
        .to_str()
        .ok_or_else(|| io::Error::other("Suplex executable path is invalid"))?;
    let (role, bridge_environment, additions, server_args, server_names) =
        match (scope.role, scope.workflow.advisor) {
            (TaskRole::Root(identity), _) => {
                let binding = root_bridge::write_binding(
                    &directory,
                    identity,
                    scope.database_path,
                    scope.artifact_root,
                    suplex,
                )?;
                (
                    invocation::Role::Root,
                    Some(HashMap::from([
                        (
                            bridge_auth::ROOT_BINDING_ENV.to_owned(),
                            binding.binding_path.to_string_lossy().into_owned(),
                        ),
                        (bridge_auth::ROOT_TOKEN_ENV.to_owned(), binding.token),
                    ])),
                    HashMap::new(),
                    ["mcp".to_owned(), "root".to_owned()],
                    // Delivery pushes from the bridge; `git` on its PATH is the Worker guard.
                    vec![
                        bridge_auth::ROOT_BINDING_ENV.to_owned(),
                        bridge_auth::ROOT_TOKEN_ENV.to_owned(),
                        "SUPLEX_GIT_REAL_BIN".to_owned(),
                    ],
                )
            }
            (TaskRole::Worker(_), Some(advisor)) => {
                let binding = advisor_bridge::write_binding(&directory, advisor, suplex)?;
                let result = advisor_bridge::advisor_result_path(&directory, turn_id)?;
                (
                    invocation::Role::Advisor,
                    Some(HashMap::from([
                        (
                            bridge_auth::ADVISOR_BINDING_ENV.to_owned(),
                            binding.binding_path.to_string_lossy().into_owned(),
                        ),
                        (bridge_auth::ADVISOR_TOKEN_ENV.to_owned(), binding.token),
                    ])),
                    HashMap::from([(
                        bridge_auth::ADVISOR_RESULT_ENV.to_owned(),
                        result.to_string_lossy().into_owned(),
                    )]),
                    ["mcp".to_owned(), "advisor".to_owned()],
                    vec![
                        bridge_auth::ADVISOR_BINDING_ENV.to_owned(),
                        bridge_auth::ADVISOR_TOKEN_ENV.to_owned(),
                        bridge_auth::ADVISOR_RESULT_ENV.to_owned(),
                    ],
                )
            }
            (TaskRole::Worker(_), None) => (
                invocation::Role::Worker,
                None,
                HashMap::new(),
                [String::new(), String::new()],
                Vec::new(),
            ),
        };
    let extension: Option<PathBuf> = match role.bridge_name() {
        Some(name) => {
            let path = directory.join(BRIDGE_EXTENSION);
            crate::shared::fs::write_private(
                &path,
                invocation::bridge_extension(
                    name,
                    &invocation::BridgeServer {
                        command: suplex,
                        args: &server_args,
                        environment_names: &server_names,
                    },
                )
                .as_bytes(),
            )?;
            Some(path)
        }
        None => None,
    };
    let environment = task_harness::task_bridge_environment(
        &guard.environment,
        bridge_environment.as_ref(),
        &additions,
    );
    let environment = task_harness::task_scope_environment(
        environment,
        scope.worktree,
        scope.project_environment,
    );
    // The host already prepended the project context to `prompt`. Pi reads
    // AGENTS.md itself, and the role prompt leads the private prompt file.
    let prompt = format!("{}\n\n{prompt}", scope.workflow.role_prompt(scope.role));
    display::show(
        scope.database_path,
        scope.session_id,
        scope.native_session_id,
        scope.worktree,
        scope.model,
    );
    runtime::dispatch(
        runtime::PiDispatch {
            directory: &directory,
            worktree: scope.worktree,
            executable: &pi,
            session_id: scope.native_session_id,
            turn_id,
            prompt: &prompt,
            model: scope.model,
            reasoning_effort: scope.reasoning_effort,
            role,
            bridge_extension: extension.as_deref(),
            environment: &environment,
            excluded_environment_keys: scope.excluded_environment_keys,
        },
        claim,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        coordination::advisor_bridge::AdvisorRole,
        runtimes::{
            headless,
            native::PromptState,
            task_harness::{WorkerPurpose, WorkflowLaunch},
        },
    };
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
        thread,
        time::Duration,
    };

    struct Fixture {
        base: PathBuf,
        database: PathBuf,
        worktree: PathBuf,
        pi: PathBuf,
        inherited: HashMap<String, String>,
        project: HashMap<String, String>,
    }

    /// A fake `pi` that checks its environment and argv, then prints a
    /// settled turn. `script` runs first and exits non-zero on a failure.
    fn fixture(name: &str, script: &str, inherited: &[(&str, &str)]) -> Fixture {
        let base = std::env::temp_dir().join(format!("suplex-pi-{name}-{}", uuid::Uuid::new_v4()));
        let worktree = base.join("worktree");
        fs::create_dir_all(&worktree).unwrap();
        let pi = base.join("pi");
        fs::write(
            &pi,
            format!(
                "#!/bin/sh\n{script}\ncat >/dev/null\nprintf '%s\\n' '{{\"type\":\"session\",\"version\":3,\"id\":\"pi-1\"}}' '{{\"type\":\"agent_end\",\"willRetry\":false}}' '{{\"type\":\"agent_settled\",\"aborted\":false}}'\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&pi, fs::Permissions::from_mode(0o700)).unwrap();
        Fixture {
            database: base.join("installation.sqlite"),
            worktree,
            pi,
            inherited: inherited
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .chain([("PATH".to_owned(), "/usr/bin:/bin".to_owned())])
                .collect(),
            project: HashMap::from([
                ("PROJECT_FLAG".into(), "yes".into()),
                ("JIRA_TOKEN".into(), "secret".into()),
            ]),
            base,
        }
    }

    fn scope<'a>(
        fixture: &'a Fixture,
        session_id: &'a str,
        role: TaskRole<'a>,
        workflow: WorkflowLaunch,
        excluded: &'a [String],
    ) -> TaskScope<'a> {
        TaskScope {
            workflow,
            database_path: &fixture.database,
            artifact_root: &fixture.base,
            task_id: "task_pi",
            session_id,
            native_session_id: "pi-native-1",
            role,
            worktree: &fixture.worktree,
            model: "ollama/qwen3-coder",
            reasoning_effort: "high",
            instance_home_directory: None,
            project_mcp: None,
            project_context_path: None,
            project_environment: &fixture.project,
            excluded_environment_keys: excluded,
            executable: Some(&fixture.pi),
            inherited_environment: &fixture.inherited,
        }
    }

    fn wait_for_completion(directory: &Path, turn_id: &str) {
        let exit = headless::turn_file(directory, turn_id, "exit");
        for _ in 0..100 {
            if let Ok(status) = fs::read_to_string(&exit) {
                let stderr =
                    fs::read_to_string(headless::turn_file(directory, turn_id, "stderr.log"))
                        .unwrap_or_default();
                assert_eq!(status.trim(), "0", "fake pi failed: {stderr}");
                assert_eq!(
                    runtime::observe(
                        directory,
                        "pi-native-1",
                        turn_id,
                        DispatchState::Ambiguous,
                        None,
                    )
                    .unwrap()
                    .state,
                    PromptState::Completed
                );
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("fake pi did not exit");
    }

    #[test]
    fn root_binding_bridge_and_guard_reach_the_child_only_after_the_claim() {
        let fixture = fixture(
            "root",
            concat!(
                "test -n \"$SUPLEX_ROOT_TOKEN\" || exit 21\n",
                "test -f \"$SUPLEX_ROOT_BINDING\" || exit 22\n",
                "test -z \"$SUPLEX_ADVISOR_TOKEN$JIRA_TOKEN\" || exit 23\n",
                "test -x \"$SUPLEX_GIT_GUARD_DIR/git\" || exit 24\n",
                "test \"$PROJECT_FLAG\" = yes || exit 25\n",
                "case \"$*\" in *\"$SUPLEX_ROOT_TOKEN\"*) exit 26 ;; esac\n",
                "case \"$*\" in *'--mode json --model ollama/qwen3-coder --thinking high --session-dir '*'/pi-sessions --session-id pi-native-1 --tools read,grep,find,ls,mcp__suplex_root__* -e '*'/suplex-bridge.ts') ;; *) exit 27 ;; esac\n",
                "eval \"extension=\\${$#}\"\n",
                "grep -q 'registerMcpServer(\"suplex_root\"' \"$extension\" || exit 28\n",
                "grep -q '\"args\":\\[\"mcp\",\"root\"\\]' \"$extension\" || exit 29\n",
                "grep -q \"$SUPLEX_ROOT_TOKEN\" \"$extension\" && exit 30\n",
                "grep -q 'Suplex Coordinator' || exit 31\n",
            ),
            &[
                ("SUPLEX_ADVISOR_TOKEN", "stale-advisor"),
                ("MISE_TRUSTED_CONFIG_PATHS", "/trusted"),
            ],
        );
        let identity = root_bridge::RootIdentity {
            task_id: "task_pi".into(),
            session_id: "session_root".into(),
            generation: 1,
        };
        let excluded = ["JIRA_TOKEN".to_owned()];
        let launch = scope(
            &fixture,
            "session_root",
            TaskRole::Root(&identity),
            WorkflowLaunch::default(),
            &excluded,
        );
        let claimed = AtomicBool::new(false);
        let observed = dispatch(&launch, "msg_root", "Inspect the worktree", |generation| {
            assert!(!generation.is_empty());
            let directory = launch.runtime_directory()?;
            assert!(directory.join("root.binding.json").exists());
            assert!(!directory.join("turn.json").exists());
            claimed.store(true, Ordering::SeqCst);
            Ok(true)
        })
        .unwrap();
        assert!(claimed.load(Ordering::SeqCst));
        assert!(observed.admission_observed);
        let directory = launch.runtime_directory().unwrap();
        let prompt =
            fs::read_to_string(headless::turn_file(&directory, "msg_root", "prompt")).unwrap();
        assert!(prompt.ends_with("\n\nInspect the worktree"));
        wait_for_completion(&directory, "msg_root");
        fs::remove_dir_all(&fixture.base).unwrap();
    }

    #[test]
    fn a_refused_claim_does_not_launch_pi() {
        let fixture = fixture("refusal", "touch \"$0.launched\"", &[]);
        let identity = root_bridge::RootIdentity {
            task_id: "task_pi".into(),
            session_id: "session_refusal".into(),
            generation: 1,
        };
        let launch = scope(
            &fixture,
            "session_refusal",
            TaskRole::Root(&identity),
            WorkflowLaunch::default(),
            &[],
        );
        assert!(dispatch(&launch, "msg_refusal", "Inspect", |_| Ok(false)).is_err());
        thread::sleep(Duration::from_millis(100));
        assert!(!fixture.base.join("pi.launched").exists());
        assert!(
            !launch
                .runtime_directory()
                .unwrap()
                .join("turn.json")
                .exists()
        );
        fs::remove_dir_all(&fixture.base).unwrap();
    }

    #[test]
    fn advisor_launch_is_read_only_with_only_the_report_bridge() {
        let fixture = fixture(
            "advisor",
            concat!(
                "test -z \"$SUPLEX_ROOT_TOKEN$SUPLEX_ROOT_BINDING\" || exit 21\n",
                "test -n \"$SUPLEX_ADVISOR_TOKEN\" || exit 22\n",
                "test -f \"$SUPLEX_ADVISOR_BINDING\" || exit 23\n",
                "case \"$SUPLEX_ADVISOR_RESULT\" in *turn-msg_advisor.advisor-report.json) ;; *) exit 24 ;; esac\n",
                "case \"$*\" in *'--tools read,grep,find,ls,mcp__suplex_advisor__* -e '*) ;; *) exit 25 ;; esac\n",
                "test -x \"$SUPLEX_GIT_GUARD_DIR/git\" || exit 26\n",
                "grep -q 'read-only Suplex Advisor' || exit 27\n",
            ),
            &[("SUPLEX_ROOT_TOKEN", "stale-root")],
        );
        let launch = scope(
            &fixture,
            "session_advisor",
            TaskRole::Worker(WorkerPurpose::Implementation),
            WorkflowLaunch {
                advisor: Some(AdvisorRole::Reviewer),
                ..WorkflowLaunch::default()
            },
            &[],
        );
        let observed = dispatch(&launch, "msg_advisor", "Review the change", |_| Ok(true)).unwrap();
        assert!(observed.admission_observed);
        let directory = launch.runtime_directory().unwrap();
        let extension = fs::read_to_string(directory.join(BRIDGE_EXTENSION)).unwrap();
        assert!(extension.contains("registerMcpServer(\"suplex_advisor\""));
        assert!(extension.contains("\"args\":[\"mcp\",\"advisor\"]"));
        wait_for_completion(&directory, "msg_advisor");
        fs::remove_dir_all(&fixture.base).unwrap();
    }

    #[test]
    fn worker_launch_keeps_default_tools_without_a_bridge_capability() {
        let fixture = fixture(
            "worker",
            concat!(
                "test -z \"$SUPLEX_ROOT_TOKEN$SUPLEX_ROOT_BINDING$SUPLEX_ADVISOR_TOKEN$SUPLEX_ADVISOR_BINDING\" || exit 21\n",
                "test -x \"$SUPLEX_GIT_GUARD_DIR/git\" || exit 22\n",
                "case \"$*\" in *--tools*|*' -e '*) exit 23 ;; esac\n",
                "case \"$*\" in *'--session-id pi-native-1') ;; *) exit 24 ;; esac\n",
                "grep -q 'Implement the assignment' || exit 25\n",
            ),
            &[
                ("SUPLEX_ROOT_TOKEN", "stale-root"),
                ("SUPLEX_ADVISOR_TOKEN", "stale-advisor"),
            ],
        );
        let launch = scope(
            &fixture,
            "session_worker",
            TaskRole::Worker(WorkerPurpose::Implementation),
            WorkflowLaunch::default(),
            &[],
        );
        let observed = dispatch(&launch, "msg_worker", "Implement the assignment", |_| {
            Ok(true)
        })
        .unwrap();
        assert!(observed.admission_observed);
        let directory = launch.runtime_directory().unwrap();
        assert!(!directory.join(BRIDGE_EXTENSION).exists());
        wait_for_completion(&directory, "msg_worker");
        fs::remove_dir_all(&fixture.base).unwrap();
    }
}
