use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    http::contracts::{self, typed},
    identity::admin,
};

use super::{super::AppState, auth};

#[derive(Serialize)]
struct Invitations {
    invitations: Vec<admin::InvitationSummary>,
}
#[derive(Serialize)]
struct Users {
    users: Vec<crate::identity::auth::AuthUser>,
}
#[derive(Serialize)]
struct Credentials {
    credentials: Vec<admin::CredentialSummary>,
}
#[derive(Serialize)]
struct AuditEvents {
    events: Vec<admin::AuditEvent>,
}
fn validation_params(contract: &str, params: Value) -> Result<(), Box<Response>> {
    match contracts::validate(contract, Some(&params)) {
        Some(Ok(_)) => Ok(()),
        Some(Err(issues)) => Err(Box::new(auth::validation_error(issues))),
        None => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

use crate::http::access::authorize_method as authenticated;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/invitations",
            get(list_invitations).post(invite_user),
        )
        .route("/api/admin/users", get(list_users))
        .route("/api/admin/credentials", get(list_credentials))
        .route(
            "/api/admin/credentials/{credential_id}/revoke",
            post(revoke_credential),
        )
        .route("/api/admin/users/{user_id}/revoke", post(revoke_user))
        .route("/api/admin/audit", get(list_audit))
}

async fn invite_user(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let parsed = match auth::validated_typed_body(&headers, &body, typed::auth::parse_display_name)
    {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let (actor, cookies) = match authenticated(&state, &headers, "POST") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        admin::invite_user(database, &actor, &parsed.display_name, Utc::now())
    }) {
        Ok(invitation) => (StatusCode::CREATED, Json(invitation)).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn list_invitations(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "GET") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| admin::list_invitations(database, &actor, Utc::now()))
    {
        Ok(invitations) => Json(Invitations { invitations }).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
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

async fn list_credentials(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "GET") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| admin::list_credentials(database, &actor)) {
        Ok(credentials) => Json(Credentials { credentials }).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn revoke_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(credential_id): Path<String>,
) -> Response {
    if let Err(error) = validation_params(
        "common.CredentialIdParamsSchema",
        json!({"credentialId": credential_id}),
    ) {
        return *error;
    }
    let (actor, cookies) = match authenticated(&state, &headers, "POST") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        admin::revoke_credential(database, &actor, &credential_id, Utc::now())
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn revoke_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Response {
    if let Err(error) = validation_params("common.UserIdParamsSchema", json!({"userId": user_id})) {
        return *error;
    }
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
