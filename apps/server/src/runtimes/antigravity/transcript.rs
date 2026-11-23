//! The turn log that `suplex antigravity-turn` writes: one JSON object per
//! line. `update` lines hold the agent's own `session/update` payloads
//! unchanged; the other lines record what the client did and what the agent
//! answered.
//!
//! - `initialized`: the `initialize` result (`agentInfo`, `agentCapabilities`).
//! - `session`: the native `sessionId`, whether it was `resumed`, and the
//!   session `configOptions`.
//! - `config`: the model and thinking level the turn selected.
//! - `update`: one `session/update` `update` object.
//! - `permission`: a permission request and the option the client chose.
//! - `message` and `thought`: a finished run of text or reasoning chunks, for
//!   the passive display.
//! - `prompt_result`: the `session/prompt` result (`stopReason`, `usage`).
//! - `settled`: tools that were still running when the client stopped waiting.
//! - `warning` and `error`: a problem the client observed.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::runtimes::native::NativeTool;

pub fn parse_events(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["type"].is_string())
        .collect()
}

fn kind(event: &Value) -> &str {
    event["type"].as_str().unwrap_or_default()
}

/// The native ACP session id the turn used.
pub fn session_id(events: &[Value]) -> Option<&str> {
    events
        .iter()
        .rev()
        .filter(|event| kind(event) == "session")
        .find_map(|event| event["sessionId"].as_str())
        .filter(|id| !id.is_empty())
}

fn prompt_result(events: &[Value]) -> Option<&Value> {
    events
        .iter()
        .rev()
        .find(|event| kind(event) == "prompt_result")
}

fn stop_reason(events: &[Value]) -> Option<&str> {
    prompt_result(events).and_then(|result| result["stopReason"].as_str())
}

/// The agent finished the prompt.
pub fn completed(events: &[Value]) -> bool {
    matches!(
        stop_reason(events),
        Some("end_turn" | "max_tokens" | "max_turn_requests")
    )
}

/// The agent ended the prompt because it was cancelled.
pub fn aborted(events: &[Value]) -> bool {
    stop_reason(events) == Some("cancelled")
}

/// The failure the turn reported, if any.
pub fn failure(events: &[Value]) -> Option<String> {
    if let Some(error) = events.iter().rev().find(|event| kind(event) == "error") {
        return Some(
            error["message"]
                .as_str()
                .unwrap_or("Antigravity reported an error")
                .to_owned(),
        );
    }
    (stop_reason(events) == Some("refusal")).then(|| "Antigravity refused the request.".to_owned())
}

/// The turn failed because Antigravity is not signed in.
#[cfg(test)]
pub fn sign_in_required(events: &[Value]) -> bool {
    events
        .iter()
        .any(|event| kind(event) == "error" && event["signInRequired"] == true)
}

fn updates(events: &[Value]) -> impl Iterator<Item = &Value> {
    events
        .iter()
        .filter(|event| kind(event) == "update")
        .map(|event| &event["update"])
}

fn update_kind(update: &Value) -> &str {
    update["sessionUpdate"].as_str().unwrap_or_default()
}

fn chunk_text(update: &Value) -> Option<&str> {
    let content = &update["content"];
    (content["type"] == "text")
        .then(|| content["text"].as_str())
        .flatten()
}

/// One tool call folded from its `tool_call` and `tool_call_update` updates.
#[derive(Debug, Clone, Default)]
pub struct ToolCall {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub raw_input: Value,
    pub raw_output: Value,
    pub content: Vec<Value>,
    pub locations: Vec<Value>,
}

impl ToolCall {
    fn apply(&mut self, update: &Value) {
        if let Some(title) = update["title"].as_str() {
            self.title = title.to_owned();
        }
        if let Some(kind) = update["kind"].as_str() {
            self.kind = kind.to_owned();
        }
        if let Some(status) = update["status"].as_str() {
            self.status = status.to_owned();
        }
        if !update["rawInput"].is_null() {
            self.raw_input = update["rawInput"].clone();
        }
        if !update["rawOutput"].is_null() {
            self.raw_output = update["rawOutput"].clone();
        }
        if let Some(content) = update["content"].as_array() {
            self.content = content.clone();
        }
        if let Some(locations) = update["locations"].as_array() {
            self.locations = locations.clone();
        }
    }

    pub fn settled(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }

    /// `mcp__<server>__<tool>` for an MCP call, as the other runtimes name
    /// it; otherwise the ACP tool kind, or its title.
    pub fn name(&self) -> String {
        if let (Some(server), Some(tool)) = (
            self.raw_input["ServerName"].as_str(),
            self.raw_input["ToolName"].as_str(),
        ) {
            return format!("mcp__{server}__{tool}");
        }
        if !self.kind.is_empty() && self.kind != "other" {
            return self.kind.clone();
        }
        if self.title.is_empty() {
            "tool".to_owned()
        } else {
            self.title.clone()
        }
    }

    /// A command the agent runs in the background: it can outlive its prompt.
    pub fn daemon(&self) -> bool {
        self.raw_input["IsDaemon"] == true
    }

