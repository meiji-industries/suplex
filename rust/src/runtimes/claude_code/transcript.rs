//! Claude Code owns the transcript at <config dir>/projects/<project>/<session>.jsonl
//! and the stream-json output of every headless turn. Suplex reads both; it
//! never edits them.

use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
};

use chrono::DateTime;
use serde_json::{Map, Value, json};

use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{native::NativeTool, native::UsageTokens},
    shared::js_json,
};

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    ToolUse {
        id: String,
        name: String,
        input: Map<String, Value>,
    },
    ToolResult {
        tool_use_id: String,
        content: Option<Value>,
        is_error: Option<bool>,
    },
    Text(String),
    Thinking(String),
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Content {
    Text(String),
    Blocks(Vec<Block>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NativeUsage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_input_tokens: f64,
    pub cache_creation_input_tokens: f64,
    pub thinking_tokens: f64,
}

/// TypeScript `ClaudeMessageEntrySchema`: one user or assistant line.
#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeMessageEntry {
    /// "user" or "assistant".
    pub kind: String,
    pub uuid: String,
    pub timestamp: Option<String>,
    pub role: String,
    pub content: Content,
    pub model: Option<String>,
    pub message_id: Option<String>,
    pub usage: Option<NativeUsage>,
    pub is_api_error_message: bool,
    pub is_sidechain: bool,
}

fn non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A present optional field must match; an absent one is `Some(None)`.
fn optional<T>(
    object: &Map<String, Value>,
    key: &str,
    parse: impl Fn(&Value) -> Option<T>,
) -> Option<Option<T>> {
    match object.get(key) {
        None => Some(None),
        Some(value) => parse(value).map(Some),
    }
}

fn count(object: &Map<String, Value>, key: &str) -> Option<f64> {
    match object.get(key) {
        None => Some(0.0),
        Some(value) => value.as_f64().filter(|value| *value >= 0.0),
    }
}

fn usage(value: &Value) -> Option<NativeUsage> {
    let object = value.as_object()?;
    let thinking = optional(object, "output_tokens_details", |details| {
        count(details.as_object()?, "thinking_tokens")
    })?;
    Some(NativeUsage {
        input_tokens: count(object, "input_tokens")?,
        output_tokens: count(object, "output_tokens")?,
        cache_read_input_tokens: count(object, "cache_read_input_tokens")?,
        cache_creation_input_tokens: count(object, "cache_creation_input_tokens")?,
        thinking_tokens: thinking.unwrap_or(0.0),
    })
}

/// TypeScript `ClaudeContentBlockSchema`.
pub fn block(value: &Value) -> Option<Block> {
    let object = value.as_object()?;
    let kind = non_empty(object.get("type")?)?;
    match kind.as_str() {
        "tool_use" => Some(Block::ToolUse {
            id: non_empty(object.get("id")?)?,
            name: non_empty(object.get("name")?)?,
            input: optional(object, "input", |input| input.as_object().cloned())?
                .unwrap_or_default(),
        }),
        "tool_result" => Some(Block::ToolResult {
            tool_use_id: non_empty(object.get("tool_use_id")?)?,
            content: object.get("content").cloned(),
            is_error: optional(object, "is_error", Value::as_bool)?,
        }),
        "text" => Some(Block::Text(object.get("text")?.as_str()?.to_owned())),
        "thinking" => Some(
            object
                .get("thinking")
                .and_then(Value::as_str)
                .map_or(Block::Other, |text| Block::Thinking(text.to_owned())),
        ),
        _ => Some(Block::Other),
    }
}

