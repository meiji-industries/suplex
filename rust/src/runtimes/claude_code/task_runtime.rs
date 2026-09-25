//! Claude Code has no server. Each prompt runs as one detached headless
//! `claude -p --resume` process whose stream-json output is the turn record;
//! the transcript Claude Code keeps under its config directory is the session.

use crate::shared::fs::read_optional;
use std::{collections::HashMap, error::Error, fs, io, os::unix::fs::PermissionsExt, path::Path};

use serde_json::{Value, json};

use super::{
    environment::{claude_environment, claude_settings_arguments},
    transcript::{self, ClaudeMessageEntry},
};
use crate::{
    coordination::{advisor_bridge, bridge_auth, root_bridge},
    profiles::agent_profiles::home_directory,
    runtimes::{
        codex::runtime as headless_observation,
        git_guard, headless,
        project_mcp::{project_mcp_servers, project_mcp_tools},
        task_harness::{
            DispatchClaim, DispatchState, ExecutableSpec, GH_EXECUTABLE, PromptObservation,
            PromptState, TaskHarness, TaskRole, TaskScope, recover_headless_dispatch,
            resolve_executable, task_scope_environment,
        },
    },
};

pub const CLAUDE_EXECUTABLE: ExecutableSpec = ExecutableSpec {
    label: "Claude Code",
    binary: "claude",
    env_var: "SUPLEX_CLAUDE_COMMAND",
    home_paths: &[".local/bin/claude", ".claude/local/claude"],
    fallback_paths: &[],
};

const ROOT_TOOLS: &str = "Read,Glob,Grep,WebFetch,WebSearch,TodoWrite";
const WORKER_TOOLS: &str =
    "Bash,Read,Write,Edit,Glob,Grep,NotebookEdit,WebFetch,WebSearch,TodoWrite,Skill";

