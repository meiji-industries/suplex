#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;

use crate::{
    http::{contracts::typed::auth::UserIdParams, validation::ValidPath},
    identity::admin,
};

use super::super::AppState;

#[derive(Serialize)]
struct Users {
    users: Vec<crate::identity::auth::AuthUser>,
}
#[derive(Serialize)]
struct AuditEvents {
    events: Vec<admin::AuditEvent>,
}
use crate::http::access::authorize_method as authenticated;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/users", get(list_users))
        .route("/api/admin/users/{user_id}/revoke", post(revoke_user))
        .route("/api/admin/audit", get(list_audit))
}

async fn list_users(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "GET") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| admin::list_users(database, &actor)) {
        Ok(users) => Json(Users { users }).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn revoke_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(UserIdParams { user_id }): ValidPath<UserIdParams>,
) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "POST") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| admin::revoke_user(database, &actor, &user_id, Utc::now()))
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn list_audit(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "GET") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| admin::list_audit_events(database, &actor))
    {
        Ok(events) => (
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            Json(AuditEvents { events }),
        )
            .into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/admin_identity.rs");
