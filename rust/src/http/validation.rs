//! The HTTP side of request validation: the body parser, the `Valid<T>`
//! extractor, and the public `400 Invalid request` envelope.

use axum::{
    body::Bytes,
    extract::{FromRequest, FromRequestParts, Path, Request},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::http::contracts::typed::{Contract, ContractFailure, ContractResult};
use crate::shared::js_json;

/// A request body that satisfies contract `T`. The handler never runs for a
/// body that fails: the rejection is the public 400, 415, or 500 response.
pub struct Valid<T>(pub T);

impl<S: Send + Sync, T: Contract> FromRequest<S> for Valid<T> {
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Response> {
        let headers = request.headers().clone();
        let body = Bytes::from_request(request, state)
            .await
            .map_err(IntoResponse::into_response)?;
        body_contract(&headers, &body)
            .map(Valid)
            .map_err(|response| *response)
    }
}

/// Path parameters that satisfy contract `T`; the route's `{task_id}` is the
/// contract field `taskId`.
pub struct ValidPath<T>(pub T);

impl<S: Send + Sync, T: Contract> FromRequestParts<S> for ValidPath<T> {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Response> {
        let Path(params) = Path::<Vec<(String, String)>>::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let input = params
            .into_iter()
            .map(|(name, value)| {
                let mut words = name.split('_');
                let mut field = words.next().unwrap_or_default().to_owned();
                for word in words {
                    let mut chars = word.chars();
                    field.extend(chars.next().map(|first| first.to_ascii_uppercase()));
                    field.push_str(chars.as_str());
                }
                (field, Value::String(value))
            })
            .collect();
        valid(Value::Object(input))
            .map(ValidPath)
            .map_err(|response| *response)
    }
}

/// Route tests call handlers directly: these run the validation the
/// `ValidPath` and `Valid` extractors perform.
#[cfg(test)]
pub(crate) fn test_path<T: Contract>(input: Value) -> Result<ValidPath<T>, Box<Response>> {
    valid(input).map(ValidPath)
}

#[cfg(test)]
pub(crate) fn test_body<T: Contract>(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Valid<T>, Box<Response>> {
    body_contract(headers, body).map(Valid)
}

/// Parse and validate a request body inside a handler that must check
/// something else first.
pub(crate) fn body_contract<T: Contract>(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<T, Box<Response>> {
    checked(T::parse(parsed_body(headers, body)?.as_ref()))
}

/// Validate params or a query object against contract `T`.
pub(crate) fn valid<T: Contract>(input: Value) -> Result<T, Box<Response>> {
    checked(T::parse(Some(&input)))
}

/// Findings become the public 400; a schema that throws is a 500.
pub(crate) fn checked<T>(result: ContractResult<T>) -> Result<T, Box<Response>> {
    result.map_err(|failure| {
        Box::new(match failure {
            ContractFailure::Issues(findings) => validation_error_public(findings),
            ContractFailure::Unhandled | ContractFailure::Internal(_) => {
                error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        })
    })
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "error": message }))).into_response()
}

/// Fastify's body parsing: none, a JSON value, or `text/plain` as a string.
pub(crate) fn parsed_body(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Option<Value>, Box<Response>> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default();
    if body.is_empty() {
        Ok(None)
    } else if content_type == "text/plain" {
        Ok(Some(Value::String(
            String::from_utf8_lossy(body).into_owned(),
        )))
    } else if content_type == "application/json" {
        serde_json::from_slice(body)
            .map(Some)
            .map_err(|_| Box::new(error(StatusCode::BAD_REQUEST, "Invalid request")))
    } else {
        Err(Box::new(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported media type",
        )))
    }
}

pub fn validation_error_public(findings: Vec<Value>) -> Response {
    let body = format!(
        "{{\"error\":\"Invalid request\",\"findings\":{}}}",
        js_json::stringify(&Value::Array(findings))
    );
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Bytes, to_bytes},
        http::{HeaderMap, HeaderValue},
    };

    #[tokio::test]
    async fn project_create_body_has_public_400_and_jira_throw_500() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        for (body, status, expected) in [
            (
                "{}",
                StatusCode::BAD_REQUEST,
                r#"{"error":"Invalid request","findings":[{"code":"invalid-invalid_union","field":".","message":"Request value is invalid"}]}"#,
            ),
            (
                r#"{"repositoryUrl":"repo","integration":{"tracker":{"kind":"jira","site":"x","project":"APP","emailEnvironment":"JIRA_EMAIL","tokenEnvironment":"JIRA_TOKEN"}}}"#,
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":"Internal server error"}"#,
            ),
        ] {
            let response = *body_contract::<
                crate::http::contracts::typed::projects::ProjectCreateBody,
            >(&headers, &Bytes::copy_from_slice(body.as_bytes()))
            .unwrap_err();
            assert_eq!(response.status(), status);
            let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            assert_eq!(bytes, expected.as_bytes());
        }
    }
}
