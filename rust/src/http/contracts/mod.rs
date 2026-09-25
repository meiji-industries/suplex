use serde_json::{Map, Value, json};

mod common;
mod common_commands;
mod profile;
mod project_aux;
mod providers;
mod task_aux;
pub mod typed;

pub type ParseResult = Result<Value, Vec<Value>>;

/// Existing Value validators remain available for routes that have not yet
/// moved to a named typed request parser.
pub fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    common::validate(contract, input)
        .or_else(|| common_commands::validate(contract, input))
        .or_else(|| providers::validate(contract, input))
        .or_else(|| profile::validate(contract, input))
        .or_else(|| project_aux::validate(contract, input))
        .or_else(|| task_aux::validate(contract, input))
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
