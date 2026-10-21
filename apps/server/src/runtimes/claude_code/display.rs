//! TypeScript `runtimes/claude-code/display.ts`: a read-only terminal view that
//! follows every headless turn log of one session runtime directory. Herdr
//! runs `claude_display_command` in the task pane; the pane attachment itself
//! belongs to the shared task display seam.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use regex::Regex;
use serde_json::Value;

use crate::coordination::bridge_auth::{
    ADVISOR_BINDING_ENV, ADVISOR_RESULT_ENV, ADVISOR_TOKEN_ENV, ROOT_BINDING_ENV, ROOT_TOKEN_ENV,
};

const WAITING_LABEL: &str = "No Claude output yet.\n";
const READ_CHUNK_BYTES: u64 = 64 * 1024;
const MAX_JSON_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_PARTIAL_TOOL_INPUT_CHARACTERS: usize = 64 * 1024;
const MAX_INPUT_PREVIEW_CHARACTERS: usize = 800;
const MAX_RESULT_PREVIEW_CHARACTERS: usize = 4_000;

pub struct ClaudeDisplayCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub command: String,
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The Suplex binary follows the runtime directory without bridge credentials.
pub fn claude_display_command(runtime_directory: &Path) -> io::Result<ClaudeDisplayCommand> {
    let executable = crate::shared::fs::executable()?
        .to_string_lossy()
        .into_owned();
    let args = vec![
        "display".to_owned(),
        "claude-code".to_owned(),
        runtime_directory.to_string_lossy().into_owned(),
    ];
    let clear = [
        ROOT_BINDING_ENV,
        ROOT_TOKEN_ENV,
        ADVISOR_BINDING_ENV,
        ADVISOR_TOKEN_ENV,
        ADVISOR_RESULT_ENV,
    ]
    .into_iter()
    .flat_map(|key| ["-u", key]);
    let command = std::iter::once("/usr/bin/env")
        .chain(clear)
        .chain(std::iter::once(executable.as_str()))
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    Ok(ClaudeDisplayCommand {
        executable,
        args,
        command,
    })
}

pub fn claude_display_attached(runtime_directory: &Path, argv: &[String]) -> bool {
    let Ok(expected) = claude_display_command(runtime_directory) else {
        return false;
    };
    argv.len() == expected.args.len() + 1
        && argv[0] == expected.executable
        && argv[1..] == expected.args[..]
}

fn safe_terminal_text(text: &str) -> String {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    let ansi = ANSI.get_or_init(|| {
        Regex::new(r"[\x1b\x{9b}][\[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))").expect("valid regex")
    });
    ansi.replace_all(text, "")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|character| {
            !matches!(*character as u32, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f..=0x9f)
        })
        .collect()
}

fn truncate(text: String, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text;
    }
    format!(
        "{}\n[Output truncated]",
        text.chars().take(limit).collect::<String>()
    )
}

fn json_preview(value: Option<&Value>, limit: usize) -> String {
    match value {
        None => String::new(),
        Some(Value::String(text)) => truncate(safe_terminal_text(text), limit),
        Some(value) => truncate(
            safe_terminal_text(&crate::shared::js_json::stringify(value)),
            limit,
        ),
    }
}

fn result_preview(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => {
            truncate(safe_terminal_text(text), MAX_RESULT_PREVIEW_CHARACTERS)
        }
        Some(Value::Array(blocks)) => {
            let text = blocks
                .iter()
                .filter(|block| block["type"] == "text" && block["text"].is_string())
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() {
                json_preview(content, MAX_RESULT_PREVIEW_CHARACTERS)
            } else {
                truncate(safe_terminal_text(&text), MAX_RESULT_PREVIEW_CHARACTERS)
            }
        }
        _ => json_preview(content, MAX_RESULT_PREVIEW_CHARACTERS),
    }
}

