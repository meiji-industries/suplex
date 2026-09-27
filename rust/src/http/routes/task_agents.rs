//! Current task-agent rows use saved session intent and live native process observation.

use crate::http::error::ApiError;

use crate::http::access::authorize;
use crate::shared::time::rfc3339_millis;
use crate::tasks::TaskError;
use crate::tasks::control::{SessionKind, SessionLifecycle, SessionRow, TaskProfile, TaskStatus};
use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    extract::{RawQuery, State},
    http::{HeaderMap, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::{
    coordination::{
        advisor_bridge::AdvisorRole,
        root_session_store::{self, RootObservationRows},
        workflows,
    },
    http::{
        AppState,
        contracts::typed::{
            agent_api::query_object,
            auth::CompanyIdParams,
            tasks::{TaskAgentsBatchQuery, TaskIdParams},
        },
        validation::{ValidPath, valid},
    },
    identity::companies,
    platform::database::SuplexDatabase,
    runtimes::{task_harness::ReaderSession, task_harness_registry},
    tasks::repository,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/agents", get(task_agents))
        .route(
            "/api/companies/{company_id}/task-agents",
            get(company_task_agents),
        )
}

fn respond(result: Result<Value, Box<dyn Error>>, cookies: Vec<String>) -> Response {
    let mut response = match result {
        Ok(value) => {
            let mut response = Json(value).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                "private, no-store".parse().expect("cache header"),
            );
            response
        }
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

struct AgentTask {
    id: String,
    status: TaskStatus,
    rows: RootObservationRows,
}

fn task(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<AgentTask, Box<dyn Error>> {
    let record = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
    companies::require_company_access(database, user_id, &record.company_id)?;
    Ok(AgentTask {
        id: record.id,
        status: record.status,
        rows: root_session_store::root_observation_rows(database, task_id)?,
    })
}

fn visible_tasks(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
    ids: &[String],
) -> Result<Vec<AgentTask>, Box<dyn Error>> {
    companies::require_company_access(database, user_id, company_id)?;
    let mut tasks = Vec::new();
    for id in ids {
        let archived: Option<Option<String>> = database
            .connection()
            .query_row(
                "SELECT archived_at FROM suplex_tasks WHERE id = ?1 AND company_id = ?2",
                rusqlite::params![id, company_id],
                |row| row.get(0),
            )
            .optional()?;
        if archived != Some(None) {
            continue;
        }
        tasks.push(task(database, user_id, id)?);
    }
    Ok(tasks)
}

fn label(session: &SessionRow) -> &'static str {
    workflows::role_label(
        session.kind.as_str(),
        session.advisor_role.map(AdvisorRole::as_str),
    )
}

/// The runtime that owns the native session reports its status.
fn native_status(
    database_path: &std::path::Path,
    session: &SessionRow,
) -> Option<(&'static str, f64)> {
    let native_session_id = session.native_session_id.as_deref()?;
    task_harness_registry::native_session_reader(native_session_id)?
        .status(&ReaderSession {
            database_path,
            session_id: &session.id,
            native_session_id,
            instance_home_directory: session
                .profile
                .as_ref()
                .and_then(TaskProfile::instance_home_directory)
                .map(std::path::Path::new),
        })
        .ok()
}

/// Null when the native time is not a valid date.
fn iso_timestamp(value: f64) -> Value {
    DateTime::<Utc>::from_timestamp_millis(value as i64)
        .filter(|_| value.is_finite())
        .map_or(Value::Null, |time| json!(rfc3339_millis(time)))
}

fn agents(task: &AgentTask, database_path: &std::path::Path) -> Vec<Value> {
    task.rows
        .sessions
        .iter()
        .filter(|session| session.current)
        .map(|session| {
            let (status, changed_at) = if matches!(
                session.lifecycle,
                SessionLifecycle::Stopped | SessionLifecycle::Cancelled
            ) {
                let changed = session
                    .stopped_at
                    .as_ref()
                    .or(session.stop_requested_at.as_ref());
                ("stopped", json!(changed))
            } else if session.native_session_id.is_none() {
                ("queued", Value::Null)
            } else {
                match native_status(database_path, session) {
                    Some(("busy", _)) => ("working", Value::Null),
                    Some(("retry", _)) => ("retrying", Value::Null),
                    Some(_)
                        if session.kind == SessionKind::Root
                            && task.status == TaskStatus::WaitingHuman =>
                    {
                        ("waiting_human", Value::Null)
                    }
                    Some((_, time)) => ("idle", iso_timestamp(time)),
                    None => ("unknown", Value::Null),
                }
            };
            json!({
                "id":session.id, "role":session.kind,
                "advisorRole":session.advisor_role, "label":label(session),
                "paneId":session.pane_id, "status":status,
                "statusChangedAt":changed_at,
            })
        })
        .collect()
}

fn database_path(database: &SuplexDatabase) -> Result<PathBuf, Box<dyn Error>> {
    Ok(PathBuf::from(
        database
            .connection()
            .path()
            .ok_or("Task database has no file path")?,
    ))
}

async fn task_agents(
    State(state): State<AppState>,
    ValidPath(TaskIdParams { task_id }): ValidPath<TaskIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (task_snapshot, database_path) = match state.with_database(|database| {
        Ok::<_, Box<dyn Error>>((
            task(database, &user_id, &task_id)?,
            database_path(database)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => return respond(Err(error), cookies),
    };
    let result = match tokio::task::spawn_blocking(
        move || json!({"agents":agents(&task_snapshot, &database_path)}),
    )
    .await
    {
        Ok(value) => state
            .with_database(|database| task(database, &user_id, &task_id))
            .map(|_| value),
        Err(error) => Err(Box::new(error) as Box<dyn Error>),
    };
    respond(result, cookies)
}

async fn company_task_agents(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    let ids = match valid::<TaskAgentsBatchQuery>(query_object(query.as_deref())) {
        Ok(query) => query.task_id,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (tasks, database_path) = match state.with_database(|database| {
        Ok::<_, Box<dyn Error>>((
            visible_tasks(database, &user_id, &company_id, &ids)?,
            database_path(database)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => return respond(Err(error), cookies),
    };
    let results = match tokio::task::spawn_blocking(move || {
        tasks
            .iter()
            .map(|task| json!({"taskId":task.id,"agents":agents(task,&database_path)}))
            .collect::<Vec<_>>()
    })
    .await
    {
        Ok(value) => value,
        Err(error) => return respond(Err(Box::new(error)), cookies),
    };
    let result = state
        .with_database(|database| visible_tasks(database, &user_id, &company_id, &ids))
        .map(|visible| {
            let ids = visible.into_iter().map(|task| task.id).collect::<std::collections::HashSet<_>>();
            json!({"tasks":results.into_iter().filter(|task| task["taskId"].as_str().is_some_and(|id| ids.contains(id))).collect::<Vec<_>>()})
        });
    respond(result, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/task_agents.rs");
