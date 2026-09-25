use serde_json::{Map, Value, json};

use super::{ParseResult, value_type};
use crate::shared::js_json::utf16_len;

type Path = Vec<Value>;

pub(super) fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    match contract {
        "providers.ProviderConnectionSchema" => Some(connection(input, &[])),
        "providers.NativeProviderSummarySchema" => Some(native_summary(input, &[])),
        "providers.ProviderSummarySchema" => Some(provider_summary(input, &[])),
        "providers.ProviderListResponseSchema" => Some(provider_list(input, &[])),
        "providers.ProviderInstanceSchema" => Some(instance(input, &[])),
        "providers.ProviderInstanceReadinessSchema" => Some(readiness(input, &[])),
        "providers.ProviderInstanceListResponseSchema" => Some(instance_list(input, &[])),
        "providers.ProviderInstanceCreateBodySchema" => Some(instance_create(input, &[])),
        "providers.ProviderLoginResponseSchema" => Some(login(input, &[])),
        _ => None,
    }
}

fn child(path: &[Value], field: impl Into<Value>) -> Path {
    let mut result = path.to_vec();
    result.push(field.into());
    result
}

fn type_issue(expected: &str, input: Option<&Value>, path: &[Value]) -> Value {
    json!({
        "expected": expected, "code": "invalid_type", "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", value_type(input))
    })
}

fn string(input: Option<&Value>, path: &[Value]) -> ParseResult {
    match input {
        Some(Value::String(_)) => Ok(input.cloned().expect("present string")),
        _ => Err(vec![type_issue("string", input, path)]),
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

fn nonnegative_integer(input: Option<&Value>, path: &[Value]) -> ParseResult {
    let Some(Value::Number(number)) = input else {
        return Err(vec![type_issue("number", input, path)]);
    };
    let value = number.as_f64().expect("finite JSON number");
    if value.fract() != 0.0 {
        return Err(vec![json!({
            "expected": "int", "format": "safeint", "code": "invalid_type", "path": path,
            "message": "Invalid input: expected int, received number"
        })]);
    }
    if value > 9_007_199_254_740_991.0 {
        return Err(vec![json!({
            "origin": "int", "code": "too_big", "maximum": 9_007_199_254_740_991_u64,
            "note": "Integers must be within the safe integer range.", "inclusive": true,
            "path": path, "message": "Too big: expected int to be <=9007199254740991"
        })]);
    }
    if value < -9_007_199_254_740_991.0 {
        return Err(vec![json!({
            "origin": "int", "code": "too_small", "minimum": -9_007_199_254_740_991_i64,
            "note": "Integers must be within the safe integer range.", "inclusive": true,
            "path": path, "message": "Too small: expected int to be >=-9007199254740991"
        })]);
    }
    if value < 0.0 {
        return Err(vec![json!({
            "origin": "number", "code": "too_small", "minimum": 0, "inclusive": true,
            "path": path, "message": "Too small: expected number to be >=0"
        })]);
    }
    Ok(input.cloned().expect("present number"))
}

fn array(
    input: Option<&Value>,
    path: &[Value],
    element: fn(Option<&Value>, &[Value]) -> ParseResult,
) -> ParseResult {
    let Some(Value::Array(items)) = input else {
        return Err(vec![type_issue("array", input, path)]);
    };
    let mut output = Vec::with_capacity(items.len());
    let mut issues = Vec::new();
    for (index, item) in items.iter().enumerate() {
        match element(Some(item), &child(path, json!(index))) {
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

struct Record<'a> {
    input: &'a Map<String, Value>,
    output: Map<String, Value>,
    issues: Vec<Value>,
    path: Path,
}

impl Record<'_> {
    fn field(&mut self, name: &str, parser: fn(Option<&Value>, &[Value]) -> ParseResult) {
        let input = self.input.get(name);
        match parser(input, &child(&self.path, json!(name))) {
            Ok(value) => {
                self.output.insert(name.into(), value);
            }
            Err(error) => self.issues.extend(error),
        }
    }

    fn optional(&mut self, name: &str, parser: fn(Option<&Value>, &[Value]) -> ParseResult) {
        if self.input.contains_key(name) {
            self.field(name, parser);
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
        return Err(vec![type_issue("object", input, path)]);
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

fn harness_kind(input: Option<&Value>, path: &[Value]) -> ParseResult {
    enumeration(input, path, &["opencode", "claude-code", "devin", "codex"])
}

fn connection(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| {
        value.field("status", |input, path| {
            enumeration(input, path, &["connected", "not-connected", "unknown"])
        });
        value.field("summary", string);
        value.optional("account", string);
    })
}

fn model(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| {
        value.field("id", string);
        value.field("label", string);
    })
}

fn models(input: Option<&Value>, path: &[Value]) -> ParseResult {
    array(input, path, model)
}

fn summary_fields(value: &mut Record<'_>) {
    value.field("id", harness_kind);
    value.field("label", string);
    value.field("modelCount", nonnegative_integer);
    value.field("models", models);
    value.field("status", |input, path| {
        enumeration(input, path, &["configured", "missing"])
    });
}

fn native_summary(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, summary_fields)
}

fn provider_summary(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| {
        summary_fields(value);
        value.field("connection", connection);
    })
}

fn provider_summaries(input: Option<&Value>, path: &[Value]) -> ParseResult {
    array(input, path, provider_summary)
}

fn provider_list(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| {
        value.field("directory", string);
        value.field("observedAt", string);
        value.field("providers", provider_summaries);
    })
}

fn instance_fields(value: &mut Record<'_>) {
    value.field("id", string);
    value.field("provider", harness_kind);
    value.field("label", string);
    value.field("homeDirectory", string);
    value.field("createdAt", string);
    value.field("updatedAt", string);
}

fn instance(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, instance_fields)
}

