//! OAuth client registration and consent request contracts.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Contract, ContractResult, Fields, MAX, list, text};

#[derive(Debug, Clone, Serialize, Deserialize)]
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

impl Contract for ClientRegistration {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        let strings = list(text(0, MAX), 0, MAX);
        Fields::new(input)?
            .req("client_name", text(0, MAX))
            .req("redirect_uris", strings)
            .opt("grant_types", strings)
            .opt("response_types", strings)
            .opt("token_endpoint_auth_method", text(0, MAX))
            .passthrough()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentApproval {
    pub company_id: String,
    pub project_ids: Vec<String>,
}

impl Contract for ConsentApproval {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("companyId", text(1, 128))
            .req("projectIds", list(text(1, 128), 1, 100))
            .strict()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentParams {
    pub request_id: String,
}

impl Contract for ConsentParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.req("requestId", text(1, 128)).finish()
    }
}
