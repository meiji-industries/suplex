use serde_json::{Map, Value, json};

use super::{ParseResult, value_type};

type Path = Vec<Value>;

pub(super) fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    match contract {
        "projects.ProfileBodySchema" => Some(profile(input, &[], ProfileMode::Body)),
        "projects.ProfilePatchBodySchema" => Some(profile(input, &[], ProfileMode::Patch)),
        "projects.ProfileResponseSchema" => Some(profile(input, &[], ProfileMode::Response)),
        "projects.ProfileListResponseSchema" => Some(profile_list(input, &[])),
        "projects.ProfileListQuerySchema" | "workflows.WorkflowListQuerySchema" => {
            Some(profile_query(input, &[]))
        }
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProfileMode {
    Body,
    Patch,
    Response,
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

#[derive(Clone, Copy)]
enum TextRule {
    Plain,
    MinOne,
    Name,
    Model,
    Avatar,
}

fn text(input: Option<&Value>, path: &[Value], rule: TextRule) -> ParseResult {
    let min = match rule {
        TextRule::Plain | TextRule::Avatar => 0,
        _ => 1,
    };
    let max = matches!(rule, TextRule::Model).then_some(256);
    let Some(Value::String(value)) = input else {
        let mut issues = vec![invalid_type("string", input, path)];
        if let Some(Value::Array(items)) = input {
            if items.len() < min {
                issues.push(json!({
                    "origin": "array", "code": "too_small", "minimum": min, "inclusive": true,
                    "path": path, "message": format!("Too small: expected array to have >={min} items")
                }));
            }
            if let Some(max) = max
                && items.len() > max
            {
                issues.push(json!({
                    "origin": "array", "code": "too_big", "maximum": max, "inclusive": true,
                    "path": path, "message": format!("Too big: expected array to have <={max} items")
                }));
            }
        }
        return Err(issues);
    };
    let value = if matches!(rule, TextRule::Name | TextRule::Model) {
        value.trim_matches(|character: char| {
            character == '\u{feff}' || (character.is_whitespace() && character != '\u{0085}')
        })
    } else {
        value.as_str()
    };
    let length = value.encode_utf16().count();
    let mut issues = Vec::new();
    if length < min {
        issues.push(json!({
            "origin": "string", "code": "too_small", "minimum": min, "inclusive": true,
            "path": path, "message": format!("Too small: expected string to have >={min} characters")
        }));
    }
    if let Some(max) = max
        && length > max
    {
        issues.push(json!({
            "origin": "string", "code": "too_big", "maximum": max, "inclusive": true,
            "path": path, "message": format!("Too big: expected string to have <={max} characters")
        }));
    }
    let pattern = match rule {
        TextRule::Model if !model_pattern(value) => Some("/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/"),
        TextRule::Avatar if !avatar_pattern(value) => Some("/^[a-f0-9]{32}$/"),
        _ => None,
    };
    if let Some(pattern) = pattern {
        issues.push(json!({
            "origin": "string", "code": "invalid_format", "format": "regex",
            "pattern": pattern, "path": path,
            "message": format!("Invalid string: must match pattern {pattern}")
        }));
    }
    if issues.is_empty() {
        Ok(json!(value))
    } else {
        Err(issues)
    }
}

fn model_pattern(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '/' | '-')
        })
}

