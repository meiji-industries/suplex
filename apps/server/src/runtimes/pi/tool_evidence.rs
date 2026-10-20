//! Tool observations projected from an immutable Pi turn log.

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

/// An MCP tool keeps its `CallToolResult` envelope, which the Advisor report
/// reader accepts. A turn log carries it whole in `structuredContent`; a
/// session file keeps only its content. A built-in tool shows its text.
pub fn tool_output(name: &str, result: &Value) -> Option<String> {
    if result.is_null() {
        return None;
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
        let input = value["args"]
            .as_object()
            .cloned()
            .or_else(|| position.map(|index| tools[index].input.clone()))
            .unwrap_or_else(Map::new);
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
