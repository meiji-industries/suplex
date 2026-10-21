use crate::runtimes::native::SessionRef;
use crate::runtimes::native::{NativeReasoning, NativeTool};
// TypeScript `CodexTaskRuntime` behind the shared task harness seam.

use std::{error::Error, io, path::Path, time::UNIX_EPOCH};

use serde_json::{Value, json};

use super::{
    runtime, session_reader,
    task_runtime::{self, RootCodexLaunch, WorkerCodexLaunch},
    tool_evidence::codex_tools,
    transcript, usage,
};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        headless,
        task_harness::{
            DispatchClaim, DispatchState, HarnessFuture, NativeSessionReader, NativeTimeline,
            PromptObservation, ReaderSession, TaskHarness, TaskRole, TaskScope, UsageEntry,
            recover_headless_dispatch,
        },
    },
};

pub struct CodexTaskRuntime;

/// TypeScript `CodexSessionReader`: every turn log in the session runtime.
impl NativeSessionReader for CodexTaskRuntime {
    fn history<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<Value>>> {
        Box::pin(async move {
            let turns = session_reader::turns(&session.runtime_directory()?)?;
            Ok(turns
                .into_iter()
                .filter_map(|turn| {
                    let text = transcript::result_text(&turn.events);
                    let mut content: Vec<Value> = Vec::new();
                    for event in &turn.events {
                        if !matches!(
                            event.kind(),
                            "item.started" | "item.updated" | "item.completed"
                        ) {
                            continue;
                        }
                        let Some(item) = event.value().get("item") else {
                            continue;
                        };
                        if item["type"] != "reasoning" {
                            continue;
                        }
                        let (Some(id), Some(reasoning)) =
                            (item["id"].as_str(), item["text"].as_str())
                        else {
                            continue;
                        };
                        if reasoning.trim().is_empty() {
                            continue;
                        }
                        let id = format!("{}:{id}", turn.id);
                        if let Some(part) = content.iter_mut().find(|part| part["id"] == id) {
                            part["text"] = json!(reasoning);
                        } else {
                            content.push(json!({"id":id,"type":"reasoning","text":reasoning}));
                        }
                    }
                    if !text.is_empty() {
                        content.push(
                            json!({"id":format!("{}:text",turn.id),"type":"text","text":text}),
                        );
                    }
                    if content.is_empty() {
                        return None;
                    }
                    let created_at: i64 = turn
                        .updated_at
                        .duration_since(UNIX_EPOCH)
                        .ok()?
                        .as_millis()
                        .try_into()
                        .ok()?;
                    Some(json!({
                        "id":turn.id,"role":"assistant","createdAt":created_at,
                        "content":content,
                    }))
                })
                .collect())
        })
    }

    fn execution<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<(Vec<NativeTool>, Value)>> {
        Box::pin(async move {
            let turns = session_reader::turns(&session.runtime_directory()?)?;
            let tools = turns
                .iter()
                .flat_map(|turn| {
                    codex_tools(&turn.events).into_iter().map(move |mut tool| {
                        tool.id = format!("{}:{}", turn.id, tool.id);
                        tool
                    })
                })
                .collect();
            Ok((tools, Value::Null))
        })
    }

