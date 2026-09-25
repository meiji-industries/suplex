use axum::{
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::shared::js_json;

pub fn validation_error(issues: Vec<Value>) -> Response {
    let findings = issues
        .into_iter()
        .map(|issue| {
            if issue.get("field").is_some() {
                return issue;
            }
            let code = issue
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("request");
            let field = issue
                .get("path")
                .and_then(Value::as_array)
                .map(|path| {
                    path.iter()
                        .map(|segment| {
                            segment
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| segment.to_string())
                        })
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .unwrap_or_default();
            json!({
                "code": format!("invalid-{code}"),
                "field": format!(".{field}"),
                "message": "Request value is invalid",
            })
        })
        .collect();
    validation_error_public(findings)
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
    async fn public_findings_keep_issue_order_and_paths() {
        let response = validation_error(vec![
            json!({"code":"too_small","path":["name"]}),
            json!({"code":"invalid_type","path":[]}),
        ]);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            body.as_ref(),
            br#"{"error":"Invalid request","findings":[{"code":"invalid-too_small","field":".name","message":"Request value is invalid"},{"code":"invalid-invalid_type","field":".","message":"Request value is invalid"}]}"#
        );
    }

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
            let response = *crate::http::routes::auth::validated_typed_body(
                &headers,
                &Bytes::copy_from_slice(body.as_bytes()),
                crate::http::contracts::typed::projects::parse_create,
            )
            .unwrap_err();
            assert_eq!(response.status(), status);
            let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            assert_eq!(bytes, expected.as_bytes());
        }
    }
}
