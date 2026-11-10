//! Telemetry for agent surfaces: the pairing exchange, `/api/agent` and
//! `/api/hermes`, `/mcp`, and `suplex mcp`, which calls the Agent API with a
//! `suplex-mcp/<version>` client header. A handler names the authenticated
//! agent with [`authenticated`]; this layer records what the response shows.
//! It reads only the method, the matched route template, the status, the
//! client header shape, and the response `code`. Recording never changes the
//! response.

use std::cell::RefCell;

use axum::{
    body::{Body, to_bytes},
    extract::{MatchedPath, Request, State},
    http::header,
    middleware::Next,
    response::Response,
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use super::AppState;
use crate::telemetry::agent::{self, Surface};

/// Error bodies larger than this are not read for a code.
const MAX_ERROR_BODY: usize = 64 * 1024;

#[derive(Clone, Debug, Default)]
struct Agent {
    agent_id: String,
    company_id: String,
    profile_id: Option<String>,
}

tokio::task_local! {
    static AGENT: RefCell<Option<Agent>>;
}

/// Names the agent that this request authenticated as, for the events of this request.
pub(crate) fn authenticated(agent_id: &str, company_id: &str, profile_id: Option<&str>) {
    let _ = AGENT.try_with(|agent| {
        *agent.borrow_mut() = Some(Agent {
            agent_id: agent_id.to_owned(),
            company_id: company_id.to_owned(),
            profile_id: profile_id.map(str::to_owned),
        });
    });
}

const PAIRING_ROUTES: [&str; 4] = [
    "/api/agent/pairing/exchange",
    "/api/agent/pair",
    "/api/hermes/pairing/exchange",
    "/api/hermes/pair",
];

fn surface(path: &str, user_agent: Option<&str>) -> Option<Surface> {
    if path == "/mcp" {
        return Some(Surface::Mcp);
    }
    if !(path.starts_with("/api/agent/") || path.starts_with("/api/hermes/")) {
        return None;
    }
    Some(if agent::client_version(user_agent).is_some() {
        Surface::Cli
    } else {
        Surface::AgentApi
    })
}

/// The `code` of an agent error body, or `error` for `/mcp`, which puts its code there.
fn response_code(surface: Surface, body: &[u8]) -> Option<String> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    let field = if surface == Surface::Mcp {
        "error"
    } else {
        "code"
    };
    value.get(field)?.as_str().map(str::to_owned)
}

pub(crate) async fn observe(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let user_agent = request
        .headers()
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let Some(surface) = surface(request.uri().path(), user_agent.as_deref()) else {
        return next.run(request).await;
    };
    let method = agent::method(request.method().as_str());
    let route = agent::route(
        request
            .extensions()
            .get::<MatchedPath>()
            .map(MatchedPath::as_str),
    );
    let cli_version = agent::client_version(user_agent.as_deref());
    let (response, identity) = AGENT
        .scope(RefCell::new(None), async move {
            let response = next.run(request).await;
            let identity = AGENT.with(|agent| agent.borrow().clone());
            (response, identity)
        })
        .await;
    let status = response.status().as_u16();
    let (response, code) = if status >= 400 {
        let (parts, body) = response.into_parts();
        match to_bytes(body, MAX_ERROR_BODY).await {
            Ok(bytes) => {
                let code = response_code(surface, &bytes);
                (Response::from_parts(parts, Body::from(bytes)), code)
            }
            // The body is gone; the status and headers still answer the request.
            Err(_) => (Response::from_parts(parts, Body::empty()), None),
        }
    } else {
        (response, None)
    };
    let observation = Observation {
        surface,
        method,
        route,
        status,
        code: agent::error_code(code.as_deref()),
        cli_version,
        agent: identity,
    };
    if observation.worth_recording() {
        state.with_database(|database| observation.record(database));
    }
    response
}

struct Observation {
    surface: Surface,
    method: &'static str,
    route: String,
    status: u16,
    code: &'static str,
    cli_version: Option<String>,
    agent: Option<Agent>,
}

impl Observation {
    fn agent_properties(&self) -> Map<String, Value> {
        let mut properties = Map::new();
        if let Some(agent) = &self.agent {
            properties.insert("agent_id".into(), json!(agent.agent_id));
            if let Some(profile_id) = &agent.profile_id {
                properties.insert("profile_id".into(), json!(agent::profile_hash(profile_id)));
            }
        }
        properties
    }

