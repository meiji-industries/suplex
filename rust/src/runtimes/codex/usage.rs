use crate::runtimes::native::UsageTokens;
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{session_reader, transcript};
use crate::{profiles::model_pricing::ModelPricingCatalog, runtimes::headless};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct NativeCounts {
    input: f64,
    cached_input: f64,
    cache_write_input: f64,
    output: f64,
    reasoning_output: f64,
}

impl NativeCounts {
    fn from_completed(event: &transcript::CodexEvent) -> Option<Self> {
        if event.kind() != "turn.completed" {
            return None;
        }
        let usage = event.value().get("usage")?.as_object()?;
        let count = |name: &str| -> Option<f64> {
            match usage.get(name) {
                None => Some(0.0),
                Some(value) => value
                    .as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0),
            }
        };
        Some(Self {
            input: count("input_tokens")?,
            cached_input: count("cached_input_tokens")?,
            cache_write_input: count("cache_write_input_tokens")?,
            output: count("output_tokens")?,
            reasoning_output: count("reasoning_output_tokens")?,
        })
    }

    fn decreased_from(self, previous: Self) -> bool {
        self.input < previous.input
            || self.cached_input < previous.cached_input
            || self.cache_write_input < previous.cache_write_input
            || self.output < previous.output
            || self.reasoning_output < previous.reasoning_output
    }

    fn delta(self, previous: Self) -> Self {
        Self {
            input: self.input - previous.input,
            cached_input: self.cached_input - previous.cached_input,
            cache_write_input: self.cache_write_input - previous.cache_write_input,
            output: self.output - previous.output,
            reasoning_output: self.reasoning_output - previous.reasoning_output,
        }
    }
}