    fn reasoning<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<NativeReasoning>>> {
        Box::pin(async move {
            let mut parts: Vec<NativeReasoning> = Vec::new();
            for turn in session_reader::turns(&session.runtime_directory()?)? {
                for event in turn.events {
                    let Some(item) = event.value().get("item") else {
                        continue;
                    };
                    if !matches!(
                        event.kind(),
                        "item.started" | "item.updated" | "item.completed"
                    ) || item["type"] != "reasoning"
                    {
                        continue;
                    }
                    let (Some(id), Some(text)) = (item["id"].as_str(), item["text"].as_str())
                    else {
                        continue;
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    let id = format!("{}:{id}", turn.id);
                    if let Some(part) = parts.iter_mut().find(|part| part.id == id) {
                        part.text = text.to_owned();
                    } else {
                        parts.push(NativeReasoning {
                            id,
                            text: text.to_owned(),
                        });
                    }
                }
            }
            Ok(parts)
        })
    }

    fn turn_evidence<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        turn_id: &'a str,
    ) -> HarnessFuture<'a, io::Result<Option<Vec<NativeTool>>>> {
        Box::pin(async move {
            Ok(
                session_reader::turn_evidence(&session.runtime_directory()?, turn_id)?
                    .map(|events| codex_tools(&events)),
            )
        })
    }

    fn timeline<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        pricing: Option<&'a ModelPricingCatalog>,
    ) -> HarnessFuture<'a, io::Result<NativeTimeline>> {
        Box::pin(async move {
            let observed = usage::observe_session(
                &session.runtime_directory()?,
                session.native_session_id,
                pricing,
            )?;
            let live = observed.live_turn_id;
            Ok(NativeTimeline {
                usage: observed
                    .turns
                    .into_iter()
                    .map(|turn| UsageEntry {
                        completed_at_ms: (live.as_deref() != Some(turn.turn_id.as_str()))
                            .then_some(turn.updated_at_ms),
                        message_id: turn.turn_id.clone(),
                        turn_id: turn.turn_id,
                        provider: "openai".to_owned(),
                        model: turn.model,
                        started_at_ms: turn.started_at_ms,
                        failed: turn.failed,
                        tokens: turn.tokens,
                        cost_usd: turn.cost_usd,
                        subsidized: turn.cost_usd > 0.0,
                        summary: false,
                        steps: 1.0,
                        source: "message",
                        // A Codex turn is timed only by its prompt file and log
                        // writes, which include tool execution and carry no
                        // first-output timestamp.
                        generation_ms: None,
                        first_response_ms: None,
                    })
                    .collect(),
                live_message_id: live,
            })
        })
    }

    fn busy<'a>(&'a self, session: &'a ReaderSession<'_>) -> HarnessFuture<'a, io::Result<bool>> {
        Box::pin(async move { crate::runtimes::headless::busy(&session.runtime_directory()?) })
    }
}

impl TaskHarness for CodexTaskRuntime {
    // Suplex reserves the prefix because a Codex thread id is itself a UUID.
    fn new_session_id(&self) -> String {
        format!("codex-{}", uuid::Uuid::new_v4())
    }

