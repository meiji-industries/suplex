//! Task timeline reads saved usage and current native execution evidence.

use crate::tasks::TaskError;
use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::json;

use crate::{
    http::{
        AppState,
        contracts::typed::{self, tasks as task_contracts},
        session, validation,
    },
    identity::companies,
    platform::database::SuplexDatabase,
    tasks::timeline::{self, SavedTimeline, TimelineResponse},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/tasks/{task_id}/timeline", get(task_timeline))
}

fn validate_task_id(task_id: &str) -> Result<(), Box<Response>> {
    match task_contracts::parse_task_id_params(Some(&json!({"taskId":task_id}))) {
        Ok(_) => Ok(()),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(validation::validation_error_public(findings)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

fn authorize(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, Vec<String>), Box<Response>> {
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(auth::service_error)
        .map_err(Box::new)?;
    match session.user {
        Some(user) => Ok((user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn scoped(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<(SavedTimeline, PathBuf), Box<dyn Error>> {
    let company_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    let company_id = company_id.ok_or_else(TaskError::not_found)?;
    companies::require_company_access(database, user_id, &company_id)?;
    let saved = timeline::read_saved(database, task_id)?.ok_or_else(TaskError::not_found)?;
    let database_path = PathBuf::from(
        database
            .connection()
            .path()
            .ok_or("Task database has no file path")?,
    );
    Ok((saved, database_path))
}

fn recheck(database: &SuplexDatabase, user_id: &str, task_id: &str) -> Result<(), Box<dyn Error>> {
    let company_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    companies::require_company_access(
        database,
        user_id,
        &company_id.ok_or_else(TaskError::not_found)?,
    )?;
    Ok(())
}

fn respond(result: Result<TimelineResponse, Box<dyn Error>>, cookies: Vec<String>) -> Response {
    let mut response = match result {
        Ok(value) => {
            let mut response = Json(value).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                "private, no-store".parse().expect("cache header"),
            );
            response
        }
        Err(error) => auth::service_error(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

async fn task_timeline(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_task_id(&task_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (saved, database_path) =
        match state.with_database(|database| scoped(database, &user_id, &task_id)) {
            Ok(value) => value,
            Err(error) => return respond(Err(error), cookies),
        };
    let observation = match tokio::task::spawn_blocking(move || {
        timeline::observe(&database_path, saved).map_err(|error| error.to_string())
    })
    .await
    {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return respond(Err(error.into()), cookies),
        Err(error) => return respond(Err(Box::new(error)), cookies),
    };
    let scope = state.with_database(|database| recheck(database, &user_id, &task_id));
    respond(scope.map(|_| observation), cookies)
}

#[cfg(test)]
include!("../../../tests/routes/task_timeline.rs");
