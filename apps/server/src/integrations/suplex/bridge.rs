//! `suplex mcp`: a stdio MCP server that drives the Agent API with a paired credential.
//! The credential comes from the environment only and never reaches a tool result.

use std::collections::HashMap;

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde_json::{Map, Value, json};

use super::TOOLS;

#[derive(Debug, PartialEq, Eq)]
pub struct Settings {
    pub base_url: String,
    pub credential: String,
}

/// `readSuplexMcpBridgeSettings`: the message names the variable and never its value.
pub fn settings(environment: &HashMap<String, String>) -> Result<Settings, String> {
    let read = |name: &str| {
        environment
            .get(name)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let base_url =
        read("SUPLEX_BASE_URL").ok_or("Set SUPLEX_BASE_URL in the MCP server environment.")?;
    let credential = read("SUPLEX_AGENT_CREDENTIAL")
        .ok_or("Set SUPLEX_AGENT_CREDENTIAL in the MCP server environment.")?;
    Ok(Settings {
        base_url: base_url.trim_end_matches('/').to_owned(),
        credential,
    })
}

pub struct Bridge {
    settings: Settings,
    client: reqwest::Client,
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn query(pairs: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        serializer.append_pair(name, value);
    }
    serializer.finish()
}

impl Bridge {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings,
            client: reqwest::Client::new(),
        }
    }

    /// Replace the credential anywhere it could reach a transcript, log, or tool result.
    pub fn redact(&self, text: &str) -> String {
        if self.settings.credential.is_empty() {
            text.to_owned()
        } else {
            text.replace(&self.settings.credential, "[redacted credential]")
        }
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, String)],
    ) -> Result<(u16, Value), String> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.settings.base_url))
            .header(
                "authorization",
                format!("Bearer {}", self.settings.credential),
            )
            .header("accept", "application/json");
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = request.send().await.map_err(|error| {
            self.redact(&format!(
                "Suplex is unreachable at {}: {error}",
                self.settings.base_url
            ))
        })?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let body = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| json!({"error": "Suplex returned a response that is not JSON", "code": "internal_error"}))
        };
        Ok((status, body))
    }

    /// The tool result before presentation; an argument or transport failure is an error message.
    pub async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
    ) -> Result<(u16, Value), String> {
        use reqwest::Method;
        let invalid = |error: super::InvalidArguments| error.to_string();
        match name {
            "suplex_whoami" => self.request(Method::GET, "/api/agent/me", None, &[]).await,
            "suplex_capabilities" => {
                self.request(Method::GET, "/api/agent/capabilities", None, &[])
                    .await
            }
            "suplex_list_workflows" | "suplex_list_templates" => {
                let project_id = super::project_arguments(args).map_err(invalid)?;
                let route = if name == "suplex_list_workflows" {
                    "workflows"
                } else {
                    "templates"
                };
                self.request(
                    Method::GET,
                    &format!("/api/agent/{route}?{}", query(&[("projectId", project_id)])),
                    None,
                    &[],
                )
                .await
            }
            "suplex_list_tasks" => {
                let parsed = super::list_arguments(args).map_err(invalid)?;
                let mut fields = serde_json::to_value(&parsed)
                    .map_err(|error| error.to_string())?
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                fields.entry("view").or_insert_with(|| json!("summary"));
                let pairs = fields
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.as_str(),
                            value
                                .as_str()
                                .map_or_else(|| value.to_string(), str::to_owned),
                        )
                    })
                    .collect::<Vec<_>>();
                self.request(
                    Method::GET,
                    &format!("/api/agent/tasks?{}", query(&pairs)),
                    None,
                    &[],
                )
                .await
            }
            "suplex_get_task" => {
                let (task_id, known) = super::get_task_arguments(args).map_err(invalid)?;
                let headers = known
                    .as_ref()
                    .map(|known| vec![("if-none-match", format!("\"{known}\""))])
                    .unwrap_or_default();
                let (status, body) = self
                    .request(
                        Method::GET,
                        &format!("/api/agent/tasks/{}", encode(&task_id)),
                        None,
                        &headers,
                    )
                    .await?;
                if status == 304 {
                    return Ok((304, json!({"unchanged": true, "revision": known})));
                }
                Ok((status, body))
            }
            "suplex_get_task_delivery" => {
                let task_id = super::task_only_arguments(args).map_err(invalid)?;
                let (status, task) = self
                    .request(
                        Method::GET,
                        &format!("/api/agent/tasks/{}", encode(&task_id)),
                        None,
                        &[],
                    )
                    .await?;
                if status != 200 {
                    return Ok((status, task));
                }
                let field = |name: &str| task.get(name).cloned().unwrap_or(Value::Null);
                Ok((
                    200,
                    json!({"taskId": field("id"), "taskStatus": field("status"), "revision": field("revision"), "queue": field("queue"), "blocker": field("blocker"), "delivery": field("delivery")}),
                ))
            }
            "suplex_create_task" => {
                let body = super::create_arguments(args).map_err(invalid)?;
                self.request(
                    Method::POST,
                    "/api/agent/tasks",
                    Some(serde_json::to_value(body).map_err(|error| error.to_string())?),
                    &[],
                )
                .await
            }
            "suplex_update_task" => {
                let (task_id, body) = super::update_arguments(args).map_err(invalid)?;
                let body = serde_json::to_value(body).map_err(|error| error.to_string())?;
                self.request(
                    Method::PATCH,
                    &format!("/api/agent/tasks/{}", encode(&task_id)),
                    Some(body),
                    &[],
                )
                .await
            }
            "suplex_set_task_dependencies" => {
                let (task_id, body) = super::dependencies_arguments(args).map_err(invalid)?;
                let body = serde_json::to_value(body).map_err(|error| error.to_string())?;
                self.request(
                    Method::PUT,
                    &format!("/api/agent/tasks/{}/dependencies", encode(&task_id)),
                    Some(body),
                    &[],
                )
                .await
            }
            "suplex_command_task" => {
                let (task_id, body) = super::command_arguments(args).map_err(invalid)?;
                let body = serde_json::to_value(body).map_err(|error| error.to_string())?;
                self.request(
                    Method::POST,
                    &format!("/api/agent/tasks/{}/commands", encode(&task_id)),
                    Some(body),
                    &[],
                )
                .await
            }
            "suplex_list_moves" => {
                let project_id = super::project_arguments(args).map_err(invalid)?;
                self.request(
                    Method::GET,
                    &format!("/api/agent/moves?{}", query(&[("projectId", project_id)])),
                    None,
                    &[],
                )
                .await
            }
            "suplex_get_move" => {
                let id = super::move_id_arguments(args).map_err(invalid)?;
                self.request(
                    Method::GET,
                    &format!("/api/agent/moves/{}", encode(&id)),
                    None,
                    &[],
                )
                .await
            }
            "suplex_create_move" => {
                let (body, key) = super::move_create_arguments(args).map_err(invalid)?;
                let mut value = serde_json::to_value(body).map_err(|e| e.to_string())?;
                value["idempotencyKey"] = json!(key);
                self.request(Method::POST, "/api/agent/moves", Some(value), &[])
                    .await
            }
            "suplex_update_move" => {
                let (id, body, updated) = super::move_update_arguments(args).map_err(invalid)?;
                let mut value = serde_json::to_value(body).map_err(|e| e.to_string())?;
                value["updatedAt"] = json!(updated);
                self.request(
                    Method::PUT,
                    &format!("/api/agent/moves/{}", encode(&id)),
                    Some(value),
                    &[],
                )
                .await
            }
            "suplex_delete_move" => {
                let (id, updated) = super::move_delete_arguments(args).map_err(invalid)?;
                self.request(
                    Method::DELETE,
                    &format!(
                        "/api/agent/moves/{}?{}",
                        encode(&id),
                        query(&[("updatedAt", updated)])
                    ),
                    None,
                    &[],
                )
                .await
            }
            "suplex_start_move" => {
                let (id, body) = super::move_run_arguments(args).map_err(invalid)?;
                self.request(
                    Method::POST,
                    &format!("/api/agent/moves/{}/runs", encode(&id)),
                    Some(serde_json::to_value(body).map_err(|e| e.to_string())?),
                    &[],
                )
                .await
            }
            "suplex_list_move_runs" => {
                let id = super::move_id_arguments(args).map_err(invalid)?;
                self.request(
                    Method::GET,
                    &format!("/api/agent/moves/{}/runs", encode(&id)),
                    None,
                    &[],
                )
                .await
            }
            "suplex_get_move_run" => {
                let id = super::run_id_arguments(args).map_err(invalid)?;
                self.request(
                    Method::GET,
                    &format!("/api/agent/move-runs/{}", encode(&id)),
                    None,
                    &[],
                )
                .await
            }
            "suplex_get_move_run_transcript" => {
                let id = super::run_id_arguments(args).map_err(invalid)?;
                self.request(
                    Method::GET,
                    &format!("/api/agent/move-runs/{}/transcript", encode(&id)),
                    None,
                    &[],
                )
                .await
            }
            "suplex_stop_move_run" => {
                let id = super::run_id_arguments(args).map_err(invalid)?;
                self.request(
                    Method::DELETE,
                    &format!("/api/agent/move-runs/{}/terminal", encode(&id)),
                    None,
                    &[],
                )
                .await
            }
            "suplex_archive_move_run" => {
                let id = super::run_id_arguments(args).map_err(invalid)?;
                self.request(
                    Method::POST,
                    &format!("/api/agent/move-runs/{}/archive", encode(&id)),
                    None,
                    &[],
                )
                .await
            }
            _ => Err(format!("Suplex MCP tool is unsupported: {name}")),
        }
    }

    /// The presented tool result with the credential redacted from every string.
    pub async fn result(&self, name: &str, args: &Map<String, Value>) -> CallToolResult {
        match self.call(name, args).await {
            Ok((status, body)) => {
                let presented = if status == 304 {
                    body
                } else {
                    json!({"status": status, "body": body})
                };
                let redacted = serde_json::from_str(&self.redact(&presented.to_string()))
                    .unwrap_or(Value::Null);
                if status >= 400 {
                    CallToolResult::structured_error(redacted)
                } else {
                    let mut result = CallToolResult::structured(redacted);
                    result.is_error = None;
                    result
                }
            }
            Err(message) => CallToolResult::error(vec![ContentBlock::text(self.redact(&message))]),
        }
    }
}

