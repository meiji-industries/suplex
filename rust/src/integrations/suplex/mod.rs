//! The Suplex MCP tools: in-process for the OAuth `/mcp` endpoint, and a stdio
//! bridge over the Agent API for a paired credential (`suplex mcp`).

pub mod bridge;
pub mod runtime;

use std::sync::LazyLock;

use rmcp::model::{CallToolResult, Tool};
use serde_json::{Map, Value, json};

use crate::http::contracts::typed::{
    ContractFailure, ContractResult,
    agent_api::{self, Check, TaskCommandBody, TaskDependenciesBody, path},
};

/// Tool names, descriptions, and input schemas generated from TypeScript by `scripts/rust-agent-artifacts.ts`.
pub static TOOLS: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("tools.json")).expect("generated MCP tools are valid")
});

pub fn tool(name: &str) -> Option<Tool> {
    TOOLS.iter().find(|tool| tool.name == name).cloned()
}

/// `presentSuplexMcpResult` plus the text and error flag both transports add.
pub fn present(status: u16, body: Value) -> CallToolResult {
    let result = if status == 304 {
        body
    } else {
        json!({"status": status, "body": body})
    };
    if status >= 400 {
        CallToolResult::structured_error(result)
    } else {
        CallToolResult::structured(result)
    }
}

/// A tool argument that fails its schema; TypeScript surfaces the Zod issues.
#[derive(Debug)]
pub struct InvalidArguments(pub Vec<Value>);

impl std::fmt::Display for InvalidArguments {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&Value::Array(self.0.clone()).to_string())
    }
}

impl std::error::Error for InvalidArguments {}

fn arguments<T>(result: ContractResult<T>) -> Result<T, InvalidArguments> {
    match result {
        Ok(value) => Ok(value),
        Err(ContractFailure::Issues(issues)) => Err(InvalidArguments(issues)),
        Err(other) => Err(InvalidArguments(vec![json!(format!("{other:?}"))])),
    }
}

fn task_id(check: &mut Check, fields: &Map<String, Value>) -> Option<String> {
    check.string(fields.get("taskId"), &path(&["taskId"]), false, 1, 100)
}

/// `{ taskId, knownRevision? }`, strict.
pub fn get_task_arguments(
    fields: &Map<String, Value>,
) -> Result<(String, Option<String>), InvalidArguments> {
    let mut check = Check::default();
    let id = task_id(&mut check, fields);
    let known = check.optional_string(fields, "knownRevision", false, 1, 256);
    check.unknown_keys(fields, &[], &["taskId", "knownRevision"]);
    arguments(check.finish(id.zip(known)))
}

/// `{ taskId }`, strict.
pub fn task_only_arguments(fields: &Map<String, Value>) -> Result<String, InvalidArguments> {
    let mut check = Check::default();
    let id = task_id(&mut check, fields);
    check.unknown_keys(fields, &[], &["taskId"]);
    arguments(check.finish(id))
}

pub fn command_arguments(
    fields: &Map<String, Value>,
) -> Result<(String, TaskCommandBody), InvalidArguments> {
    let mut check = Check::default();
    let id = task_id(&mut check, fields);
    let command = agent_api::task_command_fields(
        fields,
        &["command", "revision", "idempotencyKey", "note", "taskId"],
    );
    match (check.finish(id), command) {
        (Ok(id), Ok(command)) => Ok((id, command)),
        (id, command) => {
            let mut issues = Vec::new();
            for failure in [id.err(), command.err()].into_iter().flatten() {
                if let ContractFailure::Issues(found) = failure {
                    issues.extend(found);
                }
            }
            Err(InvalidArguments(issues))
        }
    }
}

