//! Source-shaped checks for completing a Standard task in its local worktree.
//! Git is observed by the caller before the Root and tool owner are rechecked
//! and the durable control transition is committed.

use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    coordination::{root_bridge::RootIdentity, root_session_store},
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    tasks::{
        commands::TaskFailure,
        worktree::{self, LocalRevisionObservation},
    },
};

#[derive(Debug, Eq, PartialEq)]
pub struct DeliveryOperationFailure {
    pub code: &'static str,
    pub message: &'static str,
}

impl fmt::Display for DeliveryOperationFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for DeliveryOperationFailure {}

/// Check source control state before waiting for a Git observation.
pub fn standard_local_worktree_path(control: &Value) -> Result<&str, DeliveryOperationFailure> {
    if control["deliveryTarget"] != "local_worktree" {
        return Err(DeliveryOperationFailure {
            code: "delivery_target_mismatch",
            message: "This task has a different delivery target",
        });
    }
    control["worktree"]["path"]
        .as_str()
        .ok_or(DeliveryOperationFailure {
            code: "worktree_missing",
            message: "The task has no worktree",
        })
}

/// Check only the conditions in the source Standard `completeLocal` path.
/// An uncommitted working tree is valid local delivery evidence.
pub fn check_standard_local_completion(
    control: &Value,
    expected_head: Option<&str>,
    local: &LocalRevisionObservation,
) -> Result<(), DeliveryOperationFailure> {
    standard_local_worktree_path(control)?;
    if expected_head.is_none_or(|head| head != local.head_sha)
        || control["deliveryIntent"]["headBranch"] != local.branch
    {
        return Err(DeliveryOperationFailure {
            code: "head_diverged",
            message: "Review the current worktree before completing the task",
        });
    }
    Ok(())
}

/// Observe Git outside SQLite, then recheck the current Root and tool owner
/// before recording the actual local revision and completing the task.
pub async fn complete_local_work(
    database_path: &Path,
    root: &RootIdentity,
    owner_token: &str,
    expected_head: Option<&str>,
) -> DatabaseResult<Value> {
    let initial = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let control = root_session_store::root_observation_rows(&initial, &root.task_id)?.control;
    if control["workflow"] != "standard" {
        return Err(Box::new(TaskFailure::not_ported(
            "Only Standard workflow local completion is ported",
        )));
    }
    let path = PathBuf::from(standard_local_worktree_path(&control)?);
    drop(initial);
    let local = tokio::task::spawn_blocking(move || {
        worktree::observe_local_revision(&path).map_err(|error| error.to_string())
    })
    .await?
    .map_err(io::Error::other)?;
    check_standard_local_completion(&control, expected_head, &local)?;

    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    root_session_store::assert_tool_owner(&database, &root.task_id, owner_token)?;
    let current = root_session_store::root_observation_rows(&database, &root.task_id)?.control;
    let mut worktree = current["worktree"].clone();
    worktree["headSha"] = json!(local.head_sha);
    worktree["dirty"] = json!(!local.clean);
    root_session_store::set_worktree(&mut database, &root.task_id, &worktree, Utc::now())?;
    root_session_store::mark_delivered(&mut database, &root.task_id, Utc::now())?;
    Ok(json!({"kind":"local_work_completed","headSha":local.head_sha}))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn standard_completion_uses_actual_branch_and_head_without_a_clean_tree_gate() {
        let control = json!({
            "deliveryTarget":"local_worktree",
            "worktree":{"path":"/tmp/task"},
            "deliveryIntent":{"headBranch":"task-one"}
        });
        let local = LocalRevisionObservation {
            branch: "task-one".into(),
            head_sha: "head-one".into(),
            tree_sha: "tree-one".into(),
            clean: false,
        };
        assert_eq!(
            check_standard_local_completion(&control, Some("head-one"), &local),
            Ok(())
        );
        assert_eq!(
            check_standard_local_completion(&control, None, &local)
                .unwrap_err()
                .code,
            "head_diverged"
        );
        assert_eq!(
            check_standard_local_completion(&control, Some("old-head"), &local)
                .unwrap_err()
                .code,
            "head_diverged"
        );
        let mut wrong_branch = local.clone();
        wrong_branch.branch = "other".into();
        assert_eq!(
            check_standard_local_completion(&control, Some("head-one"), &wrong_branch)
                .unwrap_err()
                .code,
            "head_diverged"
        );
        let mut wrong_target = control.clone();
        wrong_target["deliveryTarget"] = json!("pull_request");
        assert_eq!(
            check_standard_local_completion(&wrong_target, Some("head-one"), &local)
                .unwrap_err()
                .code,
            "delivery_target_mismatch"
        );
        let mut missing_worktree = control.clone();
        missing_worktree["worktree"] = Value::Null;
        assert_eq!(
            standard_local_worktree_path(&missing_worktree)
                .unwrap_err()
                .code,
            "worktree_missing"
        );
    }
}
