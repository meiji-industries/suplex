//! TypeScript `ClaudeCodeSessionReader`.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::SystemTime,
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

/// Where `transcript_path` found each session's transcript, by the first
/// config directory, the database, and the native session id. A hint only:
/// the path is used while its file opens, and a missing file is searched for
/// again. One short entry for each session that has a transcript.
type Found = HashMap<(PathBuf, PathBuf, String), PathBuf>;
static FOUND: LazyLock<Mutex<Found>> = LazyLock::new(Mutex::default);

/// The session transcript in its profile instance, the default config
/// directory, or, without a profile instance, any local provider instance.
// The search opens a file in every project directory of each config
// directory, so a found transcript is searched for only once.
fn transcript_path(session: &ReaderSession<'_>) -> io::Result<Option<PathBuf>> {
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    let directory = session.instance_home_directory.map_or_else(
        || transcript::config_directory(&environment),
        Path::to_path_buf,
    );
    let key = (
        directory,
        session.database_path.to_owned(),
        session.native_session_id.to_owned(),
    );
    let found = FOUND
        .lock()
        .expect("transcript paths lock poisoned")
        .get(&key)
        .cloned();
    if let Some(path) = found
        && fs::File::open(&path).is_ok()
    {
        return Ok(Some(path));
    }
    let path = search(session, &key.0)?;
    let mut found = FOUND.lock().expect("transcript paths lock poisoned");
    match &path {
        Some(path) => found.insert(key, path.clone()),
        None => found.remove(&key),
    };
    Ok(path)
}

