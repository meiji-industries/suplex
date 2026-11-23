//! Antigravity Coordinator, Worker, and Advisor launches over the shared
//! headless turn runtime.

use std::{
    collections::HashMap,
    error::Error,
    io,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::{
    cli, display, runtime,
    turn::{McpConfig, McpServer, Role, TurnArgs},
};
use crate::{
    coordination::{advisor_bridge, bridge_auth, root_bridge},
    profiles::agent_profiles::home_directory,
    runtimes::{
        git_guard,
        native::{DispatchState, PromptObservation},
        project_mcp::{project_mcp_servers, project_mcp_tools},
        task_harness::{self, TaskRole, TaskScope, resolve_executable},
    },
};

/// The MCP servers of a turn, in the private session runtime directory.
pub const MCP_FILE: &str = "antigravity-mcp.json";

pub fn resolve_agy(
    override_path: Option<&Path>,
    environment: &HashMap<String, String>,
) -> io::Result<PathBuf> {
    resolve_executable(
        &cli::EXECUTABLE,
        override_path,
        environment,
        home_directory().as_deref(),
    )
}

/// Project servers keep their resolved credentials in the private file, as
/// the Claude Code runtime does; the bridge names variables the turn client
/// copies from its own environment.
fn project_servers(servers: &serde_json::Map<String, Value>) -> Vec<McpServer> {
    let pairs = |value: &Value| {
        value
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, value)| (name.clone(), value.as_str().unwrap_or_default().to_owned()))
            .collect::<Vec<_>>()
    };
    servers
        .iter()
        .map(|(name, server)| {
            if server["type"] == "http" {
                McpServer {
                    name: name.clone(),
                    transport: "http".into(),
                    url: server["url"].as_str().map(str::to_owned),
                    headers: pairs(&server["headers"]),
                    ..McpServer::default()
                }
            } else {
                McpServer {
                    name: name.clone(),
                    transport: "stdio".into(),
                    command: server["command"].as_str().map(str::to_owned),
                    args: server["args"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                    env: pairs(&server["env"]),
                    ..McpServer::default()
                }
            }
        })
        .collect()
}

/// Prepare the role's bridge capability and guarded shell, then make the
/// durable prompt claim inside the native dispatch operation before spawning.
/// `driver` replaces the Suplex program that runs the turn client in tests.
pub fn dispatch<F>(
    scope: &TaskScope<'_>,
    turn_id: &str,
    prompt: &str,
    driver: Option<&Path>,
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
        return Err(io::Error::other(
            "Antigravity prompt was not proven absent; replay is blocked",
        )
        .into());
    }
    let agy = resolve_agy(scope.executable, scope.inherited_environment)?;
    let (git, gh) = git_guard::resolve_guard_binaries(scope.inherited_environment)?;
    let guard = git_guard::create_git_command_guard(
        &directory,
        &git,
        gh.as_deref(),
        scope.inherited_environment,
    )?;
    let suplex = crate::shared::fs::executable()?;
    let suplex_text = suplex
        .to_str()
        .ok_or_else(|| io::Error::other("Suplex executable path is invalid"))?;
    let (role, bridge_environment, additions, bridge) = match (scope.role, scope.workflow.advisor) {
        (TaskRole::Root(identity), _) => {
            let binding = root_bridge::write_binding(
                &directory,
                identity,
                scope.database_path,
                scope.artifact_root,
                suplex_text,
            )?;
            (
                Role::Root,
                Some(HashMap::from([
                    (
                        bridge_auth::ROOT_BINDING_ENV.to_owned(),
                        binding.binding_path.to_string_lossy().into_owned(),
                    ),
                    (bridge_auth::ROOT_TOKEN_ENV.to_owned(), binding.token),
                ])),
                HashMap::new(),
                Some((
                    "root",
                    // Delivery pushes from the bridge; `git` on its PATH is the Worker guard.
                    vec![
                        bridge_auth::ROOT_BINDING_ENV.to_owned(),
                        bridge_auth::ROOT_TOKEN_ENV.to_owned(),
                        "SUPLEX_GIT_REAL_BIN".to_owned(),
                        "SUPLEX_GH_COMMAND".to_owned(),
                        "PATH".to_owned(),
                        "HOME".to_owned(),
                    ],
                )),
            )
        }
        (TaskRole::Worker(_), Some(advisor)) => {
            let binding = advisor_bridge::write_binding(&directory, advisor, suplex_text)?;
            let result = advisor_bridge::advisor_result_path(&directory, turn_id)?;
            (
                Role::Advisor,
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
                Some((
                    "advisor",
                    vec![
                        bridge_auth::ADVISOR_BINDING_ENV.to_owned(),
                        bridge_auth::ADVISOR_TOKEN_ENV.to_owned(),
                        bridge_auth::ADVISOR_RESULT_ENV.to_owned(),
                        "PATH".to_owned(),
                        "HOME".to_owned(),
                    ],
                )),
            )
        }
        (TaskRole::Worker(_), None) => (Role::Worker, None, HashMap::new(), None),
    };
    let role_name = scope.workflow.role_name(scope.role);
    let mut mcp = McpConfig {
        servers: project_servers(&project_mcp_servers(
            scope.project_mcp,
            role_name,
            scope.inherited_environment,
        )?),
        grants: project_mcp_tools(scope.project_mcp, role_name),
    };
    if let (Some(name), Some((subcommand, inherit))) = (role.bridge_name(), bridge) {
        mcp.servers.push(McpServer {
            name: name.to_owned(),
            transport: "stdio".into(),
            command: Some(suplex_text.to_owned()),
            args: vec!["mcp".into(), subcommand.into()],
            inherit,
            ..McpServer::default()
        });
    }
    let mcp_path = (!mcp.servers.is_empty()).then(|| directory.join(MCP_FILE));
    if let Some(path) = &mcp_path {
        crate::shared::fs::write_private(path, &serde_json::to_vec(&mcp)?)?;
    }
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
    // The host already prepended the project context to `prompt`. Antigravity
    // reads AGENTS.md itself, and the role prompt leads the prompt.
    let prompt = format!("{}\n\n{prompt}", scope.workflow.role_prompt(scope.role));
    display::show(
        scope.database_path,
        scope.session_id,
        scope.native_session_id,
        scope.worktree,
        scope.model,
    );
    let driver = match driver {
        Some(driver) => driver.to_owned(),
        None => suplex,
    };
    runtime::dispatch(
        runtime::AntigravityDispatch {
            directory: &directory,
            worktree: scope.worktree,
            driver: &driver,
            turn: TurnArgs {
                agy,
                role,
                model: scope.model.to_owned(),
                effort: scope.reasoning_effort.to_owned(),
                resume: None,
                mcp: mcp_path,
            },
            session_id: scope.native_session_id,
            turn_id,
            prompt: &prompt,
            environment: &environment,
            excluded_environment_keys: scope.excluded_environment_keys,
        },
        claim,
    )
}