impl ServerHandler for Bridge {
    fn supported_protocol_versions(
        &self,
    ) -> std::borrow::Cow<'static, [rmcp::model::ProtocolVersion]> {
        crate::coordination::root_stdio::session_protocol_versions()
    }

    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.server_info.name = "suplex-agent-bridge".into();
        info.server_info.version = "1".into();
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
        Ok(ListToolsResult::with_all_items(TOOLS.clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        if super::tool(&request.name).is_none() {
            return Err(McpError::invalid_request(
                format!("MCP tool is unsupported: {}", request.name),
                None,
            ));
        }
        let mut args = request.arguments.unwrap_or_default();
        args.remove("_meta");
        Ok(self.result(&request.name, &args).await.into())
    }
}

pub async fn serve_from_environment() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    let settings = settings(&environment)?;
    // See session_protocol_versions: skip rmcp's handshake so a discover probe cannot fix the lifecycle.
    rmcp::service::serve_directly(Bridge::new(settings), rmcp::transport::stdio(), None)
        .waiting()
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::routes::agent_api::tests::agent;

    fn arguments(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    /// Ports `tests/suplex-mcp-bridge.test.ts` against the served Rust Agent API.
    #[tokio::test]
    async fn the_bridge_drives_the_paired_runtime_api_end_to_end() {
        let agent = agent().await;
        let bridge = Bridge::new(Settings {
            base_url: agent.server.base.clone(),
            credential: agent.credential.clone(),
        });
        let structured = |result: CallToolResult| result.structured_content.unwrap();
        let call =
            async |name: &str, args: Value| structured(bridge.result(name, &arguments(args)).await);
        let whoami = call("suplex_whoami", json!({})).await;
        assert_eq!(
            (
                whoami["status"].as_u64(),
                whoami["body"]["agent"]["name"].as_str()
            ),
            (Some(200), Some("AgentApi Bot"))
        );
        agent.server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_external_agents SET client_profile_id=NULL WHERE id=?1",
                    [&agent.agent_id],
                )
                .unwrap();
        });
        let recreated = call("suplex_whoami", json!({})).await;
        assert_eq!(recreated["body"]["agent"]["profileId"], Value::Null);
        assert_eq!(recreated["body"]["projects"], whoami["body"]["projects"]);
        let python = tokio::process::Command::new("/usr/bin/python3")
            .arg("-c")
            .arg("import importlib.util,json; spec=importlib.util.spec_from_file_location('suplex_client','apps/server/skills/suplex/suplex_client.py'); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); body=module.SuplexClient().call('GET','/api/hermes/me'); print(json.dumps({'id':body['agent']['id'],'profileId':body['agent']['profileId']}))")
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .env("SUPLEX_BASE_URL", &agent.server.base)
            .env("SUPLEX_AGENT_CREDENTIAL", &agent.credential)
            .output().await.unwrap();
        assert!(
            python.status.success(),
            "{}",
            String::from_utf8_lossy(&python.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&python.stdout).unwrap(),
            json!({"id":agent.agent_id,"profileId":null})
        );
        assert!(!String::from_utf8_lossy(&python.stdout).contains(&agent.credential));

        assert_eq!(
            call("suplex_list_templates", json!({"projectId": "project_api"})).await,
            json!({"status": 200, "body": {"templates": []}})
        );
        let dry = call("suplex_create_task", json!({"projectId": "project_api", "title": "Bridge dry run", "idempotencyKey": "bridge-dry-key-1", "dryRun": true})).await;
        assert_eq!(
            (
                dry["status"].as_u64(),
                dry["body"]["wouldStart"].as_str(),
                dry["body"].get("id")
            ),
            (Some(200), Some("backlog"), None)
        );
        let created = call("suplex_create_task", json!({"projectId": "project_api", "title": "Bridge task", "description": "Created through the MCP bridge", "idempotencyKey": "bridge-key-1"})).await;
        assert_eq!(created["status"], 201, "{created}");
        let task_id = created["body"]["id"].as_str().unwrap().to_owned();
        let revision = created["body"]["revision"].clone();
        let replayed = call("suplex_create_task", json!({"projectId": "project_api", "title": "Bridge task", "description": "Created through the MCP bridge", "idempotencyKey": "bridge-key-1"})).await;
        assert_eq!(
            (replayed["status"].as_u64(), replayed["body"]["id"].as_str()),
            (Some(200), Some(task_id.as_str()))
        );
        assert_eq!(
            call(
                "suplex_get_task",
                json!({"taskId": task_id, "knownRevision": revision})
            )
            .await,
            json!({"unchanged": true, "revision": revision})
        );
        let delivery = call("suplex_get_task_delivery", json!({"taskId": task_id})).await;
        assert_eq!(
            delivery,
            json!({"status": 200, "body": {"taskId": task_id, "taskStatus": "backlog", "revision": revision, "queue": {"projectConcurrencyLimited": false, "planConcurrencyLimited": false, "waitingOn": []}, "blocker": null, "delivery": null}})
        );
        let list = call(
            "suplex_list_tasks",
            json!({"projectId": "project_api", "limit": 10}),
        )
        .await;
        let listed = list["body"]["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == json!(task_id))
            .unwrap()
            .clone();
        assert_eq!(
            listed.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "id",
                "title",
                "status",
                "archived",
                "workflow",
                "dependsOn",
                "updatedAt"
            ]
        );
        let full = call(
            "suplex_list_tasks",
            json!({"projectId": "project_api", "limit": 10, "view": "full"}),
        )
        .await;
        assert!(full["body"]["tasks"][0].get("integration").is_some());
        let illegal = bridge.result("suplex_command_task", &arguments(json!({"taskId": task_id, "command": "unarchive_task", "revision": revision, "idempotencyKey": "bridge-command-1"}))).await;
        assert_eq!(illegal.is_error, Some(true));
        assert_eq!(
            illegal.structured_content.unwrap()["body"]["code"],
            "illegal_command"
        );
        let stale = call("suplex_command_task", json!({"taskId": task_id, "command": "cancel_task", "revision": "not-the-current-revision", "idempotencyKey": "bridge-command-2"})).await;
        assert_eq!(
            (stale["status"].as_u64(), stale["body"]["code"].as_str()),
            (Some(412), Some("revision_stale"))
        );
        let second = call("suplex_create_task", json!({"projectId": "project_api", "title": "Bridge second", "idempotencyKey": "bridge-key-2"})).await["body"]["id"].as_str().unwrap().to_owned();
        let dependent = call("suplex_create_task", json!({"projectId": "project_api", "title": "Bridge dependent", "idempotencyKey": "bridge-key-3", "dependsOn": [task_id]})).await;
        assert_eq!(
            (
                dependent["status"].as_u64(),
                dependent["body"]["dependsOn"].clone()
            ),
            (Some(201), json!([task_id])),
            "{dependent}"
        );
        let dependent_id = dependent["body"]["id"].as_str().unwrap().to_owned();
        let mut expected = vec![task_id.clone(), second.clone()];
        expected.sort();
        let set = call(
            "suplex_set_task_dependencies",
            json!({"taskId": dependent_id, "dependsOn": [second, task_id]}),
        )
        .await;
        assert_eq!(
            (set["status"].as_u64(), set["body"]["dependsOn"].clone()),
            (Some(200), json!(expected))
        );
        let cycle = call(
            "suplex_set_task_dependencies",
            json!({"taskId": task_id, "dependsOn": [dependent_id]}),
        )
        .await;
        assert_eq!(
            cycle,
            json!({"status": 422, "body": {"error": "The dependency creates a cycle", "code": "task_unavailable"}})
        );
    }

    #[tokio::test]
    async fn an_invalid_credential_fails_safely_and_is_redacted() {
        let agent = agent().await;
        let credential = "suplex-not-a-real-credential-value";
        let bridge = Bridge::new(Settings {
            base_url: agent.server.base.clone(),
            credential: credential.into(),
        });
        let whoami = bridge.result("suplex_whoami", &Map::new()).await;
        assert_eq!(whoami.is_error, Some(true));
        assert_eq!(
            whoami.structured_content.as_ref().unwrap()["body"]["code"],
            "credential_invalid"
        );
        assert!(!serde_json::to_string(&whoami).unwrap().contains(credential));
        assert_eq!(
            bridge.redact(&format!("token {credential} leaked")),
            "token [redacted credential] leaked"
        );
    }

    /// Move tools travel through the stdio bridge exactly as their HTTP Agent
    /// API routes do.  Keep this sequence small but complete: it catches a
    /// missing bridge case as well as lifecycle drift between the two paths.
    #[tokio::test]
    async fn bridge_drives_the_complete_move_lifecycle_with_live_grants() {
        let agent = agent().await;
        let bridge = Bridge::new(Settings {
            base_url: agent.server.base.clone(),
            credential: agent.credential.clone(),
        });
        let call = async |name: &str, args: Value| {
            let (status, body) = bridge.call(name, &arguments(args)).await.unwrap();
            json!({"status": status, "body": body})
        };
        // The credential is valid but Move authority is absent until the
        // persisted grant is changed.  This must conceal the resource.
        assert_eq!(
            call("suplex_list_moves", json!({"projectId": "project_api"})).await["status"],
            404
        );
        agent.server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_external_agents SET moves_granted_at = ?1 WHERE id = ?2",
                    rusqlite::params![crate::shared::time::now_millis_rfc3339(), agent.agent_id],
                )
                .unwrap();
        });
        let created = call("suplex_create_move", json!({
            "projectId":"project_api", "name":"Bridge move", "prompt":"Build it",
            "runner":"task", "workflow":"standard", "deliveryTarget":"local_worktree", "confirm":false, "idempotencyKey":"bridge-move-create-1"
        })).await;
        assert_eq!(created["status"], 201, "{created}");
        let move_id = created["body"]["id"].as_str().unwrap().to_owned();
        let replay = call("suplex_create_move", json!({
            "projectId":"project_api", "name":"Bridge move", "prompt":"Build it",
            "runner":"task", "workflow":"standard", "deliveryTarget":"local_worktree", "confirm":false, "idempotencyKey":"bridge-move-create-1"
        })).await;
        assert_eq!(
            (replay["status"].as_u64(), replay["body"]["id"].as_str()),
            (Some(200), Some(move_id.as_str()))
        );
        assert_eq!(call("suplex_create_move", json!({
            "projectId":"project_api", "name":"Different bridge move", "prompt":"Build it",
            "runner":"task", "workflow":"standard", "deliveryTarget":"local_worktree", "confirm":false, "idempotencyKey":"bridge-move-create-1"
        })).await["status"], 409);
        assert_eq!(
            call("suplex_list_moves", json!({"projectId":"project_api"})).await["status"],
            200
        );
        assert_eq!(
            call("suplex_get_move", json!({"moveId":move_id})).await["status"],
            200
        );
        let updated_at = created["body"]["updatedAt"].as_str().unwrap().to_owned();
        let stale = call("suplex_update_move", json!({
            "moveId":move_id, "updatedAt":"stale", "projectId":"project_api",
            "name":"Stale", "prompt":"Build it", "runner":"task", "workflow":"standard", "deliveryTarget":"local_worktree", "confirm":false
        })).await;
        assert_eq!(stale["status"], 412);
        let updated = call("suplex_update_move", json!({
            "moveId":move_id, "updatedAt":updated_at, "projectId":"project_api",
            "name":"Bridge move updated", "prompt":"Build it", "runner":"task", "workflow":"standard", "deliveryTarget":"local_worktree", "confirm":false
        })).await;
        assert_eq!(updated["status"], 200, "{updated}");
        let stale_delete = call(
            "suplex_delete_move",
            json!({"moveId":move_id, "updatedAt":updated_at}),
        )
        .await;
        assert_eq!(stale_delete["status"], 412);
        assert_eq!(
            call("suplex_get_move", json!({"moveId":move_id})).await["body"]["name"],
            "Bridge move updated"
        );
        let run = call("suplex_start_move", json!({"moveId":move_id, "idempotencyKey":"bridge-move-run-1", "inputs":{}, "excludedPullRequests":[]})).await;
        assert_eq!(run["status"], 201, "{run}");
        let run_id = run["body"]["id"].as_str().unwrap().to_owned();
        assert_eq!(
            call("suplex_list_move_runs", json!({"moveId":move_id})).await["status"],
            200
        );
        assert_eq!(
            call("suplex_get_move_run", json!({"runId":run_id})).await["status"],
            200
        );
        // Task runs have no terminal transcript; it is still the same concealed
        // missing-transcript response exposed by the Agent API.
        assert_eq!(
            call("suplex_get_move_run_transcript", json!({"runId":run_id})).await["status"],
            404
        );
        assert_eq!(
            call("suplex_stop_move_run", json!({"runId":run_id})).await["status"],
            204
        );
        assert_eq!(
            call("suplex_archive_move_run", json!({"runId":run_id})).await["status"],
            204
        );
        assert_eq!(
            call(
                "suplex_delete_move",
                json!({"moveId":move_id, "updatedAt":updated["body"]["updatedAt"]})
            )
            .await["status"],
            204
        );
        agent.server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_external_agents SET moves_granted_at = NULL WHERE id = ?1",
                    [&agent.agent_id],
                )
                .unwrap();
        });
        assert_eq!(
            call("suplex_get_move", json!({"moveId":move_id})).await["status"],
            404
        );
    }

    #[test]
    fn missing_configuration_names_the_variable_without_printing_a_value() {
        let environment = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect::<HashMap<_, _>>()
        };
        assert_eq!(
            settings(&environment(&[])).unwrap_err(),
            "Set SUPLEX_BASE_URL in the MCP server environment."
        );
        assert_eq!(
            settings(&environment(&[(
                "SUPLEX_BASE_URL",
                "http://127.0.0.1:4111"
            )]))
            .unwrap_err(),
            "Set SUPLEX_AGENT_CREDENTIAL in the MCP server environment."
        );
        assert!(
            !settings(&environment(&[
                ("SUPLEX_BASE_URL", "http://127.0.0.1:4111"),
                ("SUPLEX_AGENT_CREDENTIAL", "  ")
            ]))
            .unwrap_err()
            .contains("127.0.0.1")
        );
        assert_eq!(
            settings(&environment(&[
                ("SUPLEX_BASE_URL", "http://127.0.0.1:4111/"),
                ("SUPLEX_AGENT_CREDENTIAL", " secret ")
            ]))
            .unwrap(),
            Settings {
                base_url: "http://127.0.0.1:4111".into(),
                credential: "secret".into()
            }
        );
    }
}