fn search(session: &ReaderSession<'_>, directory: &Path) -> io::Result<Option<PathBuf>> {
    if let Some(path) = transcript::find_transcript(session.native_session_id, directory)? {
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

/// The entries of one transcript, with the size and time of the file they
/// came from.
struct Parsed {
    path: PathBuf,
    stamp: (u64, SystemTime),
    entries: Arc<Vec<transcript::ClaudeMessageEntry>>,
}

/// The transcripts read last, oldest first. Their files hold at most
/// `PARSED_BYTES` in total, so the entries of the sessions of open and running
/// tasks stay and those of a pass over every stopped session do not.
static PARSED: Mutex<Vec<Parsed>> = Mutex::new(Vec::new());
const PARSED_BYTES: u64 = 32 * 1024 * 1024;

/// Adds `next` as the newest transcript and drops the oldest ones over `limit`.
fn keep(parsed: &mut Vec<Parsed>, next: Parsed, limit: u64) {
    parsed.retain(|kept| kept.path != next.path);
    parsed.push(next);
    while parsed.iter().map(|kept| kept.stamp.0).sum::<u64>() > limit {
        parsed.remove(0);
    }
}

/// The collector and the sync observer read each session again and again.
/// An unchanged transcript, by its size and modification time, is parsed once.
fn entries(session: &ReaderSession<'_>) -> io::Result<Arc<Vec<transcript::ClaudeMessageEntry>>> {
    let path = transcript_path(session)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Claude Code session transcript is not available",
        )
    })?;
    // The stamp is read before the text: a write between the two reads gives
    // newer entries under an older stamp, which the next read replaces.
    let metadata = fs::metadata(&path)?;
    let stamp = (metadata.len(), metadata.modified()?);
    let mut parsed = PARSED.lock().expect("parsed transcripts lock poisoned");
    if let Some(position) = parsed
        .iter()
        .position(|kept| kept.path == path && kept.stamp == stamp)
    {
        let kept = parsed.remove(position);
        let entries = kept.entries.clone();
        parsed.push(kept);
        return Ok(entries);
    }
    drop(parsed);
    let entries = Arc::new(transcript::text_entries(&fs::read_to_string(&path)?));
    keep(
        &mut PARSED.lock().expect("parsed transcripts lock poisoned"),
        Parsed {
            path,
            stamp,
            entries: entries.clone(),
        },
        PARSED_BYTES,
    );
    Ok(entries)
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
                .iter()
                .filter(|entry| entry.kind == "assistant" && !entry.is_sidechain)
                .flat_map(|entry| {
                    let blocks = transcript::blocks(entry);
                    let id = &entry.uuid;
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
                    transcript::execution(&transcript::text_entries(&log)).0,
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
                    generation_ms: record.generation_ms,
                    first_response_ms: record.first_response_ms,
                })
                .collect::<Vec<_>>();
            let mut live_message_id = None;
            if self.busy(session).await?
                && let Some(live) = usage.last_mut()
            {
                live.completed_at_ms = None;
                live.generation_ms = None;
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

    #[test]
    fn a_found_transcript_is_not_searched_for_again_until_its_file_is_gone() {
        let root =
            std::env::temp_dir().join(format!("suplex-claude-found-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let database = root.join("suplex.sqlite");
        let session = ReaderSession {
            database_path: &database,
            session_id: "session-claude",
            native_session_id: "abc",
            instance_home_directory: Some(&home),
        };
        // A session without a transcript is searched for on each read.
        assert_eq!(transcript_path(&session).unwrap(), None);
        let first = home.join("projects/-repo-b/abc.jsonl");
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        fs::write(&first, "").unwrap();
        assert_eq!(transcript_path(&session).unwrap(), Some(first.clone()));
        // No search: a new directory that sorts first does not change the answer.
        let second = home.join("projects/-repo-a/abc.jsonl");
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        fs::write(&second, "").unwrap();
        assert_eq!(transcript_path(&session).unwrap(), Some(first.clone()));
        // The found file is gone: search again.
        fs::remove_file(&first).unwrap();
        assert_eq!(transcript_path(&session).unwrap(), Some(second.clone()));
        fs::remove_file(&second).unwrap();
        assert_eq!(transcript_path(&session).unwrap(), None);
        // The same session id in another instance home is another transcript.
        let other = root.join("other");
        fs::create_dir_all(other.join("projects/-repo")).unwrap();
        fs::write(other.join("projects/-repo/abc.jsonl"), "").unwrap();
        fs::write(&first, "").unwrap();
        assert_eq!(transcript_path(&session).unwrap(), Some(first));
        assert_eq!(
            transcript_path(&ReaderSession {
                instance_home_directory: Some(&other),
                ..session
            })
            .unwrap(),
            Some(other.join("projects/-repo/abc.jsonl"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn an_unchanged_transcript_is_parsed_once_and_a_changed_one_again() {
        let root =
            std::env::temp_dir().join(format!("suplex-claude-parsed-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let path = home.join("projects/-repo/abc.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let tool = |id: &str| {
            json!({"type":"assistant","uuid":id,"message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":"Bash","input":{}}]}}).to_string()
        };
        fs::write(&path, tool("first")).unwrap();
        let database = root.join("suplex.sqlite");
        let session = ReaderSession {
            database_path: &database,
            session_id: "session-claude",
            native_session_id: "abc",
            instance_home_directory: Some(&home),
        };
        let reader = ClaudeCodeTaskRuntime;
        let ids =
            |tools: Vec<NativeTool>| tools.into_iter().map(|tool| tool.id).collect::<Vec<_>>();
        let first = entries(&session).unwrap();
        assert!(Arc::ptr_eq(&first, &entries(&session).unwrap()));
        assert_eq!(ids(reader.execution(&session).await.unwrap().0), ["first"]);
        // Claude Code appends to the transcript.
        fs::write(&path, format!("{}\n{}", tool("first"), tool("second"))).unwrap();
        assert_eq!(
            ids(reader.execution(&session).await.unwrap().0),
            ["first", "second"]
        );
        // Another file of the same size replaces the transcript.
        let stamp = fs::metadata(&path).unwrap().modified().unwrap();
        let replaced = root.join("replaced.jsonl");
        fs::write(&replaced, format!("{}\n{}", tool("third"), tool("fourth"))).unwrap();
        fs::File::options()
            .write(true)
            .open(&replaced)
            .unwrap()
            .set_modified(stamp + std::time::Duration::from_secs(1))
            .unwrap();
        fs::rename(&replaced, &path).unwrap();
        assert_eq!(
            ids(reader.execution(&session).await.unwrap().0),
            ["third", "fourth"]
        );
        fs::remove_file(&path).unwrap();
        assert!(reader.execution(&session).await.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_oldest_parsed_transcripts_are_dropped_over_the_size_limit() {
        let parsed = |name: &str, bytes: u64| Parsed {
            path: PathBuf::from(name),
            stamp: (bytes, SystemTime::UNIX_EPOCH),
            entries: Arc::default(),
        };
        let mut kept = Vec::new();
        let mut paths = |next: Parsed| {
            keep(&mut kept, next, 10);
            kept.iter()
                .map(|kept| kept.path.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(parsed("a", 4)), ["a"]);
        assert_eq!(paths(parsed("b", 4)), ["a", "b"]);
        // The same transcript again replaces its entry.
        assert_eq!(paths(parsed("a", 5)), ["b", "a"]);
        assert_eq!(paths(parsed("c", 4)), ["a", "c"]);
        // A transcript over the limit is not kept.
        assert!(paths(parsed("d", 11)).is_empty());
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
