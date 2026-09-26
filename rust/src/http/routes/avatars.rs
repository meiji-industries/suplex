//! Avatar directory, image, and update routes (`src/http/routes/avatars.ts`).

use std::error::Error;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State, rejection::BytesRejection},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;

use crate::{
    http::{
        AppState,
        contracts::typed::{self, avatars as contracts},
        validation,
    },
    identity::avatars::{self, MAX_AVATAR_IMAGE_BASE64_LENGTH},
};

use super::{auth, profiles::authorize};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/avatars", get(list)).route(
        "/api/avatars/{owner_id}",
        get(image).put(update).layer(DefaultBodyLimit::max(
            MAX_AVATAR_IMAGE_BASE64_LENGTH + 64 * 1024,
        )),
    )
}

fn with_cookies(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

fn owner_params(owner_id: &str) -> Result<(), Box<Response>> {
    match contracts::parse_owner_params(Some(&json!({"ownerId": owner_id}))) {
        Ok(_) => Ok(()),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(validation::validation_error_public(findings)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

async fn list(State(state): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| avatars::list(database, &user_id)) {
        Ok(avatars) => Json(json!({"avatars": avatars})).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

async fn image(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(response) = owner_params(&owner_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<Response, Box<dyn Error>> {
        if let Some(uploaded) = avatars::image(database, &user_id, &owner_id)? {
            return Ok(
                ([(header::CONTENT_TYPE, uploaded.mime_type)], uploaded.image).into_response(),
            );
        }
        let (kind, seed) = avatars::owner(database, &user_id, &owner_id)?;
        if kind == "project"
            && let Ok(Some(favicon)) = avatars::project_favicon(database, &user_id, &owner_id)
        {
            return Ok(([(header::CONTENT_TYPE, "image/x-icon")], favicon).into_response());
        }
        Ok((
            StatusCode::FOUND,
            [(header::LOCATION, avatars::dicebear_url(kind, &seed))],
        )
            .into_response())
    });
    let mut response = match result {
        Ok(response) => response,
        Err(error) => auth::service_error(error),
    };
    let values = response.headers_mut();
    values.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    values.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    with_cookies(response, cookies)
}

async fn update(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(body) => body,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error":"Request is too large","findings":[{"code":"request-too-large","field":"images","message":"Attach fewer or smaller images and submit again"}]}))).into_response();
        }
        Err(_) => return auth::error(StatusCode::BAD_REQUEST, "Invalid request"),
    };
    if let Err(response) = owner_params(&owner_id) {
        return *response;
    }
    let patch = match auth::validated_typed_body(&headers, &body, contracts::parse_update) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "PUT", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state
        .with_database(|database| avatars::update(database, &user_id, &owner_id, &patch))
    {
        Ok(record) => Json(record).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/avatars.rs");
