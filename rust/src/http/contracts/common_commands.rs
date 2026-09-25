use serde_json::{Map, Number, Value, json};

use super::{ParseResult, invalid_type, object};

pub(super) fn validate(contract: &str, input: Option<&Value>) -> Option<ParseResult> {
    match contract {
        "common.ExpectedRevisionBodySchema" => Some(expected_revision(input, Note::None, false)),
        "common.ExpectedRevisionNoteBodySchema" => {
            Some(expected_revision(input, Note::Optional, false))
        }
        "common.RequiredRevisionNoteBodySchema" => {
            Some(expected_revision(input, Note::Required, false))
        }
        "common.ResolveDecisionBlockerBodySchema" => {
            Some(expected_revision(input, Note::None, true))
        }
        "common.HttpPlanDecisionBodySchema" => Some(plan_decision(input)),
        "common.HttpSupplementalReviewBodySchema" => Some(supplemental_review(input)),
        "common.HttpPlanBlockerResponseBodySchema" => Some(plan_blocker(input)),
        _ => None,
    }
}

enum Note {
    None,
    Optional,
    Required,
}

fn issue_type(expected: &str, input: Option<&Value>, field: &str) -> Value {
    invalid_type(expected, input, field)
}

fn number_source(input: Option<&Value>) -> f64 {
    match input {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(value)) => value.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(value)) => js_number(value),
        Some(Value::Array(_)) => js_number(&js_to_string(input.expect("present array"))),
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(js_to_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0;
    for character in digits.chars() {
        let Some(digit) = character.to_digit(radix) else {
            return f64::NAN;
        };
        value = value * f64::from(radix) + f64::from(digit);
    }
    value
}

