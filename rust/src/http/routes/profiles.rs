pub(crate) use crate::http::access::authorize_profile as authorize;
use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    http::{AppState, contracts},
    profiles::agent_profiles::{self, ProfileInput, ProfilePatch},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/profiles", get(list))
        .route("/api/admin/profiles", post(create))
        .route("/api/admin/profiles/defaults", post(choose_defaults))
        .route(
            "/api/admin/profiles/{agent_id}",
            axum::routing::patch(update).delete(delete),
        )
        .route("/api/admin/profiles/{agent_id}/duplicate", post(duplicate))
}

fn validated_response(contract: &str, value: Value, status: StatusCode) -> Response {
    match contracts::validate(contract, Some(&value)) {
        Some(Ok(value)) => (status, Json(value)).into_response(),
        _ => auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let mut input = Map::new();
    if let Some(query) = query {
        for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
            let value = json!(value.into_owned());
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
    }
    let Some(validation) = contracts::validate(
        "projects.ProfileListQuerySchema",
        Some(&Value::Object(input)),
    ) else {
        return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
    };
    let query = match validation {
        Ok(value) => value,
        Err(issues) => return auth::validation_error(issues),
    };
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let include_archived = query.get("includeArchived").and_then(Value::as_str) == Some("true");
    let response = match state
        .with_database(|database| agent_profiles::list(database, &user_id, include_archived))
    {
        Ok(profiles) => validated_response(
            "projects.ProfileListResponseSchema",
            json!({ "profiles": profiles }),
            StatusCode::OK,
        ),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn create(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match auth::validated_body(&headers, &body, "projects.ProfileBodySchema") {
        Ok(input) => input,
        Err(error) => return *error,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let input: ProfileInput = match serde_json::from_value(input) {
        Ok(input) => input,
        Err(_) => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    let response = match state
        .with_database(|database| agent_profiles::create(database, &user_id, &input, Utc::now()))
    {
        Ok(profile) => validated_response(
            "projects.ProfileResponseSchema",
            json!(profile),
            StatusCode::CREATED,
        ),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    body: Bytes,
) -> Response {
    let input = match auth::validated_body(&headers, &body, "projects.ProfilePatchBodySchema") {
        Ok(input) => input,
        Err(error) => return *error,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "PATCH", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let patch: ProfilePatch = match serde_json::from_value(input) {
        Ok(patch) => patch,
        Err(_) => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    let response = match state.with_database(|database| {
        agent_profiles::update(database, &user_id, &agent_id, patch, Utc::now())
    }) {
        Ok(profile) => validated_response(
            "projects.ProfileResponseSchema",
            json!(profile),
            StatusCode::OK,
        ),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn duplicate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        agent_profiles::duplicate(database, &user_id, &agent_id, Utc::now())
    }) {
        Ok(profile) => validated_response(
            "projects.ProfileResponseSchema",
            json!(profile),
            StatusCode::CREATED,
        ),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "DELETE", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| agent_profiles::delete(database, &user_id, &agent_id, Utc::now()))
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn choose_defaults(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        agent_profiles::choose_defaults(
            database,
            &user_id,
            agent_profiles::provider_installed,
            Utc::now(),
        )
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/profiles.rs");
