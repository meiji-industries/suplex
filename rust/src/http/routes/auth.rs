use std::error::Error;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::json;

use crate::identity::auth::{self, AuthFailure};

use super::super::{AppState, session};

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

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let result = state.with_database(|database| {
        let required = auth::bootstrap_required(database)?;
        let session =
            session::session_user(database, &headers, Some(&state.session_config), Utc::now())?;
        Ok::<_, Box<dyn Error>>((required, session))
    });
    match result {
        Ok((required, session)) => {
            let mut response = Json(json!({
                "required": required,
                "authenticated": session.user.is_some(),
            }))
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
            let mut response = Json(json!({ "user": user })).into_response();
            append_cookies(&mut response, session.set_cookies);
            response
        }
        Err(error) => service_error(error),
    }
}

async fn update_me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "PATCH", false) {
        return error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let result = state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    });
    match result {
        Ok(session) => {
            if session.user.is_none() {
                return error(StatusCode::UNAUTHORIZED, "Authentication required");
            }
            let mut response = not_ported();
            append_cookies(&mut response, session.set_cookies);
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
    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::body::to_bytes;

    fn state() -> (AppState, std::path::PathBuf) {
        let filename = std::env::temp_dir().join(format!(
            "suplex_auth_route_{}_{}.sqlite",
            std::process::id(),
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
}
