use crate::runtimes::native::NativeTool;
// Tool observations projected from an immutable native Codex turn log.

use serde_json::{Map, Value, json};

use super::transcript::CodexEvent;

fn status(item: &Value, completed: bool) -> &'static str {
    if item
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|value| {
            let lower = value.to_ascii_lowercase();
            ["fail", "error", "declined"]
                .iter()
                .any(|part| lower.contains(part))
        })
    {
        "error"
    } else if completed {
        "completed"
    } else {
        "running"
    }
}

fn js_text(value: &Value) -> String {
    crate::shared::js_json::stringify(value)
}

fn tool(item: &Value, completed: bool) -> Option<NativeTool> {
    let id = item.get("id")?.as_str()?.to_owned();
    let kind = item.get("type")?.as_str()?;
    if kind != "web_search" && item.get("status").is_some_and(|value| !value.is_string()) {
        return None;
    }
    let mut input = Map::new();
    let (name, status, output, error) = match kind {
        "command_execution" => {
            if item
                .get("aggregated_output")
                .is_some_and(|value| !value.is_string())
                || item
                    .get("exit_code")
                    .is_some_and(|value| !value.is_null() && !value.is_number())
            {
                return None;
            }
            input.insert("command".into(), json!(item.get("command")?.as_str()?));
            let exit = item.get("exit_code").filter(|value| !value.is_null());
            let failed =
                exit.is_some_and(|value| value.as_f64().is_some_and(|number| number != 0.0));
            let error =
                failed.then(|| format!("exit {}", js_text(exit.expect("failed exit code"))));
            (
                "command_execution".to_owned(),
                if failed {
                    "error"
                } else {
                    status(item, completed)
                },
                item.get("aggregated_output")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                error,
            )
        }
        "file_change" => {
            let changes = item.get("changes").and_then(Value::as_array);
            if item.get("changes").is_some_and(|value| !value.is_array())
                || changes.is_some_and(|values| {
                    values.iter().any(|value| {
                        value.get("path").and_then(Value::as_str).is_none()
                            || value.get("kind").and_then(Value::as_str).is_none()
                    })
                })
            {
                return None;
            }
            let changes = changes
                .into_iter()
                .flatten()
                .map(|change| json!({"path":change["path"],"kind":change["kind"]}))
                .collect::<Vec<_>>();
            input.insert("changes".into(), json!(changes));
            ("file_change".into(), status(item, completed), None, None)
        }
        "mcp_tool_call" => {
            let server = item.get("server")?.as_str()?;
            let tool = item.get("tool")?.as_str()?;
            input = item
                .get("arguments")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let output = item.get("result").map(js_text);
            let error = item
                .get("error")
                .filter(|value| !value.is_null())
                .map(|value| {
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| js_text(value))
                });
            (
                format!("mcp__{server}__{tool}"),
                status(item, completed),
                output,
                error,
            )
        }
        "web_search" => {
            if item.get("query").is_some_and(|value| !value.is_string()) {
                return None;
            }
            if let Some(query) = item.get("query").and_then(Value::as_str) {
                input.insert("query".into(), json!(query));
            }
            (
                "web_search".into(),
                if completed { "completed" } else { "running" },
                None,
                None,
            )
        }
        _ => return None,
    };
    Some(NativeTool {
        id,
        name,
        status,
        input,
        output,
        error,
    })
}

/// Last native item event wins, retaining the tool's first position in the turn.
pub fn codex_tools(events: &[CodexEvent]) -> Vec<NativeTool> {
    let mut tools = Vec::<NativeTool>::new();
    for event in events {
        let completed = match event.kind() {
            "item.completed" => true,
            "item.started" | "item.updated" => false,
            _ => continue,
        };
        let Some(item) = event.value().get("item") else {
            continue;
        };
        let Some(candidate) = tool(item, completed) else {
            continue;
        };
        if let Some(position) = tools.iter().position(|tool| tool.id == candidate.id) {
            tools[position] = candidate;
        } else {
            tools.push(candidate);
        }
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::codex::transcript::parse_events;

    #[test]
    fn native_tool_events_replace_in_place_and_keep_error_evidence() {
        let events = parse_events(concat!(
            "{\"type\":\"item.started\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",\"command\":\"pnpm test\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_2\",\"type\":\"mcp_tool_call\",\"server\":\"suplex_root\",\"tool\":\"observe\",\"result\":{\"ok\":true}}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",\"command\":\"pnpm test\",\"aggregated_output\":\"failed\",\"exit_code\":3}}\n"
        ));
        let tools = codex_tools(&events);
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].id, "item_1");
        assert_eq!(tools[0].status, "error");
        assert_eq!(tools[0].error.as_deref(), Some("exit 3"));
        assert_eq!(tools[1].output.as_deref(), Some("{\"ok\":true}"));
    }

    #[test]
    fn source_transcript_sample_projects_exact_tool_rows() {
        let events = parse_events(concat!(
            "{\"type\":\"item.started\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",\"command\":\"pnpm test\",\"status\":\"in_progress\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",\"command\":\"pnpm test\",\"aggregated_output\":\"2 passed\",\"exit_code\":0,\"status\":\"completed\"}}\n",
            "{\"type\":\"item.started\",\"item\":{\"id\":\"item_2\",\"type\":\"mcp_tool_call\",\"server\":\"suplex_root\",\"tool\":\"ask_human\",\"arguments\":{\"question\":\"Ship?\"},\"status\":\"in_progress\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_3\",\"type\":\"command_execution\",\"command\":\"false\",\"aggregated_output\":\"\",\"exit_code\":3,\"status\":\"failed\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_4\",\"type\":\"file_change\",\"changes\":[{\"path\":\"src/a.ts\",\"kind\":\"modify\"}],\"status\":\"completed\"}}\n",
        ));
        assert_eq!(
            serde_json::to_value(codex_tools(&events)).unwrap(),
            json!([
                {"id":"item_1","name":"command_execution","status":"completed","input":{"command":"pnpm test"},"output":"2 passed","error":null},
                {"id":"item_2","name":"mcp__suplex_root__ask_human","status":"running","input":{"question":"Ship?"},"output":null,"error":null},
                {"id":"item_3","name":"command_execution","status":"error","input":{"command":"false"},"output":"","error":"exit 3"},
                {"id":"item_4","name":"file_change","status":"completed","input":{"changes":[{"path":"src/a.ts","kind":"modify"}]},"output":null,"error":null},
            ])
        );
    }

    #[test]
    fn file_change_strips_unknown_fields_and_web_search_ignores_status() {
        let events = parse_events(concat!(
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"change\",\"type\":\"file_change\",\"changes\":[{\"path\":\"a\",\"kind\":\"modify\",\"extra\":1}]}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"search\",\"type\":\"web_search\",\"query\":\"docs\",\"status\":\"failed\"}}\n",
        ));
        assert_eq!(
            serde_json::to_value(codex_tools(&events)).unwrap(),
            json!([
                {"id":"change","name":"file_change","status":"completed","input":{"changes":[{"path":"a","kind":"modify"}]},"output":null,"error":null},
                {"id":"search","name":"web_search","status":"completed","input":{"query":"docs"},"output":null,"error":null},
            ])
        );
    }
}
