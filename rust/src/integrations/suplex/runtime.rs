//! `SuplexMcpRuntime`: the OAuth MCP tools run in process with the token's principal.

use crate::identity::IdentityError;
use crate::tasks::TaskError;
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams,
        ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde_json::{Map, Value, json};

use crate::{
    http::{AppState, routes::agent_api as routes},
    identity::external_agents::Principal,
    tasks::agent_api::{self, Creation},
};

use super::{InvalidArguments, TOOLS};

pub struct SuplexMcpRuntime {
    pub state: AppState,
    pub principal: Principal,
    pub agent_delivery: bool,
}

type Outcome = Result<(u16, Value), Box<dyn std::error::Error>>;

impl SuplexMcpRuntime {
    fn wake(&self, task_id: &str) {
        if let Some(host) = &self.state.task_host {
            host.wake(task_id.to_owned());
        }
    }

    pub async fn call(&self, name: &str, args: &Map<String, Value>) -> Outcome {
        let (state, principal) = (&self.state, &self.principal);
        match name {
            "suplex_whoami" => Ok((
                200,
                state.with_database(|database| agent_api::identity(database, principal))?,
            )),
            "suplex_capabilities" => Ok((
                200,
                routes::capabilities(self.agent_delivery, principal.answer_grant.is_some()),
            )),
            "suplex_list_workflows" => {
                let project_id = super::project_arguments(args)?;
                let workflows = state.with_database(|database| {
                    agent_api::workflows(database, principal, &project_id)
                })?;
                Ok((200, json!({"workflows": workflows})))
            }
            "suplex_list_templates" => {
                let project_id = super::project_arguments(args)?;
                let templates = state.with_database(|database| {
                    agent_api::templates(database, principal, &project_id)
                })?;
                Ok((200, json!({"templates": templates})))
            }
            "suplex_list_tasks" => {
                let query = super::list_arguments(args)?;
                let view = query.view.clone().unwrap_or_else(|| "summary".into());
                Ok((
                    200,
                    agent_api::read_list(state, principal, &query, &view).await?,
                ))
            }
            "suplex_get_task" => {
                let (task_id, known) = super::get_task_arguments(args)?;
                let task = agent_api::read(state, principal, &task_id).await?;
                if known
                    .as_ref()
                    .is_some_and(|known| task["revision"] == json!(known))
                {
                    return Ok((
                        304,
                        json!({"unchanged": true, "revision": task["revision"]}),
                    ));
                }
                Ok((200, task))
            }
            "suplex_get_task_delivery" => {
                let task_id = super::task_only_arguments(args)?;
                let task = agent_api::read(state, principal, &task_id).await?;
                Ok((
                    200,
                    json!({"taskId": task["id"], "taskStatus": task["status"], "revision": task["revision"], "queue": task["queue"], "blocker": task["blocker"], "delivery": task["delivery"]}),
                ))
            }
            "suplex_create_task" => {
                let request = super::create_arguments(args)?;
                let creation = agent_api::create(state, principal, &request, None).await?;
                match creation {
                    Creation::DryRun(preview) => Ok((200, preview)),
                    Creation::Task {
                        id,
                        created,
                        active,
                    } => {
                        if active {
                            self.wake(&id);
                        }
                        Ok((
                            if created { 201 } else { 200 },
                            agent_api::read(state, principal, &id).await?,
                        ))
                    }
                }
            }
            "suplex_set_task_dependencies" => {
                let (task_id, body) = super::dependencies_arguments(args)?;
                let result = state.with_database(|database| {
                    if body.dry_run == Some(true) {
                        agent_api::preview_dependencies(
                            database,
                            principal,
                            &task_id,
                            &body.depends_on,
                        )
                    } else {
                        agent_api::set_dependencies_array(
                            database,
                            principal,
                            &task_id,
                            &body.depends_on,
                        )
                    }
                })?;
                Ok((200, result))
            }
            "suplex_command_task" => {
                let (task_id, body) = super::command_arguments(args)?;
                let task = agent_api::command(state, principal, &task_id, &body).await?;
                if agent_api::wakes_host(&body.command) {
                    self.wake(&task_id);
                }
                Ok((200, task))
            }
            _ => Err(format!("Suplex MCP tool is unsupported: {name}").into()),
        }
    }
}

