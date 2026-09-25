//! Avatar request contracts (`src/http/contracts/avatars.ts`).

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{ContractFailure, ContractResult, finding, object, serialized};
use crate::identity::avatars::MAX_AVATAR_IMAGE_BASE64_LENGTH;

const SHAPES: &[&str] = &["square", "circle"];
const MIME_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarImageBody {
    pub mime_type: String,
    pub base64: String,
}

/// `None` is an absent field; `Some(None)` is an explicit `null`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AvatarUpdateBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<Option<AvatarImageBody>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarOwnerParams {
    pub owner_id: String,
}

fn path(prefix: &[&str], name: &str) -> Vec<Value> {
    prefix
        .iter()
        .chain(std::iter::once(&name))
        .filter(|part| !part.is_empty())
        .map(|part| json!(part))
        .collect()
}

fn shape(input: Option<&Value>, at: &[Value], issues: &mut Vec<Value>) -> Option<String> {
    match input.and_then(Value::as_str) {
        Some(value) if SHAPES.contains(&value) => Some(value.to_owned()),
        _ => {
            issues.push(finding("invalid_value", at));
            None
        }
    }
}

fn image_fields(
    fields: &Map<String, Value>,
    prefix: &[&str],
    issues: &mut Vec<Value>,
) -> Option<AvatarImageBody> {
    let mime_type = match fields.get("mimeType").and_then(Value::as_str) {
        Some(value) if MIME_TYPES.contains(&value) => Some(value.to_owned()),
        _ => {
            issues.push(finding("invalid_value", &path(prefix, "mimeType")));
            None
        }
    };
    let base64 = match fields.get("base64") {
        Some(Value::String(value)) => match value.encode_utf16().count() {
            0 => {
                issues.push(finding("too_small", &path(prefix, "base64")));
                None
            }
            length if length > MAX_AVATAR_IMAGE_BASE64_LENGTH => {
                issues.push(finding("too_big", &path(prefix, "base64")));
                None
            }
            _ => Some(value.clone()),
        },
        _ => {
            issues.push(finding("invalid_type", &path(prefix, "base64")));
            None
        }
    };
    if fields
        .keys()
        .any(|key| !["mimeType", "base64"].contains(&key.as_str()))
    {
        issues.push(finding(
            "unrecognized_keys",
            &prefix.iter().map(|part| json!(part)).collect::<Vec<_>>(),
        ));
    }
    Some(AvatarImageBody {
        mime_type: mime_type?,
        base64: base64?,
    })
}

fn result<T>(value: Option<T>, issues: Vec<Value>) -> ContractResult<T> {
    match value {
        Some(value) if issues.is_empty() => Ok(value),
        _ => Err(ContractFailure::Issues(issues)),
    }
}

pub fn parse_shape(input: Option<&Value>) -> ContractResult<String> {
    let mut issues = Vec::new();
    let value = shape(input, &[], &mut issues);
    result(value, issues)
}

pub fn parse_image(input: Option<&Value>) -> ContractResult<AvatarImageBody> {
    let mut issues = Vec::new();
    let value = image_fields(object(input)?, &[], &mut issues);
    result(value, issues)
}

pub fn parse_update(input: Option<&Value>) -> ContractResult<AvatarUpdateBody> {
    let fields = object(input)?;
    let mut issues = Vec::new();
    let mut body = AvatarUpdateBody::default();
    match fields.get("shape") {
        None => {}
        Some(Value::Null) => body.shape = Some(None),
        Some(value) => body.shape = Some(shape(Some(value), &[json!("shape")], &mut issues)),
    }
    match fields.get("image") {
        None => {}
        Some(Value::Null) => body.image = Some(None),
        Some(Value::Object(image)) => {
            body.image = Some(image_fields(image, &["image"], &mut issues));
        }
        Some(_) => issues.push(finding("invalid_type", &[json!("image")])),
    }
    if fields
        .keys()
        .any(|key| !["shape", "image"].contains(&key.as_str()))
    {
        issues.push(finding("unrecognized_keys", &[]));
    }
    result(Some(body), issues)
}

pub fn parse_owner_params(input: Option<&Value>) -> ContractResult<AvatarOwnerParams> {
    let fields = object(input)?;
    let at = [json!("ownerId")];
    match fields.get("ownerId") {
        Some(Value::String(value)) => match value.encode_utf16().count() {
            0 => Err(ContractFailure::Issues(vec![finding("too_small", &at)])),
            257.. => Err(ContractFailure::Issues(vec![finding("too_big", &at)])),
            _ => Ok(AvatarOwnerParams {
                owner_id: value.clone(),
            }),
        },
        _ => Err(ContractFailure::Issues(vec![finding("invalid_type", &at)])),
    }
}

pub fn validate(contract: &str, input: Option<&Value>) -> Option<ContractResult<Value>> {
    Some(match contract {
        "avatars.AvatarShapeSchema" => serialized(parse_shape(input)),
        "avatars.AvatarImageBodySchema" => serialized(parse_image(input)),
        "avatars.AvatarUpdateBodySchema" => serialized(parse_update(input)),
        "avatars.AvatarOwnerParamsSchema" => serialized(parse_owner_params(input)),
        _ => return None,
    })
}
