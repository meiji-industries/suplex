use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};

use super::{
    ContractFailure, ContractResult, deserialize, field_path, finding, invalid_type, object,
    serialized,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyNameBody {
    #[serde(default)]
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyIssueCodeBody {
    pub issue_code: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayNameBody {
    #[serde(default)]
    pub display_name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipBody {
    #[serde(default)]
    pub user_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_seed: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBody {
    #[serde(default)]
    pub token: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationVerificationBody {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub challenge_id: String,
    pub response: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationVerificationBody {
    #[serde(default)]
    pub challenge_id: String,
    pub response: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmptyBody {
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

fn string_fields(fields: &Map<String, Value>, names: &[&str]) -> ContractResult<()> {
    let errors = names
        .iter()
        .filter_map(|name| {
            fields
                .get(*name)
                .filter(|value| !value.is_string())
                .map(|value| invalid_type("string", Some(value), &field_path(name)))
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ContractFailure::Issues(errors))
    }
}

fn parsed<T: DeserializeOwned>(input: Option<&Value>, string_names: &[&str]) -> ContractResult<T> {
    let fields = object(input)?;
    string_fields(fields, string_names)?;
    deserialize(Value::Object(fields.clone()))
}

pub fn parse_company_name(input: Option<&Value>) -> ContractResult<CompanyNameBody> {
    parsed(input, &["name"])
}
pub fn parse_display_name(input: Option<&Value>) -> ContractResult<DisplayNameBody> {
    parsed(input, &["displayName"])
}
pub fn parse_membership(input: Option<&Value>) -> ContractResult<MembershipBody> {
    parsed(input, &["userId"])
}
pub fn parse_company_issue_code(input: Option<&Value>) -> ContractResult<CompanyIssueCodeBody> {
    let fields = object(input)?;
    match fields.get("issueCode") {
        None => Err(ContractFailure::Issues(vec![invalid_type(
            "string",
            None,
            &field_path("issueCode"),
        )])),
        Some(Value::Null | Value::String(_)) => deserialize(Value::Object(fields.clone())),
        Some(value) => Err(ContractFailure::Issues(vec![invalid_type(
            "string",
            Some(value),
            &field_path("issueCode"),
        )])),
    }
}
pub fn parse_profile(input: Option<&Value>) -> ContractResult<ProfileBody> {
    let fields = object(input)?;
    string_fields(fields, &["displayName", "username", "avatarSeed"])?;
    if ["displayName", "username", "avatarSeed"]
        .iter()
        .all(|name| !fields.contains_key(*name))
    {
        return Err(ContractFailure::Issues(vec![finding("custom", &[])]));
    }
    deserialize(Value::Object(fields.clone()))
}
pub fn parse_token(input: Option<&Value>) -> ContractResult<TokenBody> {
    parsed(input, &["token"])
}
pub fn parse_registration_verification(
    input: Option<&Value>,
) -> ContractResult<RegistrationVerificationBody> {
    let fields = object(input)?;
    let mut errors = Vec::new();
    for name in ["token", "challengeId"] {
        if let Some(value) = fields.get(name).filter(|value| !value.is_string()) {
            errors.push(invalid_type("string", Some(value), &field_path(name)));
        }
    }
    if !fields.contains_key("response") {
        errors.push(invalid_type("nonoptional", None, &field_path("response")));
    }
    if !errors.is_empty() {
        return Err(ContractFailure::Issues(errors));
    }
    deserialize(Value::Object(fields.clone()))
}
pub fn parse_authentication_verification(
    input: Option<&Value>,
) -> ContractResult<AuthenticationVerificationBody> {
    let fields = object(input)?;
    let mut errors = Vec::new();
    if let Some(value) = fields.get("challengeId").filter(|value| !value.is_string()) {
        errors.push(invalid_type(
            "string",
            Some(value),
            &field_path("challengeId"),
        ));
    }
    if !fields.contains_key("response") {
        errors.push(invalid_type("nonoptional", None, &field_path("response")));
    }
    if !errors.is_empty() {
        return Err(ContractFailure::Issues(errors));
    }
    deserialize(Value::Object(fields.clone()))
}
pub fn parse_empty(input: Option<&Value>) -> ContractResult<EmptyBody> {
    deserialize(Value::Object(object(input)?.clone()))
}

pub fn validate(contract: &str, input: Option<&Value>) -> Option<ContractResult<Value>> {
    Some(match contract {
        "auth.CompanyNameBodySchema" => serialized(parse_company_name(input)),
        "auth.CompanyIssueCodeBodySchema" => serialized(parse_company_issue_code(input)),
        "auth.DisplayNameBodySchema" => serialized(parse_display_name(input)),
        "auth.ProfileBodySchema" => serialized(parse_profile(input)),
        "auth.MembershipBodySchema" => serialized(parse_membership(input)),
        "common.EmptyBodySchema" => serialized(parse_empty(input)),
        "common.TokenBodySchema" => serialized(parse_token(input)),
        "common.RegistrationVerificationBodySchema" => {
            serialized(parse_registration_verification(input))
        }
        "common.AuthenticationVerificationBodySchema" => {
            serialized(parse_authentication_verification(input))
        }
        _ => return None,
    })
}
