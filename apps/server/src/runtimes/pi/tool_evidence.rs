//! Tool observations projected from an immutable Pi or omp turn log.

use serde_json::{Map, Value, json};

use super::transcript::PiEvent;
use crate::runtimes::native::NativeTool;

/// The text blocks of a Pi tool result.
pub fn result_text(result: &Value) -> Option<String> {
    let blocks = result["content"].as_array()?;
    Some(
        blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// omp calls a mounted MCP tool by writing its JSON arguments to the
/// `xd://<tool>` device. Such a call reads as the MCP tool, named
/// `mcp__<server>__<tool>` as Pi names it. `details` is the tool result's,
/// which names the server and tool; before it exists the device name stands.
pub fn device_call(
    name: &str,
    input: Option<&Map<String, Value>>,
    details: &Value,
) -> Option<(String, Map<String, Value>)> {
    if name != "write" {
        return None;
    }
    let device = &details["xdev"];
    let path = input
        .and_then(|input| input.get("path"))
        .and_then(Value::as_str);
    let device_name = match path {
        Some(path) => path.strip_prefix("xd://")?,
        None => device["tool"].as_str()?,
    };
    let inner = &device["inner"];
    let name = match (inner["serverName"].as_str(), inner["mcpToolName"].as_str()) {
        (Some(server), Some(tool)) => format!("mcp__{server}__{tool}"),
        _ => device_name.to_owned(),
    };
    let input = device["args"].as_object().cloned().or_else(|| {
        input?
            .get("content")?
            .as_str()
            .and_then(|content| serde_json::from_str::<Map<String, Value>>(content).ok())
    });
    Some((name, input.unwrap_or_default()))
}

/// An MCP tool keeps its `CallToolResult` envelope, which the Advisor report
/// reader accepts. A Pi turn log carries it whole in `structuredContent`; a
/// Pi session file keeps only its content. omp keeps the server's own result
/// in the device details of both. A built-in tool shows its text.
pub fn tool_output(name: &str, result: &Value) -> Option<String> {
    if result.is_null() {
        return None;
    }
    let inner = &result["details"]["xdev"]["inner"];
    if name.starts_with("mcp__") && inner["rawContent"].is_array() {
        let mut envelope = json!({
            "content": inner["rawContent"],
            "isError": inner["isError"] == true,
        });
        if !inner["structuredContent"].is_null() {
            envelope["structuredContent"] = inner["structuredContent"].clone();
        }
        return Some(crate::shared::js_json::stringify(&envelope));
    }
    if name.starts_with("mcp__") {
        let envelope = result
            .get("structuredContent")
            .filter(|envelope| envelope.get("content").is_some())
            .cloned()
            .unwrap_or_else(|| json!({"content": result["content"]}));
        Some(crate::shared::js_json::stringify(&envelope))
    } else {
        result_text(result).or_else(|| Some(crate::shared::js_json::stringify(result)))
    }
}

/// The last execution event of each tool wins, retaining its first position.
pub fn pi_tools(events: &[PiEvent]) -> Vec<NativeTool> {
    let mut tools = Vec::<NativeTool>::new();
    for event in events {
        let value = event.value();
        let finished = match event.kind() {
            "tool_execution_end" => true,
            "tool_execution_start" | "tool_execution_update" => false,
            _ => continue,
        };
        let (Some(id), Some(name)) = (value["toolCallId"].as_str(), value["toolName"].as_str())
        else {
            continue;
        };
        if id.is_empty() || name.is_empty() {
            continue;
        }
        let position = tools.iter().position(|tool| tool.id == id);
        let args = value["args"].as_object();
        let (name, input) = match device_call(name, args, &value["result"]["details"]) {
            Some(call) => call,
            // An end event repeats no arguments, so the started call stands.
            None => match (args, position) {
                (None, Some(index)) => (tools[index].name.clone(), tools[index].input.clone()),
                _ => (name.to_owned(), args.cloned().unwrap_or_else(Map::new)),
            },
        };
        let name = name.as_str();
        let failed = finished && value["isError"] == true;
        let output = if finished {
            tool_output(name, &value["result"])
        } else {
            tool_output(name, &value["partialResult"])
        };
        let candidate = NativeTool {
            id: id.to_owned(),
            name: name.to_owned(),
            status: if failed {
                "error"
            } else if finished {
                "completed"
            } else {
                "running"
            },
            input,
            error: failed.then(|| {
                result_text(&value["result"])
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| "Tool failed".to_owned())
            }),
            output,
        };
        match position {
            Some(index) => tools[index] = candidate,
            None => tools.push(candidate),
        }
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::pi::transcript::parse_events;
    use serde_json::json;

    #[test]
    fn a_real_advisor_turn_yields_a_submission_the_report_reader_accepts() {
        use crate::coordination::advisor_bridge::{AdvisorRole, advisor_report_from_turn};
        let tools = pi_tools(&parse_events(include_str!("fixtures/advisor-turn.jsonl")));
        assert_eq!(tools[0].name, "mcp__suplex_advisor__submit_report");
        let tools = tools
            .iter()
            .map(|tool| serde_json::to_value(tool).unwrap())
            .collect::<Vec<_>>();
        let report = advisor_report_from_turn(AdvisorRole::Reviewer, &tools, "").unwrap();
        assert_eq!(report["summary"], "The change is correct.");
        assert_eq!(report["approved"], true);
        let session_result = json!({"role":"toolResult","toolCallId":"call_1","toolName":"mcp__suplex_advisor__submit_report","content":[{"type":"text","text":"{\"summary\":\"Plan\"}"}],"isError":false});
        let output = tool_output("mcp__suplex_advisor__submit_report", &session_result).unwrap();
        let session_tool = json!({"name":"mcp__suplex_advisor__submit_report","status":"completed","output":output});
        assert_eq!(
            advisor_report_from_turn(AdvisorRole::PlannerA, &[session_tool], "").unwrap()["summary"],
            "Plan"
        );
    }

    #[test]
    fn a_real_omp_advisor_device_call_yields_a_submission_the_report_reader_accepts() {
        use crate::coordination::advisor_bridge::{AdvisorRole, advisor_report_from_turn};
        let tools = pi_tools(&parse_events(include_str!(
            "fixtures/omp-advisor-turn.jsonl"
        )));
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "mcp__suplex_advisor__submit_report");
        assert_eq!(tools[0].input["summary"], "The change is correct.");
        let tools = tools
            .iter()
            .map(|tool| serde_json::to_value(tool).unwrap())
            .collect::<Vec<_>>();
        let report = advisor_report_from_turn(AdvisorRole::Reviewer, &tools, "").unwrap();
        assert_eq!(report["summary"], "The change is correct.");
        assert_eq!(report["approved"], true);
        // Before its result, a device call keeps omp's device name and arguments.
        let started = pi_tools(&parse_events(
            "{\"type\":\"tool_execution_start\",\"toolCallId\":\"c\",\"toolName\":\"write\",\"args\":{\"path\":\"xd://mcp__suplex_root_observe\",\"content\":\"{\\\"taskId\\\":\\\"t\\\"}\"}}\n",
        ));
        assert_eq!(
            (started[0].name.as_str(), started[0].status),
            ("mcp__suplex_root_observe", "running")
        );
        assert_eq!(started[0].input["taskId"], "t");
        // A file write is an ordinary write.
        let file = pi_tools(&parse_events(concat!(
            "{\"type\":\"tool_execution_start\",\"toolCallId\":\"w\",\"toolName\":\"write\",\"args\":{\"path\":\"a.rs\",\"content\":\"x\"}}\n",
            "{\"type\":\"tool_execution_end\",\"toolCallId\":\"w\",\"toolName\":\"write\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Wrote a.rs\"}],\"details\":{}},\"isError\":false}\n",
        )));
        assert_eq!(file[0].name, "write");
        assert_eq!(file[0].input["path"], "a.rs");
        assert_eq!(file[0].output.as_deref(), Some("Wrote a.rs"));
    }

    #[test]
    fn native_tool_events_replace_in_place_and_keep_error_and_mcp_evidence() {
        let events = parse_events(concat!(
            "{\"type\":\"tool_execution_start\",\"toolCallId\":\"call_1\",\"toolName\":\"bash\",\"args\":{\"command\":\"pnpm test\"}}\n",
            "{\"type\":\"tool_execution_update\",\"toolCallId\":\"call_1\",\"toolName\":\"bash\",\"args\":{\"command\":\"pnpm test\"},\"partialResult\":{\"content\":[{\"type\":\"text\",\"text\":\"running\"}]}}\n",
            "{\"type\":\"tool_execution_start\",\"toolCallId\":\"call_2\",\"toolName\":\"mcp__suplex_advisor__submit_report\",\"args\":{\"summary\":\"Plan\"}}\n",
            "{\"type\":\"tool_execution_end\",\"toolCallId\":\"call_2\",\"toolName\":\"mcp__suplex_advisor__submit_report\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{}\"}],\"details\":{\"server\":\"suplex_advisor\",\"tool\":\"submit_report\"},\"structuredContent\":{\"content\":[{\"type\":\"text\",\"text\":\"{}\"}],\"structuredContent\":{\"ok\":true},\"isError\":false}},\"isError\":false,\"durationMs\":4}\n",
            "{\"type\":\"tool_execution_end\",\"toolCallId\":\"call_1\",\"toolName\":\"bash\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"2 failed\"}]},\"isError\":true,\"durationMs\":13}\n",
            "{\"type\":\"tool_execution_start\",\"toolCallId\":\"call_3\",\"toolName\":\"read\",\"args\":{\"path\":\"a.rs\"}}\n",
        ));
        assert_eq!(
            serde_json::to_value(pi_tools(&events)).unwrap(),
            json!([
                {"id":"call_1","name":"bash","status":"error","input":{"command":"pnpm test"},"output":"2 failed","error":"2 failed"},
                {"id":"call_2","name":"mcp__suplex_advisor__submit_report","status":"completed","input":{"summary":"Plan"},"output":"{\"content\":[{\"type\":\"text\",\"text\":\"{}\"}],\"structuredContent\":{\"ok\":true},\"isError\":false}","error":null},
                {"id":"call_3","name":"read","status":"running","input":{"path":"a.rs"},"output":null,"error":null},
            ])
        );
    }
}
