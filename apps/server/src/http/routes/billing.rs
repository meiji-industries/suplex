//! Installation billing: the plan summary and the money commands.

use std::error::Error;

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use serde_json::json;

use crate::{
    billing::{self, wire::CheckoutBody},
    http::{
        AppState,
        access::{authorize, authorize_method, with_cookies},
        contracts::typed::billing::IdempotencyHeader,
        error::ApiError,
        validation::{body_contract, valid},
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/billing", get(summary))
        .route("/api/billing/trial", post(trial))
        .route("/api/billing/checkout", post(checkout))
        .route("/api/billing/portal", post(portal))
}

fn respond<T: Serialize>(
    result: Result<T, Box<dyn Error + Send + Sync>>,
    cookies: Vec<String>,
) -> Response {
    let mut response = match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => ApiError::response(error),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    with_cookies(response, cookies)
}

fn idempotency_key(headers: &HeaderMap) -> Result<String, Box<Response>> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok());
    valid::<IdempotencyHeader>(json!({ "idempotency-key": key })).map(|header| header.key)
}

async fn summary(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(billing::summary(&state, &user_id).await, cookies)
}

async fn trial(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user_id, cookies) = match authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(billing::start_trial(&state, &user_id).await, cookies)
}

async fn checkout(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(response) => return *response,
    };
    let body = match body_contract::<Option<CheckoutBody>>(&headers, &body) {
        Ok(body) => body.unwrap_or_default(),
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(
        billing::checkout(&state, &user_id, &key, body).await,
        cookies,
    )
}

async fn portal(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user_id, cookies) = match authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(billing::portal(&state, &user_id).await, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/billing.rs");
