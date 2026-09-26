use crate::http::error::ApiError;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    coordination::workflow_records::{self, WorkflowRecord},
    http::{
        AppState, contracts,
        contracts::typed::{ContractResult, workflows as workflow_contracts},
        session,
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

type Parser = fn(Option<&Value>) -> ContractResult<Map<String, Value>>;

/// Validate the body, then check the request origin and the session, and run
/// the service operation, in the TypeScript hook order.
fn mutate(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    status: StatusCode,
    body: Option<(&Bytes, Parser)>,
    operation: impl FnOnce(
        &mut SuplexDatabase,
        &str,
        Map<String, Value>,
    ) -> DatabaseResult<WorkflowRecord>,
) -> Response {
    let values = match body {
        Some((body, parse)) => match auth::validated_typed_body(headers, body, parse) {
            Ok(value) => value,
            Err(response) => return *response,
        },
        None => Map::new(),
    };
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

async fn create(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    mutate(
        &state,
        &headers,
        "POST",
        StatusCode::CREATED,
        Some((&body, workflow_contracts::parse_input)),
        workflow_records::create,
    )
}

async fn update(
    State(state): State<AppState>,
    Path(workflow_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    mutate(
        &state,
        &headers,
        "PATCH",
        StatusCode::OK,
        Some((&body, workflow_contracts::parse_patch)),
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
        None,
        |database, user_id, _| workflow_records::duplicate(database, user_id, &workflow_id),
    )
}

fn include_archived(uri: &axum::http::Uri) -> Result<bool, Box<Response>> {
    let mut input = Map::new();
    for (name, selected) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
    {
        let value = json!(selected.into_owned());
        if let Some(previous) = input.get_mut(name.as_ref()) {
            if let Value::Array(values) = previous {
                values.push(value);
            } else {
                *previous = Value::Array(vec![previous.clone(), value]);
            }
        } else {
            input.insert(name.into_owned(), value);
        }
    }
    match contracts::validate(
        "workflows.WorkflowListQuerySchema",
        Some(&Value::Object(input)),
    ) {
        Some(Ok(query)) => Ok(query.get("includeArchived").and_then(Value::as_str) == Some("true")),
        Some(Err(issues)) => Err(Box::new(auth::validation_error(issues))),
        None => Err(Box::new(auth::error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

async fn list(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    let include_archived = match include_archived(&uri) {
        Ok(value) => value,
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
