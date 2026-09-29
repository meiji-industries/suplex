//! Public task snapshot in the same field order as the TypeScript response schema.

use crate::coordination::{
    advisor_bridge::AdvisorRole,
    workflows::{Completion, DeliveryWait, ReviewRecord, Workflow, WorkflowState},
};
use crate::delivery::inspection::ReviewRange;
use crate::http::contracts::typed::{
    projects::{ProjectExecution, ProjectIntegration},
    tasks::{IssueAssociation, TaskSource},
};
use crate::projects::ProjectProviderPolicy;
use crate::tasks::control::{
    DeliveryTarget, PullRequestReference, PullRequestState, TaskProfile, TaskStatus,
};
use crate::tasks::{limits::TaskLimitPause, worktree::WorktreeReference};
use rusqlite::Row;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::BTreeMap;
use ts_rs::TS;

use crate::platform::database::{DatabaseResult, SuplexDatabase};

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TaskResponse {
    pub(super) id: String,
    company_id: String,
    pub(super) project_id: String,
    pub(super) issue_key: Option<String>,
    issue: Option<IssueAssociation>,
    pub(super) title: String,
    description: String,
    pub(super) status: TaskStatus,
    pub(super) delivery_target: DeliveryTarget,
    root_profile: TaskProfile,
    worker_profile: TaskProfile,
    pub(super) workflow: Workflow,
    advisor_profiles: BTreeMap<AdvisorRole, TaskProfile>,
    pub(super) workflow_state: PublicWorkflowState,
    pub(super) depends_on: Vec<String>,
    pub(super) configuration: TaskConfiguration,
    worktree: Option<WorktreeReference>,
    pub(super) pull_request: Option<PullRequestReference>,
    pub(super) human_question: Option<TaskHumanQuestion>,
    pub(super) blocked_by: Vec<TaskBlockedBy>,
    pub(super) queue: TaskQueue,
    limits: TaskLimitSummary,
    wake_at: Option<String>,
    images: Vec<TaskImage>,
    artifacts: Vec<TaskImage>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    status_changed_at: String,
    pub(super) archived_at: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublicWorkflowState {
    #[ts(type = "1")]
    version: u8,
    reviews: Vec<ReviewRecord>,
    accepted_delivery: Option<ReviewRange>,
    pub(super) delivery_wait: Option<DeliveryWait>,
    pub(super) completion: Option<Completion>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskQueue {
    waiting_on: Vec<TaskQueueWait>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct TaskLimitSummary {
    #[serde(serialize_with = "serialize_js_number")]
    budget_usd: f64,
    max_turns: i64,
    admitted_turns: i64,
}

fn serialize_js_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
struct TaskImage {
    artifact_id: String,
    filename: String,
    mime_type: String,
    byte_size: i64,
}

fn workflow_state(row: &Row<'_>) -> DatabaseResult<PublicWorkflowState> {
    let state: WorkflowState = typed_column(row, "workflow_state_json")?;
    Ok(PublicWorkflowState {
        version: state.version,
        reviews: state.reviews,
        accepted_delivery: state.accepted_delivery,
        delivery_wait: state.delivery_wait,
        completion: state.completion,
    })
}

pub(crate) fn task_question(
    question: Option<String>,
    id: Option<String>,
    pause: Option<String>,
    options: String,
    recovery_turn_id: Option<String>,
) -> DatabaseResult<Option<TaskHumanQuestion>> {
    let (Some(text), Some(id)) = (question, id) else {
        return Ok(None);
    };
    Ok(Some(match pause {
        Some(pause) => TaskHumanQuestion::TaskLimit {
            id,
            text,
            options: vec![],
            requires_command_cleanup: false,
            pause: serde_json::from_str(&pause)?,
        },
        None => TaskHumanQuestion::Question {
            id,
            text,
            options: serde_json::from_str(&options)?,
            requires_command_cleanup: recovery_turn_id.is_some(),
        },
    }))
}

pub(crate) fn task_dependencies(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<(Vec<String>, Vec<TaskBlockedBy>, Vec<TaskQueueWait>)> {
    let mut statement = database.connection().prepare(
        "SELECT t.id, t.title, c.status, c.delivery_target, t.archived_at, json_extract(c.pull_request_json, '$.state') FROM suplex_task_dependencies d JOIN suplex_tasks t ON t.id = d.depends_on_task_id JOIN suplex_task_controls c ON c.task_id = t.id WHERE d.task_id = ?1 ORDER BY t.id",
    )?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, TaskStatus>(2)?,
                row.get::<_, DeliveryTarget>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<PullRequestState>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut statement = database.connection().prepare(
        "SELECT pull_request_number, state, title, url, observed_at FROM suplex_task_pull_request_dependencies WHERE task_id = ?1 ORDER BY pull_request_number",
    )?;
    let pull_requests = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, PullRequestState>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    dependency_projection(rows, pull_requests)
}

type TaskDependency = (
    String,
    String,
    TaskStatus,
    DeliveryTarget,
    Option<String>,
    Option<PullRequestState>,
);
type PullRequestDependency = (i64, PullRequestState, String, String, String);

fn dependency_projection(
    rows: Vec<TaskDependency>,
    pull_requests: Vec<PullRequestDependency>,
) -> DatabaseResult<(Vec<String>, Vec<TaskBlockedBy>, Vec<TaskQueueWait>)> {
    let mut depends_on = Vec::with_capacity(rows.len());
    let mut blocked_by = Vec::with_capacity(rows.len());
    let mut waiting_on = Vec::new();
    for (id, title, status, delivery_target, archived_at, pull_state) in rows {
        depends_on.push(id.clone());
        blocked_by.push(TaskBlockedBy {
            id: id.clone(),
            title: title.clone(),
            status,
            kind: None,
            number: None,
            state: None,
            url: None,
            observed_at: None,
        });
        let reason = match status {
            // A pull request target completes when its pull request merges.
            TaskStatus::Delivered => match (delivery_target, pull_state) {
                (target, _) if !target.uses_pull_request() => None,
                (_, Some(PullRequestState::Merged)) => None,
                (DeliveryTarget::Merged, _) | (_, None) => {
                    Some(TaskQueueWaitReason::PrerequisiteMergeUnobserved)
                }
                (_, Some(PullRequestState::Open)) => {
                    Some(TaskQueueWaitReason::PrerequisitePullRequestOpen)
                }
                (_, Some(PullRequestState::Closed)) => {
                    Some(TaskQueueWaitReason::PrerequisitePullRequestClosed)
                }
            },
            _ if archived_at.is_some() => Some(TaskQueueWaitReason::PrerequisiteArchived),
            TaskStatus::Backlog | TaskStatus::Queued => {
                Some(TaskQueueWaitReason::PrerequisiteNotStarted)
            }
            TaskStatus::Active => Some(TaskQueueWaitReason::PrerequisiteRunning),
            TaskStatus::WaitingHuman => Some(TaskQueueWaitReason::PrerequisiteNeedsHuman),
            TaskStatus::Cancelled => Some(TaskQueueWaitReason::PrerequisiteCancelled),
        };
        if let Some(reason) = reason {
            let condition = if delivery_target.uses_pull_request() {
                "its pull request merges"
            } else {
                "it is delivered"
            };
            let summary = match (reason, status) {
                (TaskQueueWaitReason::PrerequisiteNotStarted, TaskStatus::Queued) => {
                    format!("{title} is queued. This task starts when {condition}.")
                }
                (TaskQueueWaitReason::PrerequisiteNotStarted, _) => {
                    format!("{title} did not start. Start it. This task starts when {condition}.")
                }
                (TaskQueueWaitReason::PrerequisiteRunning, _) => {
                    format!("{title} is running. This task starts when {condition}.")
                }
                (TaskQueueWaitReason::PrerequisiteNeedsHuman, _) => format!(
                    "{title} needs an answer. Answer it. This task starts when {condition}."
                ),
                (TaskQueueWaitReason::PrerequisiteCancelled, _) => format!(
                    "{title} is cancelled. Remove it from Blocked by, or send this task to the backlog."
                ),
                (TaskQueueWaitReason::PrerequisitePullRequestOpen, _) => format!(
                    "{title} is delivered, and its pull request is open. This task starts when {condition}."
                ),
                (TaskQueueWaitReason::PrerequisitePullRequestClosed, _) => format!(
                    "{title} is delivered, but its pull request is closed without merging. Reopen and merge it, or remove {title} from Blocked by."
                ),
                (TaskQueueWaitReason::PrerequisiteArchived, _) => format!(
                    "{title} is archived and not delivered. Remove it from Blocked by, or open and deliver it."
                ),
                _ => format!(
                    "{title} is delivered, but Suplex did not observe its merged pull request. Suplex checks GitHub again."
                ),
            };
            waiting_on.push(TaskQueueWait {
                kind: DependencyKind::Task,
                id,
                title,
                status,
                delivery_target,
                number: None,
                state: None,
                url: None,
                reason,
                summary,
            });
        }
    }
    for (number, state, title, url, observed_at) in pull_requests {
        let id = format!("pull_request:{number}");
        let number = u64::try_from(number)?;
        blocked_by.push(TaskBlockedBy {
            id: id.clone(),
            title: title.clone(),
            status: TaskStatus::Backlog,
            kind: Some(DependencyKind::PullRequest),
            number: Some(number),
            state: Some(state),
            url: Some(url.clone()),
            observed_at: Some(observed_at),
        });
        if state != PullRequestState::Merged {
            let reason = if state == PullRequestState::Closed {
                TaskQueueWaitReason::PrerequisitePullRequestClosed
            } else {
                TaskQueueWaitReason::PrerequisitePullRequestOpen
            };
            let summary = if state == PullRequestState::Closed {
                format!(
                    "Pull request #{number} is closed without merging. Reopen and merge it, or remove it from Blocked by."
                )
            } else {
                format!("Pull request #{number} is open. This task starts when it merges.")
            };
            waiting_on.push(TaskQueueWait {
                kind: DependencyKind::PullRequest,
                id,
                title,
                status: TaskStatus::Backlog,
                delivery_target: DeliveryTarget::PullRequestDraft,
                number: Some(number),
                state: Some(state),
                url: Some(url),
                reason,
                summary,
            });
        }
    }
    Ok((depends_on, blocked_by, waiting_on))
}

pub fn get(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Option<TaskResponse>> {
    super::repository::task_response(database, task_id)
}

/// A JSON text column deserialized into its Rust type.
fn typed_column<T: serde::de::DeserializeOwned>(row: &Row<'_>, column: &str) -> DatabaseResult<T> {
    Ok(serde_json::from_str(&row.get::<_, String>(column)?)?)
}

/// A nullable JSON text column; SQL NULL and JSON null both read as `None`.
fn nullable_typed_column<T: serde::de::DeserializeOwned>(
    row: &Row<'_>,
    column: &str,
) -> DatabaseResult<Option<T>> {
    match row.get::<_, Option<String>>(column)? {
        Some(raw) => Ok(serde_json::from_str(&raw)?),
        None => Ok(None),
    }
}

/// The issue key, such as `SUP-12`, and the linked issue.
fn issue_from_row(row: &Row<'_>) -> DatabaseResult<(Option<String>, Option<IssueAssociation>)> {
    let code: Option<String> = row.get("issue_code")?;
    let number: Option<i64> = row.get("issue_number")?;
    let key = code
        .zip(number)
        .map(|(code, number)| format!("{code}-{number}"));
    Ok((key, nullable_typed_column(row, "issue_json")?))
}

fn question_from_row(row: &Row<'_>) -> DatabaseResult<Option<TaskHumanQuestion>> {
    task_question(
        row.get("human_question")?,
        row.get("human_question_id")?,
        row.get("limit_pause_json")?,
        row.get("human_question_options_json")?,
        row.get("recovery_turn_id")?,
    )
}

/// The task limits, with the company defaults where the task sets none.
fn limits_from_row(row: &Row<'_>) -> DatabaseResult<TaskLimitSummary> {
    let budget_usd: Option<f64> = row.get("budget_usd")?;
    let max_turns: Option<i64> = row.get("max_turns")?;
    let defaults: (f64, i64) = (row.get("default_budget")?, row.get("default_turns")?);
    Ok(TaskLimitSummary {
        budget_usd: budget_usd.unwrap_or(defaults.0),
        max_turns: max_turns.unwrap_or(defaults.1),
        admitted_turns: row.get("admitted_turns")?,
    })
}

/// Dependency ids, the Blocked by list, and the queue. Only a backlog or
/// queued task shows what it waits on.
fn dependencies_from_row(
    row: &Row<'_>,
    status: TaskStatus,
) -> DatabaseResult<(Vec<String>, Vec<TaskBlockedBy>, TaskQueue)> {
    let (depends_on, blocked_by, waiting_on) = dependency_projection(
        serde_json::from_str(&row.get::<_, String>("dependencies")?)?,
        serde_json::from_str(&row.get::<_, String>("pr_dependencies")?)?,
    )?;
    let waiting_on = if matches!(status, TaskStatus::Backlog | TaskStatus::Queued) {
        waiting_on
    } else {
        vec![]
    };
    Ok((depends_on, blocked_by, TaskQueue { waiting_on }))
}

/// The task's own timestamps.
struct TaskTimes {
    wake_at: Option<String>,
    created_at: String,
    updated_at: String,
    status_changed_at: String,
    archived_at: Option<String>,
}

fn times_from_row(row: &Row<'_>) -> DatabaseResult<TaskTimes> {
    Ok(TaskTimes {
        wake_at: row.get("wake_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        status_changed_at: row.get("status_changed_at")?,
        archived_at: row.get("archived_at")?,
    })
}

pub(crate) fn from_row(row: &Row<'_>) -> DatabaseResult<TaskResponse> {
    let status: TaskStatus = row.get("status")?;
    let (depends_on, blocked_by, queue) = dependencies_from_row(row, status)?;
    let times = times_from_row(row)?;
    let (issue_key, issue) = issue_from_row(row)?;
    Ok(TaskResponse {
        id: row.get("id")?,
        company_id: row.get("company_id")?,
        project_id: row.get("project_id")?,
        issue_key,
        issue,
        title: row.get("title")?,
        description: row.get("description")?,
        status,
        delivery_target: row.get("delivery_target")?,
        root_profile: typed_column(row, "root_profile_json")?,
        worker_profile: typed_column(row, "worker_profile_json")?,
        workflow: row.get("workflow")?,
        advisor_profiles: typed_column(row, "advisor_profiles_json")?,
        workflow_state: workflow_state(row)?,
        depends_on,
        configuration: typed_column(row, "configuration_json")?,
        worktree: nullable_typed_column(row, "worktree_json")?,
        pull_request: nullable_typed_column(row, "pull_request_json")?,
        human_question: question_from_row(row)?,
        blocked_by,
        queue,
        limits: limits_from_row(row)?,
        wake_at: times.wake_at,
        images: typed_column(row, "images")?,
        artifacts: typed_column(row, "artifacts")?,
        created_at: times.created_at,
        updated_at: times.updated_at,
        status_changed_at: times.status_changed_at,
        archived_at: times.archived_at,
    })
}

/// One selectable answer to a human question.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct HumanQuestionOption {
    pub label: String,
    pub description: String,
    pub recommended: bool,
}

/// The question a task waits on, if any.
#[derive(Debug, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TaskHumanQuestion {
    Question {
        id: String,
        text: String,
        options: Vec<HumanQuestionOption>,
        requires_command_cleanup: bool,
    },
    TaskLimit {
        id: String,
        text: String,
        /// Always empty. Kept so the wire shape does not change.
        options: Vec<HumanQuestionOption>,
        requires_command_cleanup: bool,
        pause: TaskLimitPause,
    },
}

crate::shared::wire_enum! {
    pub enum DependencyKind {
        Task = "task",
        PullRequest = "pull_request",
    }
}

crate::shared::wire_enum! {
    pub enum TaskQueueWaitReason {
        PrerequisiteNotStarted = "prerequisite_not_started",
        PrerequisiteRunning = "prerequisite_running",
        PrerequisiteNeedsHuman = "prerequisite_needs_human",
        PrerequisiteCancelled = "prerequisite_cancelled",
        PrerequisiteArchived = "prerequisite_archived",
        PrerequisiteMergeUnobserved = "prerequisite_merge_unobserved",
        PrerequisitePullRequestOpen = "prerequisite_pull_request_open",
        PrerequisitePullRequestClosed = "prerequisite_pull_request_closed",
    }
}

/// One entry of the task's "Blocked by" list.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskBlockedBy {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<DependencyKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub state: Option<PullRequestState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub observed_at: Option<String>,
}

/// One prerequisite a backlog or queued task waits on.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueWait {
    pub kind: DependencyKind,
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub delivery_target: DeliveryTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub state: Option<PullRequestState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    pub reason: TaskQueueWaitReason,
    pub summary: String,
}

/// The workflow or template selection recorded at task creation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HermesSelection {
    pub workflow_id: Option<String>,
    pub workflow_name: Option<String>,
    pub template_id: Option<String>,
}

crate::shared::wire_enum! {
    pub enum VisualEvidence {
        Off = "off",
        Capture = "capture",
        Required = "required",
    }
}

/// The project and delivery settings captured when the task was created.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskConfiguration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub provider_policy: Option<ProjectProviderPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub integration: Option<ProjectIntegration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub execution: Option<ProjectExecution>,
    pub repository: String,
    pub repository_path: String,
    pub worktree_root: String,
    pub branch: String,
    pub base_branch: String,
    pub baseline_sha: String,
    pub starting_sha: String,
    #[serde(default)]
    pub setup_command: String,
    #[serde(default)]
    pub verification_command: String,
    #[serde(default = "default_true")]
    pub run_project_tests: bool,
    #[serde(default = "default_visual_evidence")]
    pub visual_evidence: VisualEvidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hermes_selection: Option<HermesSelection>,
    pub source: Option<TaskSource>,
    pub captured_at: String,
}

