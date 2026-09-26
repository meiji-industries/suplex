//! `http/routes/update.ts` and the client lifecycle report from
//! `http/routes/authenticated.ts`. The Rust binary runs without the Node
//! supervisor, so it reports its own build as current and cannot restart.

use crate::http::error::ApiError;
use std::sync::LazyLock;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{RawQuery, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::{
            agent_api::query_object,
            system::{ClientLifecycle, UpdateQuery},
        },
        session,
        validation::{body_contract, valid},
    },
    identity::auth::AuthUser,
    platform::system_events,
};

use super::auth;

/// One identity per server process, as `server.ts` creates it.
static INSTANCE_ID: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/update", get(read_update))
        .route("/api/update/restart", post(restart))
        .route("/api/system/client-lifecycle", post(client_lifecycle))
}

fn user(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> Result<(AuthUser, Vec<String>), Box<Response>> {
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
        Some(user) => Ok((user, session.set_cookies)),
        None => Err(Box::new(auth::error(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        ))),
    }
}

fn finish(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

pub fn current_revision() -> Option<&'static str> {
    let revision = env!("SUPLEX_RUST_REVISION");
    (revision.len() == 40
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(revision)
}

async fn read_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = valid::<UpdateQuery>(query_object(query.as_deref())) {
        return *response;
    }
    let (_, cookies) = match user(&state, &headers, &Method::GET) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut body = json!({ "status": { "kind": "current" } });
    if let Some(revision) = current_revision() {
        body["currentRevision"] = json!(revision);
    }
    body["canRestart"] = json!(false);
    body["instanceId"] = json!(*INSTANCE_ID);
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    finish(response, cookies)
}

async fn restart(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user, cookies) = match user(&state, &headers, &Method::POST) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = if user.role != "admin" {
        auth::error(StatusCode::FORBIDDEN, "Administrator access necessary")
    } else {
        auth::error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Suplex update control is not available.",
        )
    };
    finish(response, cookies)
}

async fn client_lifecycle(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.len() > 1024 {
        return auth::error(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large");
    }
    let parsed = match body_contract::<ClientLifecycle>(&headers, &body) {
        Ok(parsed) => parsed,
        Err(response) => return *response,
    };
    let (_, cookies) = match user(&state, &headers, &Method::POST) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut context = Map::new();
    context.insert("source".into(), json!("http"));
    if let Some(client) = headers
        .get("x-suplex-tab-id")
        .and_then(|value| value.to_str().ok())
    {
        context.insert("clientId".into(), json!(client));
    }
    let mut event = json!({ "type": "client_lifecycle" });
    if let (Some(event), Ok(Value::Object(fields))) =
        (event.as_object_mut(), serde_json::to_value(parsed))
    {
        event.extend(fields);
    }
    system_events::emit_with_context(event, context);
    finish(StatusCode::NO_CONTENT.into_response(), cookies)
}

#[cfg(test)]
include!("../../../tests/routes/update.rs");