fn js_number(value: &str) -> f64 {
    let trimmed = value.trim_matches(|character: char| {
        character == '\u{feff}' || (character.is_whitespace() && character != '\u{0085}')
    });
    if trimmed.is_empty() {
        return 0.0;
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return radix_number(hex, 16);
    }
    if let Some(binary) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        return radix_number(binary, 2);
    }
    if let Some(octal) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        return radix_number(octal, 8);
    }
    if trimmed.to_ascii_lowercase().contains("inf")
        && !matches!(trimmed, "Infinity" | "+Infinity" | "-Infinity")
    {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

fn revision(input: Option<&Value>, field: &str, coerce: bool, maximum: bool) -> ParseResult {
    if !coerce && !matches!(input, Some(Value::Number(_))) {
        return Err(vec![issue_type("number", input, field)]);
    }
    let value = if coerce {
        number_source(input)
    } else {
        input.and_then(Value::as_f64).unwrap_or(f64::NAN)
    };
    if value.is_nan() || value.is_infinite() {
        let received = if value.is_nan() { "NaN" } else { "Infinity" };
        return Err(vec![json!({
            "expected": "number", "code": "invalid_type", "received": received,
            "path": [field], "message": if value.is_nan() { "Invalid input: expected number, received NaN" } else { "Invalid input: expected number, received number" }
        })]);
    }
    if value.fract() != 0.0 {
        return Err(vec![json!({
            "expected": "int", "format": "safeint", "code": "invalid_type", "path": [field],
            "message": "Invalid input: expected int, received number"
        })]);
    }
    let mut issues = Vec::new();
    if value > 9_007_199_254_740_991.0 {
        issues.push(json!({
            "origin": "int", "code": "too_big", "maximum": 9_007_199_254_740_991_u64,
            "note": "Integers must be within the safe integer range.", "inclusive": true,
            "path": [field], "message": "Too big: expected int to be <=9007199254740991"
        }));
    }
    if value < -9_007_199_254_740_991.0 {
        issues.push(json!({
            "origin": "int", "code": "too_small", "minimum": -9_007_199_254_740_991_i64,
            "note": "Integers must be within the safe integer range.", "inclusive": true,
            "path": [field], "message": "Too small: expected int to be >=-9007199254740991"
        }));
    }
    if value < 0.0 {
        issues.push(json!({
            "origin": "number", "code": "too_small", "minimum": 0, "inclusive": true,
            "path": [field], "message": "Too small: expected number to be >=0"
        }));
    }
    if maximum && value > 9_007_199_254_740_991.0 {
        issues.push(json!({
            "origin": "number", "code": "too_big", "maximum": 9_007_199_254_740_991_u64,
            "inclusive": true, "path": [field], "message": "Too big: expected number to be <=9007199254740991"
        }));
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(Value::Number(Number::from(value as i64)))
}

fn string(
    input: Option<&Value>,
    field: &str,
    min: usize,
    max: Option<usize>,
    trim: bool,
    key_format: bool,
) -> ParseResult {
    let Some(Value::String(text)) = input else {
        let mut issues = vec![issue_type("string", input, field)];
        if let Some(Value::Array(items)) = input {
            if items.len() < min {
                issues.push(json!({
                    "origin": "array", "code": "too_small", "minimum": min, "inclusive": true,
                    "path": [field], "message": format!("Too small: expected array to have >={min} items")
                }));
            }
            if let Some(max) = max
                && items.len() > max
            {
                issues.push(json!({
                    "origin": "array", "code": "too_big", "maximum": max, "inclusive": true,
                    "path": [field], "message": format!("Too big: expected array to have <={max} items")
                }));
            }
        }
        return Err(issues);
    };
    let text = if trim {
        text.trim_matches(|character: char| {
            character == '\u{feff}' || (character.is_whitespace() && character != '\u{0085}')
        })
    } else {
        text.as_str()
    };
    let length = text.encode_utf16().count();
    let mut issues = Vec::new();
    if length < min {
        issues.push(json!({
            "origin": "string", "code": "too_small", "minimum": min, "inclusive": true,
            "path": [field], "message": format!("Too small: expected string to have >={min} characters")
        }));
    }
    if let Some(max) = max
        && length > max
    {
        issues.push(json!({
            "origin": "string", "code": "too_big", "maximum": max, "inclusive": true,
            "path": [field], "message": format!("Too big: expected string to have <={max} characters")
        }));
    }
    if key_format {
        let mut chars = text.chars();
        let valid = chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
        if !valid {
            issues.push(json!({
                "origin": "string", "code": "invalid_format", "format": "regex",
                "pattern": "/^[A-Za-z0-9][A-Za-z0-9._:-]*$/", "path": [field],
                "message": "Invalid string: must match pattern /^[A-Za-z0-9][A-Za-z0-9._:-]*$/"
            }));
        }
    }
    if issues.is_empty() {
        Ok(json!(text))
    } else {
        Err(issues)
    }
}

fn add(result: ParseResult, field: &str, output: &mut Map<String, Value>, issues: &mut Vec<Value>) {
    match result {
        Ok(value) => {
            output.insert(field.into(), value);
        }
        Err(error) => issues.extend(error),
    }
}

fn finish(output: Map<String, Value>, issues: Vec<Value>) -> ParseResult {
    if issues.is_empty() {
        Ok(Value::Object(output))
    } else {
        Err(issues)
    }
}

fn expected_revision(input: Option<&Value>, note: Note, answer: bool) -> ParseResult {
    let input = object(input)?;
    let mut output = Map::new();
    let mut issues = Vec::new();
    add(
        revision(
            input.get("expectedRevision"),
            "expectedRevision",
            true,
            true,
        ),
        "expectedRevision",
        &mut output,
        &mut issues,
    );
    for field in ["commandId", "idempotencyKey"] {
        if let Some(value) = input.get(field) {
            add(
                string(Some(value), field, 1, Some(256), false, false),
                field,
                &mut output,
                &mut issues,
            );
        }
    }
    if let Some(value) = input.get("automatic") {
        match value {
            Value::Bool(_) => {
                output.insert("automatic".into(), value.clone());
            }
            _ => issues.push(issue_type("boolean", Some(value), "automatic")),
        }
    }
    match note {
        Note::None => {}
        Note::Optional => {
            if let Some(value) = input.get("note") {
                add(
                    string(Some(value), "note", 0, None, false, false),
                    "note",
                    &mut output,
                    &mut issues,
                );
            }
        }
        Note::Required => add(
            string(input.get("note"), "note", 1, None, true, false),
            "note",
            &mut output,
            &mut issues,
        ),
    }
    if answer {
        add(
            string(input.get("answer"), "answer", 1, None, false, false),
            "answer",
            &mut output,
            &mut issues,
        );
    }
    finish(output, issues)
}

fn plan_decision(input: Option<&Value>) -> ParseResult {
    let input = object(input)?;
    let mut output = Map::new();
    let mut issues = Vec::new();
    add(
        string(input.get("note"), "note", 1, None, true, false),
        "note",
        &mut output,
        &mut issues,
    );
    add(
        string(
            input.get("idempotencyKey"),
            "idempotencyKey",
            8,
            Some(128),
            false,
            true,
        ),
        "idempotencyKey",
        &mut output,
        &mut issues,
    );
    finish(output, issues)
}

fn supplemental_review(input: Option<&Value>) -> ParseResult {
    let input = object(input)?;
    let mut output = Map::new();
    let mut issues = Vec::new();
    add(
        revision(
            input.get("expectedRevision"),
            "expectedRevision",
            true,
            false,
        ),
        "expectedRevision",
        &mut output,
        &mut issues,
    );
    add(
        string(
            input.get("idempotencyKey"),
            "idempotencyKey",
            8,
            Some(128),
            false,
            true,
        ),
        "idempotencyKey",
        &mut output,
        &mut issues,
    );
    finish(output, issues)
}

fn plan_blocker(input: Option<&Value>) -> ParseResult {
    let input = object(input)?;
    let mut output = Map::new();
    let mut issues = Vec::new();
    add(
        revision(
            input.get("expectedWorkflowRevision"),
            "expectedWorkflowRevision",
            false,
            false,
        ),
        "expectedWorkflowRevision",
        &mut output,
        &mut issues,
    );
    add(
        string(input.get("answer"), "answer", 1, None, true, false),
        "answer",
        &mut output,
        &mut issues,
    );
    add(
        string(
            input.get("idempotencyKey"),
            "idempotencyKey",
            8,
            Some(128),
            false,
            true,
        ),
        "idempotencyKey",
        &mut output,
        &mut issues,
    );
    finish(output, issues)
}
