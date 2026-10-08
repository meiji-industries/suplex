//! Web push key and the session user's browser subscriptions.

#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

use axum::{
    Json, Router,
    body::Bytes,
    extract::{State, rejection::BytesRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use chrono::Utc;

use crate::{
    http::{
        AppState, access,
        contracts::typed::web_push::{
            WebPushKeyResponse, WebPushSubscriptionRequest, WebPushUnsubscribeRequest,
        },
        error::ApiError,
        validation::body_contract,
    },
    web_push::{self, Subscription},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/web-push/key", get(key)).route(
        "/api/web-push/subscription",
        put(subscribe).delete(unsubscribe),
    )
}

fn private(mut response: Response, cookies: Vec<String>) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    auth::append_cookies(&mut response, cookies);
    response
}

fn bytes(body: Result<Bytes, BytesRejection>) -> Result<Bytes, Box<Response>> {
    body.map_err(|_| Box::new(auth::error(StatusCode::BAD_REQUEST, "Invalid request")))
}

async fn key(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match access::authenticated(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| web_push::vapid_key(database)) {
        Ok(key) => Json(WebPushKeyResponse {
            public_key: key.public_base64url(),
        })
        .into_response(),
        Err(error) => ApiError::response(error),
    };
    private(response, cookies)
}

async fn subscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let request = match bytes(body)
        .and_then(|body| body_contract::<WebPushSubscriptionRequest>(&headers, &body))
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match access::authorize_method(&state, &headers, "PUT") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let subscription = Subscription {
        endpoint: request.endpoint,
        p256dh: request.keys.p256dh,
        auth: request.keys.auth,
    };
    let response = match web_push::validate_subscription(&subscription) {
        Err(failure) => failure.into_response(),
        Ok(()) => match state.with_database(|database| {
            web_push::save_subscription(database, &user_id, &subscription, Utc::now())
        }) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => ApiError::response(error),
        },
    };
    private(response, cookies)
}

async fn unsubscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let request = match bytes(body)
        .and_then(|body| body_contract::<WebPushUnsubscribeRequest>(&headers, &body))
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match access::authorize_method(&state, &headers, "DELETE") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| {
        web_push::delete_subscription(database, &user_id, &request.endpoint)
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    private(response, cookies)
}

include!("../../../tests/routes/web_push.rs");
