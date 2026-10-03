//! The hosted account contract. The private Suplex client and the hosted
//! service share these types. A hosted payload that does not match them is
//! `account_unavailable`: the client fails closed.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_EMAIL: usize = 254;
const MAX_NAME: usize = 200;

crate::shared::wire_enum! {
    pub enum AuthProvider { Google = "google", Github = "github", Email = "email" }
}

/// A hosted account as the hosted service reports it to the linked host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAccount {
    pub id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl HostedAccount {
    pub fn valid(&self) -> bool {
        valid_account_id(&self.id)
            && valid_email(&self.email)
            && self
                .name
                .as_deref()
                .is_none_or(|name| !name.is_empty() && name.chars().count() <= MAX_NAME)
    }
}

/// POST /v1/auth/attempts
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthAttemptBody {
    pub challenge: String,
    pub installation_id: String,
}

impl AuthAttemptBody {
    pub fn valid(&self) -> bool {
        token_shape(&self.challenge)
            && (1..=128).contains(&self.installation_id.len())
            && self
                .installation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthAttemptResponse {
    pub attempt_id: String,
}

/// POST /v1/auth/email
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthEmailBody {
    pub attempt_id: String,
    pub email: String,
}

/// POST /v1/auth/attempts/{id}/poll
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthPollBody {
    pub verifier: String,
}

/// The token is returned once; the hosted service keeps only its hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum AuthPollResponse {
    Pending,
    Complete {
        token: String,
        account: HostedAccount,
    },
}

/// 32 random bytes as 43 base64url characters: verifiers, account tokens,
/// OAuth state, and magic-link tokens.
pub fn random_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// The PKCE S256 challenge: base64url(sha256(verifier)).
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 43 base64url characters, the shape of every token above.
pub fn token_shape(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// `attempt_<32 hex>`.
pub fn valid_attempt_id(id: &str) -> bool {
    id.strip_prefix("attempt_").is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// `user_<uuid>`.
pub fn valid_account_id(id: &str) -> bool {
    id.strip_prefix("user_")
        .is_some_and(|uuid| uuid::Uuid::parse_str(uuid).is_ok())
}

/// A deliberately loose address check: one `@`, a dotted domain, no spaces
/// or control characters. The provider or the magic link proves ownership.
pub fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    email.len() <= MAX_EMAIL
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
        && !email
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_rfc_7636_example() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(token_shape(&random_token().unwrap()));
    }

    #[test]
    fn validates_ids_and_emails() {
        assert!(valid_attempt_id("attempt_0123456789abcdef0123456789abcdef"));
        assert!(!valid_attempt_id("attempt_0123"));
        assert!(valid_account_id(
            "user_67e55044-10b1-426f-9247-bb680e5fe0c8"
        ));
        assert!(!valid_account_id("user_x"));
        assert!(valid_email("ada@example.com"));
        for invalid in [
            "",
            "ada",
            "ada@",
            "@example.com",
            "ada@example",
            "a b@example.com",
            "ada@@example.com",
        ] {
            assert!(!valid_email(invalid), "{invalid}");
        }
    }

    #[test]
    fn poll_response_is_tagged_by_status() {
        assert_eq!(
            serde_json::to_value(AuthPollResponse::Pending).unwrap(),
            serde_json::json!({"status": "pending"})
        );
        let complete: AuthPollResponse = serde_json::from_value(serde_json::json!({
            "status": "complete",
            "token": "t",
            "account": {"id": "user_1", "email": "ada@example.com"}
        }))
        .unwrap();
        assert!(matches!(complete, AuthPollResponse::Complete { .. }));
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanyInvitationBody {
    pub id: String,
    pub company_id: String,
    pub company_name: String,
    pub full_name: String,
    pub email: String,
    pub host_origin: String,
}

impl CompanyInvitationBody {
    pub fn valid(&self) -> bool {
        token_shape(&self.id)
            && !self.company_id.is_empty()
            && self.company_id.len() <= 128
            && !self.company_name.trim().is_empty()
            && self.company_name.chars().count() <= 120
            && !self.full_name.trim().is_empty()
            && self.full_name.chars().count() <= 120
            && valid_email(&self.email)
            && url::Url::parse(&self.host_origin).ok().is_some_and(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.path() == "/"
            })
    }
}
