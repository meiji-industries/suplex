//! Error envelopes for agent routes. Runtime routes (`agentApiRuntime` in
//! TypeScript) always carry a stable `code`; the other agent routes use the
//! board envelope.

use std::error::Error;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

use crate::{
    identity::{auth::AuthFailure, external_agents::ExternalAgentFailure},
    platform::artifacts::ArtifactFailure,
    projects::service::ProjectFailure,
    shared::js_json,
    tasks::{agent_api::AgentTaskFailure, commands::TaskFailure, repository::TaskConflict},
};

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
        json_response(status_code, json!({"error":"Request is too large","findings":[{"code":"request-too-large","field":"images","message":"Attach fewer or smaller images and submit again"}]}))
    } else {
        auth::error(status_code, message)
    }
}

/// `agentApiTaskFailureCode`: the runtime code for a task failure.
fn runtime_task_code(status_code: u16, code: &str, message: &str) -> &'static str {
    const PASSED: [&str; 20] = [
        "delivery_policy_rejected",
        "project_not_found",
        "dependency_not_found",
        "root_profile_not_found",
        "root_profile_not_permitted",
        "worker_profile_not_found",
        "worker_profile_not_permitted",
        "advisor_profile_not_found",
        "advisor_profile_not_permitted",
        "source_issue_rejected",
        "source_pull_request_rejected",
        "source_branch_rejected",
        "workflow_not_found",
        "workflow_not_permitted",
        "template_not_found",
        "template_not_permitted",
        "revision_stale",
        "command_in_progress",
        "illegal_command",
        "request_invalid",
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
    if let Some(failure) = error.downcast_ref::<ExternalAgentFailure>() {
        return json_response(
            status(failure.status_code),
            json!({"error": failure.public_message, "code": failure.code}),
        );
    }
    if let Some(failure) = error.downcast_ref::<AuthFailure>() {
        let mut body = Map::new();
        body.insert("error".into(), json!(failure.message));
        if runtime {
            body.insert("code".into(), json!("not_found"));
        } else if failure.code != "auth_failure" {
            body.insert("code".into(), json!(failure.code));
        }
        return json_response(status(failure.status_code), Value::Object(body));
    }
    let task = error
        .downcast_ref::<AgentTaskFailure>()
        .map(|failure| (failure.status_code, failure.code, failure.public_message.clone(), failure.details.clone()))
        .or_else(|| {
            error
                .downcast_ref::<TaskFailure>()
                .map(|failure| (failure.status_code, failure.code, failure.public_message.clone(), Map::new()))
        })
        .or_else(|| {
            error
                .downcast_ref::<TaskConflict>()
                .map(|conflict| (409, "task_failure", conflict.to_string(), Map::new()))
        });
    if let Some((status_code, code, message, details)) = task {
        if code == "experimental_not_ported" {
            return auth::not_ported();
        }
        let mut body = Map::new();
        body.insert("error".into(), json!(message));
        if runtime {
            body.insert("code".into(), json!(runtime_task_code(status_code, code, &message)));
            body.extend(details);
        } else if code != "task_failure" {
            body.insert("code".into(), json!(code));
        }
        return json_response(status(status_code), Value::Object(body));
    }
    if let Some(failure) = error.downcast_ref::<ProjectFailure>() {
        let body = if runtime {
            json!({"error": failure.message, "code": if failure.status_code == 404 { "not_found" } else { "task_unavailable" }, "findings": failure.findings})
        } else {
            json!({"error": failure.message, "findings": failure.findings})
        };
        return json_response(status(failure.status_code), body);
    }
    if let Some(failure) = error.downcast_ref::<crate::tasks::sources::TaskSourceFailure>() {
        let code = if runtime { "task_unavailable" } else { failure.code };
        return json_response(status(failure.status_code), json!({"error": failure.message, "code": code}));
    }
    if let Some(failure) = error.downcast_ref::<ArtifactFailure>() {
        let code = if runtime { "task_unavailable" } else { failure.code };
        return json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error": failure.message, "code": code}),
        );
    }
    internal(runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_task_codes_follow_the_typescript_mapping() {
        assert_eq!(runtime_task_code(404, "resource_not_found", "Not found"), "not_found");
        assert_eq!(runtime_task_code(409, "task_failure", "This idempotency key belongs to a different request"), "idempotency_conflict");
        assert_eq!(runtime_task_code(409, "idempotency_conflict", "other"), "task_unavailable");
        assert_eq!(runtime_task_code(412, "revision_stale", "Task revision is stale"), "revision_stale");
        assert_eq!(runtime_task_code(422, "task_failure", "Project configuration changed"), "task_unavailable");
    }
}
