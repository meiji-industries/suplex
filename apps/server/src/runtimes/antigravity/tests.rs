//! The turn client and dispatch against a fake `agy acp` (fixtures/fake-agy.mjs).

use std::{
    collections::HashMap,
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use serde_json::{Value, json};

use super::{
    harness::ANTIGRAVITY_TASK_RUNTIME,
    runtime, session_reader, task_runtime, transcript,
    turn::{self, McpConfig, McpServer, Role, TurnArgs},
};
use crate::{
    coordination::{advisor_bridge::AdvisorRole, root_bridge},
    runtimes::{
        headless,
        native::{DispatchState, PromptState, SessionRef},
        task_harness::{TaskHarness, TaskRole, TaskScope, WorkerPurpose, WorkflowLaunch},
    },
};

const FAKE_AGENT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/runtimes/antigravity/fixtures/fake-agy.mjs"
);
const ENTRY: &str = "runtimes::antigravity::tests::turn_process_entry";
const ENTRY_ARGS: &str = "SUPLEX_TEST_ANTIGRAVITY_TURN";

struct Fixture {
    base: PathBuf,
    agy: PathBuf,
    worktree: PathBuf,
    agent_log: PathBuf,
    environment: HashMap<String, String>,
}

fn node() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("node"))
        .find(|candidate| candidate.is_file())
        .expect("node is required for the fake Antigravity agent")
}

fn executable(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn fixture(name: &str, mode: &str) -> Fixture {
    let base = std::env::temp_dir().join(format!("suplex-agy-{name}-{}", uuid::Uuid::new_v4()));
    let worktree = base.join("worktree");
    fs::create_dir_all(&worktree).unwrap();
    let agy = base.join("agy");
    executable(
        &agy,
        &format!(
            "#!/bin/sh\nexec '{}' '{FAKE_AGENT}' \"$@\"\n",
            node().display()
        ),
    );
    let agent_log = base.join("agent.jsonl");
    let environment = HashMap::from([
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ("HOME".to_owned(), base.to_string_lossy().into_owned()),
        (
            "FAKE_AGY_STATE".to_owned(),
            base.join("state").to_string_lossy().into_owned(),
        ),
        (
            "FAKE_AGY_LOG".to_owned(),
            agent_log.to_string_lossy().into_owned(),
        ),
        ("FAKE_AGY_MODE".to_owned(), mode.to_owned()),
    ]);
    Fixture {
        base,
        agy,
        worktree,
        agent_log,
        environment,
    }
}

impl Fixture {
    fn args(&self, role: Role, model: &str, effort: &str, resume: Option<&str>) -> TurnArgs {
        TurnArgs {
            agy: self.agy.clone(),
            role,
            model: model.into(),
            effort: effort.into(),
            resume: resume.map(str::to_owned),
            mcp: None,
        }
    }

    fn run(&self, args: &TurnArgs, prompt: &str) -> (i32, Vec<Value>) {
        let mut output = Vec::new();
        let code = turn::run(args, prompt, &self.worktree, &self.environment, &mut output);
        (
            code,
            transcript::parse_events(&String::from_utf8(output).unwrap()),
        )
    }

    /// What the agent received, by method.
    fn received(&self, method: &str) -> Vec<Value> {
        fs::read_to_string(&self.agent_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|entry| entry["method"] == method)
            .map(|entry| entry["params"].clone())
            .collect()
    }

    fn launches(&self) -> Vec<Value> {
        fs::read_to_string(&self.agent_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|entry| entry.get("argv").is_some())
            .collect()
    }
}

fn of_type<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event["type"] == kind)
        .collect()
}

