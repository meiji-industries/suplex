//! Project task templates: list, create, save from a task, edit, and delete.

use crate::http::error::ApiError;
use std::error::Error;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::{
    coordination::workflow_records::normalize_workflow_input,
    http::{
        AppState,
        contracts::typed::{ContractResult, finding, task_templates as contracts},
        session, validation,
    },
    platform::database::SuplexDatabase,
    tasks::templates,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/{project_id}/task-templates",
            get(list).post(create),
        )
        .route(
            "/api/tasks/{task_id}/save-as-template",
            post(save_from_task),
        )
        .route(
            "/api/task-templates/{template_id}",
            patch(update).delete(delete),
        )
}

type Parser<T> = fn(Option<&Value>) -> ContractResult<T>;

/// Parse the body, then check the request origin and the session, in the
/// TypeScript hook order.
fn admitted<T>(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
    body: Option<(&Bytes, Parser<T>)>,
) -> Result<(Option<T>, String, Vec<String>), Box<Response>> {
    let parsed = match body {
        Some((body, parse)) => Some(auth::validated_typed_body(headers, body, parse)?),
        None => None,
    };
    if !session::csrf_allowed(&state.session_config, headers, method.as_str(), false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(|error| Box::new(ApiError::response(error)))?;
    match session.user {
        Some(user) => Ok((parsed, user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn respond<T: serde::Serialize>(
    state: &AppState,
    status: StatusCode,
    cookies: Vec<String>,
    operation: impl FnOnce(&mut SuplexDatabase) -> Result<T, Box<dyn Error>>,
) -> Response {
    let mut response = match state.with_database(operation) {
        Ok(_) if status == StatusCode::NO_CONTENT => status.into_response(),
        Ok(value) => (status, Json(value)).into_response(),
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

fn object_body(input: Option<&Value>) -> ContractResult<Map<String, Value>> {
    contracts::parse_create(input).and_then(|configuration| {
        match serde_json::to_value(configuration) {
            Ok(Value::Object(value)) => Ok(value),
            _ => Err(crate::http::contracts::typed::ContractFailure::Unhandled),
        }
    })
}

async fn create(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // The TypeScript preValidation hook applies workflow defaults to the raw body.
    let mut raw = match auth::parsed_body(&headers, &body) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Some(Value::Object(fields)) = raw.as_mut()
        && let Err(message) = normalize_workflow_input(fields, false)
    {
        return auth::error(StatusCode::UNPROCESSABLE_ENTITY, &message);
    }
    let input = match object_body(raw.as_ref()) {
        Ok(value) => value,
        Err(crate::http::contracts::typed::ContractFailure::Issues(findings)) => {
            return validation::validation_error_public(findings);
        }
        Err(_) => return auth::error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    let (_, user_id, cookies) = match admitted::<()>(&state, &headers, &Method::POST, None) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(&state, StatusCode::CREATED, cookies, |database| {
        templates::create(database, &user_id, &project_id, input)
    })
}

async fn save_from_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, user_id, cookies) = match admitted(
        &state,
        &headers,
        &Method::POST,
        Some((&body, contracts::parse_save)),
    ) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let name = name.unwrap_or_default();
    respond(&state, StatusCode::CREATED, cookies, |database| {
        templates::create_from_task(database, &user_id, &task_id, &name)
    })
}

async fn update(
    State(state): State<AppState>,
    Path(template_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (changes, user_id, cookies) = match admitted(
        &state,
        &headers,
        &Method::PATCH,
        Some((&body, contracts::parse_update)),
    ) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let changes = changes.unwrap_or_default();
    respond(&state, StatusCode::OK, cookies, |database| {
        templates::update(database, &user_id, &template_id, changes)
    })
}

async fn delete(
    State(state): State<AppState>,
    Path(template_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (_, user_id, cookies) = match admitted::<()>(&state, &headers, &Method::DELETE, None) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    respond(&state, StatusCode::NO_CONTENT, cookies, |database| {
        templates::delete(database, &user_id, &template_id)
    })
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
        Err(error) => return ApiError::response(error),
    };
    let mut response = match session.user {
        Some(user) => {
            match state.with_database(|database| templates::list(database, &user.id, &project_id)) {
                Ok(templates) => Json(json!({"templates":templates})).into_response(),
                Err(error) => ApiError::response(error),
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

    #[tokio::test]
    async fn templates_use_profile_defaults_support_reset_and_delete() {
        let (state, filename) = super::super::auth::tests::state();
        let now = Utc::now();
        let (admin, project) = state.with_database(|database| {
            let admin = crate::identity::auth::development_sign_in(database, now).unwrap();
            let company =
                crate::identity::companies::create_company(database, &admin.user.id, "Templates", now)
                    .unwrap();
            database.connection().execute(
                "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('project_templates', ?1, 'Templates', '/tmp/templates', '/tmp/templates-worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', ?2, ?2)",
                rusqlite::params![company.id, now.to_rfc3339()],
            ).unwrap();
            let project =
                crate::projects::service::get(database, &admin.user.id, "project_templates").unwrap();
            (admin, project)
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(axum::serve(listener, crate::http::router(state.clone())).into_future());
        let client = reqwest::Client::new();
        let cookie = format!("sid_v1={}", admin.session_token);
        let send = |method: reqwest::Method, path: &str, body: Option<Value>| {
            let request = client
                .request(method, format!("http://{address}{path}"))
                .header("origin", "https://suplex.example.test:4111")
                .header("cookie", &cookie);
            match body {
                Some(body) => request.json(&body),
                None => request,
            }
            .send()
        };
        let url = "/api/projects/project_templates/task-templates";
        let payload = json!({"name":"Review a change","description":"Check the result","rootProfileId":"profile_native_root","workerProfileId":"profile_native_worker","deliveryTarget":"pull_request_draft","runProjectTests":true,"visualEvidence":"off"});
        let created = send(reqwest::Method::POST, url, Some(payload.clone()))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let created: Value = created.json().await.unwrap();
        assert_eq!(created["projectId"], "project_templates");
        assert_eq!(created["workflow"], "standard");
        let duplicate = send(reqwest::Method::POST, url, Some(payload.clone()))
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        assert_eq!(
            duplicate.json::<Value>().await.unwrap(),
            json!({"error":"This template name is already in use"})
        );
        let id = created["id"].as_str().unwrap();
        let updated = send(
            reqwest::Method::PATCH,
            &format!("/api/task-templates/{id}"),
            Some(json!({"rootProfileId":null})),
        )
        .await
        .unwrap();
        assert_eq!(updated.status(), StatusCode::OK);
        let updated: Value = updated.json().await.unwrap();
        assert!(updated.get("rootProfileId").is_none());
        assert_eq!(updated["workerProfileId"], "profile_native_worker");
        let mut unknown = payload.clone();
        unknown["roleAgents"] = json!({});
        assert_eq!(
            send(reqwest::Method::POST, url, Some(unknown))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let mismatch = send(
            reqwest::Method::POST,
            url,
            Some(json!({"name":"Other","workflow":"direct_build","advisorProfileIds":{"reviewer":"profile_native_root"}})),
        )
        .await
        .unwrap();
        assert_eq!(mismatch.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            mismatch.json::<Value>().await.unwrap(),
            json!({"error":"The Direct build workflow has no Reviewer Advisor"})
        );
        // Switching to repair replaces the inherited delivery settings.
        let repair = send(
            reqwest::Method::PATCH,
            &format!("/api/task-templates/{id}"),
            Some(json!({"workflow":"refine_pull_request"})),
        )
        .await
        .unwrap();
        let repair: Value = repair.json().await.unwrap();
        assert_eq!(repair["deliveryTarget"], "merged");
        assert_eq!(repair["runProjectTests"], true);
        let contradiction = send(
            reqwest::Method::PATCH,
            &format!("/api/task-templates/{id}"),
            Some(json!({"deliveryTarget":"local_worktree"})),
        )
        .await
        .unwrap();
        assert_eq!(contradiction.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let foreign = client
            .delete(format!("http://{address}/api/task-templates/{id}"))
            .header("origin", "https://foreign.example")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
        let deleted = send(
            reqwest::Method::DELETE,
            &format!("/api/task-templates/{id}"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        assert!(deleted.bytes().await.unwrap().is_empty());
        let listed = send(reqwest::Method::GET, url, None).await.unwrap();
        assert_eq!(
            listed.json::<Value>().await.unwrap(),
            json!({"templates":[]})
        );

        let task_id = crate::tasks::repository::new_task_id();
        state.with_database(|database| {
            let prepared = crate::tasks::repository::PreparedTask {
                id: task_id.clone(),
                company_id: project.company_id.clone(),
                project_id: project.id.clone(),
                title: "Saved task".into(),
                description: "Saved description".into(),
                configuration: json!({"repository":"owner/repo","branch":"task-saved","baseBranch":"main","baselineSha":"head","runProjectTests":false,"visualEvidence":"capture"}),
                idempotency_key: "saved-task-key".into(),
                request_hash: "saved-task-hash".into(),
                creator: crate::tasks::repository::TaskCreator::User(admin.user.id.clone()),
                delivery_target: "local_worktree".into(),
                delivery_intent: json!({"repository":"owner/repo","headBranch":"task-saved","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
                root_profile: json!({"profileId":"profile_native_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
                worker_profile: json!({"profileId":"profile_native_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
                advisor_profiles: json!({}),
                issue: None,
                start_queued: false,
                copied_from_task_id: None,
                depends_on: vec![], pull_request_dependencies: vec![],
            };
            crate::tasks::commands::create_user_task(
                database,
                &admin.user.id,
                &project,
                &prepared,
                now,
                |_| {},
            )
            .unwrap();
        });
        let saved = send(
            reqwest::Method::POST,
            &format!("/api/tasks/{task_id}/save-as-template"),
            Some(json!({"name":"  From task  "})),
        )
        .await
        .unwrap();
        assert_eq!(saved.status(), StatusCode::CREATED);
        let saved: Value = saved.json().await.unwrap();
        assert_eq!(saved["name"], "From task");
        assert_eq!(saved["description"], "Saved description");
        assert_eq!(saved["rootProfileId"], "profile_native_root");
        assert_eq!(saved["deliveryTarget"], "local_worktree");
        assert_eq!(saved["runProjectTests"], false);
        assert_eq!(saved["visualEvidence"], "capture");
        assert_eq!(
            send(
                reqwest::Method::POST,
                "/api/tasks/task_missing/save-as-template",
                Some(json!({"name":"Missing"})),
            )
            .await
            .unwrap()
            .status(),
            StatusCode::NOT_FOUND
        );
        server.abort();
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

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
