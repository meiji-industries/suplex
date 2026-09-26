//! Project task templates: list, create, save from a task, edit, and delete.

use crate::http::error::ApiError;
use std::error::Error;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    coordination::workflow_records::normalize_workflow_input,
    http::{
        AppState,
        contracts::typed::{ContractResult, finding, task_templates as contracts},
        session, validation,
    },
    platform::database::SuplexDatabase,
    tasks::templates,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/{project_id}/task-templates",
            get(list).post(create),
        )
        .route(
            "/api/tasks/{task_id}/save-as-template",
            post(save_from_task),
        )
        .route(
            "/api/task-templates/{template_id}",
            patch(update).delete(delete),
        )
}

type Parser<T> = fn(Option<&Value>) -> ContractResult<T>;

/// Parse the body, then check the request origin and the session, in the
/// TypeScript hook order.
fn admitted<T>(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
    body: Option<(&Bytes, Parser<T>)>,
) -> Result<(Option<T>, String, Vec<String>), Box<Response>> {
    let parsed = match body {
        Some((body, parse)) => Some(auth::validated_typed_body(headers, body, parse)?),
        None => None,
    };
    if !session::csrf_allowed(&state.session_config, headers, method.as_str(), false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(|error| Box::new(ApiError::response(error)))?;
    match session.user {
        Some(user) => Ok((parsed, user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn respond<T: serde::Serialize>(
    state: &AppState,
    status: StatusCode,
    cookies: Vec<String>,
    operation: impl FnOnce(&mut SuplexDatabase) -> Result<T, Box<dyn Error>>,
) -> Response {
    let mut response = match state.with_database(operation) {
        Ok(_) if status == StatusCode::NO_CONTENT => status.into_response(),
        Ok(value) => (status, Json(value)).into_response(),
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

fn object_body(input: Option<&Value>) -> ContractResult<Map<String, Value>> {
    contracts::parse_create(input).and_then(|configuration| {
        match serde_json::to_value(configuration) {
            Ok(Value::Object(value)) => Ok(value),
            _ => Err(crate::http::contracts::typed::ContractFailure::Unhandled),
        }
    })
}

async fn create(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // The TypeScript preValidation hook applies workflow defaults to the raw body.
    let mut raw = match auth::parsed_body(&headers, &body) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Some(Value::Object(fields)) = raw.as_mut()
        && let Err(message) = normalize_workflow_input(fields, false)
    {
        return auth::error(StatusCode::UNPROCESSABLE_ENTITY, &message);
    }
    let input = match object_body(raw.as_ref()) {
        Ok(value) => value,
        Err(crate::http::contracts::typed::ContractFailure::Issues(findings)) => {
            return validation::validation_error_public(findings);
        }
        Err(_) => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    let (_, user_id, cookies) = match admitted::<()>(&state, &headers, &Method::POST, None) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(&state, StatusCode::CREATED, cookies, |database| {
        templates::create(database, &user_id, &project_id, input)
    })
}

async fn save_from_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, user_id, cookies) = match admitted(
        &state,
        &headers,
        &Method::POST,
        Some((&body, contracts::parse_save)),
    ) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let name = name.unwrap_or_default();
    respond(&state, StatusCode::CREATED, cookies, |database| {
        templates::create_from_task(database, &user_id, &task_id, &name)
    })
}

async fn update(
    State(state): State<AppState>,
    Path(template_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (changes, user_id, cookies) = match admitted(
        &state,
        &headers,
        &Method::PATCH,
        Some((&body, contracts::parse_update)),
    ) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let changes = changes.unwrap_or_default();
    respond(&state, StatusCode::OK, cookies, |database| {
        templates::update(database, &user_id, &template_id, changes)
    })
}

async fn delete(
    State(state): State<AppState>,
    Path(template_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (_, user_id, cookies) = match admitted::<()>(&state, &headers, &Method::DELETE, None) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(&state, StatusCode::NO_CONTENT, cookies, |database| {
        templates::delete(database, &user_id, &template_id)
    })
}

async fn list(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if project_id.is_empty() {
        return validation::validation_error_public(vec![finding(
            "too_small",
            &[json!("projectId")],
        )]);
    }
    let session = match state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return ApiError::response(error),
    };
    let mut response = match session.user {
        Some(user) => {
            match state.with_database(|database| templates::list(database, &user.id, &project_id)) {
                Ok(templates) => Json(json!({"templates":templates})).into_response(),
                Err(error) => ApiError::response(error),
            }
        }
        None => auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

#[cfg(test)]
include!("../../../tests/routes/task_templates.rs");