/// TypeScript `claudeArguments` for a printed Standard turn.
pub fn claude_arguments(
    scope: &TaskScope<'_>,
    session_id: &str,
    resume: bool,
    runtime_directory: &Path,
) -> Vec<String> {
    let role = scope.workflow.role_name(scope.role);
    let mcp_tools = project_mcp_tools(scope.project_mcp, role);
    let has_project_mcp = scope
        .project_mcp
        .and_then(Value::as_array)
        .is_some_and(|servers| !servers.is_empty());
    let mut args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompts",
        "none",
        if resume { "--resume" } else { "--session-id" },
        session_id,
        "--model",
        scope.model,
        "--effort",
        scope.reasoning_effort,
    ]
    .map(str::to_owned)
    .to_vec();
    args.extend(claude_settings_arguments(
        scope.instance_home_directory.is_some() || has_project_mcp,
    ));
    let role_prompt = scope.workflow.role_prompt(scope.role);
    let mcp_config = if role != "worker" || !mcp_tools.is_empty() {
        runtime_directory
            .join("mcp.json")
            .to_string_lossy()
            .into_owned()
    } else {
        r#"{"mcpServers":{}}"#.to_owned()
    };
    args.extend([
        "--append-system-prompt".into(),
        role_prompt.into(),
        "--strict-mcp-config".into(),
        "--mcp-config".into(),
        mcp_config,
    ]);
    if scope.project_context_path.is_some() || scope.workflow.reads_evidence(scope.role) {
        args.extend([
            "--add-dir".into(),
            scope.evidence_root().to_string_lossy().into_owned(),
        ]);
    }
    if let Some(context) = scope.project_context_path {
        args.extend([
            "--add-dir".into(),
            context
                .parent()
                .unwrap_or(Path::new("/"))
                .to_string_lossy()
                .into_owned(),
        ]);
    }
    if role != "worker" {
        let bridge = if role == "root" {
            "mcp__suplex_root"
        } else {
            "mcp__suplex_advisor__submit_report"
        };
        let allowed = [bridge, "WebFetch", "WebSearch"]
            .map(str::to_owned)
            .into_iter()
            .chain(mcp_tools)
            .collect::<Vec<_>>()
            .join(",");
        args.extend(
            [
                "--tools",
                ROOT_TOOLS,
                "--permission-mode",
                "dontAsk",
                "--allowedTools",
            ]
            .map(str::to_owned),
        );
        args.push(allowed);
    } else {
        args.extend(["--disallowedTools".into(), "Agent,AskUserQuestion".into()]);
        if mcp_tools.is_empty() {
            args.push("--dangerously-skip-permissions".into());
        } else {
            args.extend(["--permission-mode", "dontAsk", "--allowedTools"].map(str::to_owned));
            args.push(
                std::iter::once(WORKER_TOOLS.to_owned())
                    .chain(mcp_tools)
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
    }
    args
}

fn turn_values(directory: &Path, turn_id: &str) -> io::Result<Vec<Value>> {
    Ok(transcript::parse_json_lines(
        &read_optional(&headless::turn_file(directory, turn_id, "jsonl"))?.unwrap_or_default(),
    ))
}

fn observation(state: PromptState, reason: &'static str) -> PromptObservation {
    PromptObservation {
        state,
        admission_observed: false,
        retry_allowed: false,
        reason,
        unsettled_tool_ids: Vec::new(),
        native_final_observed: false,
        process_running: false,
        execution_uncertain: false,
    }
}

/// Claude Code creates the transcript on the first prompt; until then the
/// session is only a reserved identity. `mcp.json` carries the current bridge.
fn prepare_session(
    scope: &TaskScope<'_>,
    directory: &Path,
    environment: &HashMap<String, String>,
) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let role = scope.workflow.role_name(scope.role);
    if scope.workflow.reads_evidence(scope.role) {
        fs::create_dir_all(scope.evidence_root())?;
        fs::set_permissions(scope.evidence_root(), fs::Permissions::from_mode(0o700))?;
    }
    let mut servers = project_mcp_servers(scope.project_mcp, role, environment)?;
    if let (TaskRole::Worker(_), Some(advisor)) = (scope.role, scope.workflow.advisor) {
        let suplex = std::env::current_exe()?;
        let suplex = suplex
            .to_str()
            .ok_or_else(|| io::Error::other("Suplex executable path is invalid"))?;
        let binding = advisor_bridge::write_binding(directory, advisor, suplex)?;
        servers.insert(
            "suplex_advisor".into(),
            json!({"type":"stdio","command":suplex,"args":["mcp","advisor"],"env":{
                bridge_auth::ADVISOR_BINDING_ENV: binding.binding_path,
                bridge_auth::ADVISOR_TOKEN_ENV: binding.token,
            }}),
        );
    }
    if let TaskRole::Root(identity) = scope.role {
        let suplex = std::env::current_exe()?;
        let suplex = suplex
            .to_str()
            .ok_or_else(|| io::Error::other("Suplex executable path is invalid"))?;
        let binding = root_bridge::write_binding(
            directory,
            identity,
            scope.database_path,
            scope.artifact_root,
            suplex,
        )?;
        let mut env = json!({
            bridge_auth::ROOT_BINDING_ENV: binding.binding_path,
            bridge_auth::ROOT_TOKEN_ENV: binding.token,
        });
        if let Ok(gh) = resolve_executable(
            &GH_EXECUTABLE,
            None,
            environment,
            home_directory().as_deref(),
        ) {
            env["SUPLEX_GH_COMMAND"] = json!(gh);
        }
        servers.insert(
            "suplex_root".into(),
            json!({"type":"stdio","command":suplex,"args":["mcp","root"],"env":env}),
        );
    }
    crate::shared::fs::write_private(
        &directory.join("mcp.json"),
        json!({"mcpServers":servers}).to_string().as_bytes(),
    )
}

fn last_assistant(entries: &[ClaudeMessageEntry]) -> Option<&ClaudeMessageEntry> {
    entries.iter().rev().find(|entry| entry.kind == "assistant")
}

/// TypeScript `ClaudeCodeTaskRuntime`.
pub struct ClaudeCodeTaskRuntime;