/// TypeScript `ClaudeMessageEntrySchema.safeParse`.
pub fn message_entry(value: &Value) -> Option<ClaudeMessageEntry> {
    let object = value.as_object()?;
    let kind = object.get("type")?.as_str()?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    let uuid = non_empty(object.get("uuid")?)?;
    optional(object, "parentUuid", |parent| {
        (parent.is_null() || parent.is_string()).then_some(())
    })?;
    let timestamp = optional(object, "timestamp", |time| time.as_str().map(str::to_owned))?;
    let message = object.get("message")?.as_object()?;
    let role = message.get("role")?.as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let content = match message.get("content")? {
        Value::String(text) => Content::Text(text.clone()),
        Value::Array(blocks) => Content::Blocks(blocks.iter().map(block).collect::<Option<_>>()?),
        _ => return None,
    };
    optional(message, "stop_reason", |reason| {
        (reason.is_null() || reason.is_string()).then_some(())
    })?;
    Some(ClaudeMessageEntry {
        kind: kind.to_owned(),
        uuid,
        timestamp,
        role: role.to_owned(),
        content,
        model: optional(message, "model", non_empty)?,
        message_id: optional(message, "id", non_empty)?,
        usage: optional(message, "usage", usage)?,
        is_api_error_message: optional(object, "isApiErrorMessage", Value::as_bool)?
            .unwrap_or(false),
        is_sidechain: optional(object, "isSidechain", Value::as_bool)?.unwrap_or(false),
    })
}

/// A partially written line is not evidence.
pub fn parse_json_lines(text: &str) -> Vec<Value> {
    text.split('\n')
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

pub fn message_entries(values: &[Value]) -> Vec<ClaudeMessageEntry> {
    values
        .iter()
        .filter_map(message_entry)
        .filter(|entry| !entry.is_sidechain)
        .collect()
}

/// TypeScript `ClaudeStreamInitSchema`: (cwd, model).
pub fn stream_init(values: &[Value]) -> Option<(String, String)> {
    values.iter().find_map(|value| {
        let object = value.as_object()?;
        (object.get("type")? == "system" && object.get("subtype")? == "init").then_some(())?;
        non_empty(object.get("session_id")?)?;
        Some((
            non_empty(object.get("cwd")?)?,
            non_empty(object.get("model")?)?,
        ))
    })
}

/// TypeScript `ClaudeStreamResultSchema`.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamResult {
    pub subtype: String,
    pub is_error: bool,
    pub result: Option<String>,
}

/// The last valid stream result line.
pub fn stream_result(values: &[Value]) -> Option<StreamResult> {
    values.iter().rev().find_map(|value| {
        let object = value.as_object()?;
        (object.get("type")? == "result").then_some(())?;
        non_empty(object.get("session_id")?)?;
        optional(object, "uuid", non_empty)?;
        optional(object, "total_cost_usd", |cost| {
            cost.as_f64().filter(|cost| *cost >= 0.0)
        })?;
        Some(StreamResult {
            subtype: non_empty(object.get("subtype")?)?,
            is_error: object.get("is_error")?.as_bool()?,
            result: optional(object, "result", |text| text.as_str().map(str::to_owned))?,
        })
    })
}

pub fn config_directory(environment: &HashMap<String, String>) -> PathBuf {
    environment.get("CLAUDE_CONFIG_DIR").map_or_else(
        || {
            crate::profiles::agent_profiles::home_directory()
                .unwrap_or_default()
                .join(".claude")
        },
        PathBuf::from,
    )
}

