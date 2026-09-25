use std::error::Error;

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::json;

use crate::{
    http::contracts,
    identity::auth::{self, AuthFailure, AuthUser, ProfileUpdate},
};

use super::super::{AppState, session};

#[derive(Serialize)]
struct AuthEnvelope {
    user: AuthUser,
}

#[derive(Serialize)]
struct AuthStatus {
    required: bool,
    authenticated: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/me", get(me).patch(update_me))
        .route("/api/auth/sign-out", post(sign_out))
}

pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub(crate) fn not_ported() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "Experimental Rust backend has not ported this route",
            "code": "experimental_not_ported",
        })),
    )
        .into_response()
}

pub(crate) fn service_error(source: Box<dyn Error>) -> Response {
    match source.downcast::<AuthFailure>() {
        Ok(failure) => {
            let status = StatusCode::from_u16(failure.status_code)
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            if failure.code == "auth_failure" {
                error(status, failure.message)
            } else {
                (
                    status,
                    Json(json!({ "error": failure.message, "code": failure.code })),
                )
                    .into_response()
            }
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}

pub(crate) fn append_cookies(response: &mut Response, cookies: Vec<String>) {
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
}

pub(crate) fn validation_error(issues: Vec<serde_json::Value>) -> Response {
    let findings = issues
        .into_iter()
        .map(|issue| {
            let code = issue["code"].as_str().unwrap_or("request");
            let field = issue["path"]
                .as_array()
                .map(|path| {
                    format!(
                        ".{}",
                        path.iter()
                            .filter_map(serde_json::Value::as_str)
                            .collect::<Vec<_>>()
                            .join(".")
                    )
                })
                .unwrap_or_else(|| ".".to_owned());
            json!({ "code": format!("invalid-{code}"), "field": field, "message": "Request value is invalid" })
        })
        .collect::<Vec<_>>();
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "Invalid request", "findings": findings })),
    )
        .into_response()
}

pub(crate) fn validated_body(
    headers: &HeaderMap,
    body: &Bytes,
    contract: &str,
) -> Result<serde_json::Value, Box<Response>> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default();
    let parsed = if body.is_empty() {
        None
    } else if content_type == "text/plain" {
        Some(serde_json::Value::String(
            String::from_utf8_lossy(body).into_owned(),
        ))
    } else if content_type == "application/json" {
        match serde_json::from_slice::<serde_json::Value>(body) {
            Ok(value) => Some(value),
            Err(_) => return Err(Box::new(error(StatusCode::BAD_REQUEST, "Invalid request"))),
        }
    } else {
        return Err(Box::new(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported media type",
        )));
    };
    match contracts::validate(contract, parsed.as_ref()) {
        Some(Ok(value)) => Ok(value),
        Some(Err(issues)) => Err(Box::new(validation_error(issues))),
        None => Err(Box::new(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let result = state.with_database(|database| {
        let required = auth::bootstrap_required(database)?;
        let session =
            session::session_user(database, &headers, Some(&state.session_config), Utc::now())?;
        Ok::<_, Box<dyn Error>>((required, session))
    });
    match result {
        Ok((required, session)) => {
            let mut response = Json(AuthStatus {
                required,
                authenticated: session.user.is_some(),
            })
            .into_response();
            append_cookies(&mut response, session.set_cookies);
            response
        }
        Err(error) => service_error(error),
    }
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let result = state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    });
    match result {
        Ok(session) => {
            let Some(user) = session.user else {
                return error(StatusCode::UNAUTHORIZED, "Authentication required");
            };
            let mut response = Json(AuthEnvelope { user }).into_response();
            append_cookies(&mut response, session.set_cookies);
            response
        }
        Err(error) => service_error(error),
    }
}