fn default_true() -> bool {
    true
}

fn default_visual_evidence() -> VisualEvidence {
    VisualEvidence::Off
}

#[cfg(test)]
mod dependency_tests {
    use super::*;

    #[test]
    fn queue_waits_explain_cancelled_human_archived_and_unobserved_merge_blockers() {
        let rows = [
            (
                "cancelled",
                "Cancelled",
                TaskStatus::Cancelled,
                DeliveryTarget::LocalWorktree,
                None,
                None,
            ),
            (
                "question",
                "Question",
                TaskStatus::WaitingHuman,
                DeliveryTarget::LocalWorktree,
                None,
                None,
            ),
            (
                "archived",
                "Archived",
                TaskStatus::Backlog,
                DeliveryTarget::LocalWorktree,
                Some("2026-09-26"),
                None,
            ),
            (
                "unmerged",
                "Unmerged",
                TaskStatus::Delivered,
                DeliveryTarget::Merged,
                None,
                Some(PullRequestState::Open),
            ),
            (
                "merged",
                "Merged",
                TaskStatus::Delivered,
                DeliveryTarget::Merged,
                None,
                Some(PullRequestState::Merged),
            ),
        ]
        .into_iter()
        .map(|(id, title, status, target, archived, pull)| {
            (
                id.to_owned(),
                title.to_owned(),
                status,
                target,
                archived.map(str::to_owned),
                pull,
            )
        })
        .collect();
        let (depends_on, blocked_by, waits) = dependency_projection(rows, vec![]).unwrap();
        assert_eq!(depends_on.len(), 5);
        assert_eq!(blocked_by.len(), 5);
        assert_eq!(
            waits.iter().map(|wait| wait.reason).collect::<Vec<_>>(),
            vec![
                TaskQueueWaitReason::PrerequisiteCancelled,
                TaskQueueWaitReason::PrerequisiteNeedsHuman,
                TaskQueueWaitReason::PrerequisiteArchived,
                TaskQueueWaitReason::PrerequisiteMergeUnobserved
            ]
        );
        assert!(waits[0].summary.contains("Remove it from Blocked by"));
        assert!(waits[1].summary.contains("Answer it"));
        assert!(waits[2].summary.contains("open and deliver it"));
        assert!(waits[3].summary.contains("Suplex checks GitHub again"));
    }
}
#[cfg(test)]
mod fixture_tests {
    use super::*;

