//! Public machine-discovery artifacts. They describe how to reach the paired-agent
//! runtime and never carry task data, credentials, or company state. The text and
//! catalogs are generated from TypeScript by `scripts/rust-agent-artifacts.ts`.

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
    js_json::stringify(&serde_json::from_str::<Value>(raw).expect("generated artifact is JSON"))
}

static CATALOG: LazyLock<String> = LazyLock::new(|| compact(include_str!("discovery/api-catalog.json")));
static SKILLS: LazyLock<String> = LazyLock::new(|| compact(include_str!("discovery/agent-skills.json")));

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/llms.txt", get(llms))
        .route("/.well-known/suplex/api-catalog.json", get(catalog))
        .route("/.well-known/suplex/agent-skills.json", get(skills))
        .route("/.well-known/oauth-protected-resource/mcp", get(protected_resource))
        .route("/.well-known/oauth-protected-resource", get(protected_resource))
        .route("/.well-known/oauth-authorization-server", get(authorization_server))
}

const PUBLIC: (header::HeaderName, &str) = (header::CACHE_CONTROL, "public, max-age=300");

async fn llms() -> Response {
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8"), PUBLIC], LLMS).into_response()
}

async fn catalog() -> Response {
    ([(header::CONTENT_TYPE, "application/json; charset=utf-8"), PUBLIC], CATALOG.as_str()).into_response()
}

async fn skills() -> Response {
    ([(header::CONTENT_TYPE, "application/json; charset=utf-8"), PUBLIC], SKILLS.as_str()).into_response()
}

fn metadata(value: Value) -> Response {
    ([(header::CONTENT_TYPE, "application/json; charset=utf-8"), PUBLIC], js_json::stringify(&value)).into_response()
}

async fn protected_resource(State(state): State<AppState>) -> Response {
    let oauth = OAuth::new(&state.session_config.reachable_address);
    metadata(json!({"resource": oauth.resource, "authorization_servers": [oauth.issuer], "scopes_supported": ["suplex:mcp"], "bearer_methods_supported": ["header"]}))
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
mod tests {
    use super::*;
    use crate::http::routes::external_agent_administration::tests::server;

    /// Ports `tests/discovery-artifacts.test.ts` and the public half of the machine-discovery journey.
    #[tokio::test]
    async fn public_artifacts_are_anonymous_secret_free_and_name_closed_runtime_routes() {
        let server = server(None).await;
        let paths = [
            "/llms.txt",
            "/.well-known/suplex/api-catalog.json",
            "/.well-known/suplex/agent-skills.json",
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-authorization-server",
        ];
        for path in paths {
            let response = server.request(reqwest::Method::GET, path, &[], None).await;
            assert_eq!(response.status(), 200, "{path}");
            assert_eq!(response.headers()["cache-control"], "public, max-age=300");
            let body = response.text().await.unwrap();
            for secret in ["fha_", "fhp_", "foa_", "for_", "sid_v1", "Bearer fha"] {
                assert!(!body.contains(secret), "{path} contains {secret}");
            }
        }
        let text = server.request(reqwest::Method::GET, "/llms.txt", &[], None).await.text().await.unwrap();
        assert!(text.starts_with("# Suplex\n") && text.contains("Read /api/agent/openapi.json after pairing"));
        let (_, catalog) = server.send(reqwest::Method::GET, "/.well-known/suplex/api-catalog.json", None, None).await;
        assert_eq!(catalog["pairing"][0]["path"], "/api/agent/pairing/exchange");
        let (_, resource) = server.send(reqwest::Method::GET, "/.well-known/oauth-protected-resource/mcp", None, None).await;
        assert_eq!(resource, json!({"resource": "https://suplex.example.test:4111/mcp", "authorization_servers": ["https://suplex.example.test:4111"], "scopes_supported": ["suplex:mcp"], "bearer_methods_supported": ["header"]}));
        for entry in catalog["runtime"].as_array().unwrap().iter().filter(|entry| entry["path"] != "/mcp") {
            let path = entry["path"].as_str().unwrap().replace("{taskId}", "task_missing");
            let method = reqwest::Method::from_bytes(entry["method"].as_str().unwrap().as_bytes()).unwrap();
            let body = (method != reqwest::Method::GET).then(|| json!({}));
            let (status, _) = server.send(method.clone(), &path, None, body).await;
            assert_eq!(status, 401, "{method} {path}");
        }
    }
}
