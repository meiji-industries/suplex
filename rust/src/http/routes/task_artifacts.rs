//! Authenticated bytes for task-owned artifacts, including image previews.

use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use crate::shared::hash::sha256_hex;
use crate::tasks::TaskError;
use std::error::Error;

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;

use crate::{
    coordination::root_session_store::{self, TaskArtifact},
    http::{AppState, contracts::typed::tasks::TaskArtifactParams, session, validation::ValidPath},
    platform::artifacts,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/artifacts/{artifact_id}", get(read))
        .route("/api/tasks/{task_id}/images/{artifact_id}", get(read))
}

fn scoped_artifact(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    artifact_id: &str,
) -> Result<TaskArtifact, Box<dyn Error>> {
    state.with_database(|database| {
        crate::tasks::authorize_task(database, user_id, task_id)?;
        root_session_store::task_artifact(database, task_id, artifact_id)?
            .ok_or_else(|| TaskError::not_found().into())
    })
}

fn reauthorize(state: &AppState, user_id: &str, task_id: &str) -> Result<(), Box<dyn Error>> {
    state.with_database(|database| {
        crate::tasks::authorize_task(database, user_id, task_id)?;
        Ok(())
    })
}

async fn read(
    State(state): State<AppState>,
    ValidPath(TaskArtifactParams {
        task_id,
        artifact_id,
    }): ValidPath<TaskArtifactParams>,
    headers: HeaderMap,
) -> Response {
    let session = match state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return ApiError::response(error),
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
        Err(error) => {
            return with_cookies(ApiError::response(error), cookies);
        }
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
        artifacts::read(&root, &company_id, &storage_path)
            .map_err(crate::http::error::public_failure)
    })
    .await;
    let bytes = match bytes {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(failure)) => {
            return with_cookies(failure.into_response(), cookies);
        }
        Err(_) => {
            return with_cookies(
                auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
                cookies,
            );
        }
    };
    if let Err(error) = reauthorize(&state, &user.id, &task_id) {
        return with_cookies(ApiError::response(error), cookies);
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
    let Ok(content_type) = artifact.mime_type.parse() else {
        return with_cookies(
            auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            cookies,
        );
    };
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        axum::http::HeaderValue::from_static("nosniff"),
    );
    with_cookies(response, cookies)
}