#[test]
fn a_first_turn_selects_model_and_thinking_and_a_later_turn_resumes_it() {
    let fixture = fixture("resume", "");
    let (code, first) = fixture.run(
        &fixture.args(Role::Worker, "gemini-b", "xhigh", None),
        "RUN_TOOL EDIT",
    );
    assert_eq!(code, 0, "{first:?}");
    let session = transcript::session_id(&first).unwrap().to_owned();
    assert_eq!(of_type(&first, "session")[0]["resumed"], false);
    assert_eq!(of_type(&first, "config")[0]["model"], "gemini-b");
    assert_eq!(of_type(&first, "config")[0]["thinking"], "extra");
    assert!(transcript::completed(&first));
    assert_eq!(
        transcript::result_text(&first),
        "Done.",
        "the answer is the text after the last tool"
    );
    let tools = transcript::native_tools(&first);
    assert_eq!(
        tools
            .iter()
            .map(|tool| (tool.name.as_str(), tool.status))
            .collect::<Vec<_>>(),
        [("execute", "completed"), ("edit", "completed")]
    );
    assert!(
        of_type(&first, "permission")
            .iter()
            .all(|event| event["outcome"] == "allow_once")
    );
    let selected = fixture.received("session/set_config_option");
    assert_eq!(
        selected
            .iter()
            .map(|params| (params["configId"].clone(), params["value"].clone()))
            .collect::<Vec<_>>(),
        [
            (json!("model"), json!("gemini-b")),
            (json!("thinking"), json!("extra"))
        ]
    );
    let launch = &fixture.launches()[0];
    assert_eq!(launch["argv"], json!(["acp"]));
    assert_eq!(launch["browser"], "false");
    assert_eq!(
        launch["cwd"],
        json!(fixture.worktree.canonicalize().unwrap())
    );

    let (code, second) = fixture.run(
        &fixture.args(Role::Worker, "gemini-b", "low", Some(&session)),
        "Continue",
    );
    assert_eq!(code, 0, "{second:?}");
    assert_eq!(transcript::session_id(&second), Some(session.as_str()));
    assert_eq!(of_type(&second, "session")[0]["resumed"], true);
    assert_eq!(fixture.received("session/resume")[0]["sessionId"], session);
    assert_eq!(fixture.received("session/new").len(), 1);
    assert!(
        transcript::result_text(&second).starts_with("Turn 2 on gemini-b/low."),
        "{}",
        transcript::result_text(&second)
    );
    // The model already matches, so only the thinking level changes.
    assert_eq!(fixture.received("session/set_config_option").len(), 3);
    fs::remove_dir_all(&fixture.base).unwrap();
}

