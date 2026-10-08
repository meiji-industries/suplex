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
use serde::Serialize;

use crate::{
    coordination::{
        advisor_bridge::AdvisorRole,
        root_session_store::{self, RootObservationRows},
        workflows,
    },
    http::{
        AppState,
        contracts::{
            task_reads::{
                TaskAgent, TaskAgentStatus, TaskAgents, TaskAgentsBatchResponse, TaskAgentsResponse,
            },
            typed::{
                agent_api::query_object,
                auth::CompanyIdParams,
                tasks::{TaskAgentsBatchQuery, TaskIdParams},
            },
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

fn respond<T: Serialize>(
    result: Result<T, Box<dyn Error + Send + Sync>>,
    cookies: Vec<String>,
) -> Response {
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

pub(crate) struct AgentTask {
    id: String,
    status: TaskStatus,
    rows: RootObservationRows,
}

fn task(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<AgentTask, Box<dyn Error + Send + Sync>> {
    crate::tasks::authorize_task(database, user_id, task_id)?;
    saved_task(database, task_id)
}

/// The task's saved sessions. The caller authorizes.
pub(crate) fn saved_task(
    database: &SuplexDatabase,
    task_id: &str,
) -> Result<AgentTask, Box<dyn Error + Send + Sync>> {
    let record = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
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
) -> Result<Vec<AgentTask>, Box<dyn Error + Send + Sync>> {
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
async fn native_status(
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
        .await
        .ok()
}

/// `None` when the native time is not a valid date.
fn iso_timestamp(value: f64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value as i64)
        .filter(|_| value.is_finite())
        .map(rfc3339_millis)
}

/// `host` derives terminal ids for host terminals instead of stored Herdr panes.
pub(crate) async fn agents(
    task: &AgentTask,
    database_path: &std::path::Path,
    host: bool,
) -> std::io::Result<TaskAgents> {
    let mut agents = Vec::new();
    for session in task.rows.sessions.iter().filter(|session| session.current) {
        let (status, status_changed_at) = if matches!(
            session.lifecycle,
            SessionLifecycle::Stopped | SessionLifecycle::Cancelled
        ) {
            let changed = session
                .stopped_at
                .as_ref()
                .or(session.stop_requested_at.as_ref());
            (TaskAgentStatus::Stopped, changed.cloned())
        } else if session.native_session_id.is_none() {
            (TaskAgentStatus::Queued, None)
        } else {
            match native_status(database_path, session).await {
                Some(("busy", _)) => (TaskAgentStatus::Working, None),
                Some(("retry", _)) => (TaskAgentStatus::Retrying, None),
                Some(_)
                    if session.kind == SessionKind::Root
                        && task.status == TaskStatus::WaitingHuman =>
                {
                    (TaskAgentStatus::WaitingHuman, None)
                }
                Some((_, time)) => (TaskAgentStatus::Idle, iso_timestamp(time)),
                None => (TaskAgentStatus::Unknown, None),
            }
        };
        agents.push(TaskAgent {
            id: session.id.clone(),
            role: session.kind,
            advisor_role: session.advisor_role,
            label: label(session).into(),
            pane_id: crate::terminals::session_pane(
                host,
                session,
                task.rows.profile_of(session).provider,
            ),
            status,
            status_changed_at,
        });
    }
    Ok(TaskAgents {
        setup: crate::tasks::preparation::read_setup(database_path, &task.id)?,
        task_id: task.id.clone(),
        agents,
    })
}

fn database_path(database: &SuplexDatabase) -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
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
    let (task_snapshot, database_path, host) = match state.with_database(|database| {
        Ok::<_, Box<dyn Error + Send + Sync>>((
            task(database, &user_id, &task_id)?,
            database_path(database)?,
            crate::terminals::host_enabled(database),
        ))
    }) {
        Ok(value) => value,
        Err(error) => return respond::<()>(Err(error), cookies),
    };
    let value = agents(&task_snapshot, &database_path, host)
        .await
        .map(|result| TaskAgentsResponse {
            agents: result.agents,
            setup: result.setup,
        });
    let result = state
        .with_database(|database| task(database, &user_id, &task_id))
        .and_then(|_| value.map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>));
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
    let (tasks, database_path, host) = match state.with_database(|database| {
        Ok::<_, Box<dyn Error + Send + Sync>>((
            visible_tasks(database, &user_id, &company_id, &ids)?,
            database_path(database)?,
            crate::terminals::host_enabled(database),
        ))
    }) {
        Ok(value) => value,
        Err(error) => return respond::<()>(Err(error), cookies),
    };
    let mut results = Vec::new();
    for task in &tasks {
        match agents(task, &database_path, host).await {
            Ok(value) => results.push(value),
            Err(error) => return respond::<()>(Err(Box::new(error)), cookies),
        }
    }
    let result = state
        .with_database(|database| visible_tasks(database, &user_id, &company_id, &ids))
        .map(|visible| {
            let ids = visible
                .into_iter()
                .map(|task| task.id)
                .collect::<std::collections::HashSet<_>>();
            TaskAgentsBatchResponse {
                tasks: results
                    .into_iter()
                    .filter(|task| ids.contains(&task.task_id))
                    .collect(),
            }
        });
    respond(result, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/task_agents.rs");
