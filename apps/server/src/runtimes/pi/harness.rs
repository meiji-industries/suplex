//! Pi behind the shared task harness seam. Turn logs are the execution
//! evidence; the Pi session file is the conversation.

use std::{error::Error, io, path::Path};

use serde_json::Value;

use super::{runtime, session_reader, task_runtime, tool_evidence::pi_tools, usage};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        headless,
        native::{NativeReasoning, NativeTool, SessionRef},
        task_harness::{
            DispatchClaim, DispatchState, HarnessFuture, NativeSessionReader, NativeTimeline,
            PromptObservation, ReaderSession, TaskHarness, TaskScope, UsageEntry,
            recover_headless_dispatch,
        },
    },
};

pub struct PiTaskRuntime;

impl NativeSessionReader for PiTaskRuntime {
    fn history<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<Value>>> {
        Box::pin(async move {
            Ok(session_reader::history(&session_reader::session_entries(
                &session.runtime_directory()?,
                session.native_session_id,
            )?))
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
                    pi_tools(&turn.events).into_iter().map(move |mut tool| {
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
            Ok(session_reader::reasoning(&session_reader::session_entries(
                &session.runtime_directory()?,
                session.native_session_id,
            )?))
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
                    .map(|events| pi_tools(&events)),
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
                        provider: turn.provider,
                        model: turn.model,
                        started_at_ms: turn.started_at_ms,
                        failed: turn.failed,
                        tokens: turn.tokens,
                        cost_usd: turn.cost_usd,
                        subsidized: turn.cost_usd > 0.0,
                        summary: false,
                        steps: 1.0,
                        source: "message",
                    })
                    .collect(),
                live_message_id: live,
            })
        })
    }

    fn busy<'a>(&'a self, session: &'a ReaderSession<'_>) -> HarnessFuture<'a, io::Result<bool>> {
        Box::pin(async move { headless::busy(&session.runtime_directory()?) })
    }
}

impl TaskHarness for PiTaskRuntime {
    // The prefix routes the session back to Pi; Pi accepts it as its own id.
    fn new_session_id(&self) -> String {
        format!("pi-{}", uuid::Uuid::new_v4())
    }

    fn observe<'a>(
        &'a self,
        session: SessionRef<'a>,
        turn_id: &'a str,
        dispatch: DispatchState,
        generation: Option<&'a str>,
    ) -> HarnessFuture<'a, io::Result<PromptObservation>> {
        Box::pin(async move {
            runtime::observe(
                session.directory,
                session.native_session_id,
                turn_id,
                dispatch,
                generation,
            )
        })
    }

    fn dispatch<'a>(
        &'a self,
        scope: &'a TaskScope<'_>,
        turn_id: &'a str,
        prompt: &'a str,
        claim: DispatchClaim<'a>,
    ) -> HarnessFuture<'a, Result<PromptObservation, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { task_runtime::dispatch(scope, turn_id, prompt, claim) })
    }

    fn recover_dispatch<'a>(
        &'a self,
        session: SessionRef<'a>,
        turn_id: &'a str,
        generation: &'a str,
    ) -> HarnessFuture<'a, io::Result<PromptObservation>> {
        Box::pin(async move {
            recover_headless_dispatch(session.directory, generation)?;
            self.observe(
                session,
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
    use std::fs;

    const SESSION: &str = include_str!("fixtures/session.jsonl");
    const TURN: &str = include_str!("fixtures/turn.jsonl");

    fn reader(database: &Path) -> ReaderSession<'_> {
        ReaderSession {
            database_path: database,
            session_id: "session-1",
            native_session_id: "pi-1234-abcd",
            instance_home_directory: None,
        }
    }

    #[tokio::test]
    async fn the_reader_uses_the_session_file_and_turn_logs_without_a_cached_status() {
        let root = std::env::temp_dir().join(format!("suplex-pi-harness-{}", uuid::Uuid::new_v4()));
        let database = root.join("suplex.sqlite");
        let directory =
            crate::runtimes::task_harness::task_session_runtime_directory(&database, "session-1")
                .unwrap();
        let session = reader(&database);
        // Before Pi writes anything the session is empty, not an error.
        assert!(PiTaskRuntime.history(&session).await.unwrap().is_empty());
        fs::create_dir_all(directory.join(session_reader::SESSION_DIRECTORY)).unwrap();
        fs::write(
            directory
                .join(session_reader::SESSION_DIRECTORY)
                .join("2026-10-20T16-46-06-320Z_pi-1234-abcd.jsonl"),
            SESSION,
        )
        .unwrap();
        fs::write(directory.join("turn-msg_2.jsonl"), TURN).unwrap();
        let history = PiTaskRuntime.history(&session).await.unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[2]["content"][1]["text"], "Done.");
        let reasoning = PiTaskRuntime.reasoning(&session).await.unwrap();
        assert_eq!(reasoning[0].text, "Thinking about it.");
        let (tools, plan) = PiTaskRuntime.execution(&session).await.unwrap();
        assert_eq!(plan, Value::Null);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "msg_2:call_1");
        assert_eq!(tools[0].output.as_deref(), Some("2 passed\n"));
        let evidence = PiTaskRuntime
            .turn_evidence(&session, "msg_2")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(evidence[0].id, "call_1");
        assert!(
            PiTaskRuntime
                .turn_evidence(&session, "msg_missing")
                .await
                .unwrap()
                .is_none()
        );
        let timeline = PiTaskRuntime.timeline(&session, None).await.unwrap();
        assert_eq!(timeline.live_message_id, None);
        let entry = &timeline.usage[0];
        assert_eq!(
            (entry.message_id.as_str(), entry.provider.as_str()),
            ("msg_2", "localfake")
        );
        assert!(entry.completed_at_ms.is_some());
        assert_eq!(entry.tokens.cache_read, 40.0);
        assert!(entry.cost_usd > 0.0 && entry.subsidized);
        assert!(!PiTaskRuntime.busy(&session).await.unwrap());
        assert_eq!(
            PiTaskRuntime
                .result_text(&directory, "msg_2")
                .await
                .unwrap(),
            "Done."
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_sessions_are_valid_pi_session_ids_with_the_routing_prefix() {
        let id = PiTaskRuntime.new_session_id();
        assert!(id.starts_with("pi-"));
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        );
        assert!(id.as_bytes().last().unwrap().is_ascii_alphanumeric());
    }
}
