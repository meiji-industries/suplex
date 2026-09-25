//! Public task snapshot in the same field order as the TypeScript response schema.

use rusqlite::{OptionalExtension, Row, params};
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::platform::database::{DatabaseResult, SuplexDatabase};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResponse {
    id: String,
    company_id: String,
    project_id: String,
    issue_key: Option<String>,
    issue: Value,
    title: String,
    description: String,
    status: String,
    delivery_target: String,
    root_profile: Value,
    worker_profile: Value,
    workflow: String,
    advisor_profiles: Value,
    workflow_state: PublicWorkflowState,
    depends_on: Vec<String>,
    configuration: Value,
    worktree: Value,
    pull_request: Value,
    human_question: Value,
    blocked_by: Vec<Value>,
    queue: TaskQueue,
    limits: TaskLimits,
    wake_at: Option<String>,
    images: Vec<TaskImage>,
    artifacts: Vec<TaskImage>,
    created_at: String,
    updated_at: String,
    status_changed_at: String,
    archived_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicWorkflowState {
    version: i64,
    reviews: Value,
    accepted_delivery: Value,
    delivery_wait: Value,
    completion: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskQueue {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskImage {
    artifact_id: String,
    filename: String,
    mime_type: String,
    byte_size: i64,
}

fn image(row: &Row<'_>) -> rusqlite::Result<TaskImage> {
    Ok(TaskImage {
        artifact_id: row.get("artifactId")?,
        filename: row.get("filename")?,
        mime_type: row.get("mimeType")?,
        byte_size: row.get("byteSize")?,
    })
}

fn images(
    database: &SuplexDatabase,
    task_id: &str,
    company_id: &str,
    kind: &str,
) -> DatabaseResult<Vec<TaskImage>> {
    let sql = if kind == "task-image" {
        "SELECT id AS artifactId, filename, mime_type AS mimeType, byte_size AS byteSize FROM suplex_artifacts WHERE task_id = ?1 AND company_id = ?2 AND kind = 'task-image' ORDER BY created_at, id"
    } else {
        "SELECT id AS artifactId, filename, mime_type AS mimeType, byte_size AS byteSize FROM suplex_artifacts WHERE task_id = ?1 AND company_id = ?2 AND kind LIKE 'delivery-%' ORDER BY created_at, id"
    };
    let mut statement = database.connection().prepare(sql)?;
    Ok(statement
        .query_map(params![task_id, company_id], image)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn parse_json(raw: &str) -> DatabaseResult<Value> {
    Ok(serde_json::from_str(raw)?)
}

fn workflow_state(raw: &str) -> DatabaseResult<PublicWorkflowState> {
    let value = parse_json(raw)?;
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

fn task_dependencies(
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
                _ => return Err(std::io::Error::other("invalid prerequisite status").into()),
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
    let raw = database.connection().query_row(
        "SELECT t.id, t.company_id, t.project_id, t.issue_json, t.issue_number, cpy.issue_code, t.title, t.description, c.status, c.delivery_target, c.root_profile_json, c.worker_profile_json, c.workflow, c.advisor_profiles_json, c.workflow_state_json, t.configuration_json, c.worktree_json, c.pull_request_json, c.human_question, c.human_question_id, c.limit_pause_json, c.human_question_options_json, c.recovery_turn_id, c.wake_at, t.created_at, CASE WHEN julianday(t.updated_at) >= julianday(COALESCE(c.updated_at, t.updated_at)) THEN t.updated_at ELSE c.updated_at END, c.status_changed_at, t.archived_at, c.budget_usd, c.max_turns FROM suplex_tasks t JOIN suplex_companies cpy ON cpy.id = t.company_id JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
        [task_id], |row| {
            Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<i64>>(4)?, row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?, row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?, row.get::<_, String>(12)?, row.get::<_, String>(13)?, row.get::<_, String>(14)?, row.get::<_, String>(15)?,
                row.get::<_, Option<String>>(16)?, row.get::<_, Option<String>>(17)?, row.get::<_, Option<String>>(18)?, row.get::<_, Option<String>>(19)?, row.get::<_, Option<String>>(20)?, row.get::<_, String>(21)?, row.get::<_, Option<String>>(22)?, row.get::<_, Option<String>>(23)?, row.get::<_, String>(24)?, row.get::<_, String>(25)?, row.get::<_, String>(26)?, row.get::<_, Option<String>>(27)?, row.get::<_, Option<f64>>(28)?, row.get::<_, Option<i64>>(29)?
            ))
        },
    ).optional()?;
    let Some((
        id,
        company_id,
        project_id,
        issue_json,
        issue_number,
        issue_code,
        title,
        description,
        status,
        delivery_target,
        root_profile,
        worker_profile,
        workflow,
        advisor_profiles,
        state,
        configuration,
        worktree,
        pull_request,
        human_question,
        human_question_id,
        limit_pause,
        question_options,
        recovery_turn_id,
        wake_at,
        created_at,
        updated_at,
        status_changed_at,
        archived_at,
        budget_usd,
        max_turns,
    )) = raw
    else {
        return Ok(None);
    };
    let (depends_on, blocked_by, waiting_on) = task_dependencies(database, &id)?;
    let defaults = database.connection().query_row(
        "SELECT default_budget_usd, default_max_turns FROM suplex_environment_settings WHERE id = 'host'",
        [], |row| Ok((row.get::<_, f64>(0)?, row.get::<_, i64>(1)?)),
    ).optional()?.unwrap_or((15.0, 40));
    let admitted_turns: i64 = database.connection().query_row(
        "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompted_at IS NOT NULL",
        [&id],
        |row| row.get(0),
    )?;
    let issue_key = issue_code
        .zip(issue_number)
        .map(|(code, number)| format!("{code}-{number}"));
    Ok(Some(TaskResponse {
        id: id.clone(),
        company_id: company_id.clone(),
        project_id,
        issue_key,
        issue: issue_json
            .as_deref()
            .map(parse_json)
            .transpose()?
            .unwrap_or(Value::Null),
        title,
        description,
        status: status.clone(),
        delivery_target,
        root_profile: parse_json(&root_profile)?,
        worker_profile: parse_json(&worker_profile)?,
        workflow,
        advisor_profiles: parse_json(&advisor_profiles)?,
        workflow_state: workflow_state(&state)?,
        depends_on,
        configuration: parse_json(&configuration)?,
        worktree: worktree
            .as_deref()
            .map(parse_json)
            .transpose()?
            .unwrap_or(Value::Null),
        pull_request: pull_request
            .as_deref()
            .map(parse_json)
            .transpose()?
            .unwrap_or(Value::Null),
        human_question: task_question(
            human_question,
            human_question_id,
            limit_pause,
            question_options,
            recovery_turn_id,
        )?,
        blocked_by,
        queue: TaskQueue {
            waiting_on: if status == "backlog" || status == "queued" {
                waiting_on
            } else {
                vec![]
            },
        },
        limits: TaskLimits {
            budget_usd: budget_usd.unwrap_or(defaults.0),
            max_turns: max_turns.unwrap_or(defaults.1),
            admitted_turns,
        },
        wake_at,
        images: images(database, &id, &company_id, "task-image")?,
        artifacts: images(database, &id, &company_id, "delivery")?,
        created_at,
        updated_at,
        status_changed_at,
        archived_at,
    }))
}
