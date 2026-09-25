//! Project template list for task creation.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use serde_json::json;

use crate::{
    http::{AppState, contracts::typed::finding, session, validation},
    tasks::{commands::TaskFailure, templates},
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/projects/{project_id}/task-templates", get(list))
}

async fn list(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if project_id.is_empty() {
        return validation::validation_error_public(vec![finding(
            "too_small",
            &[json!("projectId")],
        )]);
    }
    let session = match state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return auth::service_error(error),
    };
    let mut response = match session.user {
        Some(user) => {
            match state.with_database(|database| templates::list(database, &user.id, &project_id)) {
                Ok(templates) => Json(json!({"templates":templates})).into_response(),
                Err(error) => match error.downcast::<TaskFailure>() {
                    Ok(failure) => auth::error(
                        StatusCode::from_u16(failure.status_code)
                            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                        &failure.public_message,
                    ),
                    Err(error) => auth::service_error(error),
                },
            }
        }
        None => auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::{body::to_bytes, http::HeaderValue};
    use serde_json::Value;
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };

    #[test]
    fn stored_configuration_defaults_and_rejects_extra_keys() {
        let parsed = crate::http::contracts::typed::task_templates::parse_stored_configuration(
            json!({"name":" Alpha ","description":"  Description  "}),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            json!({
                "name":"Alpha", "description":"Description",
                "deliveryTarget":"pull_request_draft", "runProjectTests":true,
                "visualEvidence":"off", "workflow":"standard", "advisorProfileIds":{}
            })
        );
        assert!(
            crate::http::contracts::typed::task_templates::parse_stored_configuration(
                json!({"name":" ","rootProfileId":null})
            )
            .is_err()
        );
        assert!(
            crate::http::contracts::typed::task_templates::parse_stored_configuration(
                json!({"name":"Alpha","extra":"reject"})
            )
            .is_err()
        );
    }

    #[tokio::test]
    #[ignore = "requires Node and the TypeScript native-app fixture"]
    async fn same_database_template_list_matches_typescript() {
        let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut oracle = Command::new("node")
            .args([
                "node_modules/tsx/dist/cli.mjs",
                "tests/support/task-template-read-interop.ts",
            ])
            .current_dir(repository)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(oracle.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert!(!line.is_empty(), "TypeScript fixture produced no response");
        let expected: Value = serde_json::from_str(&line).unwrap();
        let database = SuplexDatabase::open(
            std::path::Path::new(expected["databasePath"].as_str().unwrap()),
            OpenMode::ReadWrite,
        )
        .unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "http://127.0.0.1:4111".into(),
                tailscale_exposure: "none".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("127.0.0.1:4111"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(expected["cookie"].as_str().unwrap()).unwrap(),
        );
        let response = list(
            State(state.clone()),
            Path(expected["projectId"].as_str().unwrap().to_owned()),
            headers,
        )
        .await;
        assert_eq!(response.status().as_u16(), expected["status"]);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            expected["body"]
        );
        drop(state);
        oracle.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
        assert!(oracle.wait().unwrap().success());
    }
}
