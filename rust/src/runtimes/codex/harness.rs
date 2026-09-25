//! TypeScript `CodexTaskRuntime` behind the shared task harness seam.

use std::{error::Error, io, path::Path};

use super::{
    runtime,
    task_runtime::{self, RootCodexLaunch, WorkerCodexLaunch},
};
use crate::runtimes::{
    headless,
    task_harness::{
        DispatchClaim, DispatchState, PromptObservation, TaskHarness, TaskRole, TaskScope,
        recover_headless_dispatch,
    },
};

pub struct CodexTaskRuntime;

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
