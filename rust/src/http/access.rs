//! Browser authentication and response cookies. Routes retain their validation order.
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::{HeaderMap, HeaderValue, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::Utc;

use super::{AppState, error::ApiError, session};
use crate::{identity::auth::AuthUser, shared::PublicFailure};

fn authority_matches(origin: &str, host: &str) -> bool {
    url::Url::parse(origin).ok().is_some_and(|url| {
        let authority = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_owned(),
        };
        authority.eq_ignore_ascii_case(host)
    })
}

pub async fn remote_access_boundary(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    request.headers_mut().remove(session::REQUEST_CLASS_HEADER);
    request.headers_mut().remove(session::VERIFIED_HTTPS_HEADER);
    request
        .headers_mut()
        .remove(session::VERIFIED_ORIGIN_HEADER);
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|value| value.0);
    let host = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let forwarded = [
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
    ]
    .iter()
    .any(|name| request.headers().contains_key(*name));
    let tailscale = request.headers().contains_key("tailscale-user-login");
    let loopback_peer = peer.is_some_and(|address| address.ip().is_loopback());
    let loopback_host = session::is_loopback_host(&state.session_config, Some(host));
    let local = loopback_peer && loopback_host && !forwarded && !tailscale;
    let policy = match state
        .with_database(|database| crate::identity::remote_access_repository::read(database))
    {
        Ok(policy) => policy,
        Err(error) => return ApiError::response(error),
    };
    let external = policy.external_https_origin();
    let forwarded_https = loopback_peer
        && request
            .headers()
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            == Some("https")
        && request
            .headers()
            .get("x-forwarded-host")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|forwarded_host| {
                external.is_some_and(|origin| authority_matches(origin, forwarded_host))
            });
    let serve_https = loopback_peer
        && state.session_config.tailscale_exposure == "serve"
        && authority_matches(&state.session_config.reachable_address, host)
        && request
            .headers()
            .get("x-forwarded-host")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|forwarded_host| {
                authority_matches(&state.session_config.reachable_address, forwarded_host)
            })
        && request
            .headers()
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            == Some("https");
    let verified_https = !local && (forwarded_https || serve_https);
    if !local && policy.requires_https() && !verified_https {
        return PublicFailure::new(403, "Remote access requires HTTPS").into_response();
    }
    let class = if local { "local" } else { "remote" };
    request.headers_mut().insert(
        session::REQUEST_CLASS_HEADER,
        HeaderValue::from_static(class),
    );
    if verified_https {
        request.headers_mut().insert(
            session::VERIFIED_HTTPS_HEADER,
            HeaderValue::from_static("1"),
        );
        let verified_origin = if serve_https {
            url::Url::parse(&state.session_config.reachable_address)
                .ok()
                .map(|value| value.origin().ascii_serialization())
        } else {
            external.map(str::to_owned)
        };
        if let Some(origin) = verified_origin.and_then(|value| HeaderValue::from_str(&value).ok()) {
            request
                .headers_mut()
                .insert(session::VERIFIED_ORIGIN_HEADER, origin);
        }
    }
    next.run(request).await
}

#[derive(Clone, Default)]
struct RefreshCookies(Arc<Mutex<Vec<String>>>);

pub async fn cookie_refresh(mut request: Request, next: Next) -> Response {
    let cookies = RefreshCookies::default();
    request.extensions_mut().insert(cookies.clone());
    let mut response = next.run(request).await;
    append_cookies(
        &mut response,
        std::mem::take(
            &mut *cookies
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        ),
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
            cookies
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend(refresh);
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
include!("../../tests/http/access.rs");
