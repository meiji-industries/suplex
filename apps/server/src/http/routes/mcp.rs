//! The remote Streamable HTTP MCP endpoint, authorized by an OAuth access token.
//! Each request builds a stateless server bound to the token's live principal.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use chrono::Utc;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::never::NeverSessionManager,
};
use serde_json::json;

use crate::{
    http::{AppState, error::ApiError},
    integrations::suplex::runtime::SuplexMcpRuntime,
};

use super::{agent_api, oauth::challenge};

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/mcp",
        post(mcp)
            .get(method_not_allowed)
            .delete(method_not_allowed)
            .layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
    )
}

async fn method_not_allowed() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST")],
        Json(json!({"error": "method_not_allowed"})),
    )
        .into_response()
}

/// The request names this deployment's canonical host, and a browser origin matches it.
fn authority_allowed(reachable: &str, host: Option<&str>, origin: Option<&str>) -> bool {
    let Ok(canonical) = url::Url::parse(reachable) else {
        return false;
    };
    let canonical_host = match (canonical.host_str(), canonical.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_owned(),
        _ => return false,
    };
    if !host.is_some_and(|host| host.eq_ignore_ascii_case(&canonical_host)) {
        return false;
    }
    origin.is_none_or(|origin| {
        url::Url::parse(origin).is_ok_and(|origin| origin.origin() == canonical.origin())
    })
}

async fn mcp(State(state): State<AppState>, request: Request) -> Response {
    let oauth = match state.oauth() {
        Ok(oauth) => oauth,
        Err(error) => return ApiError::response(error),
    };
    let headers = request.headers();
    let text = |name: header::HeaderName| headers.get(name).and_then(|value| value.to_str().ok());
    // A client that followed discovery to the external origin can still post to
    // the reachable address, such as a script on the host itself.
    let authorities = [
        oauth.issuer.as_str(),
        state.session_config.reachable_address.as_str(),
    ];
    if !authorities
        .iter()
        .any(|authority| authority_allowed(authority, text(header::HOST), text(header::ORIGIN)))
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "request_origin_invalid"})),
        )
            .into_response();
    }
    let unauthorized = || {
        let mut response = (
            StatusCode::UNAUTHORIZED,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"error": "invalid_token"})),
        )
            .into_response();
        if let Ok(value) = HeaderValue::from_str(&challenge(&oauth)) {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, value);
        }
        response
    };
    let Some(token) = text(header::AUTHORIZATION)
        .filter(|value| !value.contains(','))
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| crate::identity::auth::js_trim(token).to_owned())
    else {
        return unauthorized();
    };
    let Ok(principal) = state
        .with_database(|database| oauth.authenticate_access_token(database, &token, Utc::now()))
    else {
        return unauthorized();
    };
    let agent_delivery = agent_api::delivery(&state).is_some();
    let runtime_state = state.clone();
    let service = StreamableHttpService::new(
        move || {
            Ok(SuplexMcpRuntime {
                state: runtime_state.clone(),
                principal: principal.clone(),
                agent_delivery,
            })
        },
        Arc::new(NeverSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_sse_keep_alive(None)
            .with_sse_retry(None)
            .disable_allowed_hosts(),
    );
    service
        .handle(request)
        .await
        .map(axum::body::Body::new)
        .into_response()
}

#[cfg(test)]
include!("../../../tests/routes/mcp.rs");
