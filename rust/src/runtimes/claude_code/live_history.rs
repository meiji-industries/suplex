//! TypeScript `ClaudeLiveHistory`: the completed transcript merged with the
//! partial stream of every runtime turn log, so a running turn is visible.

use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};

use super::transcript::{self, ClaudeMessageEntry, Content};

const MAX_JSON_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_PARTIAL_TOOL_INPUT_CHARACTERS: usize = 64 * 1024;

enum Draft {
    Text {
        message_id: String,
        index: u64,
        text: String,
    },
    Tool {
        message_id: String,
        index: u64,
        id: String,
        name: String,
        input: Map<String, Value>,
        partial_input: String,
        stopped: bool,
    },
}

impl Draft {
    fn position(&self) -> String {
        match self {
            Draft::Text {
                message_id, index, ..
            }
            | Draft::Tool {
                message_id, index, ..
            } => {
                format!("{message_id}:{index}")
            }
        }
    }
}

enum Item {
    Entry(String),
    Draft(String),
}

struct Source {
    name: String,
    created_at: i64,
    entries: Vec<ClaudeMessageEntry>,
    items: Vec<Item>,
    drafts: HashMap<String, Draft>,
    represented: HashSet<String>,
}

fn block_count(entry: &ClaudeMessageEntry) -> usize {
    match &entry.content {
        Content::Blocks(blocks) => blocks.len(),
        Content::Text(_) => 0,
    }
}

/// Marks each completed block slot, keyed by native message id and position.
fn represent(
    entry: &ClaudeMessageEntry,
    offsets: &mut HashMap<String, usize>,
    mut mark: impl FnMut(String),
) {
    let count = block_count(entry);
    let Some(message_id) = entry.message_id.as_ref().filter(|_| count > 0) else {
        return;
    };
    let offset = offsets.entry(message_id.clone()).or_default();
    for index in 0..count {
        mark(format!("{message_id}:{}", *offset + index));
    }
    *offset += count;
}

