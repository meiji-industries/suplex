pub mod admin;
pub mod answer_grant_repository;
pub mod audit;
pub mod auth;
pub mod avatars;
pub mod companies;
pub mod external_agents;
pub mod oauth;
pub mod remote_access_repository;

use crate::shared::PublicFailure;

/// Identity and access refusals.
#[derive(Clone, Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("{message}")]
    Auth {
        status: u16,
        code: &'static str,
        message: &'static str,
    },
    #[error("{message}")]
    ExternalAgent {
        status: u16,
        code: &'static str,
        message: String,
    },
}

impl IdentityError {
    pub fn auth(message: &'static str, status: u16, code: &'static str) -> Self {
        Self::Auth {
            status,
            code,
            message,
        }
    }

    pub fn not_found() -> Self {
        Self::auth("Not found", 404, "auth_failure")
    }

    pub fn external_agent(message: impl Into<String>, status: u16, code: &'static str) -> Self {
        Self::ExternalAgent {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::Auth { status, .. } | Self::ExternalAgent { status, .. } => *status,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Auth { code, .. } | Self::ExternalAgent { code, .. } => code,
        }
    }
}

impl From<IdentityError> for PublicFailure {
    fn from(error: IdentityError) -> Self {
        let public = PublicFailure::new(error.status(), error.to_string());
        match error.code() {
            "auth_failure" => public,
            code => public.with_code(code),
        }
    }
}
