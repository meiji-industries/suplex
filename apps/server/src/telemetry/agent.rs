//! Observations from agent surfaces that have no audit row: pairing failures,
//! `/mcp` connections and authentication failures, `suplex mcp` use, and failed
//! agent requests. They wait in `suplex_telemetry_events` until the telemetry
//! tick sends them under the host gates. `docs/telemetry.md` lists them.
//!
//! Every property is a fixed name, an ID, a number, or a value from an
//! allowlist. A request body, credential, pairing code, header text, or path
//! never reaches a property. Recording never changes the request.

use std::{
    collections::HashSet,
    sync::{Mutex, PoisonError},
};

use chrono::{DateTime, Duration, Utc};
use rusqlite::params;
use serde_json::{Map, Value};

use crate::{
    platform::{database::SuplexDatabase, environment_settings},
    shared::{hash::sha256_hex, time::rfc3339_millis},
};

/// The events this module records. The collector sends nothing else from the table.
pub(super) const EVENTS: [&str; 5] = [
    "agent_pairing_failed",
    "mcp_connected",
    "mcp_auth_failed",
    "cli_invoked",
    "agent_request_failed",
];

/// Unsent rows at most. A new row beyond that is dropped.
const MAX_PENDING: i64 = 1000;
/// Keys this process already recorded, so a busy client does not write per request.
const MAX_REMEMBERED: usize = 512;
static RECORDED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// The agent surface that a request used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    /// `/api/agent` and `/api/hermes`, including the pairing exchange.
    AgentApi,
    /// The remote `/mcp` endpoint.
    Mcp,
    /// `suplex mcp`, the stdio bridge, which calls the Agent API.
    Cli,
}

impl Surface {
    pub fn as_str(self) -> &'static str {
        match self {
            Surface::AgentApi => "agent_api",
            Surface::Mcp => "mcp",
            Surface::Cli => "cli",
        }
    }
}

/// The client header that `suplex mcp` sends.
pub const BRIDGE_CLIENT: &str = "suplex-mcp";

/// The `User-Agent` of `suplex mcp`.
pub fn bridge_user_agent() -> String {
    format!("{BRIDGE_CLIENT}/{}", env!("CARGO_PKG_VERSION"))
}

/// The version in a `suplex-mcp/<major>.<minor>.<patch>` client header. Any
/// other text gives `None`, so no free header text reaches a property.
pub fn client_version(user_agent: Option<&str>) -> Option<String> {
    let version = user_agent?.strip_prefix(BRIDGE_CLIENT)?.strip_prefix('/')?;
    semantic_version(version).then(|| version.to_owned())
}

/// `<major>.<minor>.<patch>` with one to five digits in each part.
pub fn semantic_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| (1..=5).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()))
}

/// A one-way hash of a client profile ID. The ID is client text, so the value never leaves the host.
pub fn profile_hash(profile_id: &str) -> String {
    sha256_hex(format!("suplex-client-profile\0{profile_id}"))[..16].to_owned()
}

/// Error codes that an agent surface returns. Any other code is `other`.
const ERROR_CODES: [&str; 46] = [
    "advisor_profile_not_found",
    "advisor_role_not_in_workflow",
    "answer_grant_required",
    "billing_unavailable",
    "command_in_progress",
    "configuration_invalid",
    "credential_invalid",
    "cursor_invalid",
    "dependency_not_found",
    "forbidden",
    "human_decision_required",
    "idempotency_conflict",
    "illegal_command",
    "internal_error",
    "invalid_request",
    "invalid_token",
    "insufficient_scope",
    "method_not_allowed",
    "moves_grant_required",
    "native_session_unavailable",
    "not_found",
    "option_not_offered",
    "pairing_invalid",
    "payload_too_large",
    "plan_limit_reached",
    "project_not_found",
    "question_stale",
    "request_invalid",
    "request_origin_invalid",
    "resource_not_found",
    "revision_stale",
    "root_profile_not_found",
    "scope_not_found",
    "source_branch_rejected",
    "source_issue_rejected",
    "source_pull_request_rejected",
    "task_failure",
    "task_not_waiting",
    "task_unavailable",
    "template_not_found",
    "transcripts_grant_required",
    "unsupported_media_type",
    "validation_failed",
    "worker_profile_not_found",
    "workflow_not_found",
    "rate_limited",
];

/// `none` without a code, the code when it is in the allowlist, else `other`.
pub fn error_code(code: Option<&str>) -> &'static str {
    match code {
        None => "none",
        Some(code) => ERROR_CODES
            .into_iter()
            .find(|known| *known == code)
            .unwrap_or("other"),
    }
}

