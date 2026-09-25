//! OAuth client registration and consent request contracts.

use serde::Serialize;
use serde_json::{Map, Value};

use super::{
    ContractResult,
    agent_api::{Check, path},
};

#[derive(Debug, Clone, Serialize)]
pub struct ClientRegistration {
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_types: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_types: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_endpoint_auth_method: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

const REGISTRATION_FIELDS: [&str; 5] = [
    "client_name",
    "redirect_uris",
    "grant_types",
    "response_types",
    "token_endpoint_auth_method",
];

pub fn parse_client_registration(input: Option<&Value>) -> ContractResult<ClientRegistration> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let any = (0, usize::MAX);
    let client_name = check.string(
        fields.get("client_name"),
        &path(&["client_name"]),
        false,
        0,
        usize::MAX,
    );
    let redirect_uris = check.string_array(
        fields.get("redirect_uris"),
        &path(&["redirect_uris"]),
        any,
        any,
    );
    let mut optional_array = |name: &str| match fields.get(name) {
        None => Some(None),
        value => check
            .string_array(value, &path(&[name]), any, any)
            .map(Some),
    };
    let grant_types = optional_array("grant_types");
    let response_types = optional_array("response_types");
    let method = check.optional_string(fields, "token_endpoint_auth_method", false, 0, usize::MAX);
    let extra = fields
        .iter()
        .filter(|(name, _)| !REGISTRATION_FIELDS.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    check.finish(
        match (
            client_name,
            redirect_uris,
            grant_types,
            response_types,
            method,
        ) {
            (
                Some(client_name),
                Some(redirect_uris),
                Some(grant_types),
                Some(response_types),
                Some(token_endpoint_auth_method),
            ) => Some(ClientRegistration {
                client_name,
                redirect_uris,
                grant_types,
                response_types,
                token_endpoint_auth_method,
                extra,
            }),
            _ => None,
        },
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentApproval {
    pub company_id: String,
    pub project_ids: Vec<String>,
}

pub fn parse_consent_approval(input: Option<&Value>) -> ContractResult<ConsentApproval> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let company_id = check.string(
        fields.get("companyId"),
        &path(&["companyId"]),
        false,
        1,
        128,
    );
    let project_ids = check.string_array(
        fields.get("projectIds"),
        &path(&["projectIds"]),
        (1, 128),
        (1, 100),
    );
    check.unknown_keys(fields, &[], &["companyId", "projectIds"]);
    check.finish(match (company_id, project_ids) {
        (Some(company_id), Some(project_ids)) => Some(ConsentApproval {
            company_id,
            project_ids,
        }),
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentParams {
    pub request_id: String,
}

pub fn parse_consent_params(input: Option<&Value>) -> ContractResult<ConsentParams> {
    let fields = Check::object(input)?;
    let mut check = Check::default();
    let request_id = check.string(
        fields.get("requestId"),
        &path(&["requestId"]),
        false,
        1,
        128,
    );
    check.finish(request_id.map(|request_id| ConsentParams { request_id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::contracts::typed::agent_api::tests::assert_fixtures;

    #[test]
    fn oauth_request_fixtures_match_public_zod_contracts() {
        assert_fixtures(
            "oauth.OAuthClientRegistrationSchema",
            parse_client_registration,
        );
        assert_fixtures("oauth.OAuthConsentApprovalSchema", parse_consent_approval);
        assert_fixtures("oauth.OAuthConsentParamsSchema", parse_consent_params);
    }
}
