//! Account, company, and common id contracts (`auth.ts`, `common.ts`).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Contract, ContractResult, Fields, MAX, nullable, one_of, params, text};

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
pub struct MembershipBody {
    #[serde(default)]
    pub user_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_seed: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyIdParams {
    pub company_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyStatusParams {
    pub company_id: String,
    pub status: crate::identity::companies::CompanyStatus,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserIdParams {
    pub user_id: String,
}

/// An object of strings that default to empty.
fn defaulted(input: Option<&Value>, names: &[&'static str]) -> ContractResult<Value> {
    names
        .iter()
        .fold(Fields::new(input)?, |fields, name| {
            fields.or(name, json!(""), text(0, MAX))
        })
        .finish()
}

impl Contract for CompanyNameBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        defaulted(input, &["name"])
    }
}
impl Contract for MembershipBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        defaulted(input, &["userId"])
    }
}
impl Contract for CompanyIssueCodeBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("issueCode", nullable(text(0, MAX)))
            .finish()
    }
}
/// At least one profile field.
impl Contract for ProfileBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        let mut fields = ["displayName", "username", "avatarSeed", "title"]
            .iter()
            .fold(Fields::new(input)?, |fields, name| {
                fields.opt(name, text(0, MAX))
            });
        if fields.refinable()
            && ["displayName", "username", "avatarSeed", "title"]
                .iter()
                .all(|name| fields.raw(name).is_none())
        {
            fields.fail("custom", ".");
        }
        fields.finish()
    }
}
impl Contract for CompanyIdParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["companyId"], (1, 256))
    }
}
impl Contract for CompanyStatusParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("companyId", text(1, 256))
            .req("status", one_of(&["active", "paused", "archived"]))
            .finish()
    }
}
/// `CompanyIdParamsSchema.merge(UserIdParamsSchema)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipParams {
    pub company_id: String,
    pub user_id: String,
}
impl Contract for MembershipParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["companyId", "userId"], (1, 256))
    }
}
impl Contract for UserIdParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["userId"], (1, 256))
    }
}
