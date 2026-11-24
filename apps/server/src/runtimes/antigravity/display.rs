//! Passive Antigravity display. The Herdr pane runs
//! `suplex antigravity-display <dir>`, which follows the turn logs in the
//! private runtime directory with the Codex display loop. It never owns or
//! replays the native turn.

use std::{error::Error, io, path::Path};

use serde_json::Value;

use super::cli;
use crate::runtimes::codex::display::{self as follower, DisplayCommand};

pub fn display_command(runtime_directory: &Path) -> io::Result<DisplayCommand> {
    follower::command_for(cli::DISPLAY_SUBCOMMAND, runtime_directory)
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

/// One line per finished text run, tool start, failure, and turn end.
pub fn render_event(event: &Value) -> String {
    let text = |key: &str| event[key].as_str().unwrap_or_default();
    match text("type") {
        "message" if !text("text").is_empty() => format!("{}\n", text("text")),
        "thought" if !text("text").trim().is_empty() => indented(text("text")),
        "update" => {
            let update = &event["update"];
            if update["sessionUpdate"] != "tool_call" {
                return String::new();
            }
            let input = &update["rawInput"];
            if let (Some(server), Some(tool)) =
                (input["ServerName"].as_str(), input["ToolName"].as_str())
            {
                return format!("tool mcp__{server}__{tool}\n");
            }
            let command = ["CommandLine", "command", "commandLine", "command_line"]
                .iter()
                .find_map(|key| input[*key].as_str());
            let path = update["locations"][0]["path"].as_str();
            match (update["kind"].as_str(), command, path) {
                (Some("execute"), Some(command), _) => format!("$ {command}\n"),
                (Some(kind @ ("edit" | "delete" | "move")), _, Some(path)) => {
                    format!("{kind} {path}\n")
                }
                _ => update["title"]
                    .as_str()
                    .map_or_else(String::new, |title| format!("tool {title}\n")),
            }
        }
        "warning" => format!("warning: {}\n", text("message")),
        "error" => format!("error: {}\n", text("message")),
        "resume_failed" => format!(
            "Antigravity could not resume its session and started a new one: {}\n",
            text("message")
        ),
        "prompt_result" => "\n".into(),
        _ => String::new(),
    }
}

fn render_line(line: &str) -> Option<String> {
    super::transcript::parse_events(line)
        .first()
        .map(render_event)
}

/// Entry point for `suplex antigravity-display <runtime directory>`.
pub async fn serve(runtime_directory: &str) -> Result<(), Box<dyn Error + Send + Sync>> {
    follower::serve_with(runtime_directory, cli::WAITING_LABEL, render_line).await
}

/// Dispatch shows the session in Herdr first. The display is an observation;
/// its failure never blocks native work.
pub fn show(database_path: &Path, session: &str, native: &str, worktree: &Path, model: &str) {
    follower::show_with(
        (cli::PROVIDER, cli::DISPLAY_SUBCOMMAND),
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
    fn renders_turn_log_events_for_the_passive_display() {
        let cases = [
            (json!({"type":"message","text":"Done."}), "Done.\n"),
            (json!({"type":"thought","text":"a\nb"}), "  · a\n  · b\n"),
            (
                json!({"type":"update","update":{"sessionUpdate":"tool_call","toolCallId":"c","kind":"execute","title":"Run","rawInput":{"CommandLine":"pnpm test"}}}),
                "$ pnpm test\n",
            ),
            (
                json!({"type":"update","update":{"sessionUpdate":"tool_call","toolCallId":"c","kind":"edit","title":"Edit","locations":[{"path":"a.rs"}]}}),
                "edit a.rs\n",
            ),
            (
                json!({"type":"update","update":{"sessionUpdate":"tool_call","toolCallId":"c","kind":"other","rawInput":{"ServerName":"suplex_root","ToolName":"observe"}}}),
                "tool mcp__suplex_root__observe\n",
            ),
            (
                json!({"type":"update","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}),
                "",
            ),
            (
                json!({"type":"error","message":"Antigravity is not signed in."}),
                "error: Antigravity is not signed in.\n",
            ),
            (
                json!({"type":"prompt_result","stopReason":"end_turn"}),
                "\n",
            ),
            (json!({"type":"session","sessionId":"s"}), ""),
        ];
        for (event, expected) in cases {
            assert_eq!(render_event(&event), expected, "{event}");
        }
        assert_eq!(render_line("not json"), None);
    }

    #[test]
    fn the_display_command_runs_the_viewer_for_its_directory() {
        let display = display_command(Path::new("/private/runtime/session")).unwrap();
        assert!(display.command.contains("'-u' 'SUPLEX_ROOT_TOKEN'"));
        assert!(
            display
                .command
                .ends_with("'antigravity-display' '/private/runtime/session'")
        );
    }
}
