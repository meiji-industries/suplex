//! Per-turn Pi usage. Each assistant `message_end` carries the final usage of
//! that one response, so a turn is the sum of its responses.

use std::{
    collections::HashMap,
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use super::{session_reader, transcript};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{headless, native::UsageTokens},
};

#[derive(Debug, PartialEq)]
pub struct PiTurnUsage {
    pub turn_id: String,
    /// Pi's native provider, such as `anthropic` or a `models.json` entry.
    pub provider: String,
    pub model: String,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub failed: bool,
    pub tokens: UsageTokens,
    pub cost_usd: f64,
}

#[derive(Debug, PartialEq)]
pub struct PiUsageObservation {
    pub turns: Vec<PiTurnUsage>,
    pub live_turn_id: Option<String>,
}

fn count(usage: &Value, name: &str) -> f64 {
    usage[name]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or_default()
}

/// Pi reports `input` without cache reads and `reasoning` inside `output`.
pub fn tokens(usage: &Value) -> UsageTokens {
    let reasoning = count(usage, "reasoning");
    UsageTokens {
        input: count(usage, "input"),
        output: (count(usage, "output") - reasoning).max(0.0),
        reasoning,
        cache_read: count(usage, "cacheRead"),
        cache_write: count(usage, "cacheWrite"),
    }
}

/// Pi's own cost from its model pricing, else the Suplex catalog price.
pub fn cost(message: &Value, pricing: Option<&ModelPricingCatalog>) -> f64 {
    let native = message["usage"]["cost"]["total"]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0);
    native.unwrap_or_else(|| {
        let (Some(provider), Some(model)) =
            (message["provider"].as_str(), message["model"].as_str())
        else {
            return 0.0;
        };
        pricing
            .and_then(|catalog| catalog.get(&format!("{provider}/{model}")))
            .map_or(0.0, |price| price.estimate(tokens(&message["usage"])))
    })
}

fn add(total: &mut UsageTokens, tokens: UsageTokens) {
    total.input += tokens.input;
    total.output += tokens.output;
    total.reasoning += tokens.reasoning;
    total.cache_read += tokens.cache_read;
    total.cache_write += tokens.cache_write;
}

fn milliseconds(time: SystemTime) -> io::Result<i64> {
    time.duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis()
        .try_into()
        .map_err(io::Error::other)
}

fn created_at(metadata: &fs::Metadata) -> io::Result<i64> {
    Ok(metadata
        .created()
        .ok()
        .and_then(|time| milliseconds(time).ok())
        .filter(|time| *time > 0)
        .unwrap_or(milliseconds(metadata.modified()?)?))
}

/// The `--model <provider>/<id>` each dispatch record ran with.
fn dispatched_models(directory: &Path) -> io::Result<HashMap<String, String>> {
    let mut models = HashMap::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("dispatch-") || !name.ends_with(".json") {
            continue;
        }
        let Ok(Some(record)) = headless::read_record(&entry.path()) else {
            continue;
        };
        if let Some(model) = record
            .dispatch_arguments
            .iter()
            .position(|argument| argument == "--model")
            .and_then(|position| record.dispatch_arguments.get(position + 1))
        {
            models.insert(record.turn_id, model.clone());
        }
    }
    Ok(models)
}

fn split_model(model: Option<&String>) -> (String, String) {
    match model.and_then(|model| model.split_once('/')) {
        Some((provider, model)) => (provider.to_owned(), model.to_owned()),
        None => (
            "unknown".to_owned(),
            model.cloned().unwrap_or_else(|| "unknown".to_owned()),
        ),
    }
}

