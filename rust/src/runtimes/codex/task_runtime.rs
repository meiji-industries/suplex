use std::{collections::HashMap, error::Error, io, path::Path};

use super::{display, executable, invocation, role_prompt, runtime};
use crate::{
    coordination::{
        advisor_bridge::{self, AdvisorRole},
        bridge_auth, root_bridge,
        root_prompts::{ADVISOR_ROLE_PROMPT, ROOT_WORKFLOW_ROLE_PROMPT, WORKER_DIRECT_ROLE_PROMPT},
    },
    runtimes::{git_guard, task_harness},
};

pub struct RootCodexLaunch<'a> {
    pub database_path: &'a Path,
    pub artifact_root: &'a Path,
    pub identity: &'a root_bridge::RootIdentity,
    pub native_session_id: &'a str,
    pub turn_id: &'a str,
    pub worktree: &'a Path,
    pub prompt: &'a str,
    pub project_context: Option<&'a str>,
    pub project_context_path: Option<&'a Path>,
    pub project_environment: &'a HashMap<String, String>,
    pub excluded_environment_keys: &'a [String],
    pub model: &'a str,
    pub reasoning_effort: &'a str,
    pub codex_executable: Option<&'a Path>,
    pub inherited_environment: &'a HashMap<String, String>,
    /// False selects the workflow Coordinator role prompt.
    pub standard: bool,
}

pub struct WorkerCodexLaunch<'a> {
    pub database_path: &'a Path,
    pub session_id: &'a str,
    pub native_session_id: &'a str,
    pub turn_id: &'a str,
    pub worktree: &'a Path,
    pub prompt: &'a str,
    pub project_context: Option<&'a str>,
    pub project_context_path: Option<&'a Path>,
    pub project_environment: &'a HashMap<String, String>,
    pub excluded_environment_keys: &'a [String],
    pub purpose: role_prompt::WorkerPurpose,
    pub model: &'a str,
    pub reasoning_effort: &'a str,
    pub codex_executable: Option<&'a Path>,
    pub inherited_environment: &'a HashMap<String, String>,
    /// A Direct build implementation uses the Direct build Worker role.
    pub direct: bool,
    /// An Advisor runs read-only with only its report bridge.
    pub advisor: Option<AdvisorRole>,
}

fn require_absent(directory: &Path, session_id: &str, turn_id: &str) -> io::Result<()> {
    let before = runtime::observe(
        directory,
        session_id,
        turn_id,
        crate::runtimes::native::DispatchState::NotSubmitted,
        None,
    )?;
    if before.retry_allowed {
        Ok(())
    } else {
        Err(io::Error::other(
            "Codex prompt was not proven absent; replay is blocked",
        ))
    }
}

