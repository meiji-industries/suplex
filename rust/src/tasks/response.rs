//! Public task snapshot in the same field order as the TypeScript response schema.

use crate::tasks::TaskError;
use rusqlite::Row;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use crate::platform::database::{DatabaseResult, SuplexDatabase};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResponse {
    pub(super) id: String,
    company_id: String,
    pub(super) project_id: String,
    pub(super) issue_key: Option<String>,
    issue: Value,
    pub(super) title: String,
    description: String,
    pub(super) status: String,
    pub(super) delivery_target: String,
    root_profile: Value,
    worker_profile: Value,
    pub(super) workflow: String,
    advisor_profiles: Value,
    pub(super) workflow_state: PublicWorkflowState,
    pub(super) depends_on: Vec<String>,
    pub(super) configuration: Value,
    worktree: Value,
    pub(super) pull_request: Value,
    pub(super) human_question: Value,
    pub(super) blocked_by: Vec<Value>,
    pub(super) queue: TaskQueue,
    limits: TaskLimits,
    wake_at: Option<String>,
    images: Vec<TaskImage>,
    artifacts: Vec<TaskImage>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    status_changed_at: String,
    pub(super) archived_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublicWorkflowState {
    version: i64,
    reviews: Value,
    accepted_delivery: Value,
    pub(super) delivery_wait: Value,
    pub(super) completion: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskQueue {
    waiting_on: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskLimits {
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskImage {
    artifact_id: String,
    filename: String,
    mime_type: String,
    byte_size: i64,
}

fn parse_json(raw: &str) -> DatabaseResult<Value> {
    Ok(serde_json::from_str(raw)?)
}

fn workflow_state(row: &Row<'_>) -> DatabaseResult<PublicWorkflowState> {
    let value = json_column(row, "workflow_state_json")?;
    Ok(PublicWorkflowState {
        version: value
            .get("version")
            .and_then(Value::as_i64)
            .ok_or("workflow state version is missing")?,
        reviews: value
            .get("reviews")
            .cloned()
            .ok_or("workflow state reviews are missing")?,
        accepted_delivery: value
            .get("acceptedDelivery")
            .cloned()
            .unwrap_or(Value::Null),
        delivery_wait: value.get("deliveryWait").cloned().unwrap_or(Value::Null),
        completion: value.get("completion").cloned().unwrap_or(Value::Null),
    })
}

fn task_question(
    question: Option<String>,
    id: Option<String>,
    pause: Option<String>,
    options: String,
    recovery_turn_id: Option<String>,
) -> DatabaseResult<Value> {
    let (Some(text), Some(id)) = (question, id) else {
        return Ok(Value::Null);
    };
    let options = parse_json(&options)?;
    Ok(match pause {
        Some(pause) => {
            serde_json::json!({"id": id, "text": text, "options": [], "requiresCommandCleanup": false, "kind": "task_limit", "pause": parse_json(&pause)?})
        }
        None => {
            serde_json::json!({"id": id, "text": text, "options": options, "requiresCommandCleanup": recovery_turn_id.is_some(), "kind": "question"})
        }
    })
}

pub(crate) fn task_dependencies(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<(Vec<String>, Vec<Value>, Vec<Value>)> {
    let mut statement = database.connection().prepare(
        "SELECT t.id, t.title, c.status, c.delivery_target, t.archived_at, json_extract(c.pull_request_json, '$.state') FROM suplex_task_dependencies d JOIN suplex_tasks t ON t.id = d.depends_on_task_id JOIN suplex_task_controls c ON c.task_id = t.id WHERE d.task_id = ?1 ORDER BY t.id",
    )?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
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
                row.get::<_, String>(1)?,
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
    String,
    String,
    Option<String>,
    Option<String>,
);
type PullRequestDependency = (i64, String, String, String, String);

fn dependency_projection(
    rows: Vec<TaskDependency>,
    pull_requests: Vec<PullRequestDependency>,
) -> DatabaseResult<(Vec<String>, Vec<Value>, Vec<Value>)> {
    let mut depends_on = Vec::with_capacity(rows.len());
    let mut blocked_by = Vec::with_capacity(rows.len());
    let mut waiting_on = Vec::new();
    for (id, title, status, delivery_target, archived_at, pull_state) in rows {
        depends_on.push(id.clone());
        blocked_by.push(serde_json::json!({"id": id, "title": title, "status": status}));
        let reason = if status == "delivered" {
            if delivery_target == "merged" && pull_state.as_deref() != Some("merged") {
                Some("prerequisite_merge_unobserved")
            } else {
                None
            }
        } else if archived_at.is_some() {
            Some("prerequisite_archived")
        } else {
            Some(match status.as_str() {
                "backlog" | "queued" => "prerequisite_not_started",
                "active" => "prerequisite_running",
                "waiting_human" => "prerequisite_needs_human",
                "cancelled" => "prerequisite_cancelled",
                _ => return Err(TaskError::internal("invalid prerequisite status").into()),
            })
        };
        if let Some(reason) = reason {
            let condition = if delivery_target == "merged" {
                "its pull request merges"
            } else {
                "it is delivered"
            };
            let summary = match reason {
                "prerequisite_not_started" if status == "queued" => {
                    format!("{title} is queued. This task starts when {condition}.")
                }
                "prerequisite_not_started" => {
                    format!("{title} did not start. Start it. This task starts when {condition}.")
                }
                "prerequisite_running" => {
                    format!("{title} is running. This task starts when {condition}.")
                }
                "prerequisite_needs_human" => format!(
                    "{title} needs an answer. Answer it. This task starts when {condition}."
                ),
                "prerequisite_cancelled" => format!(
                    "{title} is cancelled. Remove it from Blocked by, or send this task to the backlog."
                ),
                "prerequisite_archived" => format!(
                    "{title} is archived and not delivered. Remove it from Blocked by, or open and deliver it."
                ),
                _ => format!(
                    "{title} is delivered, but Suplex did not observe its merged pull request. Suplex checks GitHub again."
                ),
            };
            waiting_on.push(serde_json::json!({"kind": "task", "id": id, "title": title, "status": status, "deliveryTarget": delivery_target, "reason": reason, "summary": summary}));
        }
    }
    for (number, state, title, url, observed_at) in pull_requests {
        let id = format!("pull_request:{number}");
        blocked_by.push(serde_json::json!({
            "id": id, "title": title, "status": "backlog", "kind": "pull_request",
            "number": number, "state": state, "url": url, "observedAt": observed_at,
        }));
        if state != "merged" {
            let reason = if state == "closed" {
                "prerequisite_pull_request_closed"
            } else {
                "prerequisite_pull_request_open"
            };
            let summary = if state == "closed" {
                format!(
                    "Pull request #{number} is closed without merging. Reopen and merge it, or remove it from Blocked by."
                )
            } else {
                format!("Pull request #{number} is open. This task starts when it merges.")
            };
            waiting_on.push(serde_json::json!({
                "kind": "pull_request", "id": id, "title": title, "status": "backlog",
                "deliveryTarget": "pull_request_draft", "number": number, "state": state,
                "url": url, "reason": reason, "summary": summary,
            }));
        }
    }
    Ok((depends_on, blocked_by, waiting_on))
}

pub fn get(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Option<TaskResponse>> {
    super::repository::task_response(database, task_id)
}

fn json_column(row: &Row<'_>, column: &str) -> DatabaseResult<Value> {
    parse_json(&row.get::<_, String>(column)?)
}

/// A nullable JSON text column; SQL NULL reads as JSON null.
fn nullable_json_column(row: &Row<'_>, column: &str) -> DatabaseResult<Value> {
    match row.get::<_, Option<String>>(column)? {
        Some(raw) => parse_json(&raw),
        None => Ok(Value::Null),
    }
}

/// The issue key, such as `SUP-12`, and the linked issue.
fn issue_from_row(row: &Row<'_>) -> DatabaseResult<(Option<String>, Value)> {
    let code: Option<String> = row.get("issue_code")?;
    let number: Option<i64> = row.get("issue_number")?;
    let key = code
        .zip(number)
        .map(|(code, number)| format!("{code}-{number}"));
    Ok((key, nullable_json_column(row, "issue_json")?))
}

fn question_from_row(row: &Row<'_>) -> DatabaseResult<Value> {
    task_question(
        row.get("human_question")?,
        row.get("human_question_id")?,
        row.get("limit_pause_json")?,
        row.get("human_question_options_json")?,
        row.get("recovery_turn_id")?,
    )
}

/// The task limits, with the company defaults where the task sets none.
fn limits_from_row(row: &Row<'_>) -> DatabaseResult<TaskLimits> {
    let budget_usd: Option<f64> = row.get("budget_usd")?;
    let max_turns: Option<i64> = row.get("max_turns")?;
    let defaults: (f64, i64) = (row.get("default_budget")?, row.get("default_turns")?);
    Ok(TaskLimits {
        budget_usd: budget_usd.unwrap_or(defaults.0),
        max_turns: max_turns.unwrap_or(defaults.1),
        admitted_turns: row.get("admitted_turns")?,
    })
}

/// Dependency ids, the Blocked by list, and the queue. Only a backlog or
/// queued task shows what it waits on.
fn dependencies_from_row(
    row: &Row<'_>,
    status: &str,
) -> DatabaseResult<(Vec<String>, Vec<Value>, TaskQueue)> {
    let (depends_on, blocked_by, waiting_on) = dependency_projection(
        serde_json::from_str(&row.get::<_, String>("dependencies")?)?,
        serde_json::from_str(&row.get::<_, String>("pr_dependencies")?)?,
    )?;
    let waiting_on = if status == "backlog" || status == "queued" {
        waiting_on
    } else {
        vec![]
    };
    Ok((depends_on, blocked_by, TaskQueue { waiting_on }))
}

fn images_column(row: &Row<'_>, column: &str) -> DatabaseResult<Vec<TaskImage>> {
    Ok(serde_json::from_str(&row.get::<_, String>(column)?)?)
}

/// The Coordinator, Worker, and Advisor profiles.
fn profiles_from_row(row: &Row<'_>) -> DatabaseResult<(Value, Value, Value)> {
    Ok((
        json_column(row, "root_profile_json")?,
        json_column(row, "worker_profile_json")?,
        json_column(row, "advisor_profiles_json")?,
    ))
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
    let status: String = row.get("status")?;
    let (depends_on, blocked_by, queue) = dependencies_from_row(row, &status)?;
    let (root_profile, worker_profile, advisor_profiles) = profiles_from_row(row)?;
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
        root_profile,
        worker_profile,
        workflow: row.get("workflow")?,
        advisor_profiles,
        workflow_state: workflow_state(row)?,
        depends_on,
        configuration: json_column(row, "configuration_json")?,
        worktree: nullable_json_column(row, "worktree_json")?,
        pull_request: nullable_json_column(row, "pull_request_json")?,
        human_question: question_from_row(row)?,
        blocked_by,
        queue,
        limits: limits_from_row(row)?,
        wake_at: times.wake_at,
        images: images_column(row, "images")?,
        artifacts: images_column(row, "artifacts")?,
        created_at: times.created_at,
        updated_at: times.updated_at,
        status_changed_at: times.status_changed_at,
        archived_at: times.archived_at,
    })
}
