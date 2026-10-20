//! One Pi or omp `--mode json` turn log: a session header, then agent,
//! message, and tool execution events.

use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct PiEvent(Value);

impl PiEvent {
    pub(crate) fn value(&self) -> &Value {
        &self.0
    }

    pub fn kind(&self) -> &str {
        self.0["type"].as_str().unwrap_or("")
    }

    /// The authoritative final assistant message of a `message_end`.
    pub fn assistant_message(&self) -> Option<&Value> {
        (self.kind() == "message_end")
            .then(|| self.0.get("message"))
            .flatten()
            .filter(|message| message["role"] == "assistant")
    }

    fn tool_call_id(&self) -> Option<&str> {
        self.0
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
    }
}

/// Every complete JSON object line with a type; a partial last line waits.
pub fn parse_events(jsonl: &str) -> Vec<PiEvent> {
    jsonl
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("type").and_then(Value::as_str).is_some())
        .map(PiEvent)
        .collect()
}

/// The native session id from the header Pi writes first.
pub fn session_id(events: &[PiEvent]) -> Option<&str> {
    events.iter().find_map(|event| {
        (event.kind() == "session")
            .then(|| event.0["id"].as_str())
            .flatten()
            .filter(|id| !id.is_empty())
    })
}

/// Pi's `agent_settled` ends automatic work. An `agent_end` that will not
/// retry is final too. omp sends no `agent_settled` and no `willRetry`; it
/// starts a retry with `auto_retry_start` after the failed `agent_end`.
pub fn completed(events: &[PiEvent]) -> bool {
    if events.iter().any(|event| event.kind() == "agent_settled") {
        return true;
    }
    let Some(end) = events.iter().rposition(|event| event.kind() == "agent_end") else {
        return false;
    };
    events[end].0["willRetry"] != true
        && !events[end..]
            .iter()
            .any(|event| event.kind() == "auto_retry_start")
}

pub fn aborted(events: &[PiEvent]) -> bool {
    events
        .iter()
        .any(|event| event.kind() == "agent_settled" && event.0["aborted"] == true)
        || last_assistant(events).is_some_and(|message| message["stopReason"] == "aborted")
}

fn last_assistant(events: &[PiEvent]) -> Option<&Value> {
    events
        .iter()
        .filter_map(PiEvent::assistant_message)
        .next_back()
}

/// A native error: the final assistant response failed, or retries ran out.
pub fn failure(events: &[PiEvent]) -> Option<&str> {
    if let Some(message) = last_assistant(events)
        && message["stopReason"] == "error"
    {
        return Some(
            message["errorMessage"]
                .as_str()
                .filter(|text| !text.is_empty())
                .unwrap_or("Pi reported an error"),
        );
    }
    events.iter().find_map(|event| {
        (event.kind() == "auto_retry_end" && event.0["success"] == false).then(|| {
            event.0["finalError"]
                .as_str()
                .unwrap_or("Pi retries failed")
        })
    })
}

/// The text blocks of one assistant message.
pub fn message_text(message: &Value) -> String {
    message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The last assistant message that carries text.
pub fn result_text(events: &[PiEvent]) -> String {
    events
        .iter()
        .filter_map(PiEvent::assistant_message)
        .map(message_text)
        .rfind(|text| !text.trim().is_empty())
        .unwrap_or_default()
}

pub fn unsettled_tool_ids(events: &[PiEvent]) -> Vec<&str> {
    let mut started = Vec::new();
    let mut settled = HashSet::new();
    for event in events {
        let Some(id) = event.tool_call_id() else {
            continue;
        };
        match event.kind() {
            "tool_execution_start" if !started.contains(&id) => started.push(id),
            "tool_execution_end" => {
                settled.insert(id);
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
            "{\"type\":\"session\",\"version\":3,\"id\":\"pi-1\",\"timestamp\":\"2026-10-20T16:46:06.320Z\",\"cwd\":\"/work\"}\n",
            "{\"type\":\"agent_start\"}\n",
            "{\"type\":\"tool_execution_start\",\"toolCallId\":\"call_1\",\"toolName\":\"bash\",\"args\":{\"command\":\"pwd\"}}\n",
            "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"Look\"},{\"type\":\"text\",\"text\":\"Done\"}],\"stopReason\":\"stop\"}}\n",
            "{\"type\":\"agent_end\",\"messages\":[],\"willRetry\":false}\n",
            "{\"type\":\"agent_settled\",\"aborted\":false}\n",
            "{\"type\":\"tool_execution_end\""
        ));
        assert_eq!(session_id(&events), Some("pi-1"));
        assert!(completed(&events));
        assert!(!aborted(&events));
        assert_eq!(failure(&events), None);
        assert_eq!(result_text(&events), "Done");
        assert_eq!(unsettled_tool_ids(&events), ["call_1"]);
    }

    #[test]
    fn a_retrying_end_is_not_final_and_a_failed_response_is_a_native_error() {
        let retrying = parse_events(concat!(
            "{\"type\":\"tool_execution_start\",\"toolCallId\":\"call_1\",\"toolName\":\"read\"}\n",
            "{\"type\":\"tool_execution_end\",\"toolCallId\":\"call_1\",\"toolName\":\"read\",\"isError\":false}\n",
            "{\"type\":\"agent_end\",\"willRetry\":true}\n",
        ));
        assert!(!completed(&retrying));
        assert!(unsettled_tool_ids(&retrying).is_empty());
        let failed = parse_events(concat!(
            "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"errorMessage\":\"Connection error.\"}}\n",
            "{\"type\":\"agent_end\",\"willRetry\":false}\n",
            "{\"type\":\"agent_settled\",\"aborted\":false}\n",
        ));
        assert!(completed(&failed));
        assert_eq!(failure(&failed), Some("Connection error."));
        let exhausted = parse_events(
            "{\"type\":\"auto_retry_end\",\"success\":false,\"attempt\":3,\"finalError\":\"529 overloaded\"}\n",
        );
        assert_eq!(failure(&exhausted), Some("529 overloaded"));
        let stopped = parse_events("{\"type\":\"agent_settled\",\"aborted\":true}\n");
        assert!(aborted(&stopped));
    }

    #[test]
    fn an_omp_turn_completes_at_agent_end_unless_a_retry_follows() {
        let turn = parse_events(include_str!("fixtures/omp-turn.jsonl"));
        assert!(session_id(&turn).is_some_and(|id| id.starts_with("01a15a8a")));
        assert!(completed(&turn));
        assert_eq!(result_text(&turn), "Done.");
        assert!(unsettled_tool_ids(&turn).is_empty());
        let retrying = parse_events(concat!(
            "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"errorMessage\":\"529\"}}\n",
            "{\"type\":\"agent_end\",\"messages\":[]}\n",
            "{\"type\":\"auto_retry_start\",\"attempt\":1,\"maxAttempts\":3,\"delayMs\":2000,\"errorMessage\":\"529\"}\n",
        ));
        assert!(!completed(&retrying));
        let recovered = parse_events(concat!(
            "{\"type\":\"agent_end\",\"messages\":[]}\n",
            "{\"type\":\"auto_retry_start\",\"attempt\":1}\n",
            "{\"type\":\"agent_start\"}\n",
            "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Done.\"}],\"stopReason\":\"stop\"}}\n",
            "{\"type\":\"agent_end\",\"messages\":[]}\n",
            "{\"type\":\"auto_retry_end\",\"success\":true,\"attempt\":1}\n",
        ));
        assert!(completed(&recovered));
        assert_eq!(failure(&recovered), None);
    }
}
