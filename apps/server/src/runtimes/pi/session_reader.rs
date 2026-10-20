//! Read-only Pi evidence in a Suplex session runtime directory: the per-turn
//! `--mode json` logs and the Pi session file under `pi-sessions/`.

use super::transcript::{self, PiEvent};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::tool_evidence::tool_output;
use crate::runtimes::native::NativeReasoning;

/// Pi's `--session-dir` inside the Suplex session runtime directory.
pub const SESSION_DIRECTORY: &str = "pi-sessions";

#[derive(Debug)]
pub struct NativeTurn {
    pub id: String,
    pub events: Vec<PiEvent>,
    pub updated_at: SystemTime,
}

fn valid_turn_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

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
        let text = fs::read_to_string(entry.path())?;
        let updated_at = entry.metadata()?.modified()?;
        turns.push(NativeTurn {
            id: id.to_owned(),
            events: transcript::parse_events(&text),
            updated_at,
        });
    }
    turns.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(turns)
}

pub fn turn_evidence(directory: &Path, turn_id: &str) -> io::Result<Option<Vec<PiEvent>>> {
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

/// Pi names a session file `<timestamp>_<session id>.jsonl`.
pub fn session_file(directory: &Path, native_session_id: &str) -> io::Result<Option<PathBuf>> {
    let entries = match fs::read_dir(directory.join(SESSION_DIRECTORY)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let suffix = format!("_{native_session_id}.jsonl");
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_name().to_string_lossy().ends_with(&suffix) && entry.file_type()?.is_file() {
            found.push(entry.path());
        }
    }
    found.sort();
    Ok(found.pop())
}

/// The session file's entries; no file yet is an empty session.
pub fn session_entries(directory: &Path, native_session_id: &str) -> io::Result<Vec<Value>> {
    let Some(path) = session_file(directory, native_session_id)? else {
        return Ok(Vec::new());
    };
    Ok(fs::read_to_string(path)?
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| entry["type"] == "message" && entry["id"].is_string())
        .collect())
}

fn created_at(entry: &Value) -> Option<i64> {
    entry["message"]["timestamp"].as_i64().or_else(|| {
        chrono::DateTime::parse_from_rfc3339(entry["timestamp"].as_str()?)
            .ok()
            .map(|time| time.timestamp_millis())
    })
}

/// Assistant messages with their thinking, text, and tool calls. A tool call
/// is settled by the matching `toolResult` message.
pub fn history(entries: &[Value]) -> Vec<Value> {
    let results = entries
        .iter()
        .map(|entry| &entry["message"])
        .filter(|message| message["role"] == "toolResult")
        .filter_map(|message| Some((message["toolCallId"].as_str()?, message)))
        .collect::<Vec<_>>();
    entries
        .iter()
        .filter(|entry| entry["message"]["role"] == "assistant")
        .filter_map(|entry| {
            let id = entry["id"].as_str()?;
            let message = &entry["message"];
            let content = message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .filter_map(|(index, block)| match block["type"].as_str()? {
                    "thinking" => block["thinking"]
                        .as_str()
                        .filter(|text| !text.trim().is_empty())
                        .map(|text| json!({"id":format!("{id}:{index}"),"type":"reasoning","text":text})),
                    "text" => block["text"]
                        .as_str()
                        .filter(|text| !text.is_empty())
                        .map(|text| json!({"id":format!("{id}:{index}"),"type":"text","text":text})),
                    "toolCall" => {
                        let call = block["id"].as_str()?;
                        let name = block["name"].as_str()?;
                        let result = results
                            .iter()
                            .find(|(result, _)| *result == call)
                            .map(|(_, result)| *result);
                        let failed = result.is_some_and(|result| result["isError"] == true);
                        let output = result.and_then(|result| tool_output(name, result));
                        Some(json!({
                            "id":call,"type":"tool","name":name,
                            "status":if failed { "error" } else if result.is_some() { "completed" } else { "running" },
                            "input":block["arguments"].as_object().cloned().unwrap_or_default(),
                            "error":if failed { output.clone() } else { None },
                            "output":output,
                        }))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            (!content.is_empty()).then(|| {
                json!({"id":id,"role":"assistant","createdAt":created_at(entry),"content":content})
            })
        })
        .collect()
}

/// Thinking blocks of every assistant message.
pub fn reasoning(entries: &[Value]) -> Vec<NativeReasoning> {
    history(entries)
        .into_iter()
        .flat_map(|message| {
            message["content"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|part| part["type"] == "reasoning")
                .filter_map(|part| {
                    Some(NativeReasoning {
                        id: part["id"].as_str()?.to_owned(),
                        text: part["text"].as_str()?.to_owned(),
                    })
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = include_str!("fixtures/session.jsonl");

    fn runtime_with_session() -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("suplex-pi-reader-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join(SESSION_DIRECTORY)).unwrap();
        fs::write(
            directory
                .join(SESSION_DIRECTORY)
                .join("2026-10-20T16-46-06-320Z_pi-1234-abcd.jsonl"),
            SESSION,
        )
        .unwrap();
        directory
    }

    #[test]
    fn history_and_reasoning_come_from_the_native_session_file() {
        let directory = runtime_with_session();
        assert!(session_file(&directory, "pi-other").unwrap().is_none());
        let entries = session_entries(&directory, "pi-1234-abcd").unwrap();
        let messages = history(&entries);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["id"], "4084feb2");
        assert_eq!(messages[0]["createdAt"], 1_792_514_766_417_i64);
        assert_eq!(
            messages[0]["content"],
            json!([
                {"id":"4084feb2:0","type":"reasoning","text":"Thinking about it."},
                {"id":"4084feb2:1","type":"text","text":"Done."},
            ])
        );
        assert_eq!(
            messages[1]["content"][1],
            json!({"id":"call_1","type":"tool","name":"bash","status":"completed","input":{"command":"pnpm test"},"output":"2 passed\n","error":null})
        );
        let parts = reasoning(&entries);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[1].id, "a52e8916:0");
        assert_eq!(parts[1].text, "I will call a tool.");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_missing_session_file_is_an_empty_history_and_turn_paths_reject_traversal() {
        let directory = Path::new("/tmp/suplex-missing-pi-runtime");
        assert!(session_entries(directory, "pi-1").unwrap().is_empty());
        assert!(turn_evidence(directory, "msg_1").unwrap().is_none());
        assert!(turn_evidence(directory, "../msg_1").is_err());
    }

    #[test]
    fn an_unsettled_tool_call_reads_as_running() {
        let entries = vec![
            json!({"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_9","name":"bash","arguments":{"command":"sleep 9"}}],"timestamp":5}}),
        ];
        assert_eq!(history(&entries)[0]["content"][0]["status"], "running");
    }
}