fn readiness(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| {
        value.field("status", |input, path| {
            enumeration(input, path, &["healthy", "warning", "unhealthy"])
        });
        value.field("summary", string);
    })
}

fn instance_with_status(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| {
        instance_fields(value);
        value.field("readiness", readiness);
        value.field("connection", connection);
    })
}

fn instances_with_status(input: Option<&Value>, path: &[Value]) -> ParseResult {
    array(input, path, instance_with_status)
}

fn instance_list(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| {
        value.field("instances", instances_with_status)
    })
}

fn label(input: Option<&Value>, path: &[Value]) -> ParseResult {
    let Some(Value::String(value)) = input else {
        let mut issues = vec![type_issue("string", input, path)];
        if let Some(Value::Array(items)) = input {
            if items.is_empty() {
                issues.push(json!({
                    "origin": "array", "code": "too_small", "minimum": 1, "inclusive": true,
                    "path": path, "message": "Too small: expected array to have >=1 items"
                }));
            }
            if items.len() > 128 {
                issues.push(json!({
                    "origin": "array", "code": "too_big", "maximum": 128, "inclusive": true,
                    "path": path, "message": "Too big: expected array to have <=128 items"
                }));
            }
        }
        return Err(issues);
    };
    let trimmed = value.trim_matches(|character: char| {
        character == '\u{feff}' || (character.is_whitespace() && character != '\u{0085}')
    });
    let length = utf16_len(trimmed);
    if length == 0 {
        return Err(vec![json!({
            "origin": "string", "code": "too_small", "minimum": 1, "inclusive": true,
            "path": path, "message": "Too small: expected string to have >=1 characters"
        })]);
    }
    if length > 128 {
        return Err(vec![json!({
            "origin": "string", "code": "too_big", "maximum": 128, "inclusive": true,
            "path": path, "message": "Too big: expected string to have <=128 characters"
        })]);
    }
    Ok(json!(trimmed))
}

fn instance_create(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| {
        value.field("provider", harness_kind);
        value.field("label", label);
    })
}

fn login(input: Option<&Value>, path: &[Value]) -> ParseResult {
    record(input, path, |value| value.field("paneId", string))
}
