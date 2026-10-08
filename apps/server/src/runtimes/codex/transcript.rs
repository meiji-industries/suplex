use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct CodexEvent(Value);

impl CodexEvent {
    pub(crate) fn value(&self) -> &Value {
        &self.0
    }

    pub fn kind(&self) -> &str {
        self.0["type"].as_str().unwrap_or("")
    }

    fn item(&self) -> Option<&Value> {
        self.0.get("item").filter(|item| {
            item.get("id").and_then(Value::as_str).is_some()
                && item.get("type").and_then(Value::as_str).is_some()
        })
    }
}

pub fn parse_events(jsonl: &str) -> Vec<CodexEvent> {
    jsonl
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| match value.get("type").and_then(Value::as_str) {
            Some("thread.started") => value
                .get("thread_id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty()),
            Some("turn.started") | Some("turn.completed") => true,
            Some("turn.failed") => value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .is_some(),
            Some("error") => value.get("message").and_then(Value::as_str).is_some(),
            Some("item.started" | "item.updated" | "item.completed") => {
                value.get("item").is_some_and(|item| {
                    item.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                        && item
                            .get("type")
                            .and_then(Value::as_str)
                            .is_some_and(|kind| !kind.is_empty())
                })
            }
            _ => false,
        })
        .map(CodexEvent)
        .collect()
}

pub fn thread_id(events: &[CodexEvent]) -> Option<&str> {
    events.iter().find_map(|event| {
        (event.kind() == "thread.started")
            .then(|| event.0["thread_id"].as_str())
            .flatten()
    })
}

pub fn completed(events: &[CodexEvent]) -> bool {
    events.iter().any(|event| event.kind() == "turn.completed")
}

pub fn failure(events: &[CodexEvent]) -> Option<&str> {
    events.iter().find_map(|event| match event.kind() {
        "turn.failed" => event.0.pointer("/error/message").and_then(Value::as_str),
        "error" => event.0.get("message").and_then(Value::as_str),
        _ => None,
    })
}

pub fn result_text(events: &[CodexEvent]) -> &str {
    events
        .iter()
        .filter_map(|event| {
            (event.kind() == "item.completed"
                && event.item()?.get("type")?.as_str()? == "agent_message")
                .then(|| event.item()?.get("text")?.as_str())
                .flatten()
        })
        .next_back()
        .unwrap_or("")
}

pub fn unsettled_tool_ids(events: &[CodexEvent]) -> Vec<&str> {
    let mut started = Vec::new();
    let mut settled = HashSet::new();
    for event in events {
        let Some(item) = event.item() else { continue };
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        match event.kind() {
            "item.completed" => {
                settled.insert(id);
            }
            "item.started"
                if matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("command_execution" | "mcp_tool_call" | "file_change")
                ) =>
            {
                started.push(id);
            }
            _ => {}
        }
    }
    started
        .into_iter()
        .filter(|id| !settled.contains(id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observes_real_turn_event_shapes_and_ignores_partial_lines() {
        let events = parse_events(concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
            "{\"type\":\"item.started\",\"item\":{\"id\":\"item_0\",\"type\":\"command_execution\",\"command\":\"pwd\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"Done\"}}\n",
            "{\"type\":\"turn.completed\"}\n",
            "{\"type\":\"item.started\""
        ));
        assert_eq!(thread_id(&events), Some("thread-1"));
        assert!(completed(&events));
        assert_eq!(result_text(&events), "Done");
        assert_eq!(unsettled_tool_ids(&events), ["item_0"]);
    }

    #[test]
    fn later_completion_settles_a_tool_and_native_failure_is_visible() {
        let events = parse_events(concat!(
            "{\"type\":\"item.started\",\"item\":{\"id\":\"item_0\",\"type\":\"mcp_tool_call\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"mcp_tool_call\"}}\n",
            "{\"type\":\"turn.failed\",\"error\":{\"message\":\"bad session\"}}\n"
        ));
        assert!(unsettled_tool_ids(&events).is_empty());
        assert_eq!(failure(&events), Some("bad session"));
        assert!(!completed(&events));
    }
}
