//! GitHub trigger request contracts (`src/http/contracts/github-triggers.ts`).

use crate::tasks::control::DeliveryTarget;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Contract, ContractResult, Fields, choice, flag, int, list, params, text, trimmed};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTriggerCreate {
    pub project_id: String,
    pub name: String,
    pub label: String,
    pub workflow_id: String,
    pub delivery_target: DeliveryTarget,
    pub protected_paths: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTriggerPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_target: Option<DeliveryTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTriggerParams {
    pub company_id: String,
    pub rule_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTriggerCompanyParams {
    pub company_id: String,
}

type Parse = fn(Option<&Value>) -> ContractResult<Value>;

/// `(name, parser)` in schema order; every field is required on create.
fn fields() -> [(&'static str, Parse); 6] {
    [
        ("projectId", |input| text(1, 128)(input)),
        ("name", |input| trimmed(1, 120)(input)),
        ("label", |input| trimmed(1, 100)(input)),
        ("workflowId", |input| text(1, 128)(input)),
        ("deliveryTarget", choice::<DeliveryTarget>),
        ("protectedPaths", |input| list(text(1, 512), 0, 100)(input)),
    ]
}

impl Contract for GithubTriggerCreate {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        fields()
            .into_iter()
            .fold(Fields::new(input)?, |fields, (name, parse)| {
                fields.req(name, parse)
            })
            .strict()
    }
}

impl Contract for GithubTriggerPatch {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        fields()
            .into_iter()
            .fold(Fields::new(input)?, |fields, (name, parse)| {
                fields.opt(name, parse)
            })
            .opt("enabled", flag)
            .opt("archived", flag)
            .req("expectedRevision", int(1.0, f64::MAX))
            .strict()
    }
}

impl Contract for GithubTriggerParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["companyId", "ruleId"], (1, 128))
    }
}

impl Contract for GithubTriggerCompanyParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["companyId"], (1, 128))
    }
}