    /// The deduplication key of a successful MCP or `suplex mcp` request.
    fn success_key(&self, hour: &str) -> Option<String> {
        let agent = self.agent.as_ref()?;
        match self.surface {
            Surface::Mcp => Some(format!("mcp_connected:{}:{hour}", agent.agent_id)),
            Surface::Cli => Some(format!("cli_invoked:mcp:{}:{hour}", agent.agent_id)),
            Surface::AgentApi => None,
        }
    }

    /// False when the request can record nothing, so most agent requests never take the database lock.
    fn worth_recording(&self) -> bool {
        self.status >= 400 || self.success_key("").is_some()
    }

    fn record(&self, database: &crate::platform::database::SuplexDatabase) {
        let now = Utc::now();
        let hour = agent::hour(now);
        let company_id = self.agent.as_ref().map(|agent| agent.company_id.as_str());
        let agent_key = self
            .agent
            .as_ref()
            .map_or("anonymous", |agent| agent.agent_id.as_str());
        if self.status < 400 {
            if self.agent.is_none() {
                return;
            }
            match self.surface {
                Surface::Mcp => {
                    agent::record(
                        database,
                        "mcp_connected",
                        company_id,
                        self.agent_properties(),
                        &self.success_key(&hour).unwrap_or_default(),
                        now,
                    );
                }
                Surface::Cli => {
                    let mut properties = self.agent_properties();
                    properties.insert("command".into(), json!("mcp"));
                    properties.insert("cli_version".into(), json!(self.cli_version));
                    agent::record(
                        database,
                        "cli_invoked",
                        company_id,
                        properties,
                        &self.success_key(&hour).unwrap_or_default(),
                        now,
                    );
                }
                Surface::AgentApi => {}
            }
            return;
        }
        let failure = json!({"status": self.status, "error_code": self.code});
        if PAIRING_ROUTES.contains(&self.route.as_str()) {
            agent::record(
                database,
                "agent_pairing_failed",
                None,
                failure.as_object().cloned().unwrap_or_default(),
                &format!("agent_pairing_failed:{}:{}:{hour}", self.status, self.code),
                now,
            );
        }
        if self.surface == Surface::Mcp && matches!(self.status, 401 | 403) {
            agent::record(
                database,
                "mcp_auth_failed",
                None,
                failure.as_object().cloned().unwrap_or_default(),
                &format!("mcp_auth_failed:{}:{}:{hour}", self.status, self.code),
                now,
            );
        }
        let mut properties = self.agent_properties();
        properties.extend([
            ("exception_source".into(), json!(self.surface.as_str())),
            ("http_method".into(), json!(self.method)),
            ("http_route".into(), json!(self.route)),
            ("status".into(), json!(self.status)),
            ("error_code".into(), json!(self.code)),
        ]);
        if let Some(version) = &self.cli_version {
            properties.insert("cli_version".into(), json!(version));
        }
        agent::record(
            database,
            "agent_request_failed",
            company_id,
            properties,
            &format!(
                "agent_request_failed:{}:{}:{}:{}:{}:{agent_key}:{hour}",
                self.surface.as_str(),
                self.method,
                self.route,
                self.status,
                self.code
            ),
            now,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surfaces_follow_the_path_and_the_bridge_header() {
        assert_eq!(surface("/mcp", None), Some(Surface::Mcp));
        assert_eq!(surface("/api/agent/tasks", None), Some(Surface::AgentApi));
        assert_eq!(
            surface("/api/hermes/me", Some("suplex-mcp/1.2.3")),
            Some(Surface::Cli)
        );
        assert_eq!(
            surface("/api/agent/me", Some("suplex-mcp/1.2.3 extra")),
            Some(Surface::AgentApi)
        );
        assert_eq!(surface("/api/tasks", None), None);
    }

    #[test]
    fn only_the_code_field_is_read() {
        assert_eq!(
            response_code(
                Surface::AgentApi,
                br#"{"error":"Pairing failed","code":"pairing_invalid"}"#
            )
            .as_deref(),
            Some("pairing_invalid")
        );
        assert_eq!(
            response_code(Surface::AgentApi, br#"{"error":"Invalid request"}"#),
            None
        );
        assert_eq!(
            response_code(Surface::Mcp, br#"{"error":"invalid_token"}"#).as_deref(),
            Some("invalid_token")
        );
    }
}
