use axum::{
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};

use crate::shared::js_json::{JsDocument, JsNode};

fn string_node(document: &JsDocument, object: usize, name: &str, fallback: &str) -> Vec<u16> {
    document
        .get(object, name)
        .and_then(|index| match document.node(index) {
            JsNode::String(value) => Some(value.clone()),
            _ => None,
        })
        .unwrap_or_else(|| fallback.encode_utf16().collect())
}

fn field_path(document: &JsDocument, issue: usize) -> Vec<u16> {
    let mut field = vec![b'.' as u16];
    let Some(path) = document.get(issue, "path") else {
        return field;
    };
    let JsNode::Array(segments) = document.node(path) else {
        return field;
    };
    let mut first = true;
    for segment in segments {
        if let JsNode::String(value) = document.node(*segment) {
            if !first {
                field.push(b'.' as u16);
            }
            field.extend(value);
            first = false;
        }
    }
    field
}

fn append_string(document: &mut JsDocument, value: Vec<u16>) -> usize {
    document.append_node(JsNode::String(value))
}

pub fn findings_document(issues: &JsDocument) -> JsDocument {
    let mut result = JsDocument::parse("{}").expect("empty JSON object");
    let mut findings = Vec::new();
    if let JsNode::Array(issue_nodes) = issues.node(issues.root()) {
        for issue in issue_nodes {
            if !matches!(issues.node(*issue), JsNode::Object(_)) {
                continue;
            }
            let mut code = "invalid-".encode_utf16().collect::<Vec<_>>();
            code.extend(string_node(issues, *issue, "code", "request"));
            let code_node = append_string(&mut result, code);
            let field_node = append_string(&mut result, field_path(issues, *issue));
            let message_node = append_string(
                &mut result,
                "Request value is invalid".encode_utf16().collect(),
            );
            findings.push(result.append_node(JsNode::Object(vec![
                ("code".encode_utf16().collect(), code_node),
                ("field".encode_utf16().collect(), field_node),
                ("message".encode_utf16().collect(), message_node),
            ])));
        }
    }
    let error_node = append_string(&mut result, "Invalid request".encode_utf16().collect());
    let findings_node = result.append_node(JsNode::Array(findings));
    let root = result.append_node(JsNode::Object(vec![
        ("error".encode_utf16().collect(), error_node),
        ("findings".encode_utf16().collect(), findings_node),
    ]));
    result.set_root(root);
    result
}

pub fn validation_error_js(issues: &JsDocument) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "application/json")],
        findings_document(issues).stringify(),
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

    #[test]
    fn issue_findings_keep_order_and_unpaired_utf16_path_units() {
        let issues = JsDocument::parse(
            r#"[{"code":"unrecognized_keys","path":["\ud800"],"message":"Invalid input"},{"code":"invalid_type","path":[],"message":"Invalid input"}]"#,
        )
        .unwrap();
        assert_eq!(
            findings_document(&issues).stringify(),
            r#"{"error":"Invalid request","findings":[{"code":"invalid-unrecognized_keys","field":".\ud800","message":"Request value is invalid"},{"code":"invalid-invalid_type","field":".","message":"Request value is invalid"}]}"#
        );
    }

    #[tokio::test]
    async fn project_body_helper_matches_typescript_root_surrogate_and_refinement_responses() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let cases = [
            (
                "projects.ProjectCreateBodySchema",
                "{}",
                StatusCode::BAD_REQUEST,
                r#"{"error":"Invalid request","findings":[{"code":"invalid-invalid_union","field":".","message":"Request value is invalid"}]}"#,
            ),
            (
                "projects.ProjectBodySchema",
                r#"{"name":"Project","repositoryPath":"/tmp/project","worktreeRoot":"/tmp/worktrees","repository":"team/project","baseBranch":"main","setupCommand":"pnpm install","verificationCommand":"pnpm test","rootProfileId":"root","workerProfileId":"worker","execution":{"environment":{"\ud800":"x"}}}"#,
                StatusCode::BAD_REQUEST,
                r#"{"error":"Invalid request","findings":[{"code":"invalid-invalid_key","field":".execution.environment.\ud800","message":"Request value is invalid"}]}"#,
            ),
            (
                "projects.ProjectRepositoryBodySchema",
                r#"{"repositoryUrl":"repo","integration":{"tracker":{"kind":"jira","site":"x","project":"APP","emailEnvironment":"JIRA_EMAIL","tokenEnvironment":"JIRA_TOKEN"}}}"#,
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":"Internal server error"}"#,
            ),
        ];
        for (contract, input, status, expected) in cases {
            let response = *crate::http::routes::auth::validated_js_body(
                &headers,
                &Bytes::copy_from_slice(input.as_bytes()),
                contract,
            )
            .unwrap_err();
            assert_eq!(response.status(), status, "{contract}");
            let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            assert_eq!(body, expected.as_bytes(), "{contract}");
        }
    }
}
