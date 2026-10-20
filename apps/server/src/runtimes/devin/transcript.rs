use serde_json::{Value, json};

use crate::runtimes::{native::UsageTokens, task_harness::UsageEntry};

// `devin --print` emits presentation text, not a documented event stream. Turn
// logs are therefore authoritative only for final text; tool and token detail is unavailable.
pub fn result_text(log: &str) -> &str {
    log.trim()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevinTurn {
    pub id: String,
    pub text: String,
    pub text_at: i64,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub failed: bool,
    pub running: bool,
}

pub fn history(turns: &[DevinTurn]) -> Vec<Value> {
    turns
        .iter()
        .filter(|turn| !turn.text.is_empty())
        .map(|turn| {
            json!({
                "id": turn.id, "role": "assistant", "createdAt": turn.text_at,
                "content": [{"id": format!("{}:text", turn.id), "type": "text", "text": turn.text}],
            })
        })
        .collect()
}

pub fn usage(turns: &[DevinTurn]) -> Vec<UsageEntry> {
    turns
        .iter()
        .map(|turn| UsageEntry {
            message_id: turn.id.clone(),
            turn_id: turn.id.clone(),
            provider: "devin".to_owned(),
            model: "unknown".into(),
            started_at_ms: turn.started_at,
            completed_at_ms: turn.completed_at,
            failed: turn.failed,
            tokens: UsageTokens::default(),
            cost_usd: 0.0,
            subsidized: false,
            summary: false,
            steps: 1.0,
            source: "message",
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(id: &str, text: &str, completed_at: Option<i64>) -> DevinTurn {
        DevinTurn {
            id: id.into(),
            text: text.into(),
            text_at: 20,
            started_at: 10,
            completed_at,
            failed: false,
            running: completed_at.is_none(),
        }
    }

    #[test]
    fn history_keeps_only_turns_with_text_and_usage_counts_completed_steps() {
        assert_eq!(
            result_text("  Reviewed the change.\n"),
            "Reviewed the change."
        );
        let turns = [turn("a", "Done", Some(30)), turn("b", "", None)];
        assert_eq!(
            history(&turns),
            vec![json!({"id":"a","role":"assistant","createdAt":20,
                "content":[{"id":"a:text","type":"text","text":"Done"}]})]
        );
        let usage = usage(&turns);
        assert_eq!(usage.len(), 2);
        assert_eq!(usage[0].provider, "devin");
        assert_eq!(usage[0].model, "unknown");
        assert_eq!(usage[0].completed_at_ms, Some(30));
        assert_eq!(usage[1].completed_at_ms, None);
    }
}
