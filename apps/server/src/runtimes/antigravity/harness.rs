//! Antigravity behind the shared task harness seam. Turn logs are the
//! execution evidence and the conversation the agent reported.

use std::{error::Error, io, path::Path};

use serde_json::Value;

use super::{cli, runtime, session_reader, task_runtime};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        headless,
        native::{NativeReasoning, NativeTool, SessionRef},
        task_harness::{
            DispatchClaim, DispatchState, HarnessFuture, NativeSessionReader, NativeTimeline,
            PromptObservation, ReaderSession, TaskHarness, TaskScope, recover_headless_dispatch,
        },
    },
};

pub struct AntigravityTaskRuntime;

pub static ANTIGRAVITY_TASK_RUNTIME: AntigravityTaskRuntime = AntigravityTaskRuntime;

impl NativeSessionReader for AntigravityTaskRuntime {
    fn history<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<Value>>> {
        Box::pin(async move {
            Ok(session_reader::history(&session_reader::turns(
                &session.runtime_directory()?,
            )?))
        })
    }

    fn execution<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<(Vec<NativeTool>, Value)>> {
        Box::pin(async move {
            let turns = session_reader::turns(&session.runtime_directory()?)?;
            Ok((session_reader::tools(&turns), Value::Null))
        })
    }

    fn reasoning<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<NativeReasoning>>> {
        Box::pin(async move {
            Ok(session_reader::reasoning(&session_reader::turns(
                &session.runtime_directory()?,
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
                    .map(|events| super::transcript::native_tools(&events)),
            )
        })
    }

    fn timeline<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        pricing: Option<&'a ModelPricingCatalog>,
    ) -> HarnessFuture<'a, io::Result<NativeTimeline>> {
        Box::pin(async move {
            let directory = session.runtime_directory()?;
            let turns = session_reader::turns(&directory)?;
            let live = if headless::busy(&directory)? {
                headless::read_record(&directory.join("turn.json"))?.map(|record| record.turn_id)
            } else {
                None
            };
            Ok(NativeTimeline {
                usage: session_reader::usage(&turns, live.as_deref(), pricing),
                live_message_id: live,
            })
        })
    }

    fn busy<'a>(&'a self, session: &'a ReaderSession<'_>) -> HarnessFuture<'a, io::Result<bool>> {
        Box::pin(async move { headless::busy(&session.runtime_directory()?) })
    }
}

impl TaskHarness for AntigravityTaskRuntime {
    /// The prefix routes the session here; the native ACP session id comes
    /// from the agent and is read back from the turn logs.
    fn new_session_id(&self) -> String {
        format!("{}{}", cli::SESSION_PREFIX, uuid::Uuid::new_v4())
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
        Box::pin(async move { task_runtime::dispatch(scope, turn_id, prompt, None, claim) })
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

    const TURN: &str = include_str!("fixtures/turn.jsonl");

    #[tokio::test]
    async fn the_reader_uses_turn_logs_without_a_cached_status() {
        let root = std::env::temp_dir().join(format!(
            "suplex-antigravity-harness-{}",
            uuid::Uuid::new_v4()
        ));
        let database = root.join("suplex.sqlite");
        let directory =
            crate::runtimes::task_harness::task_session_runtime_directory(&database, "session-1")
                .unwrap();
        let session = ReaderSession {
            database_path: &database,
            session_id: "session-1",
            native_session_id: "antigravity-71618050-0d31-428e-a547-d6c4a2eca88f",
            instance_home_directory: None,
        };
        // Before the first turn the session is empty, not an error.
        let runtime = &ANTIGRAVITY_TASK_RUNTIME;
        assert!(runtime.history(&session).await.unwrap().is_empty());
        assert!(!runtime.busy(&session).await.unwrap());
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("turn-msg_2.jsonl"), TURN).unwrap();
        assert_eq!(runtime.history(&session).await.unwrap().len(), 1);
        assert_eq!(
            runtime.reasoning(&session).await.unwrap()[0].text,
            "Plan the test run."
        );
        let (tools, plan) = runtime.execution(&session).await.unwrap();
        assert_eq!(plan, Value::Null);
        assert_eq!(tools[1].id, "msg_2:call_2");
        let evidence = runtime
            .turn_evidence(&session, "msg_2")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(evidence[0].id, "call_1");
        assert!(
            runtime
                .turn_evidence(&session, "msg_missing")
                .await
                .unwrap()
                .is_none()
        );
        let timeline = runtime.timeline(&session, None).await.unwrap();
        assert_eq!(timeline.live_message_id, None);
        assert_eq!(timeline.usage[0].tokens.output, 30.0);
        assert!(timeline.usage[0].completed_at_ms.is_some());
        assert_eq!(
            runtime.result_text(&directory, "msg_2").await.unwrap(),
            "All tests pass."
        );
        // Stopping a session with no recorded process is a no-op.
        runtime
            .stop(&directory, Some(session.native_session_id))
            .await
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_sessions_carry_the_routing_prefix() {
        let id = ANTIGRAVITY_TASK_RUNTIME.new_session_id();
        assert!(id.starts_with("antigravity-"));
        assert_ne!(id, ANTIGRAVITY_TASK_RUNTIME.new_session_id());
    }
}
