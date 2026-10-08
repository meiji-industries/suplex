use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

/// The browser error envelope: `{"error", "code"?, "findings"?}`.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct PublicFailure {
    pub status: StatusCode,
    pub code: Option<&'static str>,
    pub message: String,
    pub findings: Option<Value>,
}

impl PublicFailure {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            code: None,
            message: message.into(),
            findings: None,
        }
    }

    pub fn internal() -> Self {
        Self::new(500, "Internal server error")
    }

    pub fn with_code(self, code: &'static str) -> Self {
        Self {
            code: Some(code),
            ..self
        }
    }

    pub fn with_findings(self, findings: Value) -> Self {
        Self {
            findings: Some(findings),
            ..self
        }
    }
}

impl IntoResponse for PublicFailure {
    fn into_response(self) -> Response {
        let mut body = Map::new();
        body.insert("error".into(), json!(self.message));
        if let Some(code) = self.code {
            body.insert("code".into(), json!(code));
        }
        if let Some(findings) = self.findings {
            body.insert("findings".into(), findings);
        }
        (self.status, Json(Value::Object(body))).into_response()
    }
}

use crate::{
    identity::IdentityError, integrations::github_triggers::TriggerFailure,
    platform::PlatformError, profiles::agent_profiles::ProfileFailure, projects::ProjectError,
    tasks::TaskError,
};
use std::error::Error;
pub fn public_failure(error: Box<dyn Error + Send + Sync>) -> PublicFailure {
    crate::platform::system_events::emit(json!({
        "type":"failure", "state":"error", "level":40, "reason":error.to_string(),
    }));
    macro_rules! public {
        ($error:ident, $($kind:ty),+) => {$(
            let $error = match $error.downcast::<$kind>() {
                Ok(failure) => return (*failure).into(),
                Err(error) => error,
            };
        )+};
    }
    public!(
        error,
        PublicFailure,
        TaskError,
        IdentityError,
        ProjectError,
        PlatformError,
        ProfileFailure,
        TriggerFailure
    );
    drop(error);
    PublicFailure::internal()
}

#[cfg(test)]
mod tests {
    use axum::response::IntoResponse;
    use serde_json::json;

    #[tokio::test]
    async fn the_envelope_lists_error_code_and_findings_in_order() {
        let response = super::PublicFailure::new(422, "Rejected")
            .with_code("invalid")
            .with_findings(json!([]))
            .into_response();
        assert_eq!(response.status(), 422);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            &body[..],
            br#"{"error":"Rejected","code":"invalid","findings":[]}"#
        );
    }
}
