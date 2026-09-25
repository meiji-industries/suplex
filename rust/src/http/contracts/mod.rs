use serde_json::{Map, Value, json};

pub type ParseResult = Result<Value, Vec<Value>>;

/// Explicit Rust ports of Zod HTTP contracts. `None` means the contract is
/// still unported; parity tests never count it as verified.
pub fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    match contract {
        "auth.CompanyNameBodySchema" => Some(string_default_object(input, "name")),
        "auth.DisplayNameBodySchema" => Some(string_default_object(input, "displayName")),
        "auth.MembershipBodySchema" => Some(string_default_object(input, "userId")),
        "auth.CompanyIssueCodeBodySchema" => Some(company_issue_code(input)),
        "auth.ProfileBodySchema" => Some(profile_body(input)),
        _ => None,
    }
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

fn string_default_object(input: Option<&Value>, field: &str) -> ParseResult {
    let input = object(input)?;
    let mut output = Map::new();
    match input.get(field) {
        None | Some(Value::String(_)) => {
            output.insert(field.into(), input.get(field).cloned().unwrap_or(json!("")));
            Ok(Value::Object(output))
        }
        actual => Err(vec![invalid_type("string", actual, field)]),
    }
}

fn company_issue_code(input: Option<&Value>) -> ParseResult {
    let input = object(input)?;
    let actual = input.get("issueCode");
    match actual {
        Some(Value::Null | Value::String(_)) => Ok(json!({ "issueCode": actual })),
        _ => Err(vec![invalid_type("string", actual, "issueCode")]),
    }
}

fn profile_body(input: Option<&Value>) -> ParseResult {
    let input = object(input)?;
    let mut output = Map::new();
    let mut issues = Vec::new();
    for field in ["displayName", "username", "avatarSeed"] {
        if let Some(actual) = input.get(field) {
            if actual.is_string() {
                output.insert(field.into(), actual.clone());
            } else {
                issues.push(invalid_type("string", Some(actual), field));
            }
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    if output.is_empty() {
        return Err(vec![
            json!({ "code": "custom", "path": [], "message": "Invalid input" }),
        ]);
    }
    Ok(Value::Object(output))
}
