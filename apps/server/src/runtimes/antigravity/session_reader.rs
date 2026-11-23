//! Read-only Antigravity evidence in a Suplex session runtime directory: the
//! per-turn logs, which hold the agent's own `session/update` stream. Antigravity
//! keeps its conversation in its own state directory, whose format is not
//! documented, so Suplex reads what the agent reported to it.

use std::{
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use super::transcript::{self, Block};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        native::{NativeReasoning, NativeTool, UsageTokens},
        task_harness::UsageEntry,
    },
};

#[derive(Debug)]
pub struct NativeTurn {
    pub id: String,
    pub events: Vec<Value>,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
}

fn valid_turn_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn milliseconds(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

/// Every turn log in start order.
pub fn turns(directory: &Path) -> io::Result<Vec<NativeTurn>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut turns = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(id) = name
            .strip_prefix("turn-")
            .and_then(|rest| rest.strip_suffix(".jsonl"))
        else {
            continue;
        };
        if !valid_turn_id(id) {
            continue;
        }
        let events = transcript::parse_events(&fs::read_to_string(entry.path())?);
        let modified = milliseconds(entry.metadata()?.modified()?);
        turns.push(NativeTurn {
            id: id.to_owned(),
            started_at_ms: transcript::started_at(&events).unwrap_or(modified),
            updated_at_ms: transcript::updated_at(&events).unwrap_or(modified),
            events,
        });
    }
    turns.sort_by(|left, right| {
        (left.started_at_ms, &left.id).cmp(&(right.started_at_ms, &right.id))
    });
    Ok(turns)
}

/// The native ACP session the latest turn used. The turn logs are the
/// agent's answers, so a missing or stale cache cannot change this.
pub fn native_session(directory: &Path) -> io::Result<Option<String>> {
    Ok(turns(directory)?
        .iter()
        .rev()
        .find_map(|turn| transcript::session_id(&turn.events).map(str::to_owned)))
}

pub fn turn_evidence(directory: &Path, turn_id: &str) -> io::Result<Option<Vec<Value>>> {
    if !valid_turn_id(turn_id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid turn identity",
        ));
    }
    Ok(
        crate::shared::fs::read_optional(&directory.join(format!("turn-{turn_id}.jsonl")))?
            .map(|text| transcript::parse_events(&text)),
    )
}

/// One assistant message per turn with its reasoning, text, and tool calls
/// in native order, in the shape the other runtimes use.
pub fn history(turns: &[NativeTurn]) -> Vec<Value> {
    turns
        .iter()
        .filter_map(|turn| {
            let tools = transcript::tools(&turn.events);
            let content = transcript::blocks(&turn.events)
                .into_iter()
                .enumerate()
                .filter_map(|(index, block)| match block {
                    Block::Reasoning(text) if !text.trim().is_empty() => Some(
                        json!({"id":format!("{}:{index}", turn.id),"type":"reasoning","text":text}),
                    ),
                    Block::Text(text) if !text.is_empty() => Some(
                        json!({"id":format!("{}:{index}", turn.id),"type":"text","text":text}),
                    ),
                    Block::Tool(id) => {
                        let tool = tools.get(&id)?.native();
                        Some(json!({
                            "id": tool.id, "type": "tool", "name": tool.name, "status": tool.status,
                            "input": tool.input, "error": tool.error, "output": tool.output,
                        }))
                    }
                    Block::Reasoning(_) | Block::Text(_) => None,
                })
                .collect::<Vec<_>>();
            (!content.is_empty()).then(|| {
                json!({"id":turn.id,"role":"assistant","createdAt":turn.started_at_ms,"content":content})
            })
        })
        .collect()
}

