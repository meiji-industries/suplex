//! Error envelopes for agent routes. Runtime routes (`agentApiRuntime` in
//! TypeScript) always carry a stable `code`; the other agent routes use the
//! board envelope.

use crate::identity::IdentityError;
use crate::platform::PlatformError;
use crate::projects::ProjectError;
use crate::tasks::TaskError;
use std::error::Error;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

use crate::shared::js_json;

use super::routes::auth;

fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn json_response(status_code: StatusCode, body: Value) -> Response {
    (
        status_code,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        js_json::stringify(&body),
    )
        .into_response()
}

pub(crate) fn validation(findings: Vec<Value>, runtime: bool) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), json!("Invalid request"));
    if runtime {
        body.insert("code".into(), json!("request_invalid"));
    }
    if !findings.is_empty() {
        body.insert("findings".into(), Value::Array(findings));
    }
    json_response(StatusCode::BAD_REQUEST, Value::Object(body))
}

/// Body parser failures: fixed messages, never a fragment of the body.
pub(crate) fn body_failure(status_code: StatusCode, runtime: bool) -> Response {
    let (message, code) = match status_code {
        StatusCode::PAYLOAD_TOO_LARGE => ("Request body is too large", "payload_too_large"),
        StatusCode::UNSUPPORTED_MEDIA_TYPE => ("Unsupported media type", "unsupported_media_type"),
        _ => ("Invalid request", "request_invalid"),
    };
    if runtime {
        json_response(status_code, json!({"error": message, "code": code}))
    } else if status_code == StatusCode::PAYLOAD_TOO_LARGE {
        json_response(
            status_code,
            json!({"error":"Request is too large","findings":[{"code":"request-too-large","field":"images","message":"Attach fewer or smaller images and submit again"}]}),
        )
    } else {
        auth::error(status_code, message)
    }
}

/// `agentApiTaskFailureCode`: the runtime code for a task failure.
fn runtime_task_code(status_code: u16, code: &str, message: &str) -> &'static str {
    const PASSED: [&str; 20] = [
        "project_not_found",
        "dependency_not_found",
        "root_profile_not_found",
        "worker_profile_not_found",
        "advisor_profile_not_found",
        "advisor_role_not_in_workflow",
        "source_issue_rejected",
        "source_pull_request_rejected",
        "source_branch_rejected",
        "workflow_not_found",
        "template_not_found",
        "revision_stale",
        "command_in_progress",
        "illegal_command",
        "request_invalid",
        "answer_grant_required",
        "task_not_waiting",
        "question_stale",
        "human_decision_required",
        "option_not_offered",
    ];
    if status_code == 404 {
        return "not_found";
    }
    if message == "This idempotency key belongs to a different request" {
        return "idempotency_conflict";
    }
    PASSED
        .into_iter()
        .find(|passed| *passed == code)
        .unwrap_or("task_unavailable")
}

fn internal(runtime: bool) -> Response {
    if runtime {
        json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": "Internal server error", "code": "internal_error"}),
        )
    } else {
        auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
    }
}

/// `sendDomainFailure` plus the artifact and fallback branches of the TypeScript error handler.
pub(crate) fn failure(error: Box<dyn Error>, runtime: bool) -> Response {
    match error.downcast_ref::<IdentityError>() {
        Some(IdentityError::ExternalAgent {
            status: status_code,
            code,
            message,
        }) => {
            return json_response(
                status(*status_code),
                json!({"error": message, "code": code}),
            );
        }
        Some(IdentityError::Auth {
            status: status_code,
            code,
            message,
        }) => {
            let mut body = Map::new();
            body.insert("error".into(), json!(message));
            if runtime {
                body.insert("code".into(), json!("not_found"));
            } else if *code != "auth_failure" {
                body.insert("code".into(), json!(code));
            }
            return json_response(status(*status_code), Value::Object(body));
        }
        None => {}
    }
    let task = match error.downcast_ref::<TaskError>() {
        Some(TaskError::Agent {
            status,
            code,
            details,
            ..
        }) => Some((*status, *code, details.clone())),
        Some(TaskError::Failure { status, code, .. }) => Some((*status, *code, Map::new())),
        Some(TaskError::Conflict) => Some((409, "task_failure", Map::new())),
        _ => None,
    };
    if let Some((status_code, code, details)) = task {
        let message = error.to_string();
        let mut body = Map::new();
        body.insert("error".into(), json!(message));
        if runtime {
            body.insert(
                "code".into(),
                json!(runtime_task_code(status_code, code, &message)),
            );
            body.extend(details);
        } else if code != "task_failure" {
            body.insert("code".into(), json!(code));
        }
        return json_response(status(status_code), Value::Object(body));
    }
    if let Some(failure) = error.downcast_ref::<ProjectError>() {
        let body = if runtime {
            json!({"error": failure.to_string(), "code": if failure.status() == 404 { "not_found" } else { "task_unavailable" }, "findings": failure.findings()})
        } else {
            json!({"error": failure.to_string(), "findings": failure.findings()})
        };
        return json_response(status(failure.status()), body);
    }
    if let Some(TaskError::Source {
        status: status_code,
        code,
        message,
    }) = error.downcast_ref()
    {
        let code = if runtime { "task_unavailable" } else { code };
        return json_response(
            status(*status_code),
            json!({"error": message, "code": code}),
        );
    }
    if let Some(PlatformError::Artifact { code, message }) = error.downcast_ref() {
        let code = if runtime { "task_unavailable" } else { code };
        return json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error": message, "code": code}),
        );
    }
    // A plan limit keeps its status and code, so an agent can report it.
    if let Some(failure) = error.downcast_ref::<crate::shared::PublicFailure>()
        && failure.status == StatusCode::PAYMENT_REQUIRED
    {
        return json_response(
            failure.status,
            json!({"error": failure.message, "code": failure.code}),
        );
    }
    internal(runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_task_codes_follow_the_typescript_mapping() {
        assert_eq!(
            runtime_task_code(404, "resource_not_found", "Not found"),
            "not_found"
        );
        assert_eq!(
            runtime_task_code(
                409,
                "task_failure",
                "This idempotency key belongs to a different request"
            ),
            "idempotency_conflict"
        );
        assert_eq!(
            runtime_task_code(409, "idempotency_conflict", "other"),
            "task_unavailable"
        );
        assert_eq!(
            runtime_task_code(412, "revision_stale", "Task revision is stale"),
            "revision_stale"
        );
        assert_eq!(
            runtime_task_code(422, "task_failure", "Project configuration changed"),
            "task_unavailable"
        );
    }
}