pub fn dependencies_arguments(
    fields: &Map<String, Value>,
) -> Result<(String, TaskDependenciesBody), InvalidArguments> {
    let mut check = Check::default();
    let id = task_id(&mut check, fields);
    let body = agent_api::task_dependencies_fields(
        fields,
        &["dependsOn", "blockedByPullRequests", "dryRun", "taskId"],
    );
    match (check.finish(id), body) {
        (Ok(id), Ok(body)) => Ok((id, body)),
        (id, body) => {
            let mut issues = Vec::new();
            for failure in [id.err(), body.err()].into_iter().flatten() {
                if let ContractFailure::Issues(found) = failure {
                    issues.extend(found);
                }
            }
            Err(InvalidArguments(issues))
        }
    }
}

pub fn list_arguments(
    fields: &Map<String, Value>,
) -> Result<agent_api::TaskListQuery, InvalidArguments> {
    arguments(agent_api::parse_task_list(Some(&Value::Object(
        fields.clone(),
    ))))
}

pub fn project_arguments(fields: &Map<String, Value>) -> Result<String, InvalidArguments> {
    arguments(agent_api::parse_project_discovery(Some(&Value::Object(
        fields.clone(),
    ))))
    .map(|query| query.project_id)
}

pub fn create_arguments(
    fields: &Map<String, Value>,
) -> Result<agent_api::TaskCreateBody, InvalidArguments> {
    arguments(agent_api::parse_task_create(Some(&Value::Object(
        fields.clone(),
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_keep_the_typescript_names_and_carry_no_credential() {
        let names = TOOLS
            .iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "suplex_whoami",
                "suplex_capabilities",
                "suplex_list_workflows",
                "suplex_list_templates",
                "suplex_list_tasks",
                "suplex_get_task",
                "suplex_get_task_delivery",
                "suplex_create_task",
                "suplex_set_task_dependencies",
                "suplex_command_task"
            ]
        );
        let command = tool("suplex_command_task").unwrap();
        assert!(
            command
                .description
                .as_deref()
                .unwrap()
                .contains("not reversible")
        );
        let schema = serde_json::to_value(&command.input_schema).unwrap();
        assert!(
            schema["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|name| name == "taskId")
        );
        for tool in TOOLS.iter() {
            assert!(
                !serde_json::to_string(&tool.input_schema)
                    .unwrap()
                    .contains("credential")
            );
        }
        let openapi: Value =
            serde_json::from_str(include_str!("../../http/routes/agent_api_openapi.json")).unwrap();
        let create = &openapi["paths"]["/api/agent/tasks"]["post"]["requestBody"]["content"]["application/json"]
            ["schema"];
        let mut expected = create["properties"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut actual = serde_json::to_value(&tool("suplex_create_task").unwrap().input_schema)
            .unwrap()["properties"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn tool_arguments_add_task_id_to_the_strict_http_schemas() {
        let fields = |value: Value| value.as_object().unwrap().clone();
        assert_eq!(
            get_task_arguments(&fields(json!({"taskId": "t", "knownRevision": "r"}))).unwrap(),
            ("t".to_owned(), Some("r".to_owned()))
        );
        assert!(get_task_arguments(&fields(json!({}))).is_err());
        assert!(task_only_arguments(&fields(json!({"taskId": "t", "x": 1}))).is_err());
        let (id, command) = command_arguments(&fields(
            json!({"taskId": "t", "command": "start_task", "revision": "r", "idempotencyKey": "k"}),
        ))
        .unwrap();
        assert_eq!((id.as_str(), command.command.as_str()), ("t", "start_task"));
        assert!(
            command_arguments(&fields(
                json!({"command": "start_task", "revision": "r", "idempotencyKey": "k"})
            ))
            .is_err()
        );
        let (_, body) =
            dependencies_arguments(&fields(json!({"taskId": "t", "dependsOn": ["a"]}))).unwrap();
        assert_eq!(body.depends_on, ["a"]);
        assert_eq!(
            present(304, json!({"unchanged": true})).structured_content,
            Some(json!({"unchanged": true}))
        );
        assert_eq!(
            present(409, json!({"code": "illegal_command"})).is_error,
            Some(true)
        );
    }
}