#[test]
fn read_only_roles_reject_changes_and_reach_their_bridge_and_granted_servers() {
    let mut fixture = fixture("root", "");
    fixture
        .environment
        .insert("SUPLEX_ROOT_TOKEN".into(), "root-token".into());
    let mcp_path = fixture.base.join("mcp.json");
    let config = McpConfig {
        servers: vec![
            McpServer {
                name: "suplex_root".into(),
                transport: "stdio".into(),
                command: Some("/opt/suplex".into()),
                args: vec!["mcp".into(), "root".into()],
                inherit: vec!["SUPLEX_ROOT_TOKEN".into(), "MISSING".into()],
                ..McpServer::default()
            },
            McpServer {
                name: "context7".into(),
                transport: "http".into(),
                url: Some("https://example.com/mcp".into()),
                headers: vec![("Authorization".into(), "fixture".into())],
                ..McpServer::default()
            },
        ],
        grants: vec!["mcp__context7__query_docs".into()],
    };
    fs::write(&mcp_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let mut args = fixture.args(Role::Root, "default", "high", None);
    args.mcp = Some(mcp_path);
    let (code, events) = fixture.run(&args, "RUN_TOOL EDIT MCP");
    assert_eq!(code, 0, "{events:?}");
    let outcomes = of_type(&events, "permission")
        .iter()
        .map(|event| {
            (
                event["toolCallId"].as_str().unwrap().to_owned(),
                event["outcome"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes,
        [
            ("call_run".to_owned(), "reject_once".to_owned()),
            ("call_edit".to_owned(), "reject_once".to_owned()),
            ("call_mcp".to_owned(), "allow_once".to_owned()),
        ]
    );
    let tools = transcript::native_tools(&events);
    assert_eq!(tools[2].name, "mcp__suplex_root__observe");
    assert_eq!(tools[2].input["taskId"], "task_1");
    assert_eq!(tools[0].status, "error");
    // `default` keeps the account's model.
    assert!(
        fixture
            .received("session/set_config_option")
            .iter()
            .all(|params| params["configId"] != "model")
    );
    let servers = &fixture.received("session/new")[0]["mcpServers"];
    assert_eq!(
        servers[0],
        json!({"name":"suplex_root","command":"/opt/suplex","args":["mcp","root"],"env":[{"name":"SUPLEX_ROOT_TOKEN","value":"root-token"}]})
    );
    assert_eq!(
        servers[1],
        json!({"type":"http","name":"context7","url":"https://example.com/mcp","headers":[{"name":"Authorization","value":"fixture"}]})
    );
    // An HTTP MCP server needs one agent process per session.
    assert_eq!(
        fixture.launches()[0]["argv"],
        json!(["acp", "--process-per-session"])
    );
    fs::remove_dir_all(&fixture.base).unwrap();
}

#[test]
fn permission_policy_follows_the_role_and_grants() {
    let request = |kind: &str, title: &str, raw: Value| {
        json!({"toolCall":{"toolCallId":"c","kind":kind,"title":title,"rawInput":raw},"options":[
            {"optionId":"a","kind":"allow_once"},{"optionId":"r","kind":"reject_once"}]})
    };
    let chosen = |role, grants: &[String], params: &Value| {
        turn::permission_choice(role, grants, params)["outcome"]["optionId"]
            .as_str()
            .map(str::to_owned)
    };
    let grants = ["mcp__context7__query_docs".to_owned()];
    let execute = request("execute", "Run ls", json!({"CommandLine":"ls"}));
    assert_eq!(chosen(Role::Worker, &[], &execute).as_deref(), Some("a"));
    assert_eq!(chosen(Role::Advisor, &[], &execute).as_deref(), Some("r"));
    let read = request("read", "Read a.rs", Value::Null);
    assert_eq!(chosen(Role::Advisor, &[], &read).as_deref(), Some("a"));
    let report = request("other", "Run mcp_suplex_advisor_submit_report", Value::Null);
    assert_eq!(chosen(Role::Advisor, &[], &report).as_deref(), Some("a"));
    // The Coordinator bridge is not the Advisor's.
    let root = request("other", "Run mcp_suplex_root_observe", Value::Null);
    assert_eq!(chosen(Role::Advisor, &[], &root).as_deref(), Some("r"));
    let granted = request(
        "other",
        "Run",
        json!({"ServerName":"context7","ToolName":"query_docs"}),
    );
    assert_eq!(chosen(Role::Root, &grants, &granted).as_deref(), Some("a"));
    let other_tool = request(
        "other",
        "Run",
        json!({"ServerName":"context7","ToolName":"write_docs"}),
    );
    assert_eq!(
        chosen(Role::Root, &grants, &other_tool).as_deref(),
        Some("r")
    );
    let question = json!({"toolCall":{"toolCallId":"interaction_1","kind":"other"},"options":[{"optionId":"x","kind":"allow_once"}]});
    assert_eq!(
        turn::permission_choice(Role::Worker, &[], &question),
        json!({"outcome":{"outcome":"cancelled"}})
    );
}

#[test]
fn not_signed_in_unknown_models_and_old_runtimes_report_what_to_do() {
    let signed_out = fixture("signed-out", "signed-out");
    let (code, events) = signed_out.run(
        &signed_out.args(Role::Worker, "gemini-a", "medium", None),
        "Hello",
    );
    assert_eq!(code, 1);
    assert!(transcript::sign_in_required(&events), "{events:?}");
    assert!(
        transcript::failure(&events)
            .unwrap()
            .contains("agy acp --login")
    );
    assert_eq!(transcript::session_id(&events), None);
    assert_eq!(
        signed_out.received("authenticate")[0]["methodId"],
        "oauth-personal"
    );
    fs::remove_dir_all(&signed_out.base).unwrap();

    // Antigravity asks for an `authenticate` call before its first session.
    let mut once = fixture("auth-once", "auth-once");
    once.environment
        .insert("GEMINI_API_KEY".into(), "fixture".into());
    let (code, events) = once.run(&once.args(Role::Worker, "", "medium", None), "Hello");
    assert_eq!(code, 0, "{events:?}");
    assert_eq!(
        once.received("authenticate")[0]["methodId"],
        "gemini-api-key"
    );
    assert_eq!(once.received("session/new").len(), 2);
    fs::remove_dir_all(&once.base).unwrap();

    let unknown = fixture("unknown-model", "");
    let (code, events) = unknown.run(
        &unknown.args(Role::Worker, "gemini-z", "medium", None),
        "Hello",
    );
    assert_eq!(code, 1);
    assert!(
        transcript::failure(&events)
            .unwrap()
            .contains("Antigravity model 'gemini-z' is not available")
    );
    assert!(unknown.received("session/prompt").is_empty());
    fs::remove_dir_all(&unknown.base).unwrap();

    let old = fixture("old", "old");
    let (code, events) = old.run(&old.args(Role::Worker, "", "medium", None), "Hello");
    assert_eq!(code, 0);
    assert!(
        of_type(&events, "warning")[0]["message"]
            .as_str()
            .unwrap()
            .contains("older than 1.5")
    );
    fs::remove_dir_all(&old.base).unwrap();
}

#[test]
fn the_turn_waits_for_a_command_that_outlives_its_prompt_but_not_for_a_daemon() {
    let fixture = fixture("late", "");
    let (code, events) = fixture.run(&fixture.args(Role::Worker, "", "medium", None), "LATE");
    assert_eq!(code, 0, "{events:?}");
    assert_eq!(
        transcript::result_text(&events),
        "The build finished.",
        "{events:#?}"
    );
    assert_eq!(
        of_type(&events, "settled")[0]["unsettled"],
        json!(["daemon_1"])
    );
    fs::remove_dir_all(&fixture.base).unwrap();
}

#[test]
fn a_lost_native_session_continues_in_a_new_one() {
    let fixture = fixture("lost", "");
    let (code, events) = fixture.run(
        &fixture.args(Role::Worker, "", "medium", Some("native-gone")),
        "Hello",
    );
    assert_eq!(code, 0, "{events:?}");
    assert_eq!(
        of_type(&events, "resume_failed")[0]["sessionId"],
        "native-gone"
    );
    let session = of_type(&events, "session")[0];
    assert_eq!(session["replaces"], "native-gone");
    assert_ne!(transcript::session_id(&events), Some("native-gone"));
    fs::remove_dir_all(&fixture.base).unwrap();
}

/// The `suplex antigravity-turn` process for the dispatch tests: the wrapper
/// script runs this test binary here with the turn arguments.
#[test]
fn turn_process_entry() {
    let Ok(args) = std::env::var(ENTRY_ARGS) else {
        return;
    };
    let args = args.lines().skip(1).map(str::to_owned).collect::<Vec<_>>();
    let args = TurnArgs::parse(&args).unwrap();
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();
    let code = turn::run(
        &args,
        &prompt,
        &std::env::current_dir().unwrap(),
        &std::env::vars().collect(),
        &mut std::io::stdout().lock(),
    );
    std::process::exit(code);
}

fn driver(base: &Path) -> PathBuf {
    let path = base.join("suplex-driver");
    executable(
        &path,
        &format!(
            "#!/bin/sh\n{ENTRY_ARGS}=\"$(printf '%s\\n' \"$@\")\" exec '{}' --exact {ENTRY} --nocapture --test-threads=1\n",
            std::env::current_exe().unwrap().display()
        ),
    );
    path
}

fn scope<'a>(
    fixture: &'a Fixture,
    database: &'a Path,
    session_id: &'a str,
    role: TaskRole<'a>,
    workflow: WorkflowLaunch,
) -> TaskScope<'a> {
    TaskScope {
        workflow,
        database_path: database,
        artifact_root: &fixture.base,
        task_id: "task_agy",
        session_id,
        native_session_id: "antigravity-session-1",
        role,
        worktree: &fixture.worktree,
        model: "gemini-b",
        reasoning_effort: "high",
        instance_home_directory: None,
        project_mcp: None,
        project_context_path: None,
        project_environment: &EMPTY,
        excluded_environment_keys: &[],
        executable: Some(&fixture.agy),
        inherited_environment: &fixture.environment,
    }
}

static EMPTY: std::sync::LazyLock<HashMap<String, String>> = std::sync::LazyLock::new(HashMap::new);

fn wait_for_exit(directory: &Path, turn_id: &str) -> String {
    let exit = headless::turn_file(directory, turn_id, "exit");
    for _ in 0..600 {
        if let Ok(status) = fs::read_to_string(&exit) {
            return status.trim().to_owned();
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "the turn client did not exit: {}",
        fs::read_to_string(headless::turn_file(directory, turn_id, "stderr.log"))
            .unwrap_or_default()
    );
}

fn settled(directory: &Path, turn_id: &str) -> PromptState {
    for _ in 0..100 {
        let state = runtime::observe(
            directory,
            "antigravity-session-1",
            turn_id,
            DispatchState::Ambiguous,
            None,
        )
        .unwrap()
        .state;
        if state != PromptState::Running {
            return state;
        }
        thread::sleep(Duration::from_millis(50));
    }
    PromptState::Running
}

/// Without `SUPLEX_ANTIGRAVITY=1` in the host environment, a turn on an
/// Antigravity agent fails with the flag in its message. It claims no prompt,
/// writes no record, and starts no process.
#[tokio::test]
async fn a_turn_does_not_start_while_the_flag_is_off() {
    let fixture = fixture("flag-off", "");
    let database = fixture.base.join("suplex.sqlite");
    let mut environment = fixture.environment.clone();
    for value in [None, Some("0"), Some("true")] {
        match value {
            Some(value) => environment.insert(super::cli::FLAG.to_owned(), value.to_owned()),
            None => environment.remove(super::cli::FLAG),
        };
        let mut launch = scope(
            &fixture,
            &database,
            "session_worker",
            TaskRole::Worker(WorkerPurpose::Implementation),
            WorkflowLaunch::default(),
        );
        launch.inherited_environment = &environment;
        let mut claimed = false;
        let error = ANTIGRAVITY_TASK_RUNTIME
            .dispatch(&launch, "msg_1", "RUN_TOOL", &mut |_| {
                claimed = true;
                Ok(true)
            })
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), super::cli::OFF_MESSAGE);
        assert!(!claimed);
        assert!(fixture.launches().is_empty());
        let directory = launch.runtime_directory().unwrap();
        assert!(
            fs::read_dir(&directory).map_or(true, |mut entries| entries.next().is_none()),
            "{value:?}"
        );
    }
    fs::remove_dir_all(&fixture.base).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_resumes_after_lost_local_records_and_stop_ends_a_running_turn() {
    let fixture = fixture("dispatch", "");
    let database = fixture.base.join("suplex.sqlite");
    let driver = driver(&fixture.base);
    let launch = scope(
        &fixture,
        &database,
        "session_worker",
        TaskRole::Worker(WorkerPurpose::Implementation),
        WorkflowLaunch::default(),
    );
    let directory = launch.runtime_directory().unwrap();
    let observed =
        task_runtime::dispatch(&launch, "msg_1", "RUN_TOOL", Some(&driver), |_| Ok(true)).unwrap();
    assert!(observed.admission_observed);
    assert_eq!(wait_for_exit(&directory, "msg_1"), "0");
    assert_eq!(settled(&directory, "msg_1"), PromptState::Completed);
    let native = session_reader::native_session(&directory).unwrap().unwrap();
    // The Worker shell runs `git` through the guard.
    let launch_record = &fixture.launches()[0];
    assert!(
        fs::metadata(Path::new(launch_record["path"].as_str().unwrap()).join("git")).is_ok(),
        "{launch_record}"
    );
    assert!(!directory.join(task_runtime::MCP_FILE).exists());

    // A host restart can lose every local record; the turn log still names
    // the native session, so the next turn resumes it.
    for entry in fs::read_dir(&directory).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name == "turn.json" || name.starts_with("dispatch-") {
            fs::remove_file(path).unwrap();
        }
    }
    task_runtime::dispatch(&launch, "msg_2", "Continue", Some(&driver), |_| Ok(true)).unwrap();
    assert_eq!(wait_for_exit(&directory, "msg_2"), "0");
    assert_eq!(fixture.received("session/resume")[0]["sessionId"], native);
    assert_eq!(
        ANTIGRAVITY_TASK_RUNTIME
            .result_text(&directory, "msg_2")
            .await
            .unwrap(),
        "Turn 2 on gemini-b/high. Done."
    );

    task_runtime::dispatch(&launch, "msg_3", "SLOW", Some(&driver), |_| Ok(true)).unwrap();
    let log = headless::turn_file(&directory, "msg_3", "jsonl");
    for _ in 0..600 {
        if fs::read_to_string(&log)
            .unwrap_or_default()
            .contains("slow_1")
        {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let session = SessionRef {
        directory: &directory,
        native_session_id: "antigravity-session-1",
    };
    let running = ANTIGRAVITY_TASK_RUNTIME
        .observe(session, "msg_3", DispatchState::Ambiguous, None)
        .await
        .unwrap();
    assert_eq!(running.state, PromptState::Running);
    ANTIGRAVITY_TASK_RUNTIME
        .stop(&directory, Some("antigravity-session-1"))
        .await
        .unwrap();
    let stopped = ANTIGRAVITY_TASK_RUNTIME
        .observe(session, "msg_3", DispatchState::Ambiguous, None)
        .await
        .unwrap();
    assert_eq!(stopped.state, PromptState::Interrupted, "{stopped:?}");
    assert!(!stopped.process_running);
    fs::remove_dir_all(&fixture.base).unwrap();
}

#[test]
fn coordinator_and_advisor_dispatch_write_their_bridge_without_its_token() {
    let fixture = fixture("bridges", "");
    let database = fixture.base.join("suplex.sqlite");
    let driver = driver(&fixture.base);
    let identity = root_bridge::RootIdentity {
        task_id: "task_agy".into(),
        session_id: "session_root".into(),
        generation: 1,
    };
    let root = scope(
        &fixture,
        &database,
        "session_root",
        TaskRole::Root(&identity),
        WorkflowLaunch::default(),
    );
    task_runtime::dispatch(&root, "msg_r", "MCP", Some(&driver), |_| Ok(true)).unwrap();
    let directory = root.runtime_directory().unwrap();
    assert_eq!(wait_for_exit(&directory, "msg_r"), "0");
    let config: McpConfig =
        serde_json::from_slice(&fs::read(directory.join(task_runtime::MCP_FILE)).unwrap()).unwrap();
    assert_eq!(config.servers[0].name, "suplex_root");
    assert_eq!(config.servers[0].args, ["mcp", "root"]);
    let file = fs::read_to_string(directory.join(task_runtime::MCP_FILE)).unwrap();
    let new = fixture.received("session/new");
    let token = new[0]["mcpServers"][0]["env"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pair| pair["name"] == "SUPLEX_ROOT_TOKEN")
        .unwrap()["value"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!token.is_empty());
    assert!(!file.contains(&token));
    let prompt = fs::read_to_string(headless::turn_file(&directory, "msg_r", "prompt")).unwrap();
    assert!(prompt.ends_with("\n\nMCP"));
    let events = transcript::parse_events(
        &fs::read_to_string(headless::turn_file(&directory, "msg_r", "jsonl")).unwrap(),
    );
    assert_eq!(of_type(&events, "permission")[0]["outcome"], "allow_once");

    let advisor = scope(
        &fixture,
        &database,
        "session_advisor",
        TaskRole::Worker(WorkerPurpose::Verification),
        WorkflowLaunch {
            advisor: Some(AdvisorRole::Reviewer),
            ..WorkflowLaunch::default()
        },
    );
    task_runtime::dispatch(&advisor, "msg_a", "RUN_TOOL", Some(&driver), |_| Ok(true)).unwrap();
    let directory = advisor.runtime_directory().unwrap();
    assert_eq!(wait_for_exit(&directory, "msg_a"), "0");
    let config: McpConfig =
        serde_json::from_slice(&fs::read(directory.join(task_runtime::MCP_FILE)).unwrap()).unwrap();
    assert_eq!(config.servers[0].name, "suplex_advisor");
    let events = transcript::parse_events(
        &fs::read_to_string(headless::turn_file(&directory, "msg_a", "jsonl")).unwrap(),
    );
    assert_eq!(of_type(&events, "permission")[0]["outcome"], "reject_once");
    // A refused claim launches nothing.
    assert!(
        task_runtime::dispatch(&advisor, "msg_b", "Hello", Some(&driver), |_| Ok(false)).is_err()
    );
    assert!(!headless::turn_file(&directory, "msg_b", "jsonl").exists());
    fs::remove_dir_all(&fixture.base).unwrap();
}
