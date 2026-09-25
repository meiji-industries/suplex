//! TypeScript `DevinTaskRuntime` and `DevinSessionReader` behind the shared task harness seam.

use std::{error::Error, io, path::Path};

use serde_json::Value;

use super::{
    session_reader,
    task_runtime::{self, DevinRole, DevinScope},
};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        codex::{role_prompt, tool_evidence::NativeTool},
        task_harness::{
            DispatchClaim, DispatchState, NativeSessionReader, NativeTimeline, PromptObservation,
            ReaderSession, TaskHarness, TaskRole, TaskScope,
        },
    },
};

pub struct DevinTaskRuntime;

impl NativeSessionReader for DevinTaskRuntime {
    fn history(&self, session: &ReaderSession<'_>) -> io::Result<Vec<Value>> {
        session_reader::history(
            &session.runtime_directory()?,
            Some(session.native_session_id),
        )
    }

    /// `devin --print` exposes no tool stream or plan.
    fn execution(&self, _session: &ReaderSession<'_>) -> io::Result<(Vec<NativeTool>, Value)> {
        Ok((Vec::new(), Value::Null))
    }

    fn turn_evidence(
        &self,
        session: &ReaderSession<'_>,
        turn_id: &str,
    ) -> io::Result<Option<Vec<NativeTool>>> {
        Ok(Some(
            session_reader::turn_evidence(&session.runtime_directory()?, turn_id)?.tools,
        ))
    }

    fn timeline(
        &self,
        session: &ReaderSession<'_>,
        _pricing: Option<&ModelPricingCatalog>,
    ) -> io::Result<NativeTimeline> {
        session_reader::timeline(
            &session.runtime_directory()?,
            Some(session.native_session_id),
        )
    }

    fn busy(&self, session: &ReaderSession<'_>) -> io::Result<bool> {
        task_runtime::session_busy(&session.runtime_directory()?)
    }
}

impl TaskHarness for DevinTaskRuntime {
    fn new_session_id(&self) -> String {
        format!("devin-{}", uuid::Uuid::new_v4())
    }

    fn observe(
        &self,
        directory: &Path,
        native_session_id: &str,
        turn_id: &str,
        dispatch: DispatchState,
        generation: Option<&str>,
    ) -> io::Result<PromptObservation> {
        task_runtime::observe(directory, native_session_id, turn_id, dispatch, generation)
    }

    fn dispatch(
        &self,
        scope: &TaskScope<'_>,
        turn_id: &str,
        prompt: &str,
        claim: DispatchClaim<'_>,
    ) -> Result<PromptObservation, Box<dyn Error>> {
        // The host already prepended the project context to `prompt`.
        let (role, role_prompt) = match scope.role {
            TaskRole::Root(identity) => (
                DevinRole::Root {
                    identity,
                    artifact_root: scope.artifact_root,
                },
                role_prompt::ROOT_STANDARD,
            ),
            TaskRole::Worker(purpose) => (
                DevinRole::Worker,
                role_prompt::worker_standard_role(purpose),
            ),
        };
        task_runtime::dispatch(
            &DevinScope {
                database_path: scope.database_path,
                session_id: scope.session_id,
                worktree: scope.worktree,
                role,
                model: scope.model,
                executable: scope.executable,
                project_environment: scope.project_environment,
                excluded_environment_keys: scope.excluded_environment_keys,
                inherited_environment: scope.inherited_environment,
            },
            scope.native_session_id,
            turn_id,
            role_prompt,
            prompt,
            |generation| claim(generation),
        )
    }

    fn recover_dispatch(
        &self,
        directory: &Path,
        native_session_id: &str,
        turn_id: &str,
        generation: &str,
    ) -> io::Result<PromptObservation> {
        task_runtime::recover_dispatch(directory, native_session_id, turn_id, generation)
    }

    fn result_text(&self, directory: &Path, turn_id: &str) -> io::Result<String> {
        task_runtime::result_text(directory, turn_id)
    }

    fn stop(&self, directory: &Path, native_session_id: Option<&str>) -> io::Result<()> {
        task_runtime::stop(directory, native_session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::{
        codex::role_prompt::WorkerPurpose,
        headless,
        task_harness::PromptState,
        task_harness_registry::{for_profile, native_session_reader},
    };
    use std::{collections::HashMap, fs};

    #[test]
    fn registry_routes_devin_profiles_and_sessions_to_the_devin_harness() {
        let f = task_runtime::tests::Fixture::new("complete");
        let harness = for_profile("devin").unwrap();
        let native = harness.new_session_id();
        assert!(native.starts_with("devin-"));
        assert!(native_session_reader(&native).is_some());
        let scope = TaskScope {
            database_path: &f.database,
            artifact_root: &f.root,
            task_id: "task-devin",
            session_id: "session-devin",
            native_session_id: &native,
            role: TaskRole::Worker(WorkerPurpose::Implementation),
            worktree: &f.worktree,
            model: "swe",
            reasoning_effort: "low",
            instance_home_directory: None,
            project_mcp: None,
            project_context_path: None,
            project_environment: &HashMap::new(),
            workflow: crate::runtimes::task_harness::WorkflowLaunch::default(),
            excluded_environment_keys: &[],
            executable: Some(&f.executable),
            inherited_environment: &f.inherited,
        };
        harness
            .dispatch(&scope, "msg_1", "Implement the change", &mut |_| Ok(true))
            .unwrap();
        let directory = scope.runtime_directory().unwrap();
        let observed = task_runtime::tests::eventually(&directory, &native, "msg_1");
        assert_eq!(observed.state, PromptState::Completed);
        assert_eq!(
            fs::read_to_string(headless::turn_file(&directory, "msg_1", "prompt")).unwrap(),
            format!(
                "{}\n\nImplement the change",
                role_prompt::worker_standard_role(WorkerPurpose::Implementation)
            )
        );
        let session = ReaderSession {
            database_path: &f.database,
            session_id: "session-devin",
            native_session_id: &native,
            instance_home_directory: None,
        };
        assert_eq!(harness.history(&session).unwrap().len(), 1);
        assert_eq!(harness.timeline(&session, None).unwrap().usage.len(), 1);
        assert!(!harness.busy(&session).unwrap());
        assert_eq!(
            harness.result_text(&directory, "msg_1").unwrap(),
            "Reviewed the change."
        );
    }
}
