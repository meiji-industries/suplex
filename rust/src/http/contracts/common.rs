use serde_json::{Map, Value, json};

use super::{ParseResult, invalid_type, object};

pub(super) fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    match contract {
        "common.IdSchema" => Some(id(input, "").map(|value| json!(value))),
        "common.CompanyIdParamsSchema" => Some(params(input, &["companyId"], false)),
        "common.ProjectIdParamsSchema" => Some(params(input, &["projectId"], false)),
        "common.TaskIdParamsSchema" => Some(params(input, &["taskId"], false)),
        "common.UserIdParamsSchema" => Some(params(input, &["userId"], false)),
        "common.CredentialIdParamsSchema" => Some(params(input, &["credentialId"], false)),
        "common.TaskArtifactParamsSchema" => Some(params(input, &["taskId", "artifactId"], false)),
        "common.TaskExecutionParamsSchema" => {
            Some(params(input, &["taskId", "executionId"], false))
        }
        "common.AttentionIdParamsSchema" => Some(params(input, &["attentionId"], false)),
        "common.CompanyStatusParamsSchema" => Some(params(input, &["companyId"], true)),
        _ => None,
    }
}

fn id<'a>(input: Option<&'a Value>, path: &str) -> Result<&'a str, Vec<Value>> {
    let Some(Value::String(value)) = input else {
        let mut issues = vec![invalid_type("string", input, path)];
        if let Some(Value::Array(items)) = input
            && items.is_empty()
        {
            issues.push(json!({
                "origin": "array", "code": "too_small", "minimum": 1, "inclusive": true,
                "path": if path.is_empty() { Vec::<&str>::new() } else { vec![path] },
                "message": "Too small: expected array to have >=1 items"
            }));
        }
        return Err(issues);
    };
    let length = value.encode_utf16().count();
    if length < 1 {
        return Err(vec![json!({
            "origin": "string", "code": "too_small", "minimum": 1, "inclusive": true,
            "path": if path.is_empty() { Vec::<&str>::new() } else { vec![path] },
            "message": "Too small: expected string to have >=1 characters"
        })]);
    }
    if length > 256 {
        return Err(vec![json!({
            "origin": "string", "code": "too_big", "maximum": 256, "inclusive": true,
            "path": if path.is_empty() { Vec::<&str>::new() } else { vec![path] },
            "message": "Too big: expected string to have <=256 characters"
        })]);
    }
    Ok(value)
}

fn params(input: Option<&Value>, fields: &[&str], status: bool) -> ParseResult {
    let input = object(input)?;
    let mut output = Map::new();
    let mut issues = Vec::new();
    for field in fields {
        match id(input.get(*field), field) {
            Ok(value) => {
                output.insert((*field).into(), json!(value));
            }
            Err(error) => issues.extend(error),
        }
    }
    if status {
        match input.get("status").and_then(Value::as_str) {
            Some(value @ ("active" | "paused" | "archived")) => {
                output.insert("status".into(), json!(value));
            }
            _ => issues.push(json!({
                "code": "invalid_value", "values": ["active", "paused", "archived"],
                "path": ["status"], "message": "Invalid option: expected one of \"active\"|\"paused\"|\"archived\""
            })),
        }
    }
    if issues.is_empty() {
        Ok(Value::Object(output))
    } else {
        Err(issues)
    }
}