fn avatar_pattern(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn nullable_string(input: Option<&Value>, path: &[Value], min_one: bool) -> ParseResult {
    if matches!(input, Some(Value::Null)) {
        return Ok(Value::Null);
    }
    text(
        input,
        path,
        if min_one {
            TextRule::MinOne
        } else {
            TextRule::Plain
        },
    )
}

fn boolean(input: Option<&Value>, path: &[Value]) -> ParseResult {
    match input {
        Some(Value::Bool(_)) => Ok(input.cloned().expect("present boolean")),
        _ => Err(vec![invalid_type("boolean", input, path)]),
    }
}

fn field(
    input: &Map<String, Value>,
    output: &mut Map<String, Value>,
    issues: &mut Vec<Value>,
    path: &[Value],
    name: &str,
    optional: bool,
    parser: impl FnOnce(Option<&Value>, &[Value]) -> ParseResult,
) {
    let actual = input.get(name);
    if optional && actual.is_none() {
        return;
    }
    match parser(actual, &child(path, json!(name))) {
        Ok(value) => {
            output.insert(name.into(), value);
        }
        Err(error) => issues.extend(error),
    }
}

fn strict_unknown(input: &Map<String, Value>, known: &[&str], path: &[Value]) -> Option<Value> {
    let keys = input
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return None;
    }
    let message = if keys.len() == 1 {
        format!("Unrecognized key: \"{}\"", keys[0])
    } else {
        format!(
            "Unrecognized keys: {}",
            keys.iter()
                .map(|key| format!("\"{key}\""))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    Some(json!({ "code": "unrecognized_keys", "keys": keys, "path": path, "message": message }))
}

fn profile(input: Option<&Value>, path: &[Value], mode: ProfileMode) -> ParseResult {
    let Some(Value::Object(input)) = input else {
        return Err(vec![invalid_type("object", input, path)]);
    };
    let mut output = Map::new();
    let mut issues = Vec::new();
    let optional = mode == ProfileMode::Patch;
    field(
        input,
        &mut output,
        &mut issues,
        path,
        "provider",
        optional,
        |value, path| enumeration(value, path, &["opencode", "claude-code", "devin", "codex"]),
    );
    field(
        input,
        &mut output,
        &mut issues,
        path,
        "model",
        optional,
        |value, path| text(value, path, TextRule::Model),
    );
    field(
        input,
        &mut output,
        &mut issues,
        path,
        "reasoningLevel",
        optional,
        |value, path| enumeration(value, path, &["low", "medium", "high", "xhigh", "max"]),
    );
    field(
        input,
        &mut output,
        &mut issues,
        path,
        "serviceTier",
        optional,
        |value, path| enumeration(value, path, &["default", "priority"]),
    );
    field(
        input,
        &mut output,
        &mut issues,
        path,
        "providerInstanceId",
        true,
        |value, path| nullable_string(value, path, true),
    );
    field(
        input,
        &mut output,
        &mut issues,
        path,
        "name",
        optional,
        |value, path| text(value, path, TextRule::Name),
    );
    field(
        input,
        &mut output,
        &mut issues,
        path,
        "role",
        optional,
        |value, path| enumeration(value, path, &["root", "worker"]),
    );
    field(
        input,
        &mut output,
        &mut issues,
        path,
        "avatarSeed",
        optional,
        |value, path| text(value, path, TextRule::Avatar),
    );
    if mode == ProfileMode::Patch {
        field(
            input,
            &mut output,
            &mut issues,
            path,
            "archived",
            true,
            boolean,
        );
    }
    if mode == ProfileMode::Response {
        field(
            input,
            &mut output,
            &mut issues,
            path,
            "id",
            false,
            |value, path| text(value, path, TextRule::Plain),
        );
        field(
            input,
            &mut output,
            &mut issues,
            path,
            "archivedAt",
            false,
            |value, path| nullable_string(value, path, false),
        );
        field(
            input,
            &mut output,
            &mut issues,
            path,
            "createdAt",
            false,
            |value, path| text(value, path, TextRule::Plain),
        );
        field(
            input,
            &mut output,
            &mut issues,
            path,
            "updatedAt",
            false,
            |value, path| text(value, path, TextRule::Plain),
        );
    }
    if mode != ProfileMode::Response {
        let mut known = vec![
            "provider",
            "model",
            "reasoningLevel",
            "serviceTier",
            "providerInstanceId",
            "name",
            "role",
            "avatarSeed",
        ];
        if mode == ProfileMode::Patch {
            known.push("archived");
        }
        if let Some(issue) = strict_unknown(input, &known, path) {
            issues.push(issue);
        }
    }
    if issues.is_empty() {
        Ok(Value::Object(output))
    } else {
        Err(issues)
    }
}

fn profile_list(input: Option<&Value>, path: &[Value]) -> ParseResult {
    let Some(Value::Object(input)) = input else {
        return Err(vec![invalid_type("object", input, path)]);
    };
    let array_path = child(path, json!("profiles"));
    let Some(Value::Array(profiles)) = input.get("profiles") else {
        return Err(vec![invalid_type(
            "array",
            input.get("profiles"),
            &array_path,
        )]);
    };
    let mut output = Vec::new();
    let mut issues = Vec::new();
    for (index, value) in profiles.iter().enumerate() {
        match profile(
            Some(value),
            &child(&array_path, json!(index)),
            ProfileMode::Response,
        ) {
            Ok(value) => output.push(value),
            Err(error) => issues.extend(error),
        }
    }
    if issues.is_empty() {
        Ok(json!({ "profiles": output }))
    } else {
        Err(issues)
    }
}

fn profile_query(input: Option<&Value>, path: &[Value]) -> ParseResult {
    let Some(Value::Object(input)) = input else {
        return Err(vec![invalid_type("object", input, path)]);
    };
    let mut output = Map::new();
    let mut issues = Vec::new();
    if let Some(value) = input.get("includeArchived") {
        if value == "true" {
            output.insert("includeArchived".into(), value.clone());
        } else {
            issues.push(json!({
                "code": "invalid_value", "values": ["true"], "path": child(path, json!("includeArchived")),
                "message": "Invalid input: expected \"true\""
            }));
        }
    }
    if let Some(issue) = strict_unknown(input, &["includeArchived"], path) {
        issues.push(issue);
    }
    if issues.is_empty() {
        Ok(Value::Object(output))
    } else {
        Err(issues)
    }
}