impl TaskHarness for ClaudeCodeTaskRuntime {
    fn new_session_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn observe(
        &self,
        directory: &Path,
        native_session_id: &str,
        turn_id: &str,
        dispatch: DispatchState,
        generation: Option<&str>,
    ) -> io::Result<PromptObservation> {
        let record = headless_observation::admitted_record(directory, turn_id, generation)?;
        let log = read_optional(&headless::turn_file(directory, turn_id, "jsonl"))?;
        let Some(record) = record else {
            let replayable = matches!(
                dispatch,
                DispatchState::NotSubmitted | DispatchState::Rejected
            );
            return Ok(if log.is_some() {
                PromptObservation {
                    execution_uncertain: true,
                    ..observation(PromptState::Unknown, "dispatch_identity_missing")
                }
            } else {
                PromptObservation {
                    retry_allowed: replayable,
                    ..observation(
                        PromptState::Unknown,
                        if replayable {
                            "message_not_observed"
                        } else {
                            "admission_ambiguous"
                        },
                    )
                }
            });
        };
        if record.session_id != native_session_id {
            return Ok(observation(
                PromptState::Unknown,
                "session_identity_conflict",
            ));
        }
        let values = transcript::parse_json_lines(log.as_deref().unwrap_or_default());
        let entries = transcript::message_entries(&values);
        let result = transcript::stream_result(&values);
        let mut observed = PromptObservation {
            admission_observed: true,
            unsettled_tool_ids: transcript::unsettled_tool_ids(&entries)
                .into_iter()
                .take(32)
                .collect(),
            native_final_observed: result.is_some(),
            ..observation(PromptState::Running, "dispatch_process_running")
        };
        if let Some(result) = result {
            (observed.state, observed.reason) = if result.is_error || result.subtype != "success" {
                (PromptState::Error, "native_error")
            } else {
                (PromptState::Completed, "native_turn_completed")
            };
        } else if headless::running(&record)? {
            observed.process_running = true;
        } else if transcript::stream_init(&values).is_none() {
            (observed.state, observed.reason) = (PromptState::Error, "native_startup_failed");
        } else if !observed.unsettled_tool_ids.is_empty() {
            (observed.state, observed.reason) =
                (PromptState::Unknown, "tool_execution_after_process_stopped");
            observed.execution_uncertain = true;
        } else {
            (observed.state, observed.reason) =
                (PromptState::Interrupted, "dispatch_process_stopped");
        }
        Ok(observed)
    }

    fn dispatch(
        &self,
        scope: &TaskScope<'_>,
        turn_id: &str,
        prompt: &str,
        claim: DispatchClaim<'_>,
    ) -> Result<PromptObservation, Box<dyn Error>> {
        let directory = scope.runtime_directory()?;
        let before = self.observe(
            &directory,
            scope.native_session_id,
            turn_id,
            DispatchState::NotSubmitted,
            None,
        )?;
        if !before.retry_allowed {
            return Err(io::Error::other(
                "Claude Code prompt was not proven absent; replay is blocked",
            )
            .into());
        }
        let executable = resolve_executable(
            &CLAUDE_EXECUTABLE,
            scope.executable,
            scope.inherited_environment,
            home_directory().as_deref(),
        )?;
        prepare_session(scope, &directory, scope.inherited_environment)?;
        let config = scope.instance_home_directory.map_or_else(
            || transcript::config_directory(scope.inherited_environment),
            Path::to_path_buf,
        );
        let resume = transcript::find_transcript(scope.native_session_id, &config)?.is_some();
        let inherited = match (scope.role, scope.workflow.advisor) {
            (TaskRole::Worker(_), None) => {
                let (git, gh) = git_guard::resolve_guard_binaries(scope.inherited_environment)?;
                git_guard::create_git_command_guard(
                    &directory,
                    &git,
                    gh.as_deref(),
                    scope.inherited_environment,
                )?
                .environment
            }
            _ => scope.inherited_environment.clone(),
        };
        let environment = task_scope_environment(
            claude_environment(scope.instance_home_directory, &inherited),
            scope.worktree,
            scope.project_environment,
        );
        let args = claude_arguments(scope, scope.native_session_id, resume, &directory);
        if let Ok(display) = super::display::claude_display_command(&directory) {
            let attached =
                |argv: &[String]| super::display::claude_display_attached(&directory, argv);
            crate::runtimes::task_display::show_scope(
                scope,
                "claude-code",
                &display.command,
                &attached,
            );
        }
        let record = headless::dispatch_with_exclusions(
            headless::DispatchInput {
                directory: &directory,
                worktree: scope.worktree,
                session_id: scope.native_session_id,
                turn_id,
                executable: &executable,
                args: &args,
                prompt,
                environment: &environment,
            },
            scope.excluded_environment_keys,
            claim,
        )?;
        Ok(self.observe(
            &directory,
            scope.native_session_id,
            turn_id,
            DispatchState::Ambiguous,
            Some(&record.generation),
        )?)
    }