pub fn reasoning(turns: &[NativeTurn]) -> Vec<NativeReasoning> {
    turns
        .iter()
        .flat_map(|turn| {
            transcript::blocks(&turn.events)
                .into_iter()
                .enumerate()
                .filter_map(|(index, block)| match block {
                    Block::Reasoning(text) if !text.trim().is_empty() => Some(NativeReasoning {
                        id: format!("{}:{index}", turn.id),
                        text,
                    }),
                    Block::Reasoning(_) | Block::Text(_) | Block::Tool(_) => None,
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Every turn's tools, with ids qualified by the turn.
pub fn tools(turns: &[NativeTurn]) -> Vec<NativeTool> {
    turns
        .iter()
        .flat_map(|turn| {
            transcript::native_tools(&turn.events)
                .into_iter()
                .map(move |mut tool| {
                    tool.id = format!("{}:{}", turn.id, tool.id);
                    tool
                })
        })
        .collect()
}

fn count(usage: &Value, names: &[&str]) -> f64 {
    names
        .iter()
        .find_map(|name| usage[*name].as_f64())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or_default()
}

/// ACP prompt usage: `inputTokens`, `outputTokens`, `thoughtTokens`,
/// `cachedReadTokens`, and `cachedWriteTokens`.
pub fn tokens(usage: Option<&Value>) -> UsageTokens {
    let Some(usage) = usage else {
        return UsageTokens::default();
    };
    UsageTokens {
        input: count(usage, &["inputTokens", "input_tokens"]),
        output: count(usage, &["outputTokens", "output_tokens"]),
        reasoning: count(usage, &["thoughtTokens", "reasoningTokens"]),
        cache_read: count(usage, &["cachedReadTokens", "cacheReadTokens"]),
        cache_write: count(usage, &["cachedWriteTokens", "cacheWriteTokens"]),
    }
}

/// One usage entry per turn. The live turn is the last one while the
/// session's process runs.
pub fn usage(
    turns: &[NativeTurn],
    live: Option<&str>,
    pricing: Option<&ModelPricingCatalog>,
) -> Vec<UsageEntry> {
    turns
        .iter()
        .filter(|turn| transcript::session_id(&turn.events).is_some())
        .map(|turn| {
            let model = transcript::model(&turn.events).unwrap_or_default();
            let tokens = tokens(transcript::usage(&turn.events));
            let cost_usd = pricing
                .and_then(|catalog| {
                    catalog
                        .get(&format!("google/{model}"))
                        .or_else(|| catalog.get(&model))
                })
                .map_or(0.0, |price| price.estimate(tokens));
            UsageEntry {
                completed_at_ms: (live != Some(turn.id.as_str())).then_some(turn.updated_at_ms),
                message_id: turn.id.clone(),
                turn_id: turn.id.clone(),
                provider: "google".to_owned(),
                model,
                started_at_ms: turn.started_at_ms,
                failed: transcript::failure(&turn.events).is_some(),
                tokens,
                cost_usd,
                subsidized: cost_usd > 0.0,
                summary: false,
                steps: 1.0,
                source: "message",
                // The log carries no per-response timing.
                generation_ms: None,
                first_response_ms: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TURN: &str = include_str!("fixtures/turn.jsonl");

    #[test]
    fn history_reasoning_tools_and_usage_come_from_the_turn_logs() {
        let directory = std::env::temp_dir().join(format!(
            "suplex-antigravity-reader-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(turns(&directory).unwrap().is_empty());
        assert_eq!(native_session(&directory).unwrap(), None);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("turn-msg_1.jsonl"), TURN).unwrap();
        // A later turn that resumed another session id names the current one.
        let later = TURN
            .replace("native-session-1", "native-session-2")
            .replace("17950000", "17960000");
        fs::write(directory.join("turn-msg_0.jsonl"), later).unwrap();
        fs::write(directory.join("turn-bad id.jsonl"), TURN).unwrap();
        fs::write(directory.join("notes.txt"), "ignored").unwrap();
        let turns = turns(&directory).unwrap();
        assert_eq!(
            turns
                .iter()
                .map(|turn| turn.id.as_str())
                .collect::<Vec<_>>(),
            ["msg_1", "msg_0"]
        );
        assert_eq!(
            native_session(&directory).unwrap().as_deref(),
            Some("native-session-2")
        );
        let messages = history(&turns);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["id"], "msg_1");
        assert_eq!(messages[0]["createdAt"], 1_795_000_000_000_i64);
        assert_eq!(
            messages[0]["content"][0],
            json!({"id":"msg_1:0","type":"reasoning","text":"Plan the test run."})
        );
        assert_eq!(messages[0]["content"][2]["name"], "execute");
        assert_eq!(messages[0]["content"][2]["output"], "2 passed");
        assert_eq!(
            messages[0]["content"][3]["name"],
            "mcp__suplex_root__observe"
        );
        assert_eq!(reasoning(&turns)[0].text, "Plan the test run.");
        let tools = tools(&turns);
        assert_eq!(tools[0].id, "msg_1:call_1");
        assert_eq!(tools.len(), 4);
        let entries = usage(&turns, Some("msg_0"), None);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].model, "gemini-a");
        assert_eq!(entries[0].tokens.input, 120.0);
        assert_eq!(entries[0].tokens.reasoning, 10.0);
        assert_eq!(entries[0].tokens.cache_read, 40.0);
        assert!(entries[0].completed_at_ms.is_some());
        assert!(entries[1].completed_at_ms.is_none());
        assert!(turn_evidence(&directory, "msg_1").unwrap().is_some());
        assert!(turn_evidence(&directory, "msg_9").unwrap().is_none());
        assert!(turn_evidence(&directory, "../msg_1").is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
