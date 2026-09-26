//! Browser authentication and response cookies. Routes retain their validation order.
use std::sync::{Arc, Mutex};

use axum::{
    extract::{FromRequestParts, Request, State},
    http::{HeaderMap, HeaderValue, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::Utc;

use super::{AppState, error::ApiError, session};
use crate::{identity::auth::AuthUser, shared::PublicFailure};

#[derive(Clone, Default)]
struct RefreshCookies(Arc<Mutex<Vec<String>>>);

pub async fn cookie_refresh(mut request: Request, next: Next) -> Response {
    let cookies = RefreshCookies::default();
    request.extensions_mut().insert(cookies.clone());
    let mut response = next.run(request).await;
    append_cookies(
        &mut response,
        std::mem::take(&mut *cookies.0.lock().unwrap()),
    );
    response
}

pub fn append_cookies(response: &mut Response, cookies: Vec<String>) {
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
}

pub fn with_cookies(mut response: Response, cookies: Vec<String>) -> Response {
    append_cookies(&mut response, cookies);
    response
}

pub struct SessionUser(pub AuthUser);

impl FromRequestParts<AppState> for SessionUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let (user, refresh) = Self::read(state, &parts.headers)?;
        if let Some(cookies) = parts.extensions.get::<RefreshCookies>() {
            cookies.0.lock().unwrap().extend(refresh);
        }
        Ok(Self(user))
    }
}

impl SessionUser {
    pub fn read(
        state: &AppState,
        headers: &HeaderMap,
    ) -> Result<(AuthUser, Vec<String>), ApiError> {
        let session = state
            .with_database(|database| {
                session::session_user(database, headers, Some(&state.session_config), Utc::now())
            })
            .map_err(ApiError::from)?;
        let user = session
            .user
            .ok_or_else(|| PublicFailure::new(401, "Authentication required"))?;
        Ok((user, session.set_cookies))
    }
}

pub fn authenticated(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(AuthUser, Vec<String>), Box<Response>> {
    SessionUser::read(state, headers).map_err(|error| Box::new(error.into_response()))
}

pub fn authorize_method(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
) -> Result<(String, Vec<String>), Box<Response>> {
    authorize_browser(state, headers, method, false)
}

/// Used after body/path validation where eager extraction would change error precedence.
pub fn authorize(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, Vec<String>), Box<Response>> {
    authorize_browser(state, headers, "GET", false)
}

pub fn authorize_profile(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    admin: bool,
) -> Result<(String, Vec<String>), Box<Response>> {
    authorize_browser(state, headers, method, admin)
}

fn authorize_browser(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    admin: bool,
) -> Result<(String, Vec<String>), Box<Response>> {
    Csrf::check(state, headers, method).map_err(|error| Box::new(error.into_response()))?;
    let (user, cookies) = authenticated(state, headers)?;
    if admin && user.role != "admin" {
        return Err(Box::new(with_cookies(
            PublicFailure::new(403, "Administrator access required").into_response(),
            cookies,
        )));
    }
    Ok((user.id, cookies))
}

pub struct Csrf;

impl Csrf {
    pub fn check(state: &AppState, headers: &HeaderMap, method: &str) -> Result<Self, ApiError> {
        if session::csrf_allowed(&state.session_config, headers, method, false) {
            Ok(Self)
        } else {
            Err(PublicFailure::new(403, "request_origin_invalid").into())
        }
    }
}

pub async fn csrf_layer(State(state): State<AppState>, request: Request, next: Next) -> Response {
    match Csrf::check(&state, request.headers(), request.method().as_str()) {
        Ok(_) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refresh_cookies_survive_a_domain_rejection() {
        let (state, path) = crate::http::routes::auth::tests::state();
        let app = axum::Router::new()
            .route(
                "/",
                axum::routing::get(|SessionUser(_): SessionUser| async {
                    Err::<(), ApiError>(PublicFailure::new(409, "Rejected").into())
                }),
            )
            .layer(axum::middleware::from_fn(cookie_refresh))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, app).into_future());
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/"))
            .header("host", "localhost:4111")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 409);
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            2
        );
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"error":"Rejected"})
        );
        let response = client
            .get(format!("http://{address}/"))
            .header("host", "untrusted.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn extractor_refreshes_cookies_and_csrf_keeps_its_failure_envelope() {
        let (state, path) = crate::http::routes::auth::tests::state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, crate::http::router(state.clone())).into_future());
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{address}/api/auth/me"))
            .header("host", "localhost:4111")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            2
        );
        let response = client
            .post(format!("http://{address}/api/auth/options"))
            .header("origin", "https://untrusted.example")
            .header("cookie", "sid_v1=present")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"error":"request_origin_invalid"})
        );
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(path);
    }
}