    fn recover_dispatch(
        &self,
        directory: &Path,
        native_session_id: &str,
        turn_id: &str,
        generation: &str,
    ) -> io::Result<PromptObservation> {
        recover_headless_dispatch(directory, generation)?;
        self.observe(
            directory,
            native_session_id,
            turn_id,
            DispatchState::NotSubmitted,
            Some(generation),
        )
    }

    fn result_text(&self, directory: &Path, turn_id: &str) -> io::Result<String> {
        let values = turn_values(directory, turn_id)?;
        let text = transcript::stream_result(&values)
            .and_then(|result| result.result)
            .unwrap_or_else(|| transcript::assistant_text(&transcript::message_entries(&values)));
        if !text.is_empty() {
            return Ok(text);
        }
        let stderr = read_optional(&headless::turn_file(directory, turn_id, "stderr.log"))?
            .unwrap_or_default();
        let stderr = stderr.trim();
        let skip = stderr.chars().count().saturating_sub(2_000);
        Ok(stderr.chars().skip(skip).collect())
    }

    fn native(&self, directory: &Path, turn_id: &str, mut base: Value) -> io::Result<Value> {
        let values = turn_values(directory, turn_id)?;
        let entries = transcript::message_entries(&values);
        base["providerID"] = json!("claude-code");
        if let Some(last) = last_assistant(&entries) {
            base["messageID"] = json!(last.uuid);
        }
        if let Some((cwd, model)) = transcript::stream_init(&values) {
            base["modelID"] = json!(model);
            base["cwd"] = json!(cwd);
        }
        if let Some(result) = transcript::stream_result(&values) {
            base["finish"] = json!(result.subtype);
            if result.is_error {
                base["error"] = json!({"name":result.subtype});
            }
        }
        Ok(base)
    }

