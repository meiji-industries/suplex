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

/// TypeScript `DeliveryOperations.observe`: a finished task keeps its recorded
/// pull request, and a local-worktree task has no pull request to observe.
pub fn observe(control: &Value) -> DatabaseResult<Value> {
    if matches!(control["status"].as_str(), Some("cancelled" | "delivered")) {
        return Ok(control["pullRequest"].clone());
    }
    if control["deliveryTarget"] == "local_worktree" {
        return Ok(Value::Null);
    }
    Err(Box::new(TaskFailure::not_ported(
        "GitHub pull request observation is not ported",
    )))
}

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
        return crate::coordination::root_controller::complete_workflow_local_work(
            database_path,
            root,
            owner_token,
            expected_head,
        )
        .await;
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

#[derive(Debug, PartialEq, Eq)]
pub enum WorkflowCompletion {
    Completed,
    Already,
    Cancelled,
    Declined {
        code: &'static str,
        reason: String,
    },
}

/// TypeScript `completeWorkflowDelivery`: the completion commit boundary for
/// non-Standard workflows. One short transaction reloads the task, its reviews,
/// and its delegates, applies the delivery policy to the validated range against
/// freshly observed local facts, rechecks ownership, and records the workflow
/// completion with the delivered status. No Git or network I/O runs inside it.
pub fn complete_workflow_delivery(
    database: &mut SuplexDatabase,
    task_id: &str,
    range: &crate::coordination::workflows::ReviewRange,
    local: &LocalRevisionObservation,
    pull_request_number: Option<i64>,
    require_accepted: bool,
    recheck: impl FnOnce(&SuplexDatabase) -> DatabaseResult<()>,
) -> DatabaseResult<WorkflowCompletion> {
    use crate::coordination::workflows::{self, LocalSourceFacts, ReviewRange};
    database.transaction(true, |database| {
        let rows = root_session_store::root_observation_rows(database, task_id)?;
        let control = &rows.control;
        if control["status"] == "cancelled" {
            return Ok(WorkflowCompletion::Cancelled);
        }
        let state = root_session_store::workflow_state(database, task_id)?;
        if !state["completion"].is_null() || control["status"] == "delivered" {
            if control["status"] != "delivered" {
                root_session_store::mark_delivered(database, task_id, Utc::now())?;
            }
            return Ok(WorkflowCompletion::Already);
        }
        let accepted = ReviewRange::from_value(&state["acceptedDelivery"]);
        if require_accepted && accepted.is_none_or(|accepted| !workflows::same_range(&accepted, range)) {
            return Ok(WorkflowCompletion::Declined {
                code: "workflow_review_required",
                reason: "No accepted delivery decision matches this range. Complete the workflow's review and request delivery.".into(),
            });
        }
        let facts = LocalSourceFacts {
            branch: Some(&local.branch),
            head_sha: Some(&local.head_sha),
            clean: local.clean,
        };
        if let Err(refusal) = workflows::delivery_decision(control, &rows.sessions, &rows.turns, range, &facts, true) {
            return Ok(WorkflowCompletion::Declined {
                code: refusal.code,
                reason: refusal.reason,
            });
        }
        recheck(database)?;
        let mut state = state;
        state["acceptedDelivery"] = json!(range);
        state["deliveryWait"] = Value::Null;
        state["completion"] = json!({
            "kind":"workflow","reviewedHead":range.head_sha,"pullRequestNumber":pull_request_number,
            "observedAt":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        root_session_store::write_workflow_state(database, task_id, &state, Utc::now())?;
        root_session_store::mark_delivered(database, task_id, Utc::now())?;
        Ok(WorkflowCompletion::Completed)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn delivery_observation_matches_typescript_observe() {
        let local =
            json!({"status":"active","deliveryTarget":"local_worktree","pullRequest":{"number":7}});
        assert_eq!(observe(&local).unwrap(), Value::Null);
        let delivered = json!({"status":"delivered","deliveryTarget":"pull_request","pullRequest":{"number":7}});
        assert_eq!(observe(&delivered).unwrap(), json!({"number":7}));
        let github = json!({"status":"active","deliveryTarget":"pull_request","pullRequest":null});
        let failure = observe(&github).unwrap_err();
        let failure = failure.downcast_ref::<TaskFailure>().unwrap();
        assert_eq!(
            (failure.status_code, failure.code),
            (501, "experimental_not_ported")
        );
    }

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
