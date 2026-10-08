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
use serde_json::{Value, json};

use crate::{
    coordination::workflow_records::normalize_workflow_input,
    http::{
        AppState,
        contracts::typed::{
            Contract,
            task_templates::{
                ProjectTemplatesParams, SaveBody, TemplateConfiguration, TemplatePatch,
            },
        },
        session,
        validation::{Valid, ValidPath, checked, parsed_body},
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

/// After body validation, check the request origin and the session, in the
/// Validate before checking origin and session.
fn admitted(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> Result<(String, Vec<String>), Box<Response>> {
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
        Some(user) => Ok((user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn respond<T: serde::Serialize>(
    state: &AppState,
    headers: &HeaderMap,
    method: Method,
    status: StatusCode,
    operation: impl FnOnce(&mut SuplexDatabase, &str) -> Result<T, Box<dyn Error + Send + Sync>>,
) -> Response {
    let (user_id, cookies) = match admitted(state, headers, &method) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = match state.with_database(|database| operation(database, &user_id)) {
        Ok(_) if status == StatusCode::NO_CONTENT => status.into_response(),
        Ok(value) => (status, Json(value)).into_response(),
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

async fn create(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Apply workflow defaults before validating the request.
    let mut raw = match parsed_body(&headers, &body) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Some(Value::Object(fields)) = raw.as_mut()
        && let Err(message) = normalize_workflow_input(fields, false)
    {
        return auth::error(StatusCode::UNPROCESSABLE_ENTITY, &message);
    }
    let input = match checked(TemplateConfiguration::parse(raw.as_ref())) {
        Ok(configuration) => match serde_json::to_value(configuration) {
            Ok(Value::Object(value)) => value,
            _ => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
        },
        Err(response) => return *response,
    };
    respond(
        &state,
        &headers,
        Method::POST,
        StatusCode::CREATED,
        |database, user_id| templates::create(database, user_id, &project_id, input),
    )
}

async fn save_from_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    Valid(SaveBody { name }): Valid<SaveBody>,
) -> Response {
    respond(
        &state,
        &headers,
        Method::POST,
        StatusCode::CREATED,
        |database, user_id| templates::create_from_task(database, user_id, &task_id, &name),
    )
}

async fn update(
    State(state): State<AppState>,
    Path(template_id): Path<String>,
    headers: HeaderMap,
    Valid(TemplatePatch(changes)): Valid<TemplatePatch>,
) -> Response {
    respond(
        &state,
        &headers,
        Method::PATCH,
        StatusCode::OK,
        |database, user_id| templates::update(database, user_id, &template_id, changes),
    )
}

async fn delete(
    State(state): State<AppState>,
    Path(template_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    respond(
        &state,
        &headers,
        Method::DELETE,
        StatusCode::NO_CONTENT,
        |database, user_id| templates::delete(database, user_id, &template_id),
    )
}

async fn list(
    State(state): State<AppState>,
    ValidPath(ProjectTemplatesParams { project_id }): ValidPath<ProjectTemplatesParams>,
    headers: HeaderMap,
) -> Response {
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