/// The OAuth endpoint's error mapping: task and agent failures keep their own code.
pub fn failure(error: &(dyn std::error::Error + 'static)) -> (u16, Value) {
    let domain =
        |status: u16, message: &str, code: &str| (status, json!({"error": message, "code": code}));
    if let Some(TaskError::Failure { status, code, .. } | TaskError::Agent { status, code, .. }) =
        error.downcast_ref()
    {
        return domain(*status, &error.to_string(), code);
    }
    if let Some(IdentityError::ExternalAgent {
        status,
        code,
        message,
    }) = error.downcast_ref()
    {
        return domain(*status, message, code);
    }
    if error.is::<InvalidArguments>() {
        return domain(400, "Invalid request", "request_invalid");
    }
    domain(500, "Internal server error", "internal_error")
}

impl ServerHandler for SuplexMcpRuntime {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.server_info.name = "suplex".into();
        info.server_info.version = "1.0.0".into();
        info.capabilities.tools = Some(Default::default());
        info
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        super::tool(name)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        // 2026-07-28 clients require a cache policy on list results. The tools
        // depend on this paired agent's delivery grant, so nothing is shared.
        Ok(ListToolsResult::with_all_items(TOOLS.clone())
            .with_ttl_ms(0)
            .with_cache_scope(rmcp::model::CacheScope::Private))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let args = request.arguments.unwrap_or_default();
        let (status, body) = match self.call(&request.name, &args).await {
            Ok(result) => result,
            Err(error) => failure(error.as_ref()),
        };
        let mut result = super::present(status, body);
        if status < 400 {
            result.is_error = None;
        }
        Ok(result.into())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::http::routes::{
        agent_api::tests::agent,
        oauth::tests::{authorize, exchange, register},
    };

    /// Ports the in-process half of `tests/oauth-mcp.test.ts`: OAuth MCP drives the same agent task service.
    #[tokio::test]
    async fn oauth_mcp_lists_tools_and_calls_the_agent_task_service() {
        let agent = agent().await;
        let server = &agent.server;
        let client = register(server, "SDK integration").await;
        let verifier = "s".repeat(43);
        let code = authorize(server, &client, &verifier, "sdk-state").await;
        let token = exchange(server, &client, &code, &verifier).await.1["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let bearer = format!("Bearer {token}");
        let mut id = 0;
        let mut rpc = async |method: &str, params: Value| {
            id += 1;
            let response = server
                .request(
                    reqwest::Method::POST,
                    "/mcp",
                    &[
                        ("authorization", bearer.as_str()),
                        ("accept", "application/json, text/event-stream"),
                        ("mcp-protocol-version", "2025-06-18"),
                    ],
                    Some(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})),
                )
                .await;
            assert_eq!(response.status(), 200);
            response.json::<Value>().await.unwrap()
        };
        let initialized = rpc("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})).await;
        assert_eq!(initialized["result"]["serverInfo"]["name"], "suplex");
        let listed = rpc("tools/list", json!({})).await;
        assert!(
            listed["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "suplex_whoami")
        );
        let whoami = rpc(
            "tools/call",
            json!({"name": "suplex_whoami", "arguments": {}}),
        )
        .await;
        assert_eq!(whoami["result"]["structuredContent"]["status"], 200);
        assert!(
            whoami["result"]["structuredContent"]["body"]["agent"]["id"]
                .as_str()
                .unwrap()
                .starts_with("agent_")
        );

        let foreign = agent
            .create("Created by another agent", "foreign-task-001")
            .await;
        let foreign_id = foreign["id"].as_str().unwrap();
        let read = rpc(
            "tools/call",
            json!({"name": "suplex_get_task", "arguments": {"taskId": foreign_id}}),
        )
        .await;
        assert_eq!(
            (
                read["result"]["structuredContent"]["status"].as_u64(),
                read["result"]["structuredContent"]["body"]["permittedCommands"].clone()
            ),
            (
                Some(200),
                json!([
                    "start_task",
                    "cancel_task",
                    "archive_task",
                    "duplicate_task"
                ])
            )
        );
        let cancelled = rpc("tools/call", json!({"name": "suplex_command_task", "arguments": {"taskId": foreign_id, "command": "cancel_task", "revision": read["result"]["structuredContent"]["body"]["revision"], "idempotencyKey": "oauth-shared-command"}})).await;
        assert_eq!(
            (
                cancelled["result"]["structuredContent"]["status"].as_u64(),
                cancelled["result"]["structuredContent"]["body"]["status"].as_str()
            ),
            (Some(200), Some("cancelled")),
            "{cancelled}"
        );

        let created = rpc("tools/call", json!({"name": "suplex_create_task", "arguments": {"projectId": "project_api", "title": "Created through remote MCP", "idempotencyKey": "sdk-create-1"}})).await;
        assert_eq!(
            created["result"]["structuredContent"]["status"], 201,
            "{created}"
        );
        let task_id = created["result"]["structuredContent"]["body"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let revision = created["result"]["structuredContent"]["body"]["revision"].clone();
        let unchanged = rpc("tools/call", json!({"name": "suplex_get_task", "arguments": {"taskId": task_id, "knownRevision": revision}})).await;
        assert_eq!(
            unchanged["result"]["structuredContent"],
            json!({"unchanged": true, "revision": revision})
        );
        let delivery = rpc(
            "tools/call",
            json!({"name": "suplex_get_task_delivery", "arguments": {"taskId": task_id}}),
        )
        .await;
        assert_eq!(
            delivery["result"]["structuredContent"]["body"],
            json!({"taskId": task_id, "taskStatus": "backlog", "revision": revision, "queue": {"waitingOn": []}, "blocker": null, "delivery": null})
        );
        let summary = rpc(
            "tools/call",
            json!({"name": "suplex_list_tasks", "arguments": {"projectId": "project_api"}}),
        )
        .await;
        assert!(
            summary["result"]["structuredContent"]["body"]["tasks"][0]
                .get("integration")
                .is_none()
        );
        let invalid = rpc(
            "tools/call",
            json!({"name": "suplex_get_task", "arguments": {}}),
        )
        .await;
        assert_eq!(
            invalid["result"]["structuredContent"],
            json!({"status": 400, "body": {"error": "Invalid request", "code": "request_invalid"}})
        );
        let capabilities = rpc(
            "tools/call",
            json!({"name": "suplex_capabilities", "arguments": {}}),
        )
        .await;
        assert_eq!(
            capabilities["result"]["structuredContent"]["body"],
            crate::http::routes::agent_api::capabilities(true, false)
        );
    }
}