/// An HTTP method name, or `OTHER`.
pub fn method(method: &str) -> &'static str {
    match method {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    }
}

/// A matched route template keeps only the route alphabet; anything else is `unmatched`.
pub fn route(template: Option<&str>) -> String {
    template
        .filter(|route| {
            route.len() <= 200
                && route.starts_with('/')
                && route
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/{}_-.".contains(&b))
        })
        .unwrap_or("unmatched")
        .to_owned()
}

/// The hour that a deduplication key names.
pub fn hour(now: DateTime<Utc>) -> String {
    now.format("%Y-%m-%dT%H").to_string()
}

/// Recording follows the opt-out variables, the Environment setting, and the
/// notice. The host checks every gate again when it sends.
fn recording_allowed(database: &SuplexDatabase) -> bool {
    !super::opted_out(|name| std::env::var(name).ok())
        && environment_settings::read(database).is_ok_and(|settings| settings.telemetry_enabled)
        && super::state(database)
            .ok()
            .flatten()
            .is_some_and(|state| state.notice_at.is_some())
}

fn remembered(key: &str) -> bool {
    RECORDED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .is_some_and(|keys| keys.contains(key))
}

fn remember(key: &str) {
    let mut keys = RECORDED.lock().unwrap_or_else(PoisonError::into_inner);
    let keys = keys.get_or_insert_with(HashSet::new);
    if keys.len() >= MAX_REMEMBERED {
        keys.clear();
    }
    keys.insert(key.to_owned());
}

/// Queues one observation once per `dedupe_key`. A failure is ignored.
pub fn record(
    database: &SuplexDatabase,
    event: &'static str,
    company_id: Option<&str>,
    properties: Map<String, Value>,
    dedupe_key: &str,
    now: DateTime<Utc>,
) {
    debug_assert!(EVENTS.contains(&event));
    // Keyed by database as well, so one process with two installations keeps them apart.
    let remembered_key = format!(
        "{}\0{dedupe_key}",
        database.connection().path().unwrap_or_default()
    );
    if remembered(&remembered_key) || !recording_allowed(database) {
        return;
    }
    let inserted = database.connection().execute(
        "INSERT OR IGNORE INTO suplex_telemetry_events (event, company_id, properties_json, dedupe_key, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM suplex_telemetry_events WHERE id > COALESCE((SELECT event_cursor FROM suplex_telemetry WHERE id = 'host'), 0)) < ?6",
        params![
            event,
            company_id,
            Value::Object(properties).to_string(),
            dedupe_key,
            rfc3339_millis(now),
            MAX_PENDING
        ],
    );
    if inserted.is_ok() {
        remember(&remembered_key);
    }
}

/// Sent rows stay two days, so a deduplication key is not reused within its hour.
pub(super) fn prune(database: &SuplexDatabase, cursor: i64, now: DateTime<Utc>) {
    let _ = database.connection().execute(
        "DELETE FROM suplex_telemetry_events WHERE id <= ?1 AND created_at < ?2",
        params![cursor, rfc3339_millis(now - Duration::days(2))],
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_bridge_header_with_a_version_names_a_client_version() {
        assert_eq!(
            client_version(Some("suplex-mcp/1.13.6")).as_deref(),
            Some("1.13.6")
        );
        assert_eq!(
            client_version(Some(&bridge_user_agent())).as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
        for other in [
            "suplex-mcp/1.13",
            "suplex-mcp/1.13.6 (ada@example.com)",
            "suplex-mcp/1.13.6-secret",
            "suplex-mcpx/1.13.6",
            "curl/8.7.1",
            "suplex-mcp/123456.0.0",
        ] {
            assert_eq!(client_version(Some(other)), None, "{other}");
        }
        assert_eq!(client_version(None), None);
    }

    #[test]
    fn codes_methods_and_routes_are_allowlisted() {
        assert_eq!(error_code(Some("pairing_invalid")), "pairing_invalid");
        assert_eq!(error_code(Some("Invalid token for ada")), "other");
        assert_eq!(error_code(None), "none");
        assert_eq!(method("BREW"), "OTHER");
        assert_eq!(
            route(Some("/api/agent/tasks/{task_id}")),
            "/api/agent/tasks/{task_id}"
        );
        assert_eq!(route(Some("/api/agent/tasks/ada smith")), "unmatched");
        assert_eq!(route(None), "unmatched");
        assert_eq!(profile_hash("work-laptop").len(), 16);
        assert!(!profile_hash("work-laptop").contains("work"));
    }
}
