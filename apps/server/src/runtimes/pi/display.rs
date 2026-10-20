//! Passive Pi display. The Herdr pane runs `suplex pi-display <dir>`, which
//! follows the turn output files in the private runtime directory with the
//! Codex display loop. It never owns or replays the native turn.

use std::{error::Error, io, path::Path};

use serde_json::Value;

use super::transcript;
use crate::runtimes::codex::display::{self as follower, DisplayCommand};

const WAITING_LABEL: &str = "Waiting for Pi output...\n";
pub const SUBCOMMAND: &str = "pi-display";

pub fn display_command(runtime_directory: &Path) -> io::Result<DisplayCommand> {
    follower::command_for(SUBCOMMAND, runtime_directory)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn indented(text: &str) -> String {
    format!(
        "{}\n",
        text.split('\n')
            .map(|line| format!("  · {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

/// One line per completed response block, tool start, failure, and turn end.
pub fn render_event(event: &Value) -> String {
    match text(event, "type").unwrap_or_default() {
        "agent_settled" => "\n".into(),
        "auto_retry_start" => format!(
            "retry: {}\n",
            text(event, "errorMessage").unwrap_or_default()
        ),
        "tool_execution_start" => match text(event, "toolName") {
            Some("bash") => event["args"]["command"]
                .as_str()
                .map_or_else(|| "$ bash\n".into(), |command| format!("$ {command}\n")),
            Some(name @ ("edit" | "write")) => event["args"]["path"]
                .as_str()
                .map_or_else(String::new, |path| format!("{name} {path}\n")),
            Some(name) => format!("tool {name}\n"),
            None => String::new(),
        },
        "tool_execution_end" if event["isError"] == true => format!(
            "error: {}\n",
            super::tool_evidence::result_text(&event["result"])
                .unwrap_or_default()
                .trim()
        ),
        "message_end" if event["message"]["role"] == "assistant" => {
            let message = &event["message"];
            let mut rendered = String::new();
            for block in message["content"].as_array().into_iter().flatten() {
                match (
                    text(block, "type"),
                    text(block, "thinking"),
                    text(block, "text"),
                ) {
                    (Some("thinking"), Some(thinking), _) if !thinking.trim().is_empty() => {
                        rendered.push_str(&indented(thinking));
                    }
                    (Some("text"), _, Some(text)) if !text.is_empty() => {
                        rendered.push_str(text);
                        rendered.push('\n');
                    }
                    _ => {}
                }
            }
            if message["stopReason"] == "error" {
                rendered.push_str(&format!(
                    "error: {}\n",
                    text(message, "errorMessage").unwrap_or("Pi reported an error")
                ));
            }
            rendered
        }
        _ => String::new(),
    }
}

fn render_line(line: &str) -> Option<String> {
    transcript::parse_events(line)
        .first()
        .map(|event| render_event(event.value()))
}

/// Entry point for `suplex pi-display <runtime directory>`.
pub async fn serve(runtime_directory: &str) -> Result<(), Box<dyn Error + Send + Sync>> {
    follower::serve_with(runtime_directory, WAITING_LABEL, render_line).await
}

/// Dispatch shows the session in Herdr first. The display is an observation;
/// its failure never blocks native work.
pub fn show(database_path: &Path, session: &str, native: &str, worktree: &Path, model: &str) {
    follower::show_with(
        ("pi", SUBCOMMAND),
        database_path,
        session,
        native,
        worktree,
        model,
    );
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn renders_pi_events_for_the_passive_display() {
        let cases = [
            (
                json!({"type":"tool_execution_start","toolCallId":"c","toolName":"bash","args":{"command":"pnpm test"}}),
                "$ pnpm test\n",
            ),
            (
                json!({"type":"tool_execution_start","toolCallId":"c","toolName":"edit","args":{"path":"a.rs"}}),
                "edit a.rs\n",
            ),
            (
                json!({"type":"tool_execution_start","toolCallId":"c","toolName":"mcp__suplex_root__observe","args":{}}),
                "tool mcp__suplex_root__observe\n",
            ),
            (
                json!({"type":"tool_execution_end","toolCallId":"c","toolName":"bash","result":{"content":[{"type":"text","text":"exit 2\n"}]},"isError":true}),
                "error: exit 2\n",
            ),
            (
                json!({"type":"tool_execution_end","toolCallId":"c","toolName":"bash","result":{"content":[]},"isError":false}),
                "",
            ),
            (
                json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"a\nb"},{"type":"text","text":"Reviewed. 界"}],"stopReason":"stop"}}),
                "  · a\n  · b\nReviewed. 界\n",
            ),
            (
                json!({"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Connection error."}}),
                "error: Connection error.\n",
            ),
            (
                json!({"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Prompt"}]}}),
                "",
            ),
            (
                json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"x"}}),
                "",
            ),
            (json!({"type":"agent_settled","aborted":false}), "\n"),
            (json!({"type":"session","id":"pi-1"}), ""),
        ];
        for (event, expected) in cases {
            assert_eq!(render_event(&event), expected, "{event}");
        }
    }

    #[test]
    fn the_display_command_runs_the_pi_viewer_for_its_directory() {
        let display = display_command(Path::new("/private/runtime/session")).unwrap();
        assert!(display.command.contains("'-u' 'SUPLEX_ROOT_TOKEN'"));
        assert!(
            display
                .command
                .ends_with("'pi-display' '/private/runtime/session'")
        );
        assert_eq!(render_line("not json"), None);
    }
}