/// Claude Code resolves a session id across projects; so does Suplex.
pub fn find_transcript(session_id: &str, config_directory: &Path) -> io::Result<Option<PathBuf>> {
    let projects = config_directory.join("projects");
    let entries = match fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut directories = entries
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<io::Result<Vec<_>>>()?;
    directories.sort();
    for directory in directories {
        let candidate = projects.join(directory).join(format!("{session_id}.jsonl"));
        match fs::File::open(&candidate) {
            Ok(_) => return Ok(Some(candidate)),
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.kind() == io::ErrorKind::NotADirectory => {}
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

pub fn blocks(entry: &ClaudeMessageEntry) -> Vec<Block> {
    match &entry.content {
        Content::Text(text) => vec![Block::Text(text.clone())],
        Content::Blocks(blocks) => blocks.clone(),
    }
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match (block.get("type"), block.get("text")) {
                (Some(kind), Some(Value::String(text))) if kind == "text" => text.clone(),
                _ => js_json::stringify(block),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => js_json::stringify(other),
    }
}

fn created_at(entry: &ClaudeMessageEntry) -> Option<i64> {
    DateTime::parse_from_rfc3339(entry.timestamp.as_deref()?)
        .ok()
        .map(|time| time.timestamp_millis())
}

/// TypeScript `claudeHistoryMessages`.
pub fn history_messages(entries: &[ClaudeMessageEntry]) -> Vec<Value> {
    let mut results = HashMap::new();
    for entry in entries {
        for block in blocks(entry) {
            if let Block::ToolResult {
                tool_use_id,
                content,
                is_error,
            } = block
            {
                results.insert(tool_use_id, (content, is_error == Some(true)));
            }
        }
    }
    entries
        .iter()
        .filter_map(|entry| {
            let mut content = Vec::new();
            for (index, block) in blocks(entry).into_iter().enumerate() {
                match block {
                    Block::Text(text) => content.push(json!({
                        "id":format!("{}:text:{index}", entry.uuid),"type":"text","text":text,
                    })),
                    Block::Thinking(text) if !text.trim().is_empty() => content.push(json!({
                        "id":format!("{}:reasoning:{index}", entry.uuid),"type":"reasoning","text":text,
                    })),
                    Block::ToolUse { id, name, input } => {
                        let result = results.get(&id);
                        let text = result.map(|(content, _)| result_text(content.as_ref()));
                        let failed = result.is_some_and(|(_, failed)| *failed);
                        content.push(json!({
                            "id":id,"type":"tool","name":name,
                            "status":match result { None => "running", Some(_) if failed => "error", Some(_) => "completed" },
                            "input":input,
                            "output":if failed { None } else { text.clone() },
                            "error":if failed { text } else { None },
                        }));
                    }
                    _ => {}
                }
            }
            (!content.is_empty()).then(|| {
                json!({"id":entry.uuid,"role":entry.kind,"createdAt":created_at(entry),"content":content})
            })
        })
        .collect()
}

/// TypeScript `claudeExecution`: tools and the last successful TodoWrite plan.
pub fn execution(entries: &[ClaudeMessageEntry]) -> (Vec<NativeTool>, Value) {
    let mut tools: Vec<NativeTool> = Vec::new();
    let mut index = HashMap::new();
    let mut plan = Value::Null;
    for entry in entries {
        for block in blocks(entry) {
            match block {
                Block::ToolUse { id, name, input } => {
                    index.insert(id.clone(), tools.len());
                    tools.push(NativeTool {
                        id,
                        name,
                        status: "running",
                        input,
                        output: None,
                        error: None,
                    });
                }
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    let Some(tool) = index
                        .get(&tool_use_id)
                        .and_then(|position| tools.get_mut(*position))
                    else {
                        continue;
                    };
                    let failed = is_error == Some(true);
                    let text = result_text(content.as_ref());
                    tool.status = if failed { "error" } else { "completed" };
                    (tool.output, tool.error) = if failed {
                        (None, Some(text))
                    } else {
                        (Some(text), None)
                    };
                    if tool.name == "TodoWrite"
                        && !failed
                        && let Some(items) = todo_plan(&tool.input)
                    {
                        plan = items;
                    }
                }
                _ => {}
            }
        }
    }
    (tools, plan)
}

fn todo_plan(input: &Map<String, Value>) -> Option<Value> {
    input
        .get("todos")?
        .as_array()?
        .iter()
        .map(|todo| {
            let content = todo.get("content")?.as_str()?;
            let status = todo.get("status")?.as_str()?;
            ["pending", "in_progress", "completed", "cancelled"]
                .contains(&status)
                .then(|| json!({"content":content,"status":status}))
        })
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}

pub fn unsettled_tool_ids(entries: &[ClaudeMessageEntry]) -> Vec<String> {
    let settled = entries
        .iter()
        .flat_map(blocks)
        .filter_map(|block| match block {
            Block::ToolResult { tool_use_id, .. } => Some(tool_use_id),
            _ => None,
        })
        .collect::<HashSet<_>>();
    entries
        .iter()
        .flat_map(blocks)
        .filter_map(|block| match block {
            Block::ToolUse { id, .. } if !settled.contains(&id) => Some(id),
            _ => None,
        })
        .collect()
}

pub fn assistant_text(entries: &[ClaudeMessageEntry]) -> String {
    entries
        .iter()
        .filter(|entry| entry.kind == "assistant")
        .flat_map(blocks)
        .filter_map(|block| match block {
            Block::Text(text) => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One TypeScript `TaskUsage` record.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageRecord {
    pub message_id: String,
    pub turn_id: String,
    pub model: String,
    pub started_at_ms: i64,
    pub failed: bool,
    pub tokens: UsageTokens,
    pub cost_usd: f64,
}

/// TypeScript `claudeUsage`: one record per API response. Claude Code reports
/// no native cost per message, so listed prices estimate it.
pub fn usage_records(
    entries: &[ClaudeMessageEntry],
    pricing: Option<&ModelPricingCatalog>,
) -> Vec<UsageRecord> {
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    let mut turn_id = String::new();
    for entry in entries {
        if entry.kind == "user"
            && blocks(entry)
                .iter()
                .all(|block| !matches!(block, Block::ToolResult { .. }))
        {
            turn_id = entry.uuid.clone();
            continue;
        }
        if entry.kind != "assistant" || turn_id.is_empty() {
            continue;
        }
        if !seen.insert(
            entry
                .message_id
                .clone()
                .unwrap_or_else(|| entry.uuid.clone()),
        ) {
            continue;
        }
        let tokens = entry
            .usage
            .as_ref()
            .map_or_else(UsageTokens::default, |native| UsageTokens {
                input: native.input_tokens,
                output: native.output_tokens,
                reasoning: native.thinking_tokens,
                cache_read: native.cache_read_input_tokens,
                cache_write: native.cache_creation_input_tokens,
            });
        let model = entry.model.clone().unwrap_or_else(|| "unknown".into());
        let cost_usd = pricing
            .and_then(|catalog| catalog.get(&format!("anthropic/{model}")))
            .map_or(0.0, |price| price.estimate(tokens));
        records.push(UsageRecord {
            message_id: entry.uuid.clone(),
            turn_id: turn_id.clone(),
            model,
            started_at_ms: created_at(entry).unwrap_or(0),
            failed: entry.is_api_error_message,
            tokens,
            cost_usd,
        });
    }
    records
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_block_keeps_visible_native_text() {
        assert_eq!(
            block(&json!({"type":"thinking","thinking":"Check the callers."})),
            Some(Block::Thinking("Check the callers.".into()))
        );
        assert_eq!(block(&json!({"type":"thinking"})), Some(Block::Other));
    }
    use crate::profiles::model_pricing::ModelPricing;

    fn transcript() -> String {
        let usage = json!({"input_tokens":9,"output_tokens":82,"cache_read_input_tokens":5,"cache_creation_input_tokens":6053,"output_tokens_details":{"thinking_tokens":74}});
        let mut usage_8 = usage.clone();
        usage_8["input_tokens"] = json!(8);
        let lines = [
            json!({"type":"queue-operation","operation":"enqueue"}),
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-09-07T15:37:02.162Z","message":{"role":"user","content":"Read the id file"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-09-07T15:37:24.252Z","message":{"model":"claude-haiku-4-5-20251001","id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":""}],"usage":usage}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"a1","timestamp":"2026-09-07T15:37:24.300Z","message":{"model":"claude-haiku-4-5-20251001","id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/repo/id"}},{"type":"tool_use","id":"toolu_2","name":"TodoWrite","input":{"todos":[{"content":"Inspect","status":"completed","activeForm":"Inspecting"},{"content":"Reply","status":"in_progress","activeForm":"Replying"}]}}],"usage":usage}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a2","timestamp":"2026-09-07T15:37:24.400Z","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\tabc\n"},{"tool_use_id":"toolu_2","type":"tool_result","content":[{"type":"text","text":"Todos have been modified"}]}]}}),
            json!({"type":"assistant","uuid":"a3","parentUuid":"u2","timestamp":"2026-09-07T15:37:25.252Z","message":{"model":"claude-haiku-4-5-20251001","id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"Bash","input":{"command":"false"}}],"usage":usage_8}}),
            json!({"type":"user","uuid":"u3","parentUuid":"a3","timestamp":"2026-09-07T15:37:26.000Z","message":{"role":"user","content":[{"tool_use_id":"toolu_3","type":"tool_result","content":"exit 1","is_error":true}]}}),
            json!({"type":"assistant","uuid":"a4","parentUuid":"u3","timestamp":"2026-09-07T15:37:27.000Z","isSidechain":true,"message":{"model":"claude-haiku-4-5-20251001","id":"msg_side","role":"assistant","content":[{"type":"text","text":"subagent"}],"usage":usage}}),
            json!({"type":"assistant","uuid":"a5","parentUuid":"u3","timestamp":"2026-09-07T15:37:28.000Z","isApiErrorMessage":true,"message":{"model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"text","text":"API Error"}]}}),
        ];
        format!(
            "{}\n{{\"type\":\"assistant\",\"truncated",
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        )
    }

    fn ms(time: &str) -> i64 {
        DateTime::parse_from_rfc3339(time)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn execution_reads_tool_results_plans_and_unsettled_tools_from_a_transcript() {
        let entries = message_entries(&parse_json_lines(&transcript()));
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.uuid.as_str())
                .collect::<Vec<_>>(),
            ["u1", "a1", "a2", "u2", "a3", "u3", "a5"]
        );
        let (tools, plan) = execution(&entries);
        let tools = serde_json::to_value(&tools).unwrap();
        assert_eq!(
            tools[0],
            json!({"id":"toolu_1","name":"Read","status":"completed","input":{"file_path":"/repo/id"},"output":"1\tabc\n","error":null})
        );
        assert_eq!(tools[1]["status"], "completed");
        assert_eq!(tools[1]["output"], "Todos have been modified");
        assert_eq!(
            tools[2],
            json!({"id":"toolu_3","name":"Bash","status":"error","input":{"command":"false"},"output":null,"error":"exit 1"})
        );
        assert_eq!(
            plan,
            json!([{"content":"Inspect","status":"completed"},{"content":"Reply","status":"in_progress"}])
        );
        assert!(unsettled_tool_ids(&entries).is_empty());
        assert_eq!(unsettled_tool_ids(&entries[..5]), ["toolu_3"]);
    }

    #[test]
    fn history_joins_completed_failed_and_running_tools_by_native_id() {
        let entries = message_entries(&parse_json_lines(&transcript()));
        let history = history_messages(&entries[..5]);
        assert_eq!(
            history
                .iter()
                .map(|message| message["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["u1", "a2", "a3"]
        );
        assert_eq!(history[0]["role"], "user");
        assert_eq!(history[0]["createdAt"], ms("2026-09-07T15:37:02.162Z"));
        assert_eq!(history[0]["content"][0]["text"], "Read the id file");
        assert_eq!(
            history[1]["content"][0],
            json!({"id":"toolu_1","type":"tool","name":"Read","status":"completed","input":{"file_path":"/repo/id"},"output":"1\tabc\n","error":null})
        );
        assert_eq!(
            history[1]["content"][1]["output"],
            "Todos have been modified"
        );
        assert_eq!(
            history[2]["content"],
            json!([{"id":"toolu_3","type":"tool","name":"Bash","status":"running","input":{"command":"false"},"output":null,"error":null}])
        );
        assert_eq!(
            history_messages(&entries)[2]["content"],
            json!([{"id":"toolu_3","type":"tool","name":"Bash","status":"error","input":{"command":"false"},"output":null,"error":"exit 1"}])
        );
    }

    #[test]
    fn history_text_identities_use_the_immutable_transcript_block_slot() {
        let entry = |content: Value| {
            message_entries(&[
                json!({"type":"assistant","uuid":"a-slots","timestamp":"2026-09-07T15:37:28.000Z","message":{"role":"assistant","content":content}}),
            ])
        };
        let duplicated = history_messages(&entry(
            json!([{"type":"text","text":"same"},{"type":"thinking","thinking":"hidden"},{"type":"text","text":"same"}]),
        ));
        assert_eq!(duplicated[0]["content"][0]["id"], "a-slots:text:0");
        assert_eq!(
            duplicated[0]["content"][1],
            json!({"id":"a-slots:reasoning:1","type":"reasoning","text":"hidden"})
        );
        assert_eq!(duplicated[0]["content"][2]["id"], "a-slots:text:2");
        let changed = history_messages(&entry(
            json!([{"type":"text","text":"expanded text"},{"type":"thinking","thinking":"hidden"},{"type":"text","text":"same"}]),
        ));
        assert_eq!(changed[0]["content"][0]["id"], "a-slots:text:0");
    }

    #[test]
    fn usage_records_one_entry_per_api_response_keyed_by_the_prompt_that_started_the_turn() {
        let entries = message_entries(&parse_json_lines(&transcript()));
        let pricing = ModelPricingCatalog::from([(
            "anthropic/claude-haiku-4-5-20251001".to_owned(),
            ModelPricing {
                input: 1.0,
                output: 5.0,
                cache_read: 0.1,
                cache_write: 1.25,
            },
        )]);
        let usage = usage_records(&entries, Some(&pricing));
        assert_eq!(
            usage
                .iter()
                .map(|record| (
                    record.message_id.as_str(),
                    record.turn_id.as_str(),
                    record.failed
                ))
                .collect::<Vec<_>>(),
            [("a1", "u1", false), ("a3", "u1", false), ("a5", "u1", true)]
        );
        assert_eq!(usage[0].model, "claude-haiku-4-5-20251001");
        assert_eq!(
            usage[0].tokens,
            UsageTokens {
                input: 9.0,
                output: 82.0,
                reasoning: 74.0,
                cache_read: 5.0,
                cache_write: 6053.0
            }
        );
        assert_eq!(usage[0].started_at_ms, ms("2026-09-07T15:37:24.252Z"));
        let expected = (9.0 + (82.0 + 74.0) * 5.0 + 5.0 * 0.1 + 6053.0 * 1.25) / 1_000_000.0;
        assert!((usage[0].cost_usd - expected).abs() < 1e-12);
        assert_eq!(usage_records(&entries, None)[0].cost_usd, 0.0);
    }

    #[test]
    fn transcripts_are_located_by_session_id_across_claude_projects() {
        let config =
            std::env::temp_dir().join(format!("suplex-claude-config-{}", uuid::Uuid::new_v4()));
        assert_eq!(find_transcript("missing", &config).unwrap(), None);
        fs::create_dir_all(config.join("projects/-repo-a")).unwrap();
        fs::create_dir_all(config.join("projects/-repo-b")).unwrap();
        fs::write(config.join("projects/-repo-b/abc.jsonl"), transcript()).unwrap();
        assert_eq!(
            find_transcript("abc", &config).unwrap(),
            Some(config.join("projects/-repo-b/abc.jsonl"))
        );
        fs::remove_dir_all(config).unwrap();
    }
}
