//! Authenticated bytes for task-owned artifacts, including image previews.

use crate::shared::hash::sha256_hex;
use crate::tasks::TaskError;
use std::error::Error;

use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::json;

use crate::{
    coordination::root_session_store::{self, TaskArtifact},
    http::{AppState, session, validation},
    identity::companies,
    platform::artifacts,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/artifacts/{artifact_id}", get(read))
        .route("/api/tasks/{task_id}/images/{artifact_id}", get(read))
}

fn params(task_id: &str, artifact_id: &str) -> Result<(), Box<Response>> {
    let mut findings = Vec::new();
    for (name, value) in [("taskId", task_id), ("artifactId", artifact_id)] {
        let code = match value.encode_utf16().count() {
            0 => Some("too_small"),
            1..=256 => None,
            _ => Some("too_big"),
        };
        if let Some(code) = code {
            findings.push(json!({"code":format!("invalid-{code}"),"field":format!(".{name}"),"message":"Request value is invalid"}));
        }
    }
    if findings.is_empty() {
        Ok(())
    } else {
        Err(Box::new(validation::validation_error_public(findings)))
    }
}

fn not_found() -> Box<dyn Error> {
    TaskError::not_found().into()
}

fn scoped_artifact(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    artifact_id: &str,
) -> Result<TaskArtifact, Box<dyn Error>> {
    state.with_database(|database| {
        let company_id: Option<String> = database
            .connection()
            .query_row(
                "SELECT company_id FROM suplex_tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()?;
        let company_id = company_id.ok_or_else(not_found)?;
        companies::require_company_access(database, user_id, &company_id)?;
        root_session_store::task_artifact(database, task_id, artifact_id)?.ok_or_else(not_found)
    })
}

fn reauthorize(state: &AppState, user_id: &str, task_id: &str) -> Result<(), Box<dyn Error>> {
    state.with_database(|database| {
        let company_id: Option<String> = database
            .connection()
            .query_row(
                "SELECT company_id FROM suplex_tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()?;
        companies::require_company_access(database, user_id, &company_id.ok_or_else(not_found)?)?;
        Ok(())
    })
}

fn with_cookies(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

async fn read(
    State(state): State<AppState>,
    Path((task_id, artifact_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = params(&task_id, &artifact_id) {
        return *response;
    }
    let session = match state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return auth::service_error(error),
    };
    let Some(user) = session.user else {
        return with_cookies(
            auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
            session.set_cookies,
        );
    };
    let cookies = session.set_cookies;
    let artifact = match scoped_artifact(&state, &user.id, &task_id, &artifact_id) {
        Ok(artifact) => artifact,
        Err(error) => return with_cookies(auth::service_error(error), cookies),
    };
    let Some(root) = state.artifact_root.clone() else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
    };
    let company_id = artifact.company_id.clone();
    let storage_path = artifact.storage_path.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        artifacts::read(&root, &company_id, &storage_path).map_err(auth::public_failure)
    })
    .await;
    let bytes = match bytes {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(failure)) => return with_cookies(failure.into_response(), cookies),
        Err(_) => {
            return with_cookies(
                auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
                cookies,
            );
        }
    };
    if let Err(error) = reauthorize(&state, &user.id, &task_id) {
        return with_cookies(auth::service_error(error), cookies);
    }
    if sha256_hex(&bytes) != artifact.sha256 {
        return with_cookies(
            auth::error(
                StatusCode::CONFLICT,
                "The stored artifact failed its integrity check",
            ),
            cookies,
        );
    }
    let mut response = Response::new(Body::from(bytes));
    let content_type = match artifact.mime_type.parse() {
        Ok(content_type) => content_type,
        Err(_) => {
            return with_cookies(
                auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
                cookies,
            );
        }
    };
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    with_cookies(response, cookies)
}
