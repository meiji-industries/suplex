use serde_json::{Map, Value, json};

use crate::shared::js_json::{self, JsDocument};

mod auth_js;
mod common;
mod common_commands;
mod profile;
mod project_aux;
mod project_policy;
mod providers;
mod task_aux;

pub type ParseResult = Result<Value, Vec<Value>>;
pub type JsParseResult = Result<JsDocument, Vec<Value>>;

/// Lossless contract entry point. Only schemas migrated to JsDocument appear
/// here; callers must keep the raw document for any other accepted schema.
pub fn validate_js(contract: &str, input: Option<&JsDocument>) -> Option<JsParseResult> {
    auth_js::validate(contract, input)
}

/// Serde adapter for existing routes and ordinary parity fixtures. `None`
/// means an unported schema or a value requiring the lossless entry point.
pub fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    if contract.starts_with("auth.") || contract.starts_with("common.") {
        let document = input.map(|value| {
            JsDocument::parse(&js_json::stringify(value)).expect("serde JSON value is valid JSON")
        });
        if let Some(result) = auth_js::validate(contract, document.as_ref()) {
            return match result {
                Ok(document) => document.to_serde_if_representable().ok().map(Ok),
                Err(issues) => Some(Err(issues)),
            };
        }
    }
    if let Some(result) = common::validate(contract, input) {
        return Some(result);
    }
    if let Some(result) = common_commands::validate(contract, input) {
        return Some(result);
    }
    if let Some(result) = providers::validate(contract, input) {
        return Some(result);
    }
    if let Some(result) = profile::validate(contract, input) {
        return Some(result);
    }
    if let Some(result) = project_aux::validate(contract, input) {
        return Some(result);
    }
    if let Some(result) = project_policy::validate(contract, input) {
        return Some(result);
    }
    if let Some(result) = task_aux::validate(contract, input) {
        return Some(result);
    }
    None
}

fn value_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn invalid_type(expected: &str, actual: Option<&Value>, path: &str) -> Value {
    json!({
        "expected": expected,
        "code": "invalid_type",
        "path": if path.is_empty() { Vec::<&str>::new() } else { vec![path] },
        "message": format!("Invalid input: expected {expected}, received {}", value_type(actual))
    })
}

fn object(input: Option<&Value>) -> Result<&Map<String, Value>, Vec<Value>> {
    match input {
        Some(Value::Object(value)) => Ok(value),
        _ => Err(vec![invalid_type("object", input, "")]),
    }
}
