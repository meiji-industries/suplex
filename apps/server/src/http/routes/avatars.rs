//! Avatar directory, image, and update routes.

use crate::http::access::with_cookies;
use crate::http::error::ApiError;
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
        contracts::typed::avatars::{AvatarOwnerParams, AvatarUpdateBody},
        validation::{ValidPath, body_contract, valid},
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

async fn list(State(state): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| avatars::list(database, &user_id)) {
        Ok(avatars) => Json(json!({"avatars": avatars})).into_response(),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn image(
    State(state): State<AppState>,
    ValidPath(AvatarOwnerParams { owner_id }): ValidPath<AvatarOwnerParams>,
    headers: axum::http::HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(
        |database| -> Result<Response, Box<dyn Error + Send + Sync>> {
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
        },
    );
    let mut response = match result {
        Ok(response) => response,
        Err(error) => ApiError::response(error),
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
    // The body limit answers before the owner id is checked.
    let patch = match valid::<AvatarOwnerParams>(json!({"ownerId": owner_id}))
        .and_then(|_| body_contract::<AvatarUpdateBody>(&headers, &body))
    {
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
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/avatars.rs");
