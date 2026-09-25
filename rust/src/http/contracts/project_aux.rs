use serde_json::{Map, Value, json};

use super::{ParseResult, value_type};

type Path = Vec<Value>;

pub(super) fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    match contract {
        "projects.ProjectRepositoryDefaultsResponseSchema" => Some(repository_defaults(input, &[])),
        "projects.ProjectProviderInstanceSchema" => Some(provider_instance(input, &[])),
        "projects.ProjectProviderInstanceListResponseSchema" => {
            Some(provider_instances(input, &[]))
        }
        "projects.ModelResponseSchema" => Some(model(input, &[])),
        "projects.ModelListResponseSchema" => Some(models(input, &[])),
        "projects.TaskSourceQuerySchema" => Some(task_source_query(input, &[])),
        _ => None,
    }
}

fn child(path: &[Value], segment: impl Into<Value>) -> Path {
    let mut result = path.to_vec();
    result.push(segment.into());
    result
}

fn invalid_type(expected: &str, input: Option<&Value>, path: &[Value]) -> Value {
    json!({
        "expected": expected, "code": "invalid_type", "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", value_type(input))
    })
}

fn string(input: Option<&Value>, path: &[Value]) -> ParseResult {
    match input {
        Some(Value::String(_)) => Ok(input.cloned().expect("present string")),
        _ => Err(vec![invalid_type("string", input, path)]),
    }
}

fn enumeration(input: Option<&Value>, path: &[Value], values: &[&str]) -> ParseResult {
    if let Some(Value::String(value)) = input
        && values.contains(&value.as_str())
    {
        return Ok(json!(value));
    }
    Err(vec![json!({
        "code": "invalid_value", "values": values, "path": path,
        "message": format!("Invalid option: expected one of {}", values.iter().map(|value| format!("\"{value}\"")).collect::<Vec<_>>().join("|"))
    })])
}

struct Record<'a> {
    input: &'a Map<String, Value>,
    output: Map<String, Value>,
    issues: Vec<Value>,
    path: Path,
}

impl Record<'_> {
    fn field(&mut self, name: &str, parser: impl FnOnce(Option<&Value>, &[Value]) -> ParseResult) {
        match parser(self.input.get(name), &child(&self.path, json!(name))) {
            Ok(value) => {
                self.output.insert(name.into(), value);
            }
            Err(error) => self.issues.extend(error),
        }
    }

    fn finish(self) -> ParseResult {
        if self.issues.is_empty() {
            Ok(Value::Object(self.output))
        } else {
            Err(self.issues)
        }
    }
}

fn record(
    input: Option<&Value>,
    path: &[Value],
    fields: impl FnOnce(&mut Record<'_>),
) -> ParseResult {
    let Some(Value::Object(input)) = input else {
        return Err(vec![invalid_type("object", input, path)]);
    };
    let mut record = Record {
        input,
        output: Map::new(),
        issues: Vec::new(),
        path: path.to_vec(),
    };
    fields(&mut record);
    record.finish()
}

fn array(
    input: Option<&Value>,
    path: &[Value],
    item: fn(Option<&Value>, &[Value]) -> ParseResult,
) -> ParseResult {
    let Some(Value::Array(input)) = input else {
        return Err(vec![invalid_type("array", input, path)]);
    };
    let mut output = Vec::with_capacity(input.len());
    let mut issues = Vec::new();
    for (index, value) in input.iter().enumerate() {
        match item(Some(value), &child(path, json!(index))) {
            Ok(value) => output.push(value),
            Err(error) => issues.extend(error),
        }
    }
    if issues.is_empty() {
        Ok(Value::Array(output))
    } else {
        Err(issues)
    }
}

fn harness_kind(input: Option<&Value>, path: &[Value]) -> ParseResult {
    enumeration(input, path, &["opencode", "claude-code", "devin", "codex"])
}

fn repository_defaults(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("setupCommand", string);
        record.field("verificationCommand", string);
    })
}

fn provider_instance(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("id", string);
        record.field("provider", harness_kind);
        record.field("label", string);
    })
}

fn provider_instance_array(input: Option<&Value>, path: &[Value]) -> ParseResult {
    array(input, path, provider_instance)
}

fn provider_instances(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("instances", provider_instance_array)
    })
}

fn model(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("id", string);
        record.field("provider", harness_kind);
        record.field("providerLabel", string);
        record.field("providerStatus", |value, path| {
            enumeration(value, path, &["configured", "missing"])
        });
        record.field("displayName", string);
    })
}

fn model_array(input: Option<&Value>, path: &[Value]) -> ParseResult {
    array(input, path, model)
}

fn models(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| record.field("models", model_array))
}

fn task_source_query(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |record| {
        record.field("kind", |value, path| {
            enumeration(value, path, &["pull_request", "issue", "branch"])
        });
    })
}