    fn input(&self) -> Map<String, Value> {
        let mut input = match &self.raw_input {
            Value::Object(object) => {
                // An MCP call keeps its tool arguments, as the other runtimes do.
                match object.get("Arguments").or_else(|| object.get("arguments")) {
                    Some(Value::Object(arguments)) if object.contains_key("ServerName") => {
                        arguments.clone()
                    }
                    Some(_) | None => object.clone(),
                }
            }
            Value::Null => Map::new(),
            Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => {
                Map::from_iter([("input".to_owned(), self.raw_input.clone())])
            }
        };
        if input.is_empty() && !self.title.is_empty() {
            input.insert("title".into(), json!(self.title));
        }
        if let Some(path) = self
            .locations
            .first()
            .and_then(|location| location["path"].as_str())
            && !input.contains_key("path")
        {
            input.insert("path".into(), json!(path));
        }
        input
    }

    fn text(&self) -> Option<String> {
        let text = self
            .content
            .iter()
            .filter_map(|block| {
                let inner = &block["content"];
                (block["type"] == "content" && inner["type"] == "text")
                    .then(|| inner["text"].as_str())
                    .flatten()
            })
            .collect::<Vec<_>>();
        (!text.is_empty()).then(|| text.join("\n"))
    }

    /// An MCP call keeps a `CallToolResult` envelope, which the Advisor report
    /// reader accepts. Another tool shows its text.
    pub fn output(&self) -> Option<String> {
        let mcp = self.raw_input.get("ServerName").is_some();
        if mcp {
            if self.raw_output.get("content").is_some() {
                return Some(crate::shared::js_json::stringify(&self.raw_output));
            }
            return self.text().map(|text| {
                crate::shared::js_json::stringify(&json!({"content":[{"type":"text","text":text}]}))
            });
        }
        self.text().or_else(|| match &self.raw_output {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            Value::Object(object) => object
                .get("output")
                .or_else(|| object.get("combinedOutput"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some(crate::shared::js_json::stringify(&self.raw_output))),
            Value::Bool(_) | Value::Number(_) | Value::Array(_) => {
                Some(self.raw_output.to_string())
            }
        })
    }

    pub fn native(&self) -> NativeTool {
        let failed = self.status == "failed";
        let output = self.output();
        NativeTool {
            id: self.id.clone(),
            name: self.name(),
            status: if failed {
                "error"
            } else if self.status == "completed" {
                "completed"
            } else {
                "running"
            },
            input: self.input(),
            error: if failed { output.clone() } else { None },
            output,
        }
    }
}

/// Tool calls in first-seen order.
#[derive(Debug, Default)]
pub struct Tools {
    order: Vec<String>,
    calls: HashMap<String, ToolCall>,
}

impl Tools {
    /// Folds one `session/update` payload; `true` when it is a tool update.
    pub fn apply(&mut self, update: &Value) -> bool {
        if !matches!(update_kind(update), "tool_call" | "tool_call_update") {
            return false;
        }
        let Some(id) = update["toolCallId"].as_str() else {
            return false;
        };
        if !self.calls.contains_key(id) {
            self.order.push(id.to_owned());
        }
        self.calls
            .entry(id.to_owned())
            .or_insert_with(|| ToolCall {
                id: id.to_owned(),
                ..ToolCall::default()
            })
            .apply(update);
        true
    }

    pub fn get(&self, id: &str) -> Option<&ToolCall> {
        self.calls.get(id)
    }

    pub fn all(&self) -> impl Iterator<Item = &ToolCall> {
        self.order.iter().filter_map(|id| self.calls.get(id))
    }

    pub fn unsettled(&self) -> Vec<&ToolCall> {
        self.all().filter(|call| !call.settled()).collect()
    }
}

pub fn tools(events: &[Value]) -> Tools {
    let mut tools = Tools::default();
    for update in updates(events) {
        tools.apply(update);
    }
    tools
}

pub fn native_tools(events: &[Value]) -> Vec<NativeTool> {
    tools(events).all().map(ToolCall::native).collect()
}

pub fn unsettled_tool_ids(events: &[Value]) -> Vec<String> {
    tools(events)
        .unsettled()
        .into_iter()
        .map(|call| call.id.clone())
        .collect()
}

/// One block of an assistant turn in native order.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text(String),
    Reasoning(String),
    Tool(String),
}

/// The turn's text and reasoning chunks merged into runs, with each tool at
/// its first appearance.
pub fn blocks(events: &[Value]) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut seen = Vec::new();
    for update in updates(events) {
        match update_kind(update) {
            "agent_message_chunk" => {
                let Some(text) = chunk_text(update) else {
                    continue;
                };
                match blocks.last_mut() {
                    Some(Block::Text(current)) => current.push_str(text),
                    _ => blocks.push(Block::Text(text.to_owned())),
                }
            }
            "agent_thought_chunk" => {
                let Some(text) = chunk_text(update) else {
                    continue;
                };
                match blocks.last_mut() {
                    Some(Block::Reasoning(current)) => current.push_str(text),
                    _ => blocks.push(Block::Reasoning(text.to_owned())),
                }
            }
            "tool_call" | "tool_call_update" => {
                if let Some(id) = update["toolCallId"].as_str()
                    && !seen.iter().any(|known| known == id)
                {
                    seen.push(id.to_owned());
                    blocks.push(Block::Tool(id.to_owned()));
                }
            }
            _ => {}
        }
    }
    blocks
}