fn write_line(output: &mut dyn Write, text: &str) -> io::Result<()> {
    let safe = safe_terminal_text(text);
    if safe.is_empty() {
        return Ok(());
    }
    output.write_all(safe.as_bytes())?;
    if !safe.ends_with('\n') {
        output.write_all(b"\n")?;
    }
    Ok(())
}

enum StreamBlock {
    Text {
        message_id: Option<String>,
        ends_with_newline: bool,
    },
    Tool {
        id: String,
        name: String,
        partial_input: String,
    },
}

#[derive(Default)]
struct TurnState {
    current_message_id: Option<String>,
    blocks: HashMap<u64, StreamBlock>,
    streamed_text_blocks: HashSet<String>,
    completed_entries: HashSet<String>,
    completed_block_offsets: HashMap<String, usize>,
    started_tools: HashMap<String, String>,
    displayed_tool_inputs: HashMap<String, String>,
    displayed_tool_results: HashSet<String>,
    wrote_assistant_text: bool,
    displayed_result: bool,
}

fn text_block_key(message_id: Option<&str>, index: u64) -> String {
    format!("{}:{index}", message_id.unwrap_or("unknown"))
}

fn non_empty(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

/// `tool_use` or `server_tool_use` with an id and a name.
fn rendered_tool(block: &Value) -> Option<(&str, &str)> {
    matches!(block["type"].as_str(), Some("tool_use" | "server_tool_use")).then_some(())?;
    Some((non_empty(&block["id"])?, non_empty(&block["name"])?))
}

impl TurnState {
    fn show_tool_start(
        &mut self,
        output: &mut dyn Write,
        id: &str,
        name: &str,
        input: Option<&Value>,
    ) -> io::Result<()> {
        if !self.started_tools.contains_key(id) {
            self.started_tools.insert(id.to_owned(), name.to_owned());
            write_line(output, &format!("[Tool: {name}]"))?;
        }
        let preview = json_preview(input, MAX_INPUT_PREVIEW_CHARACTERS);
        if !preview.is_empty()
            && preview != "{}"
            && self.displayed_tool_inputs.get(id) != Some(&preview)
        {
            write_line(output, &format!("[Tool input: {name}] {preview}"))?;
            self.displayed_tool_inputs.insert(id.to_owned(), preview);
        }
        Ok(())
    }

    fn render_stream_event(&mut self, output: &mut dyn Write, event: &Value) -> io::Result<()> {
        let index = event["index"].as_u64();
        match (event["type"].as_str(), index) {
            (Some("message_start"), _) if event["message"].is_object() => {
                self.current_message_id = non_empty(&event["message"]["id"]).map(str::to_owned);
                self.blocks.clear();
            }
            (Some("content_block_start"), Some(index)) => {
                let block = &event["content_block"];
                if block["type"] == "text"
                    && let Some(text) = block["text"].as_str()
                {
                    self.blocks.insert(
                        index,
                        StreamBlock::Text {
                            message_id: self.current_message_id.clone(),
                            ends_with_newline: text.ends_with('\n'),
                        },
                    );
                    if !text.is_empty() {
                        self.streamed_text_blocks
                            .insert(text_block_key(self.current_message_id.as_deref(), index));
                        output.write_all(safe_terminal_text(text).as_bytes())?;
                        self.wrote_assistant_text = true;
                    }
                } else if let Some((id, name)) = rendered_tool(block) {
                    self.blocks.insert(
                        index,
                        StreamBlock::Tool {
                            id: id.to_owned(),
                            name: name.to_owned(),
                            partial_input: String::new(),
                        },
                    );
                    self.show_tool_start(output, id, name, block.get("input"))?;
                }
            }
            (Some("content_block_delta"), Some(index)) => {
                let delta = &event["delta"];
                match (self.blocks.get_mut(&index), delta["type"].as_str()) {
                    (
                        Some(StreamBlock::Text {
                            message_id,
                            ends_with_newline,
                        }),
                        Some("text_delta"),
                    ) if delta["text"].is_string() => {
                        let text = delta["text"].as_str().unwrap_or_default();
                        output.write_all(safe_terminal_text(text).as_bytes())?;
                        if !text.is_empty() {
                            *ends_with_newline = text.ends_with('\n');
                        }
                        let key = text_block_key(message_id.as_deref(), index);
                        self.streamed_text_blocks.insert(key);
                        self.wrote_assistant_text = true;
                    }
                    (Some(StreamBlock::Tool { partial_input, .. }), Some("input_json_delta"))
                        if partial_input.chars().count() < MAX_PARTIAL_TOOL_INPUT_CHARACTERS =>
                    {
                        let available =
                            MAX_PARTIAL_TOOL_INPUT_CHARACTERS - partial_input.chars().count();
                        partial_input.extend(
                            delta["partial_json"]
                                .as_str()
                                .unwrap_or_default()
                                .chars()
                                .take(available),
                        );
                    }
                    _ => {}
                }
            }
            (Some("content_block_stop"), Some(index)) => match self.blocks.get(&index) {
                Some(StreamBlock::Text {
                    ends_with_newline: false,
                    ..
                }) => {
                    output.write_all(b"\n")?;
                }
                Some(StreamBlock::Tool {
                    id,
                    name,
                    partial_input,
                }) if !partial_input.is_empty() => {
                    let input = serde_json::from_str::<Value>(partial_input)
                        .unwrap_or_else(|_| Value::String(partial_input.clone()));
                    let preview = json_preview(Some(&input), MAX_INPUT_PREVIEW_CHARACTERS);
                    if !preview.is_empty() && self.displayed_tool_inputs.get(id) != Some(&preview) {
                        write_line(output, &format!("[Tool input: {name}] {preview}"))?;
                        self.displayed_tool_inputs.insert(id.clone(), preview);
                    }
                }
                _ => {}
            },
            _ => {}
        }
        Ok(())
    }

    fn render_completed(&mut self, output: &mut dyn Write, value: &Value) -> io::Result<()> {
        let uuid = value["uuid"].as_str().unwrap_or_default();
        if !self.completed_entries.insert(uuid.to_owned()) {
            return Ok(());
        }
        let message = &value["message"];
        let assistant = message["role"] == "assistant";
        let message_id = non_empty(&message["id"]);
        let blocks = match &message["content"] {
            Value::String(text) => {
                if assistant && !text.is_empty() {
                    write_line(output, text)?;
                    self.wrote_assistant_text = true;
                }
                return Ok(());
            }
            Value::Array(blocks) => blocks,
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => return Ok(()),
        };
        let message_key = message_id.unwrap_or(uuid).to_owned();
        let offset = self
            .completed_block_offsets
            .get(&message_key)
            .copied()
            .unwrap_or(0);
        for (index, block) in blocks.iter().enumerate() {
            let block_index = (offset + index) as u64;
            if block["type"] == "text"
                && let Some(text) = block["text"].as_str()
            {
                if assistant {
                    if !self
                        .streamed_text_blocks
                        .contains(&text_block_key(message_id, block_index))
                        && !text.is_empty()
                    {
                        write_line(output, text)?;
                    }
                    if !text.is_empty() {
                        self.wrote_assistant_text = true;
                    }
                }
                continue;
            }
            if let Some((id, name)) = rendered_tool(block) {
                self.show_tool_start(output, id, name, block.get("input"))?;
                continue;
            }
            let result = matches!(
                block["type"].as_str(),
                Some("tool_result" | "web_search_tool_result" | "web_fetch_tool_result")
            );
            let Some(tool_use_id) = non_empty(&block["tool_use_id"]).filter(|_| result) else {
                continue;
            };
            if block["type"] == "tool_result"
                && !block["is_error"].is_null()
                && !block["is_error"].is_boolean()
            {
                continue;
            }
            if !self.displayed_tool_results.insert(tool_use_id.to_owned()) {
                continue;
            }
            let name = self
                .started_tools
                .get(tool_use_id)
                .map_or("tool", String::as_str);
            let preview = result_preview(block.get("content"));
            let label = if block["is_error"] == true {
                "Error"
            } else {
                "Result"
            };
            let suffix = if preview.is_empty() {
                String::new()
            } else {
                format!("\n{preview}")
            };
            write_line(output, &format!("[{label}: {name}]{suffix}"))?;
        }
        self.completed_block_offsets
            .insert(message_key, offset + blocks.len());
        Ok(())
    }

    fn render(&mut self, output: &mut dyn Write, value: &Value) -> io::Result<bool> {
        if value["type"] == "stream_event" && value.get("event").is_some() {
            self.render_stream_event(output, &value["event"])?;
            return Ok(true);
        }
        let completed = matches!(value["type"].as_str(), Some("assistant" | "user"))
            && non_empty(&value["uuid"]).is_some()
            && matches!(
                value["message"]["role"].as_str(),
                Some("assistant" | "user")
            )
            && (value["message"]["content"].is_string() || value["message"]["content"].is_array());
        if completed {
            self.render_completed(output, value)?;
            return Ok(true);
        }
        let result = value["type"] == "result"
            && non_empty(&value["subtype"]).is_some()
            && value["is_error"].is_boolean();
        if !result || self.displayed_result {
            return Ok(false);
        }
        self.displayed_result = true;
        let text = value["result"].as_str().unwrap_or_default();
        let error = value["is_error"] == true;
        if text.is_empty() || (!error && self.wrote_assistant_text) {
            return Ok(true);
        }
        write_line(
            output,
            &format!("{}{text}", if error { "[Claude error]\n" } else { "" }),
        )?;
        Ok(true)
    }
}

#[derive(Default)]
struct Cursor {
    offset: u64,
    pending: Vec<u8>,
    dropping_oversized_line: bool,
    wrote_stderr_label: bool,
}

struct OutputFile {
    path: PathBuf,
    turn: String,
    jsonl: bool,
    size: u64,
}

fn output_files(runtime_directory: &Path) -> io::Result<Vec<OutputFile>> {
    let entries = match fs::read_dir(runtime_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let (turn, jsonl) = if let Some(turn) = name.strip_suffix(".jsonl") {
            (turn, true)
        } else if let Some(turn) = name.strip_suffix(".stderr.log") {
            (turn, false)
        } else {
            continue;
        };
        if turn.len() <= "turn-".len() || !turn.starts_with("turn-") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let created = metadata
            .created()
            .or_else(|_| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        files.push((
            created,
            name.clone(),
            OutputFile {
                path: entry.path(),
                turn: turn.to_owned(),
                jsonl,
                size: metadata.len(),
            },
        ));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(files.into_iter().map(|(_, _, file)| file).collect())
}

/// Follows turn output across scans; each scan writes only new records.
#[derive(Default)]
pub struct ClaudeDisplay {
    cursors: HashMap<PathBuf, Cursor>,
    turns: HashMap<String, TurnState>,
}

impl ClaudeDisplay {
    /// Render appended output. Returns whether anything was written.
    pub fn scan(&mut self, runtime_directory: &Path, output: &mut dyn Write) -> io::Result<bool> {
        let mut wrote = false;
        for file in output_files(runtime_directory)? {
            let cursor = self.cursors.entry(file.path.clone()).or_default();
            let current = match fs::metadata(&file.path) {
                Ok(metadata) => metadata.len(),
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if current < cursor.offset {
                *cursor = Cursor::default();
            }
            let end = current.min(file.size);
            while cursor.offset < end {
                let mut handle = match File::open(&file.path) {
                    Ok(handle) => handle,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                    Err(error) => return Err(error),
                };
                handle.seek(SeekFrom::Start(cursor.offset))?;
                let mut chunk = Vec::new();
                handle
                    .take(READ_CHUNK_BYTES.min(end - cursor.offset))
                    .read_to_end(&mut chunk)?;
                if chunk.is_empty() {
                    break;
                }
                cursor.offset += chunk.len() as u64;
                if !file.jsonl {
                    cursor.pending.extend(chunk);
                    let valid = match std::str::from_utf8(&cursor.pending) {
                        Ok(text) => text.len(),
                        Err(error) if error.error_len().is_none() => error.valid_up_to(),
                        Err(_) => cursor.pending.len(),
                    };
                    let text = String::from_utf8_lossy(&cursor.pending[..valid]).into_owned();
                    cursor.pending.drain(..valid);
                    let safe = safe_terminal_text(&text);
                    if safe.is_empty() {
                        continue;
                    }
                    if !cursor.wrote_stderr_label {
                        output.write_all(b"[Claude stderr]\n")?;
                        cursor.wrote_stderr_label = true;
                    }
                    output.write_all(safe.as_bytes())?;
                    wrote = true;
                    continue;
                }
                let state = self.turns.entry(file.turn.clone()).or_default();
                let mut remaining = chunk.as_slice();
                while let Some(newline) = remaining.iter().position(|byte| *byte == b'\n') {
                    let segment = &remaining[..newline];
                    remaining = &remaining[newline + 1..];
                    if cursor.dropping_oversized_line {
                        cursor.dropping_oversized_line = false;
                        cursor.pending.clear();
                        continue;
                    }
                    cursor.pending.extend_from_slice(segment);
                    let line = std::mem::take(&mut cursor.pending);
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    if line.len() > MAX_JSON_RECORD_BYTES {
                        write_line(output, "Suplex omitted a Claude record larger than 8 MiB.")?;
                        wrote = true;
                        continue;
                    }
                    if let Ok(value) = serde_json::from_slice::<Value>(&line)
                        && state.render(output, &value)?
                    {
                        wrote = true;
                    }
                }
                if !cursor.dropping_oversized_line {
                    cursor.pending.extend_from_slice(remaining);
                    if cursor.pending.len() > MAX_JSON_RECORD_BYTES {
                        cursor.pending.clear();
                        cursor.dropping_oversized_line = true;
                        write_line(output, "Suplex omitted a Claude record larger than 8 MiB.")?;
                        wrote = true;
                    }
                }
            }
        }
        Ok(wrote)
    }
}

/// TypeScript `runClaudeDisplay`: follow the runtime directory until killed
/// or until the directory is removed.
pub fn run_claude_display(runtime_directory: &Path) -> io::Result<()> {
    if !runtime_directory.is_absolute() {
        return Err(io::Error::other("A private runtime directory is necessary"));
    }
    let mut display = ClaudeDisplay::default();
    let mut output = io::stdout();
    if !display.scan(runtime_directory, &mut output)? {
        output.write_all(WAITING_LABEL.as_bytes())?;
    }
    output.flush()?;
    let mut seen = false;
    loop {
        std::thread::sleep(Duration::from_millis(250));
        if crate::runtimes::task_display::runtime_removed(runtime_directory, &mut seen) {
            return Ok(());
        }
        display.scan(runtime_directory, &mut output)?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_display_ends_when_its_runtime_directory_is_removed() {
        let directory = runtime();
        let runner = {
            let directory = directory.clone();
            std::thread::spawn(move || run_claude_display(&directory))
        };
        std::thread::sleep(Duration::from_millis(300));
        fs::remove_dir_all(&directory).unwrap();
        for _ in 0..100 {
            if runner.is_finished() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            runner.is_finished(),
            "the display outlived its runtime directory"
        );
        runner.join().unwrap().unwrap();
    }

    fn runtime() -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("suplex-claude-display-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn lines(values: &[Value]) -> String {
        values.iter().map(|value| format!("{value}\n")).collect()
    }

    fn scan(display: &mut ClaudeDisplay, directory: &Path, output: &mut Vec<u8>) -> String {
        display.scan(directory, output).unwrap();
        String::from_utf8(output.clone()).unwrap()
    }

    #[test]
    fn the_display_command_clears_bridge_credentials_and_matches_only_its_runtime_directory() {
        let (first, second) = (runtime(), runtime());
        let display = claude_display_command(&first).unwrap();
        for key in [
            ROOT_BINDING_ENV,
            ROOT_TOKEN_ENV,
            ADVISOR_BINDING_ENV,
            ADVISOR_TOKEN_ENV,
            ADVISOR_RESULT_ENV,
        ] {
            assert!(display.command.contains(&format!("'-u' '{key}'")));
        }
        assert!(!display.command.contains("claude --resume"));
        let argv = std::iter::once(display.executable.clone())
            .chain(display.args.clone())
            .collect::<Vec<_>>();
        assert!(claude_display_attached(&first, &argv));
        assert!(!claude_display_attached(&second, &argv));
        assert!(!claude_display_attached(
            &first,
            &[argv.clone(), vec!["extra".into()]].concat()
        ));
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn the_display_catches_up_turns_follows_later_turns_and_renders_tools_without_duplicate_text() {
        let directory = runtime();
        fs::write(directory.join("turn-1.jsonl"), lines(&[
            json!({"type":"assistant","uuid":"shared-thinking","message":{"id":"shared-message","role":"assistant","content":[{"type":"thinking","thinking":"hidden"}]}}),
            json!({"type":"assistant","uuid":"shared-tool","message":{"id":"shared-message","role":"assistant","content":[{"type":"tool_use","id":"shared-tool-id","name":"Glob","input":{"pattern":"src/**"}}]}}),
            json!({"type":"assistant","uuid":"legacy-a","message":{"id":"legacy-message","role":"assistant","content":[{"type":"text","text":"Legacy answer"},{"type":"tool_use","id":"legacy-tool","name":"Read","input":{"file_path":"/repo/id"}}]}}),
            json!({"type":"user","uuid":"legacy-u","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"legacy-tool","content":"abc\u{1b}[31m"}]}}),
        ])).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        fs::write(directory.join("turn-2.jsonl"), lines(&[json!({"type":"result","subtype":"error_max_turns","is_error":true,"result":"Second turn failed","session_id":"session"})])).unwrap();
        let (mut display, mut output) = (ClaudeDisplay::default(), Vec::new());
        let text = scan(&mut display, &directory, &mut output);
        assert!(text.find("Legacy answer").unwrap() < text.find("Second turn failed").unwrap());
        assert!(text.contains("[Tool: Glob]\n[Tool input: Glob] {\"pattern\":\"src/**\"}"));
        assert!(text.contains("[Tool: Read]\n[Tool input: Read] {\"file_path\":\"/repo/id\"}"));
        assert!(text.contains("[Result: Read]\nabc"));
        assert!(!text.contains("[31m") && !text.contains('\u{1b}'));
        fs::write(directory.join("turn-3.jsonl"), lines(&[
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"stream-message"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Live "}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"stream-tool","name":"Bash","input":{}}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"pnpm"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" test\"}"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_stop","index":1}}),
            json!({"type":"assistant","uuid":"stream-a","message":{"id":"stream-message","role":"assistant","content":[{"type":"text","text":"Live answer"},{"type":"tool_use","id":"stream-tool","name":"Bash","input":{"command":"pnpm test"}}]}}),
            json!({"type":"user","uuid":"stream-u","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"stream-tool","content":[{"type":"text","text":"Tests passed"}]}]}}),
            json!({"type":"result","subtype":"success","is_error":false,"result":"Live answer","session_id":"session"}),
        ])).unwrap();
        let text = scan(&mut display, &directory, &mut output);
        assert_eq!(text.matches("Live answer").count(), 1);
        assert_eq!(text.matches("[Tool: Bash]").count(), 1);
        assert!(text.contains("Live answer\n[Tool: Bash]"));
        assert!(text.contains("[Tool input: Bash] {\"command\":\"pnpm test\"}"));
        assert!(text.contains("[Result: Bash]\nTests passed"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn the_display_keeps_partial_json_and_utf8_across_reads_and_recovers_after_oversized_records() {
        use std::fs::OpenOptions;
        let directory = runtime();
        let path = directory.join("turn-partial.jsonl");
        fs::write(&path, "").unwrap();
        let append = |bytes: &[u8]| {
            OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(bytes)
                .unwrap();
        };
        let (mut display, mut output) = (ClaudeDisplay::default(), Vec::new());
        assert!(!display.scan(&directory, &mut output).unwrap());
        let event = format!(
            "{}\n",
            json!({"type":"assistant","uuid":"utf8-a","message":{"id":"utf8-message","role":"assistant","content":[{"type":"text","text":"split 🥔"}]}})
        );
        let split = event.find('🥔').unwrap() + 1;
        append(&event.as_bytes()[..split]);
        assert!(!scan(&mut display, &directory, &mut output).contains("split"));
        append(&event.as_bytes()[split..]);
        assert!(scan(&mut display, &directory, &mut output).contains("split 🥔"));
        append(format!("{}\nnot json\n", json!({"type":"assistant","uuid":"oversized-a","message":{"id":"oversized-message","role":"assistant","content":[{"type":"text","text":"x".repeat(8 * 1024 * 1024)}]}})).as_bytes());
        append(format!("{}\n", json!({"type":"assistant","uuid":"recovered-a","message":{"id":"recovered-message","role":"assistant","content":[{"type":"text","text":"Recovered"}]}})).as_bytes());
        let mut text = String::new();
        for _ in 0..400 {
            text = scan(&mut display, &directory, &mut output);
            if text.contains("Recovered") {
                break;
            }
        }
        assert!(text.contains("Recovered"));
        assert!(text.contains("Suplex omitted a Claude record larger than 8 MiB."));
        assert!(!text.contains(&"x".repeat(100)));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn the_display_truncates_large_results_renders_web_search_and_drains_older_turns_first() {
        let directory = runtime();
        fs::write(directory.join("turn-old.jsonl"), lines(&[
            json!({"type":"assistant","uuid":"large-tool","message":{"id":"large-message","role":"assistant","content":[{"type":"tool_use","id":"large-read","name":"Read","input":{"file_path":"/repo/large.log"}}]}}),
            json!({"type":"user","uuid":"large-result","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"large-read","content":format!("result-start {} result-end", "z".repeat(300 * 1024))}]}}),
            json!({"type":"assistant","uuid":"web","message":{"id":"web-message","role":"assistant","content":[
                {"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"Claude Shannon birth date"}},
                {"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","url":"https://example.com/shannon","title":"Claude Shannon","encrypted_content":"opaque"}]},
            ]}}),
            json!({"type":"assistant","uuid":"old-tail","message":{"id":"old-tail-message","role":"assistant","content":[{"type":"text","text":"OLD TAIL"}]}}),
        ])).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        fs::write(directory.join("turn-new.jsonl"), lines(&[json!({"type":"assistant","uuid":"new","message":{"id":"new-message","role":"assistant","content":[{"type":"text","text":"NEW REPLY"}]}})])).unwrap();
        let (mut display, mut output) = (ClaudeDisplay::default(), Vec::new());
        let text = scan(&mut display, &directory, &mut output);
        assert!(text.contains("[Result: Read]\nresult-start"));
        assert!(text.contains("[Output truncated]"));
        assert!(!text.contains("result-end") && !text.contains("Suplex omitted"));
        assert!(text.contains("[Tool: web_search]"));
        assert!(
            text.contains("[Tool input: web_search] {\"query\":\"Claude Shannon birth date\"}")
        );
        assert!(text.contains("[Result: web_search]"));
        assert!(text.contains("https://example.com/shannon"));
        assert!(text.find("OLD TAIL").unwrap() < text.find("NEW REPLY").unwrap());
        fs::remove_dir_all(directory).unwrap();
    }
}