async fn update_me(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let parsed = match validated_body(&headers, &body, "auth.ProfileBodySchema") {
        Ok(parsed) => parsed,
        Err(response) => return *response,
    };
    if !session::csrf_allowed(&state.session_config, &headers, "PATCH", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let result = state.with_database(|database| {
        let session =
            session::session_user(database, &headers, Some(&state.session_config), Utc::now())?;
        let Some(user) = session.user else {
            return Ok::<_, Box<dyn Error>>((None, session.set_cookies));
        };
        let update = ProfileUpdate {
            display_name: parsed
                .get("displayName")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
            username: parsed
                .get("username")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
            avatar_seed: parsed
                .get("avatarSeed")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
        };
        let updated = auth::update_profile(database, &user.id, update, Utc::now());
        Ok((Some(updated), session.set_cookies))
    });
    match result {
        Ok((user, cookies)) => {
            let Some(user) = user else {
                return error(StatusCode::UNAUTHORIZED, "Authentication required");
            };
            let user = match user {
                Ok(user) => user,
                Err(failure) => {
                    let mut response = service_error(failure);
                    append_cookies(&mut response, cookies);
                    return response;
                }
            };
            let mut response = Json(AuthEnvelope { user }).into_response();
            append_cookies(&mut response, cookies);
            response
        }
        Err(error) => service_error(error),
    }
}

async fn sign_out(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let result = state.with_database(|database| {
        let session = session::session_user(database, &headers, None, Utc::now())?;
        if session.user.is_none() {
            return Ok::<_, Box<dyn Error>>(false);
        }
        let token = session::cookie(&headers, session::SESSION_COOKIE_NAME)
            .or_else(|| session::cookie(&headers, session::LEGACY_SESSION_COOKIE_NAME))
            .unwrap_or_default();
        auth::sign_out(database, &token, Utc::now())?;
        Ok(true)
    });
    match result {
        Ok(false) => error(StatusCode::UNAUTHORIZED, "Authentication required"),
        Ok(true) => {
            let mut response = Json(json!({ "signedOut": true })).into_response();
            append_cookies(&mut response, session::clear_session_cookies());
            response
        }
        Err(error) => service_error(error),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::body::to_bytes;

    fn state() -> (AppState, std::path::PathBuf) {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let filename = std::env::temp_dir().join(format!(
            "suplex_auth_route_{}_{}_{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let config = session::SessionConfig {
            port: 4111,
            reachable_address: "https://suplex.example.test:4111".to_owned(),
            tailscale_exposure: "serve".to_owned(),
        };
        (AppState::new(database, config), filename)
    }

    #[tokio::test]
    async fn status_cookie_and_sign_out_follow_existing_order() {
        let (state, filename) = state();
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        let response = status(State(state.clone()), headers.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookies = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(cookies.len(), 2);
        assert!(cookies[0].starts_with("sid_v1=session_v1_"));
        assert!(cookies[1].starts_with("csrf_v1="));
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({ "required": true, "authenticated": true })
        );

        let without_cookie = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(without_cookie.status(), StatusCode::UNAUTHORIZED);
        let session_cookie = cookies[0].split(';').next().unwrap();
        headers.insert("cookie", HeaderValue::from_str(session_cookie).unwrap());
        let current = me(State(state.clone()), headers.clone()).await;
        let current_body = to_bytes(current.into_body(), 4096).await.unwrap();
        assert_eq!(
            current_body,
            r#"{"user":{"id":"user_development","displayName":"Operator","username":"operator@suplex.local","avatarSeed":"operator@suplex.local","role":"admin","status":"active","companyIds":[]}}"#
        );
        let wrong_origin = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        let signed_out = sign_out(State(state.clone()), headers.clone()).await;
        assert_eq!(signed_out.status(), StatusCode::OK);
        assert_eq!(
            signed_out
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            3
        );
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        let after = me(State(state.clone()), headers).await;
        assert_eq!(after.status(), StatusCode::UNAUTHORIZED);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn profile_body_validation_precedes_csrf_and_session() {
        let (state, filename) = state();
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:4111"));
        let signin = status(State(state.clone()), headers.clone()).await;
        let cookie = signin
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        headers.insert("cookie", HeaderValue::from_str(&cookie).unwrap());
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let invalid = update_me(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let invalid_body = to_bytes(invalid.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&invalid_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-custom", "field": ".", "message": "Request value is invalid" }] })
        );
        let wrong_type = update_me(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"username":42}"#),
        )
        .await;
        assert_eq!(wrong_type.status(), StatusCode::BAD_REQUEST);
        let wrong_type_body = to_bytes(wrong_type.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&wrong_type_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".username", "message": "Request value is invalid" }] })
        );
        let missing = update_me(State(state.clone()), headers.clone(), Bytes::new()).await;
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        let missing_body = to_bytes(missing.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&missing_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".", "message": "Request value is invalid" }] })
        );
        let mut text_headers = headers.clone();
        text_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        let text = update_me(
            State(state.clone()),
            text_headers,
            Bytes::from_static(b"hello"),
        )
        .await;
        assert_eq!(text.status(), StatusCode::BAD_REQUEST);
        let text_body = to_bytes(text.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&text_body).unwrap(),
            json!({ "error": "Invalid request", "findings": [{ "code": "invalid-invalid_type", "field": ".", "message": "Request value is invalid" }] })
        );
        let valid = Bytes::from_static(
            br#"{"displayName":"\uFEFFUpdated Operator\uFEFF","username":"\uFEFFupdated-operator\uFEFF","avatarSeed":"\uFEFFupdated-avatar\uFEFF"}"#,
        );
        let wrong_origin = update_me(State(state.clone()), headers.clone(), valid.clone()).await;
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        headers.insert("origin", HeaderValue::from_static("http://localhost:4111"));
        let updated = update_me(State(state.clone()), headers.clone(), valid).await;
        assert_eq!(updated.status(), StatusCode::OK);
        let body = to_bytes(updated.into_body(), 4096).await.unwrap();
        assert_eq!(
            body,
            r#"{"user":{"id":"user_development","displayName":"Updated Operator","username":"updated-operator","avatarSeed":"updated-avatar","role":"admin","status":"active","companyIds":[]}}"#
        );
        headers.remove("cookie");
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        let anonymous = update_me(
            State(state.clone()),
            headers,
            Bytes::from_static(br#"{"displayName":"Other"}"#),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