    fn stop(&self, directory: &Path, native_session_id: Option<&str>) -> io::Result<()> {
        headless::stop_session(directory, native_session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::codex::session_reader;
    use crate::runtimes::task_harness::WorkerPurpose;
    use std::path::PathBuf;
    use std::{thread, time::Duration};

    const SESSION: &str = "71618050-0d31-428e-a547-d6c4a2eca88f";

    struct Fixture {
        root: PathBuf,
        worktree: PathBuf,
        database: PathBuf,
        executable: PathBuf,
        inherited: HashMap<String, String>,
        empty: HashMap<String, String>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn line(value: Value) -> String {
        format!("echo '{value}'")
    }

    fn fixture(behaviour: &str) -> Fixture {
        let root =
            std::env::temp_dir().join(format!("suplex-claude-runtime-{}", uuid::Uuid::new_v4()));
        let worktree = root.join("worktree");
        let config = root.join("claude-config");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(config.join("projects")).unwrap();
        let init = |model: &str| {
            line(
                json!({"type":"system","subtype":"init","session_id":SESSION,"cwd":worktree,"model":model,"tools":[]}),
            )
        };
        let script = match behaviour {
            "complete" => vec![
                init("claude-haiku-4-5-20251001"),
                line(
                    json!({"type":"assistant","uuid":"a1","session_id":SESSION,"message":{"role":"assistant","model":"claude-haiku-4-5-20251001","id":"msg_1","content":[{"type":"text","text":"Reviewed."}]}}),
                ),
                line(
                    json!({"type":"result","subtype":"success","is_error":false,"result":"Reviewed the change.","session_id":SESSION,"uuid":"r1"}),
                ),
            ],
            "hang" => vec![
                init("m"),
                line(
                    json!({"type":"assistant","uuid":"a1","session_id":SESSION,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"sleep"}}]}}),
                ),
                "sleep 30".into(),
                "exit 0".into(),
            ],
            "crash" => vec![init("m"), "exit 1".into()],
            _ => vec!["echo 'Error: Not logged in' >&2".into(), "exit 1".into()],
        };
        let executable = root.join("claude");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SUPLEX_TEST_ARGS\"\nprintf '%s|%s|%s|%s|%s' \"$CLAUDE_CONFIG_DIR\" \"$ANTHROPIC_API_KEY\" \"$ANTHROPIC_CONFIG_DIR\" \"$SUPLEX_CLAUDE_ENV_SENTINEL\" \"$SUPLEX_GIT_GUARD_DIR\" > \"$SUPLEX_TEST_CONFIG_DIR\"\ncat > \"$SUPLEX_TEST_PROMPT\"\n{}\n",
                script.join("\n")
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let mut inherited = std::env::vars().collect::<HashMap<_, _>>();
        for (name, value) in [
            ("SUPLEX_TEST_ARGS", root.join("args.txt")),
            ("SUPLEX_TEST_PROMPT", root.join("prompt.txt")),
            ("SUPLEX_TEST_CONFIG_DIR", root.join("config-dir.txt")),
            ("CLAUDE_CONFIG_DIR", config),
        ] {
            inherited.insert(name.into(), value.to_string_lossy().into_owned());
        }
        inherited.insert("ANTHROPIC_API_KEY".into(), "global-fixture".into());
        inherited.insert("SUPLEX_CLAUDE_ENV_SENTINEL".into(), "sentinel".into());
        Fixture {
            database: root.join("suplex.sqlite"),
            root,
            worktree,
            executable,
            inherited,
            empty: HashMap::new(),
        }
    }

    fn scope<'a>(
        f: &'a Fixture,
        session_id: &'a str,
        role: TaskRole<'a>,
        instance: Option<&'a Path>,
    ) -> TaskScope<'a> {
        TaskScope {
            workflow: Default::default(),
            database_path: &f.database,
            artifact_root: &f.root,
            task_id: "task-claude",
            session_id,
            native_session_id: SESSION,
            role,
            worktree: &f.worktree,
            model: "haiku",
            reasoning_effort: "low",
            instance_home_directory: instance,
            project_mcp: None,
            project_context_path: None,
            project_environment: &f.empty,
            excluded_environment_keys: &[],
            executable: Some(&f.executable),
            inherited_environment: &f.inherited,
        }
    }

    fn worker(f: &Fixture) -> TaskScope<'_> {
        scope(
            f,
            "session-claude",
            TaskRole::Worker(WorkerPurpose::Implementation),
            None,
        )
    }

    fn settle(scope: &TaskScope<'_>, generation: Option<&str>) -> PromptObservation {
        let directory = scope.runtime_directory().unwrap();
        for _ in 0..100 {
            let observed = ClaudeCodeTaskRuntime
                .observe(
                    &directory,
                    SESSION,
                    "msg_turn",
                    DispatchState::Ambiguous,
                    generation,
                )
                .unwrap();
            if observed.state != PromptState::Running {
                return observed;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("fake Claude did not settle");
    }

    fn dispatch(scope: &TaskScope<'_>) -> Result<PromptObservation, Box<dyn Error>> {
        ClaudeCodeTaskRuntime.dispatch(scope, "msg_turn", "Implement the change", &mut |_| Ok(true))
    }

    #[test]
    fn a_headless_turn_is_dispatched_once_observed_from_its_stream_and_reported_as_the_result() {
        let f = fixture("complete");
        let scope = worker(&f);
        let directory = scope.runtime_directory().unwrap();
        assert!(uuid::Uuid::try_parse(&ClaudeCodeTaskRuntime.new_session_id()).is_ok());
        let before = ClaudeCodeTaskRuntime
            .observe(
                &directory,
                SESSION,
                "msg_turn",
                DispatchState::NotSubmitted,
                None,
            )
            .unwrap();
        assert_eq!(
            (
                before.state,
                before.admission_observed,
                before.retry_allowed
            ),
            (PromptState::Unknown, false, true)
        );
        let mut claims = Vec::new();
        let dispatched = ClaudeCodeTaskRuntime
            .dispatch(
                &scope,
                "msg_turn",
                "Implement the change",
                &mut |generation| {
                    claims.push(generation.to_owned());
                    Ok(true)
                },
            )
            .unwrap();
        assert_eq!(claims.len(), 1);
        assert!(dispatched.admission_observed);
        let observed = settle(&scope, Some(&claims[0]));
        assert_eq!(
            (observed.state, observed.retry_allowed),
            (PromptState::Completed, false)
        );
        assert_eq!(
            fs::read_to_string(f.root.join("prompt.txt")).unwrap(),
            "Implement the change"
        );
        let args = fs::read_to_string(f.root.join("args.txt")).unwrap();
        let args = args.trim().split('\n').collect::<Vec<_>>();
        for expected in [
            "-p",
            "--include-partial-messages",
            "--session-id",
            SESSION,
            "--model",
            "haiku",
            "--effort",
            "low",
            "--dangerously-skip-permissions",
        ] {
            assert!(args.contains(&expected), "{expected}");
        }
        assert!(!args.contains(&"--resume"));
        let native = ClaudeCodeTaskRuntime
            .native(&directory, "msg_turn", json!({"messageID":"msg_turn"}))
            .unwrap();
        assert_eq!(
            native,
            json!({"messageID":"a1","providerID":"claude-code","modelID":"claude-haiku-4-5-20251001","cwd":f.worktree,"finish":"success"})
        );
        assert_eq!(
            ClaudeCodeTaskRuntime
                .result_text(&directory, "msg_turn")
                .unwrap(),
            "Reviewed the change."
        );
        assert!(
            dispatch(&scope)
                .unwrap_err()
                .to_string()
                .contains("replay is blocked")
        );
        assert!(!session_reader::busy(&directory).unwrap());
    }

    #[test]
    fn a_local_claude_instance_supplies_its_config_directory_and_isolates_auth() {
        let f = fixture("complete");
        let local = f.root.join("provider-instances/local");
        fs::create_dir_all(local.join("projects/worktree")).unwrap();
        let scope = scope(
            &f,
            "session-claude",
            TaskRole::Worker(WorkerPurpose::Implementation),
            Some(&local),
        );
        dispatch(&scope).unwrap();
        settle(&scope, None);
        let observed = fs::read_to_string(f.root.join("config-dir.txt")).unwrap();
        let fields = observed.split('|').collect::<Vec<_>>();
        assert_eq!(fields[0], local.to_string_lossy());
        assert_eq!(
            fields[1], "",
            "a dedicated instance removes inherited credentials"
        );
        assert_eq!(fields[2], local.join("anthropic").to_string_lossy());
        assert_eq!(fields[3], "sentinel");
        assert!(
            !fields[4].is_empty(),
            "the Worker runs behind the Git guard"
        );
        let args = fs::read_to_string(f.root.join("args.txt")).unwrap();
        assert!(args.contains("--setting-sources\n\n"));
        fs::write(local.join(format!("projects/worktree/{SESSION}.jsonl")), "").unwrap();
        assert_eq!(
            transcript::find_transcript(SESSION, &local).unwrap(),
            Some(local.join(format!("projects/worktree/{SESSION}.jsonl")))
        );
    }

    #[test]
    fn root_dispatch_inherits_caller_configuration_and_writes_the_bridge_to_mcp_config() {
        let mut f = fixture("complete");
        let gh = f.root.join("gh");
        fs::write(&gh, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o700)).unwrap();
        f.inherited.insert(
            "SUPLEX_GH_COMMAND".into(),
            gh.to_string_lossy().into_owned(),
        );
        let identity = root_bridge::RootIdentity {
            task_id: "task-claude".into(),
            session_id: "session-root".into(),
            generation: 1,
        };
        let scope = scope(&f, "session-root", TaskRole::Root(&identity), None);
        dispatch(&scope).unwrap();
        assert_eq!(settle(&scope, None).state, PromptState::Completed);
        let observed = fs::read_to_string(f.root.join("config-dir.txt")).unwrap();
        let fields = observed.split('|').collect::<Vec<_>>();
        assert_eq!(fields[0], f.inherited["CLAUDE_CONFIG_DIR"]);
        assert_eq!(fields[1], "global-fixture");
        assert_eq!(fields[4], "", "the read-only Coordinator has no Git guard");
        let directory = scope.runtime_directory().unwrap();
        let config: Value =
            serde_json::from_str(&fs::read_to_string(directory.join("mcp.json")).unwrap()).unwrap();
        let server = &config["mcpServers"]["suplex_root"];
        assert_eq!(server["args"], json!(["mcp", "root"]));
        assert!(
            server["env"]["SUPLEX_ROOT_BINDING"]
                .as_str()
                .unwrap()
                .ends_with("root.binding.json")
        );
        assert!(
            uuid::Uuid::try_parse(server["env"]["SUPLEX_ROOT_TOKEN"].as_str().unwrap()).is_ok()
        );
        assert_eq!(server["env"]["SUPLEX_GH_COMMAND"], json!(gh));
        let args = claude_arguments(&scope, SESSION, true, Path::new("/runtime"));
        for expected in [
            "--tools",
            "--allowedTools",
            "mcp__suplex_root,WebFetch,WebSearch",
            "--mcp-config",
            "/runtime/mcp.json",
            "--strict-mcp-config",
            "--permission-prompts",
            "none",
            "--resume",
        ] {
            assert!(args.iter().any(|arg| arg == expected), "{expected}");
        }
        assert!(
            !args
                .iter()
                .any(|arg| arg == "--dangerously-skip-permissions")
        );
        assert!(
            args[args
                .iter()
                .position(|arg| arg == "--append-system-prompt")
                .unwrap()
                + 1]
            .starts_with(" When you need a decision")
        );
    }

    #[test]
    fn an_advisor_runs_read_only_with_its_report_bridge_and_the_workflow_evidence() {
        let f = fixture("complete");
        let mut scope = scope(
            &f,
            "session-advisor",
            TaskRole::Worker(WorkerPurpose::Implementation),
            None,
        );
        scope.workflow.advisor = Some(crate::coordination::advisor_bridge::AdvisorRole::Reviewer);
        let directory = scope.runtime_directory().unwrap();
        prepare_session(&scope, &directory, &f.inherited).unwrap();
        let config: Value =
            serde_json::from_slice(&fs::read(directory.join("mcp.json")).unwrap()).unwrap();
        let bridge = &config["mcpServers"]["suplex_advisor"];
        assert_eq!(bridge["args"], json!(["mcp", "advisor"]));
        assert!(bridge["env"][bridge_auth::ADVISOR_TOKEN_ENV].is_string());
        assert!(config["mcpServers"]["suplex_root"].is_null());
        assert!(scope.evidence_root().is_dir());
        let args = claude_arguments(&scope, "session", false, &directory);
        let after = |flag: &str| &args[args.iter().position(|arg| arg == flag).unwrap() + 1];
        assert_eq!(
            after("--append-system-prompt"),
            crate::coordination::root_prompts::ADVISOR_ROLE_PROMPT
        );
        assert_eq!(after("--tools"), ROOT_TOOLS);
        assert_eq!(
            after("--allowedTools"),
            "mcp__suplex_advisor__submit_report,WebFetch,WebSearch"
        );
        assert_eq!(after("--add-dir"), &scope.evidence_root().to_string_lossy());
        assert!(
            !args
                .iter()
                .any(|arg| arg == "--dangerously-skip-permissions")
        );
        // A Direct build Worker keeps Worker tools with the Direct role prompt.
        scope.workflow = crate::runtimes::task_harness::WorkflowLaunch {
            direct: true,
            ..Default::default()
        };
        let args = claude_arguments(&scope, "session", false, &directory);
        assert_eq!(
            args[args
                .iter()
                .position(|arg| arg == "--append-system-prompt")
                .unwrap()
                + 1],
            crate::coordination::root_prompts::WORKER_DIRECT_ROLE_PROMPT
        );
        assert!(
            args.iter()
                .any(|arg| arg == "--dangerously-skip-permissions")
        );
    }

    #[test]
    fn mcp_worker_grants_never_run_with_permission_bypass() {
        let f = fixture("complete");
        let servers = json!([{"name":"context7","transport":{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"CONTEXT7_TOKEN"}},"grants":{"root":["query_docs"],"advisor":[],"worker":["query_docs","resolve_library_id"]}}]);
        let mut scope = scope(
            &f,
            "s",
            TaskRole::Worker(WorkerPurpose::Implementation),
            Some(Path::new("/dedicated")),
        );
        scope.project_mcp = Some(&servers);
        let args = claude_arguments(&scope, "session", true, Path::new("/runtime"));
        assert!(
            !args
                .iter()
                .any(|arg| arg == "--dangerously-skip-permissions")
        );
        for expected in [
            "--strict-mcp-config",
            "/runtime/mcp.json",
            "--permission-mode",
            "dontAsk",
            "--setting-sources",
            "",
        ] {
            assert!(args.iter().any(|arg| arg == expected), "{expected}");
        }
        let allowed = &args[args.iter().position(|arg| arg == "--allowedTools").unwrap() + 1];
        assert!(allowed.contains("mcp__context7__query_docs"));
        assert!(!allowed.contains("mcp__context7__*"));
        let verification = claude_arguments(
            &TaskScope {
                workflow: Default::default(),
                role: TaskRole::Worker(WorkerPurpose::Verification),
                project_mcp: None,
                ..scope
            },
            "session",
            false,
            Path::new("/runtime"),
        );
        assert!(
            verification[verification
                .iter()
                .position(|arg| arg == "--append-system-prompt")
                .unwrap()
                + 1]
            .contains("verification Worker")
        );
        assert_eq!(
            verification[verification
                .iter()
                .position(|arg| arg == "--mcp-config")
                .unwrap()
                + 1],
            r#"{"mcpServers":{}}"#
        );
    }

    #[test]
    fn a_running_turn_is_busy_until_stopped_then_reads_as_an_uncertain_execution_when_tools_were_open()
     {
        let f = fixture("hang");
        let scope = worker(&f);
        let directory = scope.runtime_directory().unwrap();
        let dispatched = dispatch(&scope).unwrap();
        assert!(dispatched.admission_observed);
        let generation = headless::read_record(&directory.join("turn.json"))
            .unwrap()
            .unwrap()
            .generation;
        let mut observed = dispatched;
        for _ in 0..100 {
            if !observed.unsettled_tool_ids.is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
            observed = ClaudeCodeTaskRuntime
                .observe(
                    &directory,
                    SESSION,
                    "msg_turn",
                    DispatchState::Ambiguous,
                    Some(&generation),
                )
                .unwrap();
        }
        assert_eq!(observed.state, PromptState::Running);
        assert_eq!(observed.unsettled_tool_ids, ["toolu_1"]);
        assert!(session_reader::busy(&directory).unwrap());
        ClaudeCodeTaskRuntime
            .stop(&directory, Some(SESSION))
            .unwrap();
        assert!(!session_reader::busy(&directory).unwrap());
        let recovered = ClaudeCodeTaskRuntime
            .recover_dispatch(&directory, SESSION, "msg_turn", &generation)
            .unwrap();
        assert_eq!(recovered.state, PromptState::Unknown);
        assert!(recovered.execution_uncertain);
    }

    #[test]
    fn a_turn_whose_process_exits_without_a_result_is_interrupted_and_a_startup_failure_surfaces_stderr()
     {
        let crashed = fixture("crash");
        let scope = worker(&crashed);
        dispatch(&scope).unwrap();
        let observed = settle(&scope, None);
        assert_eq!(
            (observed.state, observed.reason),
            (PromptState::Interrupted, "dispatch_process_stopped")
        );
        let failed = fixture("startup_failure");
        let scope = worker(&failed);
        dispatch(&scope).unwrap();
        let observed = settle(&scope, None);
        assert_eq!(
            (observed.state, observed.reason),
            (PromptState::Error, "native_startup_failed")
        );
        let text = ClaudeCodeTaskRuntime
            .result_text(&scope.runtime_directory().unwrap(), "msg_turn")
            .unwrap();
        assert!(text.contains("Not logged in"));
    }

    #[test]
    fn an_unclaimed_prompt_is_never_spawned_and_a_log_without_an_identity_is_uncertain() {
        let f = fixture("complete");
        let scope = worker(&f);
        let directory = scope.runtime_directory().unwrap();
        let refused = ClaudeCodeTaskRuntime
            .dispatch(&scope, "msg_turn", "prompt", &mut |_| Ok(false))
            .unwrap_err();
        assert!(refused.to_string().contains("claim was not acquired"));
        assert!(!directory.join("turn.json").exists());
        fs::write(directory.join("turn-msg_turn.jsonl"), "").unwrap();
        let observed = ClaudeCodeTaskRuntime
            .observe(
                &directory,
                SESSION,
                "msg_turn",
                DispatchState::Ambiguous,
                Some("b775df17-718a-4cb2-8e23-6912b8aa0d39"),
            )
            .unwrap();
        assert_eq!(
            (observed.state, observed.retry_allowed, observed.reason),
            (PromptState::Unknown, false, "dispatch_identity_missing")
        );
        assert!(observed.execution_uncertain);
    }
}
