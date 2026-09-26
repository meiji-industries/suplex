use crate::http::error::ApiError;
use axum::{
    Json, Router,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{
    coordination::workflow_records::{self, WorkflowRecord},
    http::{
        AppState,
        contracts::typed::{
            agent_api::query_object,
            projects::IncludeArchivedQuery,
            workflows::{WorkflowInput, WorkflowPatch},
        },
        session,
        validation::{Valid, valid},
    },
    platform::database::{DatabaseResult, SuplexDatabase},
};

use super::auth;

#[derive(Serialize)]
struct WorkflowList {
    workflows: Vec<WorkflowRecord>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workflows", get(list))
        .route("/api/admin/workflows", post(create))
        .route("/api/admin/workflows/{workflow_id}", patch(update))
        .route(
            "/api/admin/workflows/{workflow_id}/duplicate",
            post(duplicate),
        )
}

/// After body validation, check the request origin and the session, and run
/// the service operation, in the TypeScript hook order.
fn mutate(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    status: StatusCode,
    values: Map<String, Value>,
    operation: impl FnOnce(
        &mut SuplexDatabase,
        &str,
        Map<String, Value>,
    ) -> DatabaseResult<WorkflowRecord>,
) -> Response {
    if !session::csrf_allowed(&state.session_config, headers, method, false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let session = match state.with_database(|database| {
        session::session_user(database, headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(value) => value,
        Err(error) => return ApiError::response(error),
    };
    let mut response = match session.user {
        None => auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
        Some(user) => match state.with_database(|database| operation(database, &user.id, values)) {
            Ok(record) => (status, Json(record)).into_response(),
            Err(error) => ApiError::response(error),
        },
    };
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(WorkflowInput(values)): Valid<WorkflowInput>,
) -> Response {
    mutate(
        &state,
        &headers,
        "POST",
        StatusCode::CREATED,
        values,
        workflow_records::create,
    )
}

async fn update(
    State(state): State<AppState>,
    Path(workflow_id): Path<String>,
    headers: HeaderMap,
    Valid(WorkflowPatch(values)): Valid<WorkflowPatch>,
) -> Response {
    mutate(
        &state,
        &headers,
        "PATCH",
        StatusCode::OK,
        values,
        |database, user_id, changes| {
            workflow_records::update(database, user_id, &workflow_id, changes)
        },
    )
}

async fn duplicate(
    State(state): State<AppState>,
    Path(workflow_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    mutate(
        &state,
        &headers,
        "POST",
        StatusCode::CREATED,
        Map::new(),
        |database, user_id, _| workflow_records::duplicate(database, user_id, &workflow_id),
    )
}

async fn list(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let include_archived = match valid::<IncludeArchivedQuery>(query_object(uri.query())) {
        Ok(query) => query.include_archived.is_some(),
        Err(response) => return *response,
    };
    let session = match state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(value) => value,
        Err(error) => return ApiError::response(error),
    };
    let Some(user) = session.user else {
        let mut response = auth::error(
            axum::http::StatusCode::UNAUTHORIZED,
            "Authentication required",
        );
        auth::append_cookies(&mut response, session.set_cookies);
        return response;
    };
    let mut response = match state
        .with_database(|database| workflow_records::list(database, &user.id, include_archived))
    {
        Ok(workflows) => Json(WorkflowList { workflows }).into_response(),
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

#[cfg(test)]
include!("../../../tests/routes/workflows.rs");
