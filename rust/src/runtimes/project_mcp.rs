//! TypeScript `runtimes/project-mcp.ts`: project MCP servers granted per role.
//! `servers` is a validated project `execution.mcp` array.

use std::{collections::HashMap, io};

use serde_json::{Map, Value, json};

fn granted<'a>(server: &'a Value, role: &str) -> impl Iterator<Item = &'a str> {
    server["grants"][role]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

pub fn project_mcp_tools(servers: Option<&Value>, role: &str) -> Vec<String> {
    servers
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|server| {
            let name = server["name"].as_str().unwrap_or_default();
            granted(server, role).map(move |tool| format!("mcp__{name}__{tool}"))
        })
        .collect()
}

/// Resolve credential references from the Suplex process environment.
pub fn project_mcp_servers(
    servers: Option<&Value>,
    role: &str,
    environment: &HashMap<String, String>,
) -> io::Result<Map<String, Value>> {
    let resolve = |references: &Value| -> io::Result<Map<String, Value>> {
        let mut resolved = Map::new();
        for (key, reference) in references.as_object().into_iter().flatten() {
            let reference = reference.as_str().unwrap_or_default();
            let value = environment
                .get(reference)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    io::Error::other(format!(
                        "MCP credential environment variable {reference} is not configured"
                    ))
                })?;
            resolved.insert(key.clone(), json!(value));
        }
        Ok(resolved)
    };
    let mut result = Map::new();
    for server in servers.and_then(Value::as_array).into_iter().flatten() {
        if granted(server, role).next().is_none() {
            continue;
        }
        let transport = &server["transport"];
        let entry = if transport["type"] == "stdio" {
            json!({"type":"stdio","command":transport["command"],"args":transport.get("args").cloned().unwrap_or(json!([])),"env":resolve(&transport["env"])?})
        } else {
            json!({"type":"http","url":transport["url"],"headers":resolve(&transport["headers"])?})
        };
        result.insert(
            server["name"].as_str().unwrap_or_default().to_owned(),
            entry,
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_grants_are_exact_and_role_scoped() {
        let servers = json!([{"name":"context7","transport":{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"CONTEXT7_TOKEN"}},"grants":{"root":["query_docs"],"advisor":[],"worker":["query_docs","resolve_library_id"]}}]);
        assert_eq!(
            project_mcp_tools(Some(&servers), "root"),
            ["mcp__context7__query_docs"]
        );
        assert!(project_mcp_tools(None, "root").is_empty());
        assert!(
            project_mcp_servers(Some(&servers), "advisor", &HashMap::new())
                .unwrap()
                .is_empty()
        );
        let token = HashMap::from([("CONTEXT7_TOKEN".to_owned(), "fixture".to_owned())]);
        assert_eq!(
            Value::Object(project_mcp_servers(Some(&servers), "root", &token).unwrap()),
            json!({"context7":{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"fixture"}}})
        );
        let missing = project_mcp_servers(Some(&servers), "root", &HashMap::new()).unwrap_err();
        assert!(missing.to_string().contains("CONTEXT7_TOKEN"));
        let stdio = json!([{"name":"local","transport":{"type":"stdio","command":"/bin/tool","args":["--x"],"env":{"KEY":"LOCAL_KEY"}},"grants":{"root":[],"advisor":[],"worker":["run"]}}]);
        let key = HashMap::from([("LOCAL_KEY".to_owned(), "secret".to_owned())]);
        assert_eq!(
            Value::Object(project_mcp_servers(Some(&stdio), "worker", &key).unwrap()),
            json!({"local":{"type":"stdio","command":"/bin/tool","args":["--x"],"env":{"KEY":"secret"}}})
        );
    }
}
