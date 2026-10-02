//! Company billing: the summary and the money commands.

use std::error::Error;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use serde_json::json;

use crate::{
    billing,
    http::{
        AppState,
        access::{authorize, authorize_method, with_cookies},
        contracts::typed::{
            auth::CompanyIdParams,
            billing::{IdempotencyHeader, SeatChangeBody, SeatQuantityBody},
        },
        error::ApiError,
        validation::{Valid, ValidPath, valid},
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/companies/{company_id}/billing", get(summary))
        .route(
            "/api/companies/{company_id}/billing/checkout",
            post(checkout),
        )
        .route(
            "/api/companies/{company_id}/billing/seats/preview",
            post(preview_seats),
        )
        .route(
            "/api/companies/{company_id}/billing/seats",
            post(change_seats),
        )
        .route("/api/companies/{company_id}/billing/portal", post(portal))
}

fn respond<T: Serialize>(result: Result<T, Box<dyn Error>>, cookies: Vec<String>) -> Response {
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

async fn summary(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(
        billing::summary(&state, &user_id, &company_id).await,
        cookies,
    )
}

async fn checkout(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
    Valid(body): Valid<SeatQuantityBody>,
) -> Response {
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(
        billing::checkout(&state, &user_id, &company_id, body.quantity, &key).await,
        cookies,
    )
}

async fn preview_seats(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
    Valid(body): Valid<SeatQuantityBody>,
) -> Response {
    let (user_id, cookies) = match authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(
        billing::preview_seats(&state, &user_id, &company_id, body.quantity).await,
        cookies,
    )
}

async fn change_seats(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
    Valid(SeatChangeBody(body)): Valid<SeatChangeBody>,
) -> Response {
    let key = match idempotency_key(&headers) {
        Ok(key) => key,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(
        billing::change_seats(&state, &user_id, &company_id, &body, &key).await,
        cookies,
    )
}

async fn portal(
    State(state): State<AppState>,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize_method(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(
        billing::portal(&state, &user_id, &company_id).await,
        cookies,
    )
}

#[cfg(test)]
include!("../../../tests/routes/billing.rs");
