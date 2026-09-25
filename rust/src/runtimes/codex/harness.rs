//! TypeScript `CodexTaskRuntime` behind the shared task harness seam.

use std::{error::Error, io, path::Path, time::UNIX_EPOCH};

use serde_json::{Value, json};

use super::{
    runtime, session_reader,
    task_runtime::{self, RootCodexLaunch, WorkerCodexLaunch},
    tool_evidence::{NativeTool, codex_tools},
    transcript, usage,
};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        headless,
        task_harness::{
            DispatchClaim, DispatchState, NativeSessionReader, NativeTimeline, PromptObservation,
            ReaderSession, TaskHarness, TaskRole, TaskScope, UsageEntry, recover_headless_dispatch,
        },
    },
};

pub struct CodexTaskRuntime;

/// TypeScript `CodexSessionReader`: every turn log in the session runtime.
impl NativeSessionReader for CodexTaskRuntime {
    fn history(&self, session: &ReaderSession<'_>) -> io::Result<Vec<Value>> {
        let turns = session_reader::turns(&session.runtime_directory()?)?;
        Ok(turns
            .into_iter()
            .filter_map(|turn| {
                let text = transcript::result_text(&turn.events);
                if text.is_empty() {
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
                    "content":[{"id":format!("{}:text",turn.id),"type":"text","text":text}],
                }))
            })
            .collect())
    }

    fn execution(&self, session: &ReaderSession<'_>) -> io::Result<(Vec<NativeTool>, Value)> {
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
    }

    fn turn_evidence(
        &self,
        session: &ReaderSession<'_>,
        turn_id: &str,
    ) -> io::Result<Option<Vec<NativeTool>>> {
        Ok(
            session_reader::turn_evidence(&session.runtime_directory()?, turn_id)?
                .map(|events| codex_tools(&events)),
        )
    }

    fn timeline(
        &self,
        session: &ReaderSession<'_>,
        pricing: Option<&ModelPricingCatalog>,
    ) -> io::Result<NativeTimeline> {
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
                    provider: "openai",
                    model: turn.model,
                    started_at_ms: turn.updated_at_ms,
                    failed: turn.failed,
                    tokens: turn.tokens,
                    cost_usd: turn.cost_usd,
                })
                .collect(),
            live_message_id: live,
        })
    }

    fn busy(&self, session: &ReaderSession<'_>) -> io::Result<bool> {
        session_reader::busy(&session.runtime_directory()?)
    }
}

impl TaskHarness for CodexTaskRuntime {
    // Suplex reserves the prefix because a Codex thread id is itself a UUID.
    fn new_session_id(&self) -> String {
        format!("codex-{}", uuid::Uuid::new_v4())
    }

    fn observe(
        &self,
        directory: &Path,
        native_session_id: &str,
        turn_id: &str,
        dispatch: DispatchState,
        generation: Option<&str>,
    ) -> io::Result<PromptObservation> {
        runtime::observe(directory, native_session_id, turn_id, dispatch, generation)
    }

    fn dispatch(
        &self,
        scope: &TaskScope<'_>,
        turn_id: &str,
        prompt: &str,
        claim: DispatchClaim<'_>,
    ) -> Result<PromptObservation, Box<dyn Error>> {
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
                },
                claim,
            ),
        }
    }

    fn recover_dispatch(
        &self,
        directory: &Path,
        native_session_id: &str,
        turn_id: &str,
        generation: &str,
    ) -> io::Result<PromptObservation> {
        recover_headless_dispatch(directory, generation)?;
        self.observe(
            directory,
            native_session_id,
            turn_id,
            DispatchState::NotSubmitted,
            Some(generation),
        )
    }

    fn result_text(&self, directory: &Path, turn_id: &str) -> io::Result<String> {
        runtime::result_text(directory, turn_id)
    }

    fn stop(&self, directory: &Path, native_session_id: Option<&str>) -> io::Result<()> {
        headless::stop_session(directory, native_session_id)
    }
}