    fn observe<'a>(
        &'a self,
        session: SessionRef<'a>,
        turn_id: &'a str,
        dispatch: DispatchState,
        generation: Option<&'a str>,
    ) -> HarnessFuture<'a, io::Result<PromptObservation>> {
        Box::pin(async move {
            let directory = session.directory;
            let native_session_id = session.native_session_id;
            runtime::observe(directory, native_session_id, turn_id, dispatch, generation)
        })
    }

    fn dispatch<'a>(
        &'a self,
        scope: &'a TaskScope<'_>,
        turn_id: &'a str,
        prompt: &'a str,
        claim: DispatchClaim<'a>,
    ) -> HarnessFuture<'a, Result<PromptObservation, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            // The host already prepended the project context to `prompt`.
            match scope.role {
                TaskRole::Root(identity) => task_runtime::dispatch_codex_root(
                    RootCodexLaunch {
                        database_path: scope.database_path,
                        artifact_root: scope.artifact_root,
                        identity,
                        native_session_id: scope.native_session_id,
                        turn_id,
                        worktree: scope.worktree,
                        prompt,
                        project_context: None,
                        project_context_path: None,
                        project_environment: scope.project_environment,
                        excluded_environment_keys: scope.excluded_environment_keys,
                        model: scope.model,
                        reasoning_effort: scope.reasoning_effort,
                        codex_executable: scope.executable,
                        inherited_environment: scope.inherited_environment,
                        standard: !scope.workflow.workflow_root,
                    },
                    claim,
                ),
                TaskRole::Worker(purpose) => task_runtime::dispatch_codex_worker(
                    WorkerCodexLaunch {
                        database_path: scope.database_path,
                        session_id: scope.session_id,
                        native_session_id: scope.native_session_id,
                        turn_id,
                        worktree: scope.worktree,
                        prompt,
                        project_context: None,
                        project_context_path: None,
                        project_environment: scope.project_environment,
                        excluded_environment_keys: scope.excluded_environment_keys,
                        purpose,
                        model: scope.model,
                        reasoning_effort: scope.reasoning_effort,
                        codex_executable: scope.executable,
                        inherited_environment: scope.inherited_environment,
                        direct: scope.workflow.direct,
                        advisor: scope.workflow.advisor,
                    },
                    claim,
                ),
            }
        })
    }

    fn recover_dispatch<'a>(
        &'a self,
        session: SessionRef<'a>,
        turn_id: &'a str,
        generation: &'a str,
    ) -> HarnessFuture<'a, io::Result<PromptObservation>> {
        Box::pin(async move {
            let directory = session.directory;
            let native_session_id = session.native_session_id;
            recover_headless_dispatch(directory, generation)?;
            self.observe(
                SessionRef {
                    directory,
                    native_session_id,
                },
                turn_id,
                DispatchState::NotSubmitted,
                Some(generation),
            )
            .await
        })
    }

    fn result_text<'a>(
        &'a self,
        directory: &'a Path,
        turn_id: &'a str,
    ) -> HarnessFuture<'a, io::Result<String>> {
        Box::pin(async move { runtime::result_text(directory, turn_id) })
    }

    fn stop<'a>(
        &'a self,
        directory: &'a Path,
        native_session_id: Option<&'a str>,
    ) -> HarnessFuture<'a, io::Result<()>> {
        Box::pin(async move { headless::stop_session(directory, native_session_id) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, fs, path::Path};

    #[tokio::test]
    async fn reasoning_reads_completed_native_text() {
        let root =
            std::env::temp_dir().join(format!("suplex-codex-reasoning-{}", uuid::Uuid::new_v4()));
        let database = root.join("suplex.sqlite");
        let directory =
            crate::runtimes::task_harness::task_session_runtime_directory(&database, "session-1")
                .unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("turn-msg_1.jsonl"), concat!(
            "{\"type\":\"item.updated\",\"item\":{\"id\":\"r1\",\"type\":\"reasoning\",\"text\":\"partial\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"r1\",\"type\":\"reasoning\",\"text\":\"I checked the call sites.\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"a1\",\"type\":\"agent_message\",\"text\":\"Done\"}}\n",
        )).unwrap();
        let parts = CodexTaskRuntime
            .reasoning(&ReaderSession {
                database_path: &database,
                session_id: "session-1",
                native_session_id: "native-1",
                instance_home_directory: None,
            })
            .await
            .unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].id, "msg_1:r1");
        assert_eq!(parts[0].text, "I checked the call sites.");
        let history = CodexTaskRuntime
            .history(&ReaderSession {
                database_path: &database,
                session_id: "session-1",
                native_session_id: "native-1",
                instance_home_directory: None,
            })
            .await
            .unwrap();
        assert_eq!(
            history[0]["content"],
            json!([
                {"id":"msg_1:r1","type":"reasoning","text":"I checked the call sites."},
                {"id":"msg_1:text","type":"text","text":"Done"},
            ])
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn timeline_keeps_a_running_empty_turn_unfinished() {
        let root =
            std::env::temp_dir().join(format!("suplex-codex-timeline-{}", uuid::Uuid::new_v4()));
        let database = root.join("suplex.sqlite");
        let session_id = "session-live";
        let directory =
            crate::runtimes::task_harness::task_session_runtime_directory(&database, session_id)
                .unwrap();
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
        let timeline = CodexTaskRuntime
            .timeline(
                &ReaderSession {
                    database_path: &database,
                    session_id,
                    native_session_id: "codex-native-live",
                    instance_home_directory: None,
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(timeline.live_message_id.as_deref(), Some("msg_live"));
        assert_eq!(timeline.usage.len(), 1);
        assert_eq!(timeline.usage[0].message_id, "msg_live");
        assert!(timeline.usage[0].started_at_ms > 0);
        assert_eq!(timeline.usage[0].completed_at_ms, None);
        headless::stop_owned(&record).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
