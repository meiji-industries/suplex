//! `http/contracts/system-events.ts` and `http/contracts/update.ts` requests.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{ContractFailure, ContractResult, finding, object, serialized};

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

pub fn parse_client_lifecycle(input: Option<&Value>) -> ContractResult<ClientLifecycle> {
    let fields = object(input)?;
    let mut issues = Vec::new();
    if !fields
        .get("state")
        .and_then(Value::as_str)
        .is_some_and(|state| CLIENT_STATES.contains(&state))
    {
        issues.push(finding("invalid_value", &[json!("state")]));
    }
    for (name, pattern) in [
        ("tabId", &*UUID),
        ("documentId", &*UUID),
        ("clientTime", &*DATETIME),
    ] {
        match fields.get(name) {
            Some(Value::String(text)) if pattern.is_match(text) => {}
            Some(Value::String(_)) => issues.push(finding("invalid_format", &[json!(name)])),
            _ => issues.push(finding("invalid_type", &[json!(name)])),
        }
    }
    for name in ["visible", "online"] {
        if !fields.get(name).is_some_and(Value::is_boolean) {
            issues.push(finding("invalid_type", &[json!(name)]));
        }
    }
    if fields.keys().any(|key| {
        ![
            "state",
            "tabId",
            "documentId",
            "clientTime",
            "visible",
            "online",
        ]
        .contains(&key.as_str())
    }) {
        issues.push(finding("unrecognized_keys", &[]));
    }
    if !issues.is_empty() {
        return Err(ContractFailure::Issues(issues));
    }
    serde_json::from_value(Value::Object(fields.clone()))
        .map_err(|error| ContractFailure::Internal(error.to_string()))
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UpdateQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
}

pub fn parse_update_query(input: Option<&Value>) -> ContractResult<UpdateQuery> {
    let fields = object(input)?;
    let mut issues = Vec::new();
    match fields.get("check") {
        None => {}
        Some(Value::String(check)) if check == "1" => {}
        Some(_) => issues.push(finding("invalid_value", &[json!("check")])),
    }
    if fields.keys().any(|key| key != "check") {
        issues.push(finding("unrecognized_keys", &[]));
    }
    if !issues.is_empty() {
        return Err(ContractFailure::Issues(issues));
    }
    Ok(UpdateQuery {
        check: fields
            .get("check")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

pub fn validate(contract: &str, input: Option<&Value>) -> Option<ContractResult<Value>> {
    Some(match contract {
        "system-events.ClientLifecycleSchema" => serialized(parse_client_lifecycle(input)),
        "update.UpdateQuerySchema" => serialized(parse_update_query(input)),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use super::*;

    #[test]
    fn system_contracts_match_zod_request_fixtures() {
        let mut count = 0;
        for contract in [
            "system-events.ClientLifecycleSchema",
            "update.UpdateQuerySchema",
        ] {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/parity")
                .join(contract);
            for entry in fs::read_dir(root).unwrap() {
                let fixture: Value =
                    serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap();
                let actual = match validate(contract, fixture.get("input")).unwrap() {
                    Ok(value) => json!({"accepted": true, "value": value}),
                    Err(ContractFailure::Issues(error)) => {
                        json!({"accepted": false, "error": error})
                    }
                    Err(other) => panic!("unexpected parser failure: {other:?}"),
                };
                assert_eq!(
                    actual, fixture["expected"],
                    "{contract} {}",
                    fixture["case"]
                );
                count += 1;
            }
        }
        assert_eq!(count, 16);
    }

    #[test]
    fn client_lifecycle_rejects_malformed_identity_and_time() {
        let body = json!({"state":"startup","tabId":"not-a-uuid","documentId":"11111111-1111-4111-8111-111111111111","clientTime":"2026-09-22T12:00:00+01:00","visible":true,"online":false});
        let Err(ContractFailure::Issues(issues)) = parse_client_lifecycle(Some(&body)) else {
            panic!("malformed lifecycle accepted");
        };
        assert_eq!(
            issues,
            [
                finding("invalid_format", &[json!("tabId")]),
                finding("invalid_format", &[json!("clientTime")])
            ]
        );
    }
}