    #[test]
    fn populated_task_matches_shared_fixture() {
        let timestamp = "2026-09-26T12:00:00.000Z";
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let response = TaskResponse {
            id: "task_01".into(),
            company_id: "company_01".into(),
            project_id: "project_01".into(),
            issue_key: Some("SUP-12".into()),
            issue: Some(IssueAssociation::Github {
                repository: "meiji-industries/suplex".into(),
                number: 12,
                id: "I_kwDOexample".into(),
                key: "SUP-12".into(),
                title: "Typed contracts".into(),
                url: "https://github.com/meiji-industries/suplex/issues/12".into(),
            }),
            title: "Typed contracts".into(),
            description: "Generate the browser task contract from Rust.".into(),
            status: TaskStatus::Queued,
            delivery_target: DeliveryTarget::PullRequestDraft,
            root_profile: TaskProfile {
                profile_id: "profile_root".into(),
                provider: crate::tasks::control::HarnessKind::Codex,
                model: "gpt-5".into(),
                reasoning_level: crate::tasks::control::ReasoningLevel::High,
                service_tier: crate::tasks::control::ServiceTier::Default,
                provider_instance_id: None,
                instance_home_directory: None,
            },
            worker_profile: TaskProfile {
                profile_id: "profile_worker".into(),
                provider: crate::tasks::control::HarnessKind::ClaudeCode,
                model: "claude-opus-5-5".into(),
                reasoning_level: crate::tasks::control::ReasoningLevel::Medium,
                service_tier: crate::tasks::control::ServiceTier::Default,
                provider_instance_id: Some(None),
                instance_home_directory: None,
            },
            workflow: Workflow::Standard,
            advisor_profiles: BTreeMap::from([(
                AdvisorRole::Reviewer,
                TaskProfile {
                    profile_id: "profile_reviewer".into(),
                    provider: crate::tasks::control::HarnessKind::ClaudeCode,
                    model: "claude-sonnet-5".into(),
                    reasoning_level: crate::tasks::control::ReasoningLevel::Medium,
                    service_tier: crate::tasks::control::ServiceTier::Default,
                    provider_instance_id: None,
                    instance_home_directory: None,
                },
            )]),
            workflow_state: PublicWorkflowState {
                version: 1,
                reviews: vec![],
                accepted_delivery: None,
                delivery_wait: None,
                completion: None,
            },
            depends_on: vec!["task_00".into()],
            configuration: TaskConfiguration {
                provider_policy: None,
                integration: None,
                execution: None,
                repository: "meiji-industries/suplex".into(),
                repository_path: "/repo/suplex".into(),
                worktree_root: "/repo/suplex/.worktrees".into(),
                branch: "task/typed-contracts-task-01".into(),
                base_branch: "main".into(),
                baseline_sha: sha.into(),
                starting_sha: sha.into(),
                setup_command: "pnpm install".into(),
                verification_command: "pnpm check".into(),
                run_project_tests: true,
                visual_evidence: VisualEvidence::Off,
                hermes_selection: None,
                source: None,
                captured_at: timestamp.into(),
            },
            worktree: None,
            pull_request: None,
            human_question: Some(TaskHumanQuestion::Question {
                id: "question_01".into(),
                text: "Merge now?".into(),
                options: vec![HumanQuestionOption {
                    label: "Yes".into(),
                    description: "Merge the pull request.".into(),
                    recommended: true,
                }],
                requires_command_cleanup: false,
            }),
            blocked_by: vec![TaskBlockedBy {
                id: "task_00".into(),
                title: "Prerequisite".into(),
                status: TaskStatus::Active,
                kind: None,
                number: None,
                state: None,
                url: None,
                observed_at: None,
            }],
            queue: TaskQueue {
                waiting_on: vec![TaskQueueWait {
                    kind: DependencyKind::Task,
                    id: "task_00".into(),
                    title: "Prerequisite".into(),
                    status: TaskStatus::Active,
                    delivery_target: DeliveryTarget::Merged,
                    number: None,
                    state: None,
                    url: None,
                    reason: TaskQueueWaitReason::PrerequisiteRunning,
                    summary:
                        "Prerequisite is running. This task starts when its pull request merges."
                            .into(),
                }],
            },
            limits: TaskLimitSummary {
                budget_usd: 25.0,
                max_turns: 40,
                admitted_turns: 3,
            },
            wake_at: None,
            images: vec![],
            artifacts: vec![],
            created_at: timestamp.into(),
            updated_at: timestamp.into(),
            status_changed_at: timestamp.into(),
            archived_at: None,
        };
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/task-response.json"))
                .unwrap();
        assert_eq!(serde_json::to_value(&response).unwrap(), expected);
    }
}
