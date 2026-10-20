//! TypeScript `ClaudeCodeSessionReader`.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::{live_history, task_runtime::ClaudeCodeTaskRuntime, transcript};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        headless::busy,
        native::{NativeReasoning, NativeTool},
        task_harness::{
            HarnessFuture, NativeSessionReader, NativeStatus, NativeTimeline, ReaderSession,
            UsageEntry, modified_ms,
        },
    },
};

/// Locally created provider instance homes (TypeScript `providerInstanceDirectories`).
fn provider_instance_directories(database_path: &Path) -> io::Result<Vec<PathBuf>> {
    let root = database_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("provider-instances");
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut directories = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            directories.push(entry.path());
        }
    }
    directories.sort();
    Ok(directories)
}

/// The session transcript in its profile instance, the default config
/// directory, or, without a profile instance, any local provider instance.
fn transcript_path(session: &ReaderSession<'_>) -> io::Result<Option<PathBuf>> {
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    let directory = session.instance_home_directory.map_or_else(
        || transcript::config_directory(&environment),
        Path::to_path_buf,
    );
    if let Some(path) = transcript::find_transcript(session.native_session_id, &directory)? {
        return Ok(Some(path));
    }
    if session.instance_home_directory.is_some() {
        return Ok(None);
    }
    for directory in provider_instance_directories(session.database_path)? {
        if let Some(path) = transcript::find_transcript(session.native_session_id, &directory)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn entries(session: &ReaderSession<'_>) -> io::Result<Vec<transcript::ClaudeMessageEntry>> {
    let path = transcript_path(session)?
        .ok_or_else(|| io::Error::other("Claude Code session transcript is not available"))?;
    Ok(transcript::message_entries(&transcript::parse_json_lines(
        &fs::read_to_string(path)?,
    )))
}

impl NativeSessionReader for ClaudeCodeTaskRuntime {
    fn history<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<Value>>> {
        Box::pin(async move {
            live_history::read(
                &session.runtime_directory()?,
                transcript_path(session)?.as_deref(),
            )
        })
    }

    fn execution<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<(Vec<NativeTool>, Value)>> {
        Box::pin(async move { Ok(transcript::execution(&entries(session)?)) })
    }

    fn reasoning<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<NativeReasoning>>> {
        Box::pin(async move {
            Ok(entries(session)?
                .into_iter()
                .filter(|entry| entry.kind == "assistant" && !entry.is_sidechain)
                .flat_map(|entry| {
                    let blocks = transcript::blocks(&entry);
                    let id = entry.uuid;
                    blocks
                        .into_iter()
                        .enumerate()
                        .filter_map(move |(index, block)| match block {
                            transcript::Block::Thinking(text) if !text.trim().is_empty() => {
                                Some(NativeReasoning {
                                    id: format!("{id}:{index}"),
                                    text,
                                })
                            }
                            transcript::Block::ToolUse { .. }
                            | transcript::Block::ToolResult { .. }
                            | transcript::Block::Text(_)
                            | transcript::Block::Thinking(_)
                            | transcript::Block::Other => None,
                        })
                })
                .collect())
        })
    }

    fn turn_evidence<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        turn_id: &'a str,
    ) -> HarnessFuture<'a, io::Result<Option<Vec<NativeTool>>>> {
        Box::pin(async move {
            if turn_id.is_empty()
                || !turn_id.as_bytes()[0].is_ascii_alphanumeric()
                || !turn_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Invalid task turn identity",
                ));
            }
            match fs::read_to_string(
                session
                    .runtime_directory()?
                    .join(format!("turn-{turn_id}.jsonl")),
            ) {
                Ok(log) => Ok(Some(
                    transcript::execution(&transcript::message_entries(
                        &transcript::parse_json_lines(&log),
                    ))
                    .0,
                )),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error),
            }
        })
    }

    fn timeline<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        pricing: Option<&'a ModelPricingCatalog>,
    ) -> HarnessFuture<'a, io::Result<NativeTimeline>> {
        Box::pin(async move {
            let mut usage = transcript::usage_records(&entries(session)?, pricing)
                .into_iter()
                .map(|record| UsageEntry {
                    message_id: record.message_id,
                    turn_id: record.turn_id,
                    provider: "anthropic".to_owned(),
                    model: record.model,
                    started_at_ms: record.started_at_ms,
                    completed_at_ms: Some(record.started_at_ms),
                    failed: record.failed,
                    tokens: record.tokens,
                    cost_usd: record.cost_usd,
                    subsidized: record.cost_usd > 0.0,
                    summary: false,
                    steps: 1.0,
                    source: "message",
                })
                .collect::<Vec<_>>();
            let mut live_message_id = None;
            if self.busy(session).await?
                && let Some(live) = usage.last_mut()
            {
                live.completed_at_ms = None;
                live_message_id = Some(live.message_id.clone());
            }
            Ok(NativeTimeline {
                usage,
                live_message_id,
            })
        })
    }

    fn busy<'a>(&'a self, session: &'a ReaderSession<'_>) -> HarnessFuture<'a, io::Result<bool>> {
        Box::pin(async move { busy(&session.runtime_directory()?) })
    }

    fn status<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<NativeStatus>> {
        Box::pin(async move {
            let path = match transcript_path(session)? {
                Some(path) => path,
                None => session.runtime_directory()?.join("turn.json"),
            };
            let updated_at = modified_ms(&path)?;
            Ok(NativeStatus::new(
                if self.busy(session).await? {
                    "busy"
                } else {
                    "idle"
                },
                updated_at,
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn the_session_reader_discovers_a_local_instance_transcript_without_a_session_profile() {
        let root =
            std::env::temp_dir().join(format!("suplex-claude-reader-{}", uuid::Uuid::new_v4()));
        // A fresh identity cannot match a transcript in the user's own config.
        let session_id = &uuid::Uuid::new_v4().to_string();
        let local = root.join("provider-instances/instance/projects/worktree");
        fs::create_dir_all(&local).unwrap();
        fs::write(
            local.join(format!("{session_id}.jsonl")),
            json!({"type":"assistant","uuid":"message","timestamp":"2026-09-07T15:37:28.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Local transcript"}]}}).to_string(),
        )
        .unwrap();
        let database = root.join("suplex.sqlite");
        let session = ReaderSession {
            database_path: &database,
            session_id: "session-claude",
            native_session_id: session_id,
            instance_home_directory: None,
        };
        let reader = ClaudeCodeTaskRuntime;
        assert_eq!(
            reader.history(&session).await.unwrap()[0]["content"][0]["text"],
            "Local transcript"
        );
        assert!(reader.execution(&session).await.unwrap().0.is_empty());
        assert!(!reader.busy(&session).await.unwrap());
        assert!(
            reader
                .timeline(&session, None)
                .await
                .unwrap()
                .usage
                .is_empty()
        );
        let empty = root.join("empty-instance");
        let dedicated = ReaderSession {
            instance_home_directory: Some(&empty),
            ..session
        };
        assert!(
            reader
                .execution(&dedicated)
                .await
                .unwrap_err()
                .to_string()
                .contains("transcript is not available")
        );
        assert!(reader.history(&dedicated).await.unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn workflow_evidence_reads_only_the_requested_native_turn() {
        let root =
            std::env::temp_dir().join(format!("suplex-claude-evidence-{}", uuid::Uuid::new_v4()));
        let database = root.join("suplex.sqlite");
        let session = ReaderSession {
            database_path: &database,
            session_id: "session-claude",
            native_session_id: "71618050-0d31-428e-a547-d6c4a2eca88f",
            instance_home_directory: None,
        };
        let reader = ClaudeCodeTaskRuntime;
        assert!(
            reader
                .turn_evidence(&session, "msg_turn")
                .await
                .unwrap()
                .is_none()
        );
        let directory = session.runtime_directory().unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("turn-other.jsonl"), json!({"type":"assistant","uuid":"other","message":{"role":"assistant","content":[{"type":"tool_use","id":"other-tool","name":"Bash","input":{"command":"wrong turn"}}]}}).to_string()).unwrap();
        fs::write(
            directory.join("turn-msg_turn.jsonl"),
            [
                json!({"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"check","name":"Bash","input":{"command":"pnpm test"}}]}}),
                json!({"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"check","content":"Tests passed"}]}}),
            ]
            .map(|value| value.to_string())
            .join("\n"),
        )
        .unwrap();
        let tools = serde_json::to_value(
            reader
                .turn_evidence(&session, "msg_turn")
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            tools,
            json!([{"id":"check","name":"Bash","status":"completed","input":{"command":"pnpm test"},"output":"Tests passed","error":null}])
        );
        assert!(reader.turn_evidence(&session, "../x").await.is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
