//! Public machine-discovery artifacts. They describe how to reach the paired-agent
//! runtime and never carry task data, credentials, or company state. The public text and
//! catalogs live beside this module and are checked with the discovery routes.

use std::sync::LazyLock;

use axum::{
    Router,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};

use crate::{http::AppState, identity::oauth::OAuth, shared::js_json};

const LLMS: &str = include_str!("discovery/llms.txt");

fn compact(raw: &str) -> String {
    js_json::stringify(&serde_json::from_str::<Value>(raw).expect("discovery artifact is JSON"))
}

static CATALOG: LazyLock<String> =
    LazyLock::new(|| compact(include_str!("discovery/api-catalog.json")));
static SKILLS: LazyLock<String> =
    LazyLock::new(|| compact(include_str!("discovery/agent-skills.json")));

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/llms.txt", get(llms))
        .route("/.well-known/suplex/api-catalog.json", get(catalog))
        .route("/.well-known/suplex/agent-skills.json", get(skills))
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(authorization_server),
        )
}

const PUBLIC: (header::HeaderName, &str) = (header::CACHE_CONTROL, "public, max-age=300");

async fn llms() -> Response {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8"), PUBLIC],
        LLMS,
    )
        .into_response()
}

async fn catalog() -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            PUBLIC,
        ],
        CATALOG.as_str(),
    )
        .into_response()
}

async fn skills() -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            PUBLIC,
        ],
        SKILLS.as_str(),
    )
        .into_response()
}

fn metadata(value: Value) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            PUBLIC,
        ],
        js_json::stringify(&value),
    )
        .into_response()
}

async fn protected_resource(State(state): State<AppState>) -> Response {
    let oauth = OAuth::new(&state.session_config.reachable_address);
    metadata(
        json!({"resource": oauth.resource, "authorization_servers": [oauth.issuer], "scopes_supported": ["suplex:mcp"], "bearer_methods_supported": ["header"]}),
    )
}

async fn authorization_server(State(state): State<AppState>) -> Response {
    let issuer = OAuth::new(&state.session_config.reachable_address).issuer;
    metadata(json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/oauth/authorize"),
        "token_endpoint": format!("{issuer}/oauth/token"),
        "registration_endpoint": format!("{issuer}/oauth/register"),
        "revocation_endpoint": format!("{issuer}/oauth/revoke"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["suplex:mcp"],
        "authorization_response_iss_parameter_supported": true,
    }))
}

#[cfg(test)]
include!("../../../tests/routes/discovery.rs");