pub fn observe_session(
    directory: &Path,
    native_session_id: &str,
    pricing: Option<&ModelPricingCatalog>,
) -> io::Result<PiUsageObservation> {
    let current = headless::read_record(&directory.join("turn.json"))?;
    let live_turn_id = match current.as_ref() {
        Some(record) if record.session_id == native_session_id && headless::running(record)? => {
            Some(record.turn_id.clone())
        }
        _ => None,
    };
    let mut native_turns = session_reader::turns(directory)?;
    if let Some(live_turn_id) = live_turn_id.as_ref()
        && native_turns.iter().all(|turn| &turn.id != live_turn_id)
    {
        native_turns.push(session_reader::NativeTurn {
            id: live_turn_id.clone(),
            events: Vec::new(),
            updated_at: fs::metadata(directory.join("turn.json"))?.modified()?,
        });
    }
    if native_turns.is_empty() {
        return Err(io::Error::other("Pi turn logs are missing"));
    }
    native_turns.sort_by(|left, right| {
        left.updated_at
            .cmp(&right.updated_at)
            .then(left.id.cmp(&right.id))
    });
    let models = dispatched_models(directory)?;
    let mut turns = Vec::new();
    for turn in &native_turns {
        let live = live_turn_id.as_deref() == Some(turn.id.as_str());
        let messages = turn
            .events
            .iter()
            .filter_map(transcript::PiEvent::assistant_message)
            .collect::<Vec<_>>();
        if messages.is_empty() && !live {
            continue;
        }
        let (mut provider, mut model) = split_model(models.get(&turn.id));
        if let Some(last) = messages.last() {
            if let Some(native) = last["provider"].as_str() {
                native.clone_into(&mut provider);
            }
            if let Some(native) = last["model"].as_str() {
                native.clone_into(&mut model);
            }
        }
        let mut total = UsageTokens::default();
        let mut cost_usd = 0.0;
        for message in &messages {
            add(&mut total, tokens(&message["usage"]));
            cost_usd += cost(message, pricing);
        }
        let started_at_ms = match fs::metadata(headless::turn_file(directory, &turn.id, "prompt")) {
            Ok(metadata) => created_at(&metadata)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => milliseconds(turn.updated_at)?,
            Err(error) => return Err(error),
        };
        turns.push(PiTurnUsage {
            turn_id: turn.id.clone(),
            provider,
            model,
            started_at_ms,
            updated_at_ms: milliseconds(turn.updated_at)?,
            failed: transcript::failure(&turn.events).is_some(),
            tokens: total,
            cost_usd,
        });
    }
    Ok(PiUsageObservation {
        turns,
        live_turn_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::model_pricing::ModelPricing;
    use serde_json::json;

    const TURN: &str = include_str!("fixtures/turn.jsonl");

    #[test]
    fn a_real_turn_sums_each_response_with_native_cost_and_provider() {
        let directory =
            std::env::temp_dir().join(format!("suplex-pi-usage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(headless::turn_file(&directory, "msg_001", "jsonl"), TURN).unwrap();
        let observed = observe_session(&directory, "pi-1234-abcd", None).unwrap();
        assert_eq!(observed.live_turn_id, None);
        let turn = &observed.turns[0];
        assert_eq!(
            (turn.provider.as_str(), turn.model.as_str()),
            ("localfake", "fake-model")
        );
        assert_eq!(
            turn.tokens,
            UsageTokens {
                input: 200.0,
                output: 60.0,
                reasoning: 0.0,
                cache_read: 40.0,
                cache_write: 0.0,
            }
        );
        assert!((turn.cost_usd - 0.00034).abs() < 1e-12);
        assert!(!turn.failed);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reasoning_is_split_from_output_and_the_catalog_prices_an_unpriced_response() {
        let message = json!({"role":"assistant","provider":"anthropic","model":"claude-sonnet-5","usage":{"input":10,"output":50,"reasoning":20,"cacheRead":5,"cacheWrite":3,"cost":{"total":0}}});
        assert_eq!(
            tokens(&message["usage"]),
            UsageTokens {
                input: 10.0,
                output: 30.0,
                reasoning: 20.0,
                cache_read: 5.0,
                cache_write: 3.0,
            }
        );
        assert_eq!(cost(&message, None), 0.0);
        let pricing = ModelPricingCatalog::from([(
            "anthropic/claude-sonnet-5".into(),
            ModelPricing {
                input: 1_000_000.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
        )]);
        assert!(cost(&message, Some(&pricing)) > 0.0);
        let native = json!({"provider":"anthropic","model":"claude-sonnet-5","usage":{"input":10,"cost":{"total":0.25}}});
        assert_eq!(cost(&native, Some(&pricing)), 0.25);
    }

    #[test]
    fn a_running_turn_without_responses_uses_the_dispatched_model() {
        let directory =
            std::env::temp_dir().join(format!("suplex-pi-live-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let environment = HashMap::new();
        let record = headless::dispatch(
            headless::DispatchInput {
                directory: &directory,
                worktree: &directory,
                session_id: "pi-native-live",
                turn_id: "msg_live",
                executable: Path::new("/bin/sh"),
                args: &[
                    "-c".into(),
                    "sleep 30".into(),
                    "--model".into(),
                    "ollama/qwen3-coder".into(),
                ],
                prompt: "Implement the change",
                environment: &environment,
            },
            |_| Ok(true),
        )
        .unwrap();
        let observed = observe_session(&directory, "pi-native-live", None).unwrap();
        assert_eq!(observed.live_turn_id.as_deref(), Some("msg_live"));
        let live = &observed.turns[0];
        assert_eq!(
            (live.provider.as_str(), live.model.as_str()),
            ("ollama", "qwen3-coder")
        );
        assert_eq!(live.tokens, UsageTokens::default());
        headless::stop_owned(&record).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}
