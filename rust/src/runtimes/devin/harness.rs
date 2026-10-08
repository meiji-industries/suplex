//! TypeScript `DevinTaskRuntime` and `DevinSessionReader` behind the shared task harness seam.

use crate::runtimes::native::SessionRef;
use std::{error::Error, io, path::Path};

use serde_json::Value;

use super::{
    session_reader,
    task_runtime::{self, DevinRole, DevinScope},
};
use crate::{
    profiles::model_pricing::ModelPricingCatalog,
    runtimes::{
        native::NativeTool,
        task_harness::{
            DispatchClaim, DispatchState, HarnessFuture, NativeSessionReader, NativeTimeline,
            PromptObservation, ReaderSession, TaskHarness, TaskRole, TaskScope,
        },
    },
};

pub struct DevinTaskRuntime;

impl NativeSessionReader for DevinTaskRuntime {
    fn history<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<Vec<Value>>> {
        Box::pin(async move {
            session_reader::history(
                &session.runtime_directory()?,
                Some(session.native_session_id),
            )
        })
    }

    /// `devin --print` exposes no tool stream or plan.
    fn execution<'a>(
        &'a self,
        _session: &'a ReaderSession<'_>,
    ) -> HarnessFuture<'a, io::Result<(Vec<NativeTool>, Value)>> {
        Box::pin(async move { Ok((Vec::new(), Value::Null)) })
    }

    fn turn_evidence<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        turn_id: &'a str,
    ) -> HarnessFuture<'a, io::Result<Option<Vec<NativeTool>>>> {
        Box::pin(async move {
            Ok(Some(
                session_reader::turn_evidence(&session.runtime_directory()?, turn_id)?.tools,
            ))
        })
    }

    fn timeline<'a>(
        &'a self,
        session: &'a ReaderSession<'_>,
        _pricing: Option<&'a ModelPricingCatalog>,
    ) -> HarnessFuture<'a, io::Result<NativeTimeline>> {
        Box::pin(async move {
            session_reader::timeline(
                &session.runtime_directory()?,
                Some(session.native_session_id),
            )
        })
    }

    fn busy<'a>(&'a self, session: &'a ReaderSession<'_>) -> HarnessFuture<'a, io::Result<bool>> {
        Box::pin(async move { task_runtime::session_busy(&session.runtime_directory()?) })
    }
}

impl TaskHarness for DevinTaskRuntime {
    fn new_session_id(&self) -> String {
        format!("devin-{}", uuid::Uuid::new_v4())
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
            task_runtime::observe(directory, native_session_id, turn_id, dispatch, generation)
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
            let role = match (scope.role, scope.workflow.advisor) {
                (TaskRole::Root(identity), _) => DevinRole::Root {
                    identity,
                    artifact_root: scope.artifact_root,
                },
                (TaskRole::Worker(_), Some(advisor)) => DevinRole::Advisor(advisor),
                (TaskRole::Worker(_), None) => DevinRole::Worker,
            };
            let role_prompt = scope.workflow.role_prompt(scope.role);
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
            task_runtime::recover_dispatch(directory, native_session_id, turn_id, generation)
        })
    }

    fn result_text<'a>(
        &'a self,
        directory: &'a Path,
        turn_id: &'a str,
    ) -> HarnessFuture<'a, io::Result<String>> {
        Box::pin(async move { task_runtime::result_text(directory, turn_id) })
    }

    fn stop<'a>(
        &'a self,
        directory: &'a Path,
        native_session_id: Option<&'a str>,
    ) -> HarnessFuture<'a, io::Result<()>> {
        Box::pin(async move { task_runtime::stop(directory, native_session_id) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::{
        codex::role_prompt::{self, WorkerPurpose},
        headless,
        task_harness::PromptState,
        task_harness_registry::{for_profile, native_session_reader},
    };
    use std::{collections::HashMap, fs};

    #[tokio::test]
    async fn registry_routes_devin_profiles_and_sessions_to_the_devin_harness() {
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
            .await
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
        assert_eq!(harness.history(&session).await.unwrap().len(), 1);
        assert_eq!(
            harness.timeline(&session, None).await.unwrap().usage.len(),
            1
        );
        assert!(!harness.busy(&session).await.unwrap());
        assert_eq!(
            harness.result_text(&directory, "msg_1").await.unwrap(),
            "Reviewed the change."
        );
    }
}