fn tool_input(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

impl Source {
    fn read(path: &Path, transcript: bool, created_at: i64) -> io::Result<Self> {
        let mut source = Source {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            created_at,
            entries: Vec::new(),
            items: Vec::new(),
            drafts: HashMap::new(),
            represented: HashSet::new(),
        };
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        let mut seen = HashSet::new();
        let mut offsets = HashMap::new();
        let mut current: Option<String> = None;
        for line in String::from_utf8_lossy(&bytes).split('\n') {
            if line.trim().is_empty() || line.len() > MAX_JSON_RECORD_BYTES {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(entry) =
                transcript::message_entry(&value).filter(|entry| !entry.is_sidechain)
            {
                if seen.insert(entry.uuid.clone()) {
                    represent(&entry, &mut offsets, |key| {
                        source.represented.insert(key);
                    });
                    source.items.push(Item::Entry(entry.uuid.clone()));
                    source.entries.push(entry);
                }
                continue;
            }
            if transcript || value["type"] != "stream_event" {
                continue;
            }
            source.stream_event(&value["event"], &mut current);
        }
        Ok(source)
    }

    fn stream_event(&mut self, event: &Value, current: &mut Option<String>) {
        let index = event["index"].as_u64();
        match event["type"].as_str() {
            Some("message_start") if event["message"].is_object() => {
                *current = event["message"]["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned);
            }
            Some("content_block_start") => {
                let (Some(message_id), Some(index)) = (current.clone(), index) else {
                    return;
                };
                let block = &event["content_block"];
                let draft = match (
                    block["type"].as_str(),
                    block["id"].as_str(),
                    block["name"].as_str(),
                ) {
                    (Some("text"), _, _) if block["text"].is_string() => Draft::Text {
                        message_id,
                        index,
                        text: block["text"].as_str().unwrap_or_default().to_owned(),
                    },
                    (Some("tool_use" | "server_tool_use"), Some(id), Some(name))
                        if !id.is_empty() && !name.is_empty() =>
                    {
                        Draft::Tool {
                            message_id,
                            index,
                            id: id.to_owned(),
                            name: name.to_owned(),
                            input: tool_input(block.get("input")),
                            partial_input: String::new(),
                            stopped: false,
                        }
                    }
                    _ => return,
                };
                let key = draft.position();
                self.drafts.insert(key.clone(), draft);
                self.items.push(Item::Draft(key));
            }
            Some("content_block_delta") => {
                let (Some(message_id), Some(index)) = (current.as_ref(), index) else {
                    return;
                };
                let delta = &event["delta"];
                match (
                    self.drafts.get_mut(&format!("{message_id}:{index}")),
                    delta["type"].as_str(),
                ) {
                    (Some(Draft::Text { text, .. }), Some("text_delta")) => {
                        text.push_str(delta["text"].as_str().unwrap_or_default());
                    }
                    (
                        Some(Draft::Tool {
                            input,
                            partial_input,
                            ..
                        }),
                        Some("input_json_delta"),
                    ) if partial_input.chars().count() < MAX_PARTIAL_TOOL_INPUT_CHARACTERS => {
                        let available =
                            MAX_PARTIAL_TOOL_INPUT_CHARACTERS - partial_input.chars().count();
                        partial_input.extend(
                            delta["partial_json"]
                                .as_str()
                                .unwrap_or_default()
                                .chars()
                                .take(available),
                        );
                        if let Ok(parsed) = serde_json::from_str::<Value>(partial_input) {
                            *input = tool_input(Some(&parsed));
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                let (Some(message_id), Some(index)) = (current.as_ref(), index) else {
                    return;
                };
                if let Some(Draft::Tool {
                    input,
                    partial_input,
                    stopped,
                    ..
                }) = self.drafts.get_mut(&format!("{message_id}:{index}"))
                {
                    *stopped = true;
                    if let Ok(parsed) = serde_json::from_str::<Value>(partial_input) {
                        *input = tool_input(Some(&parsed));
                    }
                }
            }
            _ => {}
        }
    }

    fn draft(&self, key: &str, represented: &HashSet<String>) -> Option<Value> {
        let draft = self.drafts.get(key)?;
        let position = draft.position();
        if self.represented.contains(key) || represented.contains(&position) {
            return None;
        }
        let id = format!("claude-live:{}:{position}", self.name);
        let content = match draft {
            Draft::Text { text, .. } if text.is_empty() => return None,
            Draft::Text { text, .. } => {
                json!({"id":format!("{id}:text"),"type":"text","text":text})
            }
            Draft::Tool {
                id: tool,
                name,
                input,
                stopped,
                ..
            } => json!({
                "id":tool,"type":"tool","name":name,
                "status":if *stopped { "running" } else { "pending" },
                "input":input,"output":null,"error":null,
            }),
        };
        Some(json!({"id":id,"role":"assistant","createdAt":self.created_at,"content":[content]}))
    }
}

fn created_at(metadata: &fs::Metadata) -> i64 {
    let time = metadata
        .created()
        .or_else(|_| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn runtime_files(runtime_directory: &Path) -> io::Result<Vec<(PathBuf, i64)>> {
    let entries = match fs::read_dir(runtime_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.len() <= "turn-.jsonl".len()
            || !name.starts_with("turn-")
            || !name.ends_with(".jsonl")
        {
            continue;
        }
        match entry.metadata() {
            Ok(metadata) if metadata.is_file() => files.push((entry.path(), created_at(&metadata))),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    files.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    Ok(files)
}

/// TypeScript `ClaudeLiveHistory.read`.
// ponytail: rereads every file on each call; keep per-file cursors if long sessions make history slow.
pub fn read(runtime_directory: &Path, transcript_path: Option<&Path>) -> io::Result<Vec<Value>> {
    let mut sources = Vec::new();
    if let Some(path) = transcript_path {
        sources.push(Source::read(path, true, created_at(&fs::metadata(path)?))?);
    }
    for (path, created) in runtime_files(runtime_directory)? {
        sources.push(Source::read(&path, false, created)?);
    }
    let mut seen = HashSet::new();
    let entries = sources
        .iter()
        .flat_map(|source| source.entries.iter())
        .filter(|entry| seen.insert(entry.uuid.clone()))
        .cloned()
        .collect::<Vec<_>>();
    let completed = transcript::history_messages(&entries)
        .into_iter()
        .map(|message| {
            (
                message["id"].as_str().unwrap_or_default().to_owned(),
                message,
            )
        })
        .collect::<HashMap<_, _>>();
    let mut represented = HashSet::new();
    let mut owners = HashMap::new();
    let mut offsets = HashMap::new();
    for entry in &entries {
        represent(entry, &mut offsets, |key| {
            represented.insert(key.clone());
            owners.insert(key, entry.uuid.clone());
        });
    }
    let mut emitted = HashSet::new();
    let mut messages = Vec::new();
    for source in &sources {
        for item in &source.items {
            let message = match item {
                Item::Entry(id) => completed.get(id).cloned(),
                Item::Draft(key) => match source
                    .drafts
                    .get(key)
                    .and_then(|draft| owners.get(&draft.position()))
                {
                    Some(owner) => completed.get(owner).cloned(),
                    None => source.draft(key, &represented),
                },
            };
            if let Some(message) = message
                && emitted.insert(message["id"].as_str().unwrap_or_default().to_owned())
            {
                messages.push(message);
            }
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_lines(path: &Path, values: &[Value]) {
        fs::write(
            path,
            values
                .iter()
                .map(|value| format!("{value}\n"))
                .collect::<String>(),
        )
        .unwrap();
    }

    fn stream(event: Value) -> Value {
        json!({"type":"stream_event","event":event})
    }

    fn directory() -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("suplex-claude-live-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn live_history_replaces_only_the_completed_blocks_of_a_shared_native_message() {
        let directory = directory();
        write_lines(
            &directory.join("turn-one.jsonl"),
            &[
                json!({"type":"user","uuid":"u1","message":{"role":"user","content":"Inspect"}}),
                stream(json!({"type":"message_start","message":{"id":"msg_1"}})),
                stream(
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                ),
                stream(
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Reading"}}),
                ),
                stream(
                    json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}),
                ),
                stream(
                    json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"/repo/a\"}"}}),
                ),
                stream(json!({"type":"content_block_stop","index":1})),
                json!({"type":"assistant","uuid":"a1","message":{"role":"assistant","id":"msg_1","content":[{"type":"text","text":"Reading"}]}}),
            ],
        );
        let messages = read(&directory, None).unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["u1", "a1", "claude-live:turn-one.jsonl:msg_1:1"]
        );
        assert_eq!(
            messages[2]["content"][0],
            json!({"id":"toolu_1","type":"tool","name":"Read","status":"running","input":{"file_path":"/repo/a"},"output":null,"error":null})
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_transcript_completion_suppresses_the_matching_runtime_draft() {
        let directory = directory();
        let transcript = directory.join("session.jsonl");
        write_lines(
            &transcript,
            &[
                json!({"type":"assistant","uuid":"a1","message":{"role":"assistant","id":"msg_1","content":[{"type":"text","text":"Done"}]}}),
            ],
        );
        write_lines(
            &directory.join("turn-one.jsonl"),
            &[
                stream(json!({"type":"message_start","message":{"id":"msg_1"}})),
                stream(
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Do"}}),
                ),
            ],
        );
        let messages = read(&directory, Some(&transcript)).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"][0]["text"], "Done");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn live_history_waits_for_a_complete_json_line() {
        let directory = directory();
        let path = directory.join("turn-one.jsonl");
        let entry = json!({"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}).to_string();
        fs::write(&path, &entry[..entry.len() / 2]).unwrap();
        assert!(read(&directory, None).unwrap().is_empty());
        fs::write(&path, &entry).unwrap();
        assert_eq!(
            read(&directory, None).unwrap()[0]["content"][0]["text"],
            "Hello"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn live_history_waits_for_the_rest_of_a_split_utf8_character() {
        let directory = directory();
        let path = directory.join("turn-one.jsonl");
        let entry = json!({"type":"assistant","uuid":"utf8-entry","message":{"id":"utf8-message","role":"assistant","content":[{"type":"text","text":"split 🥔"}]}}).to_string() + "\n";
        let bytes = entry.as_bytes();
        let split = bytes
            .windows(4)
            .position(|window| window == "🥔".as_bytes())
            .unwrap()
            + 1;
        fs::write(&path, &bytes[..split]).unwrap();
        assert!(read(&directory, None).unwrap().is_empty());
        fs::write(&path, bytes).unwrap();
        assert_eq!(
            read(&directory, None).unwrap()[0]["content"][0]["text"],
            "split 🥔"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