/// Prepare the current Root capability and guarded shell, then make the
/// durable prompt claim inside the native dispatch operation before spawning.
pub fn dispatch_codex_root<F>(
    input: RootCodexLaunch<'_>,
    claim: F,
) -> Result<crate::runtimes::native::PromptObservation, Box<dyn Error>>
where
    F: FnOnce(&str) -> Result<bool, Box<dyn Error>>,
{
    let directory = crate::runtimes::native::session_directory(
        input.database_path,
        &input.identity.session_id,
    )?;
    require_absent(&directory, input.native_session_id, input.turn_id)?;
    let codex = executable::resolve_codex_executable(input.codex_executable)?;
    let suplex = std::env::current_exe()?;
    let suplex = suplex
        .to_str()
        .ok_or_else(|| io::Error::other("Suplex executable path is invalid"))?;
    let binding = root_bridge::write_binding(
        &directory,
        input.identity,
        input.database_path,
        input.artifact_root,
        suplex,
    )?;
    let (git, gh) = git_guard::resolve_guard_binaries(input.inherited_environment)?;
    let guard = git_guard::create_git_command_guard(
        &directory,
        &git,
        gh.as_deref(),
        input.inherited_environment,
    )?;
    let bridge_environment = HashMap::from([
        (
            bridge_auth::ROOT_BINDING_ENV.to_owned(),
            binding.binding_path.to_string_lossy().into_owned(),
        ),
        (bridge_auth::ROOT_TOKEN_ENV.to_owned(), binding.token),
    ]);
    let environment = task_harness::task_bridge_environment(
        &guard.environment,
        Some(&bridge_environment),
        &HashMap::new(),
    );
    let environment = task_harness::task_scope_environment(
        environment,
        input.worktree,
        input.project_environment,
    );
    let server_args = ["mcp".to_owned(), "root".to_owned()];
    // Delivery pushes from the bridge; `git` on its PATH is the Worker guard.
    let server_names = [
        bridge_auth::ROOT_BINDING_ENV.to_owned(),
        bridge_auth::ROOT_TOKEN_ENV.to_owned(),
        "SUPLEX_GIT_REAL_BIN".to_owned(),
    ];
    let server = invocation::BridgeServer {
        command: suplex,
        args: &server_args,
        environment_names: &server_names,
    };
    let task_prompt = task_harness::task_context_prompt(
        input.prompt,
        input.project_context,
        input.project_context_path,
    );
    let prompt = if input.standard {
        role_prompt::root_standard_prompt(&task_prompt)
    } else {
        format!("{ROOT_WORKFLOW_ROLE_PROMPT}\n\n{task_prompt}")
    };
    let session = &input.identity.session_id;
    display::show(
        input.database_path,
        session,
        input.native_session_id,
        input.worktree,
        input.model,
    );
    runtime::dispatch(
        runtime::CodexDispatch {
            directory: &directory,
            worktree: input.worktree,
            executable: &codex,
            session_id: input.native_session_id,
            turn_id: input.turn_id,
            prompt: &prompt,
            model: input.model,
            reasoning_effort: input.reasoning_effort,
            role: invocation::Role::Root,
            bridge: Some(&server),
            environment: &environment,
            excluded_environment_keys: input.excluded_environment_keys,
        },
        claim,
    )
}

