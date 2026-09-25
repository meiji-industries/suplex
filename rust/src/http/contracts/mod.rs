use serde_json::{Map, Value, json};

use crate::shared::js_json::{self, JsDocument, JsNode};

mod auth_js;
mod common;
mod common_commands;
mod js_issues;
mod profile;
mod project_aux;
mod project_creation_js;
mod providers;
mod task_answer_js;
mod task_aux;
mod task_control_js;
mod task_create_js;
mod workflow_records_js;

pub type ParseResult = Result<Value, Vec<Value>>;
pub type JsParseResult = Result<JsDocument, Vec<Value>>;

#[derive(Clone, Debug)]
pub struct JsThrown {
    pub name: &'static str,
    pub code: &'static str,
    pub message: &'static str,
    pub input: Vec<u16>,
}

impl JsThrown {
    pub fn as_document(&self) -> JsDocument {
        let mut output = JsDocument::parse("{}").expect("empty JSON object");
        let fields = [
            ("kind", "thrown".encode_utf16().collect()),
            ("name", self.name.encode_utf16().collect()),
            ("code", self.code.encode_utf16().collect()),
            ("message", self.message.encode_utf16().collect()),
            ("input", self.input.clone()),
        ]
        .into_iter()
        .map(|(key, value)| {
            let index = output.append_node(JsNode::String(value));
            (key.encode_utf16().collect(), index)
        })
        .collect();
        let root = output.append_node(JsNode::Object(fields));
        output.set_root(root);
        output
    }
}

#[derive(Clone, Debug)]
pub enum JsContractFailure {
    Issues(JsDocument),
    Thrown(JsThrown),
}

impl JsContractFailure {
    pub fn stringify(&self) -> String {
        match self {
            Self::Issues(issues) => issues.stringify(),
            Self::Thrown(thrown) => thrown.as_document().stringify(),
        }
    }
}

pub type DetailedJsParseResult = Result<JsDocument, JsContractFailure>;

/// Exact lossless result for project contracts, including Zod refinement
/// exceptions and issue strings that contain lone UTF-16 surrogates.
pub fn validate_js_detailed(
    contract: &str,
    input: Option<&JsDocument>,
) -> Option<DetailedJsParseResult> {
    if let Some(result) = project_creation_js::validate_detailed(contract, input) {
        return Some(result);
    }
    if let Some(result) = workflow_records_js::validate_detailed(contract, input) {
        return Some(result);
    }
    if let Some(result) = task_create_js::validate_detailed(contract, input) {
        return Some(result);
    }
    if let Some(result) = task_control_js::validate_detailed(contract, input) {
        return Some(result);
    }
    if let Some(result) = task_answer_js::validate_detailed(contract, input) {
        return Some(result);
    }
    auth_js::validate(contract, input).map(|result| {
        result.map_err(|issues| {
            JsContractFailure::Issues(
                JsDocument::parse(&js_json::stringify(&json!(issues)))
                    .expect("Zod-compatible issues serialize as JSON"),
            )
        })
    })
}

/// Lossless contract entry point. Only schemas migrated to JsDocument appear
/// here; callers must keep the raw document for any other accepted schema.
pub fn validate_js(contract: &str, input: Option<&JsDocument>) -> Option<JsParseResult> {
    match validate_js_detailed(contract, input)? {
        Ok(document) => Some(Ok(document)),
        Err(JsContractFailure::Issues(issues)) => issues
            .to_serde_if_representable()
            .ok()
            .and_then(|value| value.as_array().cloned())
            .map(Err),
        Err(JsContractFailure::Thrown(_)) => None,
    }
}

/// Serde adapter for existing routes and ordinary parity fixtures. `None`
/// means an unported schema or a value requiring the lossless entry point.
pub fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    if contract.starts_with("auth.")
        || contract.starts_with("common.")
        || contract.starts_with("projects.")
        || contract.starts_with("tasks.")
        || contract.starts_with("workflows.")
    {
        let document = input.map(|value| {
            JsDocument::parse(&js_json::stringify(value)).expect("serde JSON value is valid JSON")
        });
        if let Some(result) = validate_js(contract, document.as_ref()) {
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
