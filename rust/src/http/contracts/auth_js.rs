use serde_json::{Value, json};

use crate::shared::js_json::{JsDocument, JsNode};

pub(super) type JsParseResult = Result<JsDocument, Vec<Value>>;

pub(super) fn validate(contract: &str, input: Option<&JsDocument>) -> Option<JsParseResult> {
    match contract {
        "auth.CompanyNameBodySchema" => Some(string_default_object(input, "name")),
        "auth.DisplayNameBodySchema" => Some(string_default_object(input, "displayName")),
        "auth.MembershipBodySchema" => Some(string_default_object(input, "userId")),
        "auth.CompanyIssueCodeBodySchema" => Some(company_issue_code(input)),
        "auth.ProfileBodySchema" => Some(profile_body(input)),
        "common.EmptyBodySchema" => Some(object(input).cloned()),
        "common.TokenBodySchema" => Some(string_default_object(input, "token")),
        "common.RegistrationVerificationBodySchema" => {
            Some(verification_body(input, &["token", "challengeId"]))
        }
        "common.AuthenticationVerificationBodySchema" => {
            Some(verification_body(input, &["challengeId"]))
        }
        _ => None,
    }
}

fn invalid_type(expected: &str, input: Option<(&JsDocument, usize)>, path: &str) -> Value {
    let received = input.map_or("undefined", |(document, index)| document.value_type(index));
    json!({
        "expected": expected,
        "code": "invalid_type",
        "path": if path.is_empty() { Vec::<&str>::new() } else { vec![path] },
        "message": format!("Invalid input: expected {expected}, received {received}")
    })
}

fn object(input: Option<&JsDocument>) -> Result<&JsDocument, Vec<Value>> {
    match input {
        Some(document) if matches!(document.node(document.root()), JsNode::Object(_)) => {
            Ok(document)
        }
        Some(document) => Err(vec![invalid_type(
            "object",
            Some((document, document.root())),
            "",
        )]),
        None => Err(vec![invalid_type("object", None, "")]),
    }
}

fn project(input: &JsDocument, fields: Vec<(&str, usize)>) -> JsDocument {
    let mut output = input.clone();
    let root = output.append_node(JsNode::Object(
        fields
            .into_iter()
            .map(|(name, index)| (name.encode_utf16().collect(), index))
            .collect(),
    ));
    output.set_root(root);
    output
}

fn string_default_object(input: Option<&JsDocument>, field: &str) -> JsParseResult {
    let document = object(input)?;
    match document.get(document.root(), field) {
        Some(index) if matches!(document.node(index), JsNode::String(_)) => {
            Ok(project(document, vec![(field, index)]))
        }
        Some(index) => Err(vec![invalid_type("string", Some((document, index)), field)]),
        None => {
            let mut output = document.clone();
            let value = output.append_node(JsNode::String(Vec::new()));
            let root = output.append_node(JsNode::Object(vec![(
                field.encode_utf16().collect(),
                value,
            )]));
            output.set_root(root);
            Ok(output)
        }
    }
}

fn company_issue_code(input: Option<&JsDocument>) -> JsParseResult {
    let document = object(input)?;
    match document.get(document.root(), "issueCode") {
        Some(index) if matches!(document.node(index), JsNode::String(_) | JsNode::Null) => {
            Ok(project(document, vec![("issueCode", index)]))
        }
        actual => Err(vec![invalid_type(
            "string",
            actual.map(|index| (document, index)),
            "issueCode",
        )]),
    }
}

fn profile_body(input: Option<&JsDocument>) -> JsParseResult {
    let document = object(input)?;
    let mut fields = Vec::new();
    let mut issues = Vec::new();
    for name in ["displayName", "username", "avatarSeed"] {
        if let Some(index) = document.get(document.root(), name) {
            if matches!(document.node(index), JsNode::String(_)) {
                fields.push((name, index));
            } else {
                issues.push(invalid_type("string", Some((document, index)), name));
            }
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    if fields.is_empty() {
        return Err(vec![
            json!({ "code": "custom", "path": [], "message": "Invalid input" }),
        ]);
    }
    Ok(project(document, fields))
}

fn verification_body(input: Option<&JsDocument>, defaults: &[&str]) -> JsParseResult {
    let document = object(input)?;
    let mut output = document.clone();
    let mut fields = Vec::new();
    let mut issues = Vec::new();
    for name in defaults {
        match document.get(document.root(), name) {
            Some(index) if matches!(document.node(index), JsNode::String(_)) => {
                fields.push((name.encode_utf16().collect(), index));
            }
            Some(index) => issues.push(invalid_type("string", Some((document, index)), name)),
            None => {
                let index = output.append_node(JsNode::String(Vec::new()));
                fields.push((name.encode_utf16().collect(), index));
            }
        }
    }
    match document.get(document.root(), "response") {
        Some(index) => fields.push(("response".encode_utf16().collect(), index)),
        None => issues.push(invalid_type("nonoptional", None, "response")),
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    let root = output.append_node(JsNode::Object(fields));
    output.set_root(root);
    Ok(output)
}