/// The agent's final answer: the text after its last tool call, or all of
/// its text when that is empty.
pub fn result_text(events: &[Value]) -> String {
    let blocks = blocks(events);
    let last_tool = blocks
        .iter()
        .rposition(|block| matches!(block, Block::Tool(_)));
    let text = |from: usize| {
        blocks[from..]
            .iter()
            .filter_map(|block| match block {
                Block::Text(text) => Some(text.as_str()),
                Block::Reasoning(_) | Block::Tool(_) => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let after = text(last_tool.map_or(0, |index| index + 1));
    if after.trim().is_empty() {
        text(0).trim().to_owned()
    } else {
        after.trim().to_owned()
    }
}

/// The model the turn selected, or the session's current model.
pub fn model(events: &[Value]) -> Option<String> {
    let configured = events
        .iter()
        .rev()
        .filter(|event| kind(event) == "config")
        .find_map(|event| event["model"].as_str());
    configured
        .or_else(|| {
            events
                .iter()
                .rev()
                .filter(|event| kind(event) == "session")
                .find_map(|event| {
                    super::acp::model_option(&event["configOptions"])?["currentValue"].as_str()
                })
        })
        .map(str::to_owned)
}

/// The `usage` of the prompt result, when the agent reports one.
pub fn usage(events: &[Value]) -> Option<&Value> {
    prompt_result(events)
        .map(|result| &result["usage"])
        .filter(|usage| usage.is_object())
}

/// When the turn started (Unix ms), from its first event.
pub fn started_at(events: &[Value]) -> Option<i64> {
    events.iter().find_map(|event| event["at"].as_i64())
}

/// When the turn last changed (Unix ms), from its last event.
pub fn updated_at(events: &[Value]) -> Option<i64> {
    events.iter().rev().find_map(|event| event["at"].as_i64())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TURN: &str = include_str!("fixtures/turn.jsonl");

    #[test]
    fn a_recorded_turn_projects_its_session_tools_text_and_reasoning() {
        let events = parse_events(TURN);
        assert_eq!(session_id(&events), Some("native-session-1"));
        assert!(completed(&events));
        assert!(!aborted(&events));
        assert_eq!(failure(&events), None);
        assert_eq!(result_text(&events), "All tests pass.");
        assert_eq!(model(&events).as_deref(), Some("gemini-a"));
        let tools = native_tools(&events);
        assert_eq!(
            tools
                .iter()
                .map(|tool| (tool.id.as_str(), tool.name.as_str(), tool.status))
                .collect::<Vec<_>>(),
            [
                ("call_1", "execute", "completed"),
                ("call_2", "mcp__suplex_root__observe", "completed")
            ]
        );
        assert_eq!(tools[0].output.as_deref(), Some("2 passed"));
        assert_eq!(tools[0].input["CommandLine"], "pnpm test");
        assert_eq!(tools[1].input["taskId"], "task_1");
        let output: Value = serde_json::from_str(tools[1].output.as_deref().unwrap()).unwrap();
        assert_eq!(output["content"][0]["text"], "observed");
        assert!(unsettled_tool_ids(&events).is_empty());
        assert_eq!(
            blocks(&events),
            [
                Block::Reasoning("Plan the test run.".into()),
                Block::Text("I will run the tests.".into()),
                Block::Tool("call_1".into()),
                Block::Tool("call_2".into()),
                Block::Text("All tests pass.".into()),
            ]
        );
        assert_eq!(usage(&events).unwrap()["inputTokens"], 120);
    }

    #[test]
    fn failures_cancellation_and_running_tools_come_from_the_log() {
        let refused = parse_events("{\"type\":\"prompt_result\",\"stopReason\":\"refusal\"}\n");
        assert!(!completed(&refused));
        assert_eq!(
            failure(&refused).as_deref(),
            Some("Antigravity refused the request.")
        );
        let cancelled = parse_events("{\"type\":\"prompt_result\",\"stopReason\":\"cancelled\"}\n");
        assert!(aborted(&cancelled));
        let signed_out = parse_events(
            "{\"type\":\"error\",\"message\":\"Antigravity is not signed in.\",\"signInRequired\":true}\n",
        );
        assert!(sign_in_required(&signed_out));
        assert_eq!(
            failure(&signed_out).as_deref(),
            Some("Antigravity is not signed in.")
        );
        let running = parse_events(
            "{\"type\":\"update\",\"update\":{\"sessionUpdate\":\"tool_call\",\"toolCallId\":\"c9\",\"kind\":\"execute\",\"status\":\"in_progress\",\"rawInput\":{\"CommandLine\":\"sleep 60\"}}}\nnot json\n",
        );
        assert_eq!(unsettled_tool_ids(&running), ["c9"]);
        assert_eq!(native_tools(&running)[0].status, "running");
        assert_eq!(result_text(&running), "");
    }
}
