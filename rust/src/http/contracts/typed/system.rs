//! `http/contracts/system-events.ts` and `http/contracts/update.ts` requests.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    Contract, ContractResult, Fields, MAX, flag, formatted, int, number, one_of, rule, text,
};
use crate::platform::environment_settings::MAX_MIN_FREE_DISK_GB;

pub const CLIENT_STATES: &[&str] = &[
    "startup",
    "resumed",
    "api_activity",
    "pageshow",
    "pagehide",
    "visible",
    "hidden",
    "online",
    "offline",
];

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$").expect("Zod UUID pattern")
});

/// `z.iso.datetime()`: UTC only, optional seconds, any fraction.
static DATETIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$").expect("Zod datetime pattern")
});

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientLifecycle {
    pub state: String,
    pub tab_id: String,
    pub document_id: String,
    pub client_time: String,
    pub visible: bool,
    pub online: bool,
}

fn uuid(value: &str, _: &()) -> garde::Result {
    rule(UUID.is_match(value), "invalid_format")
}

fn datetime(value: &str, _: &()) -> garde::Result {
    rule(DATETIME.is_match(value), "invalid_format")
}

impl Contract for ClientLifecycle {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("state", one_of(CLIENT_STATES))
            .req("tabId", formatted(0, MAX, uuid))
            .req("documentId", formatted(0, MAX, uuid))
            .req("clientTime", formatted(0, MAX, datetime))
            .req("visible", flag)
            .req("online", flag)
            .strict()
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UpdateQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
}

impl Contract for UpdateQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.opt("check", one_of(&["1"])).strict()
    }
}

/// `HealthQuerySchema`: the project and profiles whose providers to check.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthQuery {
    pub project_id: Option<String>,
    pub profile_ids: Option<String>,
}

impl Contract for HealthQuery {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("projectId", text(1, MAX))
            .opt("profileIds", text(1, MAX))
            .strict()
    }
}

/// Host-wide experiments that change what every signed-in user sees.
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExperimentsResponse {
    pub today_page: bool,
    pub host_terminal: bool,
}

/// `EnvironmentSettingsBodySchema`: at least one bounded setting.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentPatch {
    pub min_free_disk_gb: Option<f64>,
    pub default_budget_usd: Option<f64>,
    pub default_max_turns: Option<i64>,
    pub today_page_enabled: Option<bool>,
    pub host_terminal_enabled: Option<bool>,
}

impl Contract for EnvironmentPatch {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        let mut fields = Fields::new(input)?
            .opt("minFreeDiskGb", number(0.0, MAX_MIN_FREE_DISK_GB))
            .opt("defaultBudgetUsd", number(0.0, f64::MAX))
            .opt("defaultMaxTurns", int(0.0, f64::MAX))
            .opt("todayPageEnabled", flag)
            .opt("hostTerminalEnabled", flag);
        if fields.refinable()
            && [
                "minFreeDiskGb",
                "defaultBudgetUsd",
                "defaultMaxTurns",
                "todayPageEnabled",
                "hostTerminalEnabled",
            ]
            .iter()
            .all(|name| fields.raw(name).is_none())
        {
            fields.fail("custom", ".");
        }
        fields.finish()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::http::contracts::typed::{ContractFailure, issue};

    #[test]
    fn client_lifecycle_rejects_malformed_identity_and_time() {
        let body = json!({"state":"startup","tabId":"not-a-uuid","documentId":"11111111-1111-4111-8111-111111111111","clientTime":"2026-09-22T12:00:00+01:00","visible":true,"online":false});
        let Err(ContractFailure::Issues(issues)) = ClientLifecycle::parse(Some(&body)) else {
            panic!("malformed lifecycle accepted");
        };
        assert_eq!(
            issues,
            [
                issue("invalid_format", ".tabId"),
                issue("invalid_format", ".clientTime")
            ]
        );
    }
}