/// Workers use the same durable native dispatch and Git guard, without a Root
/// bridge capability. An Advisor gets only its report bridge and runs read-only.
pub fn dispatch_codex_worker<F>(
    input: WorkerCodexLaunch<'_>,
    claim: F,
) -> Result<crate::runtimes::native::PromptObservation, Box<dyn Error>>
where
    F: FnOnce(&str) -> Result<bool, Box<dyn Error>>,
{
    let directory =
        crate::runtimes::native::session_directory(input.database_path, input.session_id)?;
    require_absent(&directory, input.native_session_id, input.turn_id)?;
    let codex = executable::resolve_codex_executable(input.codex_executable)?;
    let (git, gh) = git_guard::resolve_guard_binaries(input.inherited_environment)?;
    let guard = git_guard::create_git_command_guard(
        &directory,
        &git,
        gh.as_deref(),
        input.inherited_environment,
    )?;
    let suplex = std::env::current_exe()?;
    let suplex = suplex
        .to_str()
        .ok_or_else(|| io::Error::other("Suplex executable path is invalid"))?;
    let server_args = ["mcp".to_owned(), "advisor".to_owned()];
    let server_names = [
        bridge_auth::ADVISOR_BINDING_ENV.to_owned(),
        bridge_auth::ADVISOR_TOKEN_ENV.to_owned(),
    ];
    let (bridge_environment, additions) = match input.advisor {
        Some(role) => {
            let binding = advisor_bridge::write_binding(&directory, role, suplex)?;
            let result = advisor_bridge::advisor_result_path(&directory, input.turn_id)?;
            (
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
            )
        }
        None => (None, HashMap::new()),
    };
    let server = invocation::BridgeServer {
        command: suplex,
        args: &server_args,
        environment_names: &server_names,
    };
    let environment = task_harness::task_bridge_environment(
        &guard.environment,
        bridge_environment.as_ref(),
        &additions,
    );
    let environment = task_harness::task_scope_environment(
        environment,
        input.worktree,
        input.project_environment,
    );
    let task_prompt = task_harness::task_context_prompt(
        input.prompt,
        input.project_context,
        input.project_context_path,
    );
    let prompt = match (input.advisor, input.direct, input.purpose) {
        (Some(_), _, _) => format!("{ADVISOR_ROLE_PROMPT}\n\n{task_prompt}"),
        (None, true, role_prompt::WorkerPurpose::Implementation) => {
            format!("{WORKER_DIRECT_ROLE_PROMPT}\n\n{task_prompt}")
        }
        _ => role_prompt::worker_standard_prompt(input.purpose, &task_prompt),
    };
    let (role, bridge) = if input.advisor.is_some() {
        (invocation::Role::Advisor, Some(&server))
    } else {
        (invocation::Role::Worker, None)
    };
    let session = input.session_id;
    display::show(
        input.database_path,
        session,
        input.native_session_id,
        input.worktree,
        input.model,
    );
    runtime::dispatch(
        runtime::CodexDispatch {
            directory: &directory,
            worktree: input.worktree,
            executable: &codex,
            session_id: input.native_session_id,
            turn_id: input.turn_id,
            prompt: &prompt,
            model: input.model,
            reasoning_effort: input.reasoning_effort,
            role,
            bridge,
            environment: &environment,
            excluded_environment_keys: input.excluded_environment_keys,
        },
        claim,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicBool, Ordering},
        thread,
        time::Duration,
    };

    #[test]
    fn root_binding_and_guard_reach_child_only_after_claim() {
        let base = std::env::temp_dir().join(format!("suplex-root-codex-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let database = base.join("installation.sqlite");
        let worktree = base.join("worktree");
        fs::create_dir(&worktree).unwrap();
        let context_path = base.join("prepared.txt");
        fs::write(&context_path, "Prepared context").unwrap();
        let codex = base.join("codex");
        fs::write(
            &codex,
            "#!/bin/sh\ntest -n \"$SUPLEX_ROOT_TOKEN\" || exit 21\ntest -f \"$SUPLEX_ROOT_BINDING\" || exit 22\ntest -z \"$SUPLEX_ADVISOR_TOKEN$JIRA_TOKEN\" || exit 23\ntest -x \"$SUPLEX_GIT_GUARD_DIR/git\" || exit 24\ntest \"$PROJECT_FLAG\" = yes || exit 25\ncase \"$MISE_TRUSTED_CONFIG_PATHS\" in *\":$PWD\") ;; *) exit 26 ;; esac\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"root-thread\"}' '{\"type\":\"turn.completed\"}'\n".replace(":$PWD", &format!(":{}", worktree.display())),
        )
        .unwrap();
        fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
        let identity = root_bridge::RootIdentity {
            task_id: "task_1".into(),
            session_id: "session_1".into(),
            generation: 1,
        };
        let inherited = HashMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SUPLEX_ADVISOR_TOKEN".into(), "stale-advisor".into()),
            ("MISE_TRUSTED_CONFIG_PATHS".into(), "/trusted".into()),
        ]);
        let project_environment = HashMap::from([
            ("PROJECT_FLAG".into(), "yes".into()),
            ("JIRA_TOKEN".into(), "secret".into()),
        ]);
        let excluded = ["JIRA_TOKEN".to_owned()];
        let launch = RootCodexLaunch {
            database_path: &database,
            artifact_root: &base,
            identity: &identity,
            native_session_id: "codex-root-1",
            turn_id: "msg_first",
            worktree: &worktree,
            prompt: "Inspect the worktree",
            project_context: Some("Project instructions"),
            project_context_path: Some(&context_path),
            project_environment: &project_environment,
            excluded_environment_keys: &excluded,
            model: "gpt-6-sol",
            reasoning_effort: "medium",
            codex_executable: Some(&codex),
            inherited_environment: &inherited,
            standard: true,
        };
        let claimed = AtomicBool::new(false);
        let result = dispatch_codex_root(launch, |generation| {
            assert!(!generation.is_empty());
            let directory =
                crate::runtimes::native::session_directory(&database, &identity.session_id)?;
            assert!(directory.join("root.binding.json").exists());
            assert!(!directory.join("turn.json").exists());
            claimed.store(true, Ordering::SeqCst);
            Ok(true)
        })
        .unwrap();
        assert!(claimed.load(Ordering::SeqCst));
        assert!(result.admission_observed);
        let directory =
            crate::runtimes::native::session_directory(&database, &identity.session_id).unwrap();
        let prompt = fs::read_to_string(crate::runtimes::headless::turn_file(
            &directory,
            "msg_first",
            "prompt",
        ))
        .unwrap();
        assert!(
            prompt.contains("Project instructions\n\nPrepared context\n\nInspect the worktree")
        );
        let exit = crate::runtimes::headless::turn_file(&directory, "msg_first", "exit");
        for _ in 0..60 {
            if let Ok(status) = fs::read_to_string(&exit) {
                assert_eq!(status.trim(), "0");
                assert_eq!(
                    runtime::observe(
                        &directory,
                        "codex-root-1",
                        "msg_first",
                        crate::runtimes::native::DispatchState::Ambiguous,
                        None,
                    )
                    .unwrap()
                    .state,
                    crate::runtimes::native::PromptState::Completed
                );
                fs::remove_dir_all(base).unwrap();
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("fake Codex did not exit");
    }

    #[test]
    fn refused_claim_does_not_launch_codex() {
        let base =
            std::env::temp_dir().join(format!("suplex-root-refusal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let database = base.join("installation.sqlite");
        let worktree = base.join("worktree");
        fs::create_dir(&worktree).unwrap();
        let marker = base.join("launched");
        let codex = base.join("codex");
        fs::write(&codex, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
        let identity = root_bridge::RootIdentity {
            task_id: "task_refusal".into(),
            session_id: "session_refusal".into(),
            generation: 1,
        };
        let inherited = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        let result = dispatch_codex_root(
            RootCodexLaunch {
                database_path: &database,
                artifact_root: &base,
                identity: &identity,
                native_session_id: "codex-root-refusal",
                turn_id: "msg_refusal",
                worktree: &worktree,
                prompt: "Inspect",
                project_context: None,
                project_context_path: None,
                project_environment: &HashMap::new(),
                excluded_environment_keys: &[],
                model: "gpt-6-sol",
                reasoning_effort: "medium",
                codex_executable: Some(&codex),
                inherited_environment: &inherited,
                standard: true,
            },
            |_| Ok(false),
        );
        assert!(result.is_err());
        assert!(!marker.exists());
        let directory =
            crate::runtimes::native::session_directory(&database, &identity.session_id).unwrap();
        assert!(!directory.join("turn.json").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn advisor_launch_is_read_only_with_only_the_report_bridge() {
        let base =
            std::env::temp_dir().join(format!("suplex-advisor-codex-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let database = base.join("installation.sqlite");
        let worktree = base.join("worktree");
        fs::create_dir(&worktree).unwrap();
        let codex = base.join("codex");
        fs::write(
            &codex,
            "#!/bin/sh\ntest -z \"$SUPLEX_ROOT_TOKEN$SUPLEX_ROOT_BINDING\" || exit 21\ntest -n \"$SUPLEX_ADVISOR_TOKEN\" || exit 22\ntest -f \"$SUPLEX_ADVISOR_BINDING\" || exit 23\ncase \"$SUPLEX_ADVISOR_RESULT\" in *turn-msg_advisor.advisor-report.json) ;; *) exit 24 ;; esac\ncase \"$*\" in *'sandbox_mode=\"read-only\"'*'mcp_servers.suplex_advisor='*) ;; *) exit 25 ;; esac\ngrep -q 'read-only Suplex Advisor' || exit 26\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"advisor-thread\"}'\nsleep 0.3\nprintf '%s\\n' '{\"type\":\"turn.completed\"}'\n",
        )
        .unwrap();
        fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
        let inherited = HashMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SUPLEX_ROOT_TOKEN".into(), "stale-root".into()),
        ]);
        let result = dispatch_codex_worker(
            WorkerCodexLaunch {
                database_path: &database,
                session_id: "advisor_session",
                native_session_id: "codex-advisor-1",
                turn_id: "msg_advisor",
                worktree: &worktree,
                prompt: "Review the change",
                project_context: None,
                project_context_path: None,
                project_environment: &HashMap::new(),
                excluded_environment_keys: &[],
                purpose: role_prompt::WorkerPurpose::Implementation,
                model: "gpt-6-sol",
                reasoning_effort: "medium",
                codex_executable: Some(&codex),
                inherited_environment: &inherited,
                direct: false,
                advisor: Some(AdvisorRole::Reviewer),
            },
            |_| Ok(true),
        )
        .unwrap();
        assert!(result.admission_observed);
        let directory =
            crate::runtimes::native::session_directory(&database, "advisor_session").unwrap();
        let exit = crate::runtimes::headless::turn_file(&directory, "msg_advisor", "exit");
        for _ in 0..60 {
            if let Ok(status) = fs::read_to_string(&exit) {
                assert_eq!(status.trim(), "0");
                assert_eq!(
                    runtime::observe(
                        &directory,
                        "codex-advisor-1",
                        "msg_advisor",
                        crate::runtimes::native::DispatchState::Ambiguous,
                        None,
                    )
                    .unwrap()
                    .state,
                    crate::runtimes::native::PromptState::Completed
                );
                fs::remove_dir_all(base).unwrap();
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("fake Advisor Codex did not exit");
    }

    #[test]
    fn worker_launch_has_write_scope_and_no_bridge_capability() {
        let base =
            std::env::temp_dir().join(format!("suplex-worker-codex-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let database = base.join("installation.sqlite");
        let worktree = base.join("worktree");
        fs::create_dir(&worktree).unwrap();
        let codex = base.join("codex");
        fs::write(
            &codex,
            "#!/bin/sh\ntest -z \"$SUPLEX_ROOT_TOKEN$SUPLEX_ROOT_BINDING$SUPLEX_ADVISOR_TOKEN$SUPLEX_ADVISOR_BINDING\" || exit 21\ntest -x \"$SUPLEX_GIT_GUARD_DIR/git\" || exit 22\ncase \"$*\" in *'sandbox_mode=\"danger-full-access\"'*) ;; *) exit 23 ;; esac\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"worker-thread\"}' '{\"type\":\"turn.completed\"}'\n",
        )
        .unwrap();
        fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
        let inherited = HashMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SUPLEX_ROOT_TOKEN".into(), "stale-root".into()),
            ("SUPLEX_ADVISOR_TOKEN".into(), "stale-advisor".into()),
        ]);
        let result = dispatch_codex_worker(
            WorkerCodexLaunch {
                database_path: &database,
                session_id: "worker_session",
                native_session_id: "codex-worker-1",
                turn_id: "msg_worker",
                worktree: &worktree,
                prompt: "Implement the assignment",
                project_context: None,
                project_context_path: None,
                project_environment: &HashMap::new(),
                excluded_environment_keys: &[],
                purpose: role_prompt::WorkerPurpose::Implementation,
                model: "gpt-6-sol",
                reasoning_effort: "medium",
                codex_executable: Some(&codex),
                inherited_environment: &inherited,
                direct: false,
                advisor: None,
            },
            |_| Ok(true),
        )
        .unwrap();
        assert!(result.admission_observed);
        let directory =
            crate::runtimes::native::session_directory(&database, "worker_session").unwrap();
        let exit = crate::runtimes::headless::turn_file(&directory, "msg_worker", "exit");
        for _ in 0..60 {
            if let Ok(status) = fs::read_to_string(&exit) {
                assert_eq!(status.trim(), "0");
                fs::remove_dir_all(base).unwrap();
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("fake Worker Codex did not exit");
    }
}
