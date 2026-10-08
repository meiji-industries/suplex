//! Suplex account requests and responses.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Contract, ContractResult, Fields, formatted, one_of, rule, text};
use crate::accounts::{AccountLoginState, wire};

fn email(value: &str, _: &()) -> garde::Result {
    rule(wire::valid_email(value), "invalid_format")
}

/// `POST /api/account/login`. The email is required by the email provider. `recovery` is a `suplex recover` token. `client` is where the login starts; without it, the desktop app.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginBody {
    pub provider: wire::AuthProvider,
    pub email: Option<String>,
    pub recovery: Option<String>,
    pub client: Option<wire::LoginClient>,
}

impl Contract for AccountLoginBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("provider", one_of(&["google", "github", "email"]))
            .opt("email", formatted(3, 254, email))
            .opt("recovery", text(1, 256))
            .opt("client", one_of(&["desktop", "web"]))
            .strict()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptIdParams {
    pub attempt_id: String,
}

impl Contract for AttemptIdParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.req("attemptId", text(1, 64)).finish()
    }
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_name: Option<String>,
}

/// `GET /api/account`. `configured` is false when this host has no account
/// service; the app then never asks for a login.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccountResponse {
    pub configured: bool,
    pub can_manage: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<AccountSummary>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccountLoginResponse {
    pub attempt_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccountLoginStatusResponse {
    pub status: AccountLoginState,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn login_body_accepts_only_known_providers_and_valid_emails() {
        assert!(AccountLoginBody::parse(Some(&json!({"provider": "google"}))).is_ok());
        let body = AccountLoginBody::parse(Some(
            &json!({"provider": "email", "email": "ada@example.com"}),
        ))
        .unwrap();
        assert_eq!(body.provider, wire::AuthProvider::Email);
        for invalid in [
            json!({"provider": "saml"}),
            json!({}),
            json!({"provider": "email", "email": "not an email"}),
            json!({"provider": "github", "extra": true}),
        ] {
            assert!(
                AccountLoginBody::parse(Some(&invalid)).is_err(),
                "{invalid}"
            );
        }
    }
}