impl From<NativeCounts> for UsageTokens {
    fn from(native: NativeCounts) -> Self {
        Self {
            input: (native.input - native.cached_input - native.cache_write_input).max(0.0),
            output: (native.output - native.reasoning_output).max(0.0),
            reasoning: native.reasoning_output,
            cache_read: native.cached_input,
            cache_write: native.cache_write_input,
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct CodexTurnUsage {
    pub turn_id: String,
    pub model: String,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub failed: bool,
    pub tokens: UsageTokens,
    pub cost_usd: f64,
    pub priced: bool,
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

fn file_metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Debug, PartialEq)]
pub struct CodexUsageObservation {
    pub turns: Vec<CodexTurnUsage>,
    pub live_turn_id: Option<String>,
    pub complete: bool,
    pub estimated_cost_usd: f64,
}

fn dispatched_models(directory: &Path) -> io::Result<HashMap<String, String>> {
    let mut models = HashMap::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("dispatch-") || !name.ends_with(".json") {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let has_dispatch_arguments = raw.get("dispatchArguments").is_some();
        let Ok(record) = serde_json::from_value::<headless::HeadlessTurnRecord>(raw) else {
            continue;
        };
        let arguments = if has_dispatch_arguments {
            &record.dispatch_arguments
        } else {
            &record.process_identity.argv
        };
        let model = arguments
            .iter()
            .position(|argument| argument == "-m")
            .and_then(|position| arguments.get(position + 1))
            .cloned()
            .unwrap_or_else(|| "unknown".into());
        models.insert(record.turn_id, model);
    }
    Ok(models)
}

fn dispatched_start_times(directory: &Path) -> io::Result<HashMap<String, i64>> {
    let mut starts = HashMap::<String, i64>::new();
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
        let created_at = created_at(&entry.metadata()?)?;
        starts
            .entry(record.turn_id)
            .and_modify(|prior| *prior = (*prior).min(created_at))
            .or_insert(created_at);
    }
    Ok(starts)
}

fn started_at_ms(
    directory: &Path,
    turn: &session_reader::NativeTurn,
    dispatched_starts: &HashMap<String, i64>,
) -> io::Result<i64> {
    Ok(
        file_metadata(&headless::turn_file(directory, &turn.id, "prompt"))?
            .as_ref()
            .map(created_at)
            .transpose()?
            .or_else(|| dispatched_starts.get(&turn.id).copied())
            .unwrap_or(milliseconds(turn.updated_at)?),
    )
}

/// Observe the native Codex timeline, preserving cumulative per-thread token
/// semantics. Missing prices produce zero estimated cost, as in the source
/// observer's optional catalog fallback; they do not create a new admission gate.
pub fn observe_session(
    directory: &Path,
    native_session_id: &str,
    pricing: Option<&ModelPricingCatalog>,
) -> io::Result<CodexUsageObservation> {
    let models = dispatched_models(directory)?;
    let dispatched_starts = dispatched_start_times(directory)?;
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
    if native_turns.is_empty() && live_turn_id.is_none() {
        return Err(io::Error::other("Codex turn logs are missing"));
    }
    if native_turns.iter().all(|turn| turn.id.starts_with("msg_")) {
        native_turns.sort_by(|left, right| left.id.cmp(&right.id));
    } else {
        native_turns.sort_by(|left, right| {
            left.updated_at
                .cmp(&right.updated_at)
                .then(left.id.cmp(&right.id))
        });
    }
    let mut previous = HashMap::<String, NativeCounts>::new();
    let mut gaps = HashMap::<String, HashSet<String>>::new();
    let mut turns = Vec::new();
    let mut complete = true;
    for turn in &native_turns {
        let started_at_ms = started_at_ms(directory, turn, &dispatched_starts)?;
        let model = models
            .get(&turn.id)
            .cloned()
            .unwrap_or_else(|| "unknown".into());
        let thread = transcript::thread_id(&turn.events).map(str::to_owned);
        let reported = turn
            .events
            .iter()
            .filter_map(NativeCounts::from_completed)
            .next_back();
        let Some(reported) = reported else {
            if live_turn_id.as_deref() == Some(turn.id.as_str()) {
                turns.push(CodexTurnUsage {
                    turn_id: turn.id.clone(),
                    model,
                    started_at_ms,
                    updated_at_ms: milliseconds(turn.updated_at)?,
                    failed: false,
                    tokens: UsageTokens::default(),
                    cost_usd: 0.0,
                    priced: false,
                });
            } else if let Some(thread) = thread {
                gaps.entry(thread).or_default().insert(model);
            }
            complete = false;
            continue;
        };
        let prior = thread
            .as_ref()
            .and_then(|thread| previous.get(thread))
            .copied();
        if prior.is_some_and(|prior| reported.decreased_from(prior)) {
            return Err(io::Error::other(format!(
                "Codex cumulative usage decreased within native thread {}",
                thread.as_deref().unwrap_or_default()
            )));
        }
        let ambiguous = thread.as_ref().is_some_and(|thread| {
            gaps.get(thread)
                .is_some_and(|models| models.iter().any(|gap_model| gap_model != &model))
        });
        let tokens = UsageTokens::from(reported.delta(prior.unwrap_or_default()));
        if let Some(thread) = thread {
            previous.insert(thread.clone(), reported);
            gaps.remove(&thread);
        }
        let model = if ambiguous { "unknown".into() } else { model };
        let price = (!ambiguous)
            .then(|| pricing.and_then(|catalog| catalog.get(&format!("openai/{model}"))))
            .flatten();
        let cost_usd = price.map_or(0.0, |price| price.estimate(tokens));
        turns.push(CodexTurnUsage {
            turn_id: turn.id.clone(),
            model,
            started_at_ms,
            updated_at_ms: milliseconds(turn.updated_at)?,
            failed: transcript::failure(&turn.events).is_some(),
            tokens,
            cost_usd,
            priced: price.is_some(),
        });
    }
    if live_turn_id.is_some() {
        complete = false;
    }
    let estimated_cost_usd = turns.iter().map(|turn| turn.cost_usd).sum();
    Ok(CodexUsageObservation {
        turns,
        live_turn_id,
        complete,
        estimated_cost_usd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::model_pricing::ModelPricing;
    use serde_json::json;

    fn dispatch_record(turn_id: &str, model: &str) -> Value {
        json!({
            "generation":"generation-1","turnId":turn_id,"sessionID":"codex-native-1","pid":999999,
            "processIdentity":{"command":"codex exec","executable":"codex","argv":["codex","exec"],"processGroup":999999,"startTime":"gone","ownerUid":501},
            "dispatchArguments":["codex","exec","-m",model]
        })
    }

    use serde_json::Value;

    #[test]
    fn cumulative_native_thread_usage_uses_dispatched_model_and_optional_pricing() {
        let directory =
            std::env::temp_dir().join(format!("suplex-codex-usage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("dispatch-first.json"),
            dispatch_record("msg_001", "gpt-6-sol").to_string(),
        )
        .unwrap();
        fs::write(
            directory.join("dispatch-second.json"),
            dispatch_record("msg_002", "gpt-6-sol").to_string(),
        )
        .unwrap();
        fs::write(directory.join("turn-msg_001.jsonl"), concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":100,\"cached_input_tokens\":20,\"output_tokens\":50,\"reasoning_output_tokens\":10}}\n"
        )).unwrap();
        fs::write(directory.join("turn-msg_002.jsonl"), concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":180,\"cached_input_tokens\":30,\"output_tokens\":90,\"reasoning_output_tokens\":30}}\n",
            "{\"type\":\"error\",\"message\":\"Native turn failed\"}\n"
        )).unwrap();
        let pricing = ModelPricingCatalog::from([(
            "openai/gpt-6-sol".into(),
            ModelPricing {
                input: 1.0,
                output: 5.0,
                cache_read: 0.2,
                cache_write: 0.0,
            },
        )]);
        let observed = observe_session(&directory, "codex-native-1", Some(&pricing)).unwrap();
        assert!(observed.complete);
        assert_eq!(observed.turns.len(), 2);
        assert!(observed.turns[0].updated_at_ms > 0);
        assert!(!observed.turns[0].failed);
        assert!(observed.turns[1].failed);
        assert_eq!(observed.turns[1].tokens.input, 70.0);
        assert_eq!(observed.turns[1].tokens.output, 20.0);
        assert_eq!(observed.turns[1].tokens.reasoning, 20.0);
        assert_eq!(observed.turns[1].tokens.cache_read, 10.0);
        assert!(observed.estimated_cost_usd > 0.0);
        let unpriced = observe_session(&directory, "codex-native-1", None).unwrap();
        assert_eq!(unpriced.estimated_cost_usd, 0.0);
        assert!(!unpriced.turns[0].priced);
        fs::write(directory.join("turn-msg_002.jsonl"), concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":90,\"output_tokens\":90}}\n"
        )).unwrap();
        assert!(observe_session(&directory, "codex-native-1", Some(&pricing)).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn old_dispatch_record_uses_process_argv_only_when_arguments_are_absent() {
        let directory =
            std::env::temp_dir().join(format!("suplex-codex-model-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let mut old = dispatch_record("msg_old", "ignored");
        old.as_object_mut().unwrap().remove("dispatchArguments");
        old["processIdentity"]["argv"] = json!(["codex", "exec", "-m", "legacy-model"]);
        fs::write(directory.join("dispatch-old.json"), old.to_string()).unwrap();
        let mut present_empty = dispatch_record("msg_empty", "ignored");
        present_empty["dispatchArguments"] = json!([]);
        present_empty["processIdentity"]["argv"] = json!(["codex", "exec", "-m", "wrong-fallback"]);
        fs::write(
            directory.join("dispatch-empty.json"),
            present_empty.to_string(),
        )
        .unwrap();
        let models = dispatched_models(&directory).unwrap();
        assert_eq!(models["msg_old"], "legacy-model");
        assert_eq!(models["msg_empty"], "unknown");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn running_turn_with_an_empty_log_is_observed_from_dispatch_evidence() {
        let directory =
            std::env::temp_dir().join(format!("suplex-codex-live-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let environment = HashMap::new();
        let record = headless::dispatch(
            headless::DispatchInput {
                directory: &directory,
                worktree: &directory,
                session_id: "codex-native-live",
                turn_id: "msg_live",
                executable: Path::new("/bin/sh"),
                args: &["-c".into(), "sleep 30".into()],
                prompt: "Implement the change",
                environment: &environment,
            },
            |_| Ok(true),
        )
        .unwrap();
        let prompt = fs::metadata(headless::turn_file(&directory, "msg_live", "prompt")).unwrap();
        let observed = observe_session(&directory, "codex-native-live", None).unwrap();
        assert_eq!(observed.live_turn_id.as_deref(), Some("msg_live"));
        assert!(!observed.complete);
        assert_eq!(observed.turns.len(), 1);
        let live = &observed.turns[0];
        assert_eq!(live.turn_id, "msg_live");
        assert_eq!(live.started_at_ms, created_at(&prompt).unwrap());
        assert_eq!(live.tokens, UsageTokens::default());
        assert_eq!(live.cost_usd, 0.0);
        assert!(!live.failed);
        headless::stop_owned(&record).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn prompt_creation_precedes_completed_log_time() {
        let directory =
            std::env::temp_dir().join(format!("suplex-codex-start-time-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            headless::turn_file(&directory, "msg_done", "prompt"),
            "Implement the change",
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(
            headless::turn_file(&directory, "msg_done", "jsonl"),
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
                "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}\n"
            ),
        )
        .unwrap();
        let observed = observe_session(&directory, "codex-native-done", None).unwrap();
        assert!(observed.turns[0].started_at_ms < observed.turns[0].updated_at_ms);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn incomplete_historical_turn_is_not_reported_as_live() {
        let directory = std::env::temp_dir().join(format!(
            "suplex-codex-incomplete-turn-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            headless::turn_file(&directory, "msg_done", "jsonl"),
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
                "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}\n"
            ),
        )
        .unwrap();
        fs::write(headless::turn_file(&directory, "msg_lost", "jsonl"), "").unwrap();
        let observed = observe_session(&directory, "codex-native-done", None).unwrap();
        assert_eq!(observed.live_turn_id, None);
        assert_eq!(observed.turns.len(), 1);
        assert_eq!(observed.turns[0].turn_id, "msg_done");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn older_non_message_turns_use_mtime_for_cumulative_usage() {
        let directory = std::env::temp_dir().join(format!(
            "suplex-codex-old-turn-order-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let earlier = directory.join("turn-z.jsonl");
        let later = directory.join("turn-a.jsonl");
        fs::write(&earlier, concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"old-thread\"}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":100,\"output_tokens\":20}}\n"
        )).unwrap();
        fs::write(&later, concat!(
            "{\"type\":\"thread.started\",\"thread_id\":\"old-thread\"}\n",
            "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":180,\"output_tokens\":35}}\n"
        )).unwrap();
        let base =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        fs::File::options()
            .write(true)
            .open(&earlier)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(base))
            .unwrap();
        fs::File::options()
            .write(true)
            .open(&later)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(base + std::time::Duration::from_secs(10)))
            .unwrap();
        let observed = observe_session(&directory, "codex-old", None).unwrap();
        assert_eq!(observed.turns[0].turn_id, "z");
        assert_eq!(observed.turns[1].turn_id, "a");
        assert_eq!(observed.turns[1].tokens.input, 80.0);
        fs::remove_dir_all(directory).unwrap();
    }
}
