use garde::Validate;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{ContractFailure, ContractResult, finding, garde_findings, id_1_256, object};

#[derive(Debug, Clone, Deserialize, Serialize, Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevicePollBody {
    #[garde(custom(id_1_256))]
    pub flow_id: String,
}

pub fn parse_device_poll(input: Option<&Value>) -> ContractResult<DevicePollBody> {
    let fields = object(input)?;
    // Serde owns construction and strictness. These small shape findings keep
    // the public Zod envelope precise before typed deserialization.
    let mut issues = Vec::new();
    let body = if let Some(Value::String(flow_id)) = fields.get("flowId") {
        let mut typed_fields = Map::new();
        typed_fields.insert("flowId".into(), Value::String(flow_id.clone()));
        let body: DevicePollBody = serde_json::from_value(Value::Object(typed_fields))
            .map_err(|_| ContractFailure::Issues(vec![finding("invalid_type", &[])]))?;
        if let Err(report) = body.validate() {
            issues.extend(garde_findings(&report));
        }
        Some(body)
    } else {
        issues.push(finding("invalid_type", &[json!("flowId")]));
        None
    };
    if fields.keys().any(|key| key != "flowId") {
        issues.push(finding("unrecognized_keys", &[]));
    }
    match (body, issues.is_empty()) {
        (Some(body), true) => Ok(body),
        _ => Err(ContractFailure::Issues(issues)),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn device_poll_matches_zod_request_fixtures() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/parity/github-auth.GitHubDevicePollBodySchema");
        let mut count = 0;
        for entry in fs::read_dir(root).unwrap() {
            let fixture: Value =
                serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap();
            let actual = match parse_device_poll(fixture.get("input")) {
                Ok(value) => {
                    json!({"accepted": true, "value": serde_json::to_value(value).unwrap()})
                }
                Err(ContractFailure::Issues(error)) => json!({"accepted": false, "error": error}),
                Err(other) => panic!("unexpected parser failure: {other:?}"),
            };
            assert_eq!(actual, fixture["expected"], "{}", fixture["case"]);
            count += 1;
        }
        assert_eq!(count, 14);
    }
}
