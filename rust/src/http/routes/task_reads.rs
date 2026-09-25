//! Read-only task details backed by saved intent and native observations.

use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::{
    coordination::root_session_store::{self, RootObservationRows},
    http::{
        AppState,
        contracts::typed::{self, tasks as task_contracts},
        session, validation,
    },
    identity::companies,
    platform::database::SuplexDatabase,
    runtimes::codex::{session_reader, tool_evidence},
    tasks::commands::TaskFailure,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/activity", get(activity))
        .route("/api/tasks/{task_id}/execution", get(execution))
        .route("/api/tasks/{task_id}/diff/summary", get(diff_summary))
}

fn validated_task_id(id: &str) -> Result<(), Box<Response>> {
    match task_contracts::parse_task_id_params(Some(&json!({"taskId": id}))) {
        Ok(_) => Ok(()),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(validation::validation_error_public(findings)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

fn authorize(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, Vec<String>), Box<Response>> {
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(auth::service_error)
        .map_err(Box::new)?;
    match session.user {
        Some(user) => Ok((user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn not_found() -> Box<dyn Error> {
    Box::new(TaskFailure {
        public_message: "Not found".into(),
        status_code: 404,
        code: "task_failure",
    })
}

fn read_task(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<(RootObservationRows, PathBuf), Box<dyn Error>> {
    let company_id: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    let company_id = company_id.ok_or_else(not_found)?;
    companies::require_company_access(database, user_id, &company_id)?;
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let database_path = PathBuf::from(
        database
            .connection()
            .path()
            .ok_or("Task database has no file path")?,
    );
    Ok((rows, database_path))
}

fn service_error(error: Box<dyn Error>) -> Response {
    match error.downcast::<TaskFailure>() {
        Ok(failure) => auth::error(
            StatusCode::from_u16(failure.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &failure.public_message,
        ),
        Err(error) => auth::service_error(error),
    }
}

fn respond(result: Result<Value, Box<dyn Error>>, cookies: Vec<String>) -> Response {
    let mut response = match result {
        Ok(value) => {
            let mut response = Json(value).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                "private, no-store".parse().expect("cache header"),
            );
            response
        }
        Err(error) => service_error(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

fn role_label(session: &Value) -> &'static str {
    if session["kind"] == "root" {
        "Coordinator"
    } else {
        match session["advisorRole"].as_str() {
            Some("reviewer") => "Reviewer",
            Some("planner_a") => "Plan A",
            Some("planner_b") => "Plan B",
            Some("rater") => "Rater",
            _ => "Worker",
        }
    }
}

fn session_profile<'a>(rows: &'a RootObservationRows, session: &'a Value) -> &'a Value {
    if !session["profile"].is_null() {
        return &session["profile"];
    }
    if session["kind"] == "root" {
        &rows.control["rootProfile"]
    } else if let Some(role) = session["advisorRole"].as_str() {
        rows.control["advisorProfiles"]
            .get(role)
            .unwrap_or(&rows.control["rootProfile"])
    } else {
        &rows.control["workerProfile"]
    }
}

fn activity_document(rows: &RootObservationRows) -> Value {
    let sessions = rows
        .sessions
        .iter()
        .map(|session| {
            let profile = session_profile(rows, session);
            let mut entry = json!({
                "id":session["id"], "kind":session["kind"],
                "advisorRole":session["advisorRole"], "label":role_label(session),
                "profileId":profile["profileId"], "generation":session["generation"],
                "nativeSessionId":session["nativeSessionId"], "paneId":session["paneId"],
                "current":session["current"], "replacement":session["replacement"],
            });
            if let Some(provider) = profile.get("provider") {
                entry["harness"] = provider.clone();
            }
            entry
        })
        .collect::<Vec<_>>();
    let turns = rows
        .turns
        .iter()
        .map(|turn| {
            json!({
                "id":turn["id"], "sessionId":turn["sessionId"],
                "prompt":turn["promptText"], "status":turn["status"],
                "promptedAt":turn["promptedAt"], "completedAt":turn["completedAt"],
                "result":turn["terminalObservation"],
            })
        })
        .collect::<Vec<_>>();
    json!({
        "sessions":sessions, "turns":turns,
        "shellPaneId":rows.control["shellPaneId"],
    })
}

fn execution_document(rows: &RootObservationRows, database_path: &std::path::Path) -> Value {
    let sessions = rows
        .sessions
        .iter()
        .filter(|session| !session["nativeSessionId"].is_null())
        .map(|session| {
            let mut entry = json!({
                "id":session["id"], "role":session["kind"],
                "advisorRole":session["advisorRole"], "label":role_label(session),
                "generation":session["generation"],
            });
            let profile = session_profile(rows, session);
            let observed = if profile["provider"] == "codex" {
                session["id"]
                    .as_str()
                    .ok_or("Task session ID is invalid")
                    .and_then(|id| {
                        session_reader::session_directory(database_path, id)
                            .map_err(|_| "Task session directory is unavailable")
                    })
                    .and_then(|directory| {
                        session_reader::turns(&directory)
                            .map_err(|_| "Native session observation failed")
                    })
                    .map(|turns| {
                        turns
                            .iter()
                            .flat_map(|turn| {
                                tool_evidence::codex_tools(&turn.events).into_iter().map(
                                    move |mut tool| {
                                        tool.id = format!("{}:{}", turn.id, tool.id);
                                        tool
                                    },
                                )
                            })
                            .collect::<Vec<_>>()
                    })
            } else {
                Err("The native provider is unavailable")
            };
            match observed {
                Ok(tools) => {
                    entry["available"] = json!(true);
                    entry["limited"] = json!(false);
                    entry["tools"] = json!(tools);
                    entry["plan"] = Value::Null;
                }
                Err(_) => {
                    entry["available"] = json!(false);
                    entry["limited"] = json!(false);
                    entry["tools"] = json!([]);
                    entry["plan"] = Value::Null;
                }
            }
            entry
        })
        .collect::<Vec<_>>();
    json!({"sessions":sessions})
}

async fn activity(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<Value, Box<dyn Error>> {
        let (rows, _) = read_task(database, &user_id, &task_id)?;
        Ok(activity_document(&rows))
    });
    respond(result, cookies)
}

async fn execution(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (rows, database_path) =
        match state.with_database(|database| read_task(database, &user_id, &task_id)) {
            Ok(value) => value,
            Err(error) => return respond(Err(error), cookies),
        };
    let observation = match tokio::task::spawn_blocking(move || {
        execution_document(&rows, &database_path)
    })
    .await
    {
        Ok(value) => value,
        Err(error) => return respond(Err(Box::new(error)), cookies),
    };
    // Native files can change during observation; refresh user scope after it.
    let scope = state.with_database(|database| read_task(database, &user_id, &task_id));
    respond(scope.map(|_| observation), cookies)
}

async fn diff_summary(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<Option<Value>, Box<dyn Error>> {
        let (rows, _) = read_task(database, &user_id, &task_id)?;
        if rows.control["worktree"].is_null() {
            Ok(Some(json!({"available":false,"files":0})))
        } else {
            Ok(None)
        }
    });
    match result {
        Ok(Some(value)) => respond(Ok(value), cookies),
        Ok(None) => {
            let mut response = auth::not_ported();
            auth::append_cookies(&mut response, cookies);
            response
        }
        Err(error) => respond(Err(error), cookies),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use axum::{body::to_bytes, http::HeaderValue};
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };

    #[tokio::test]
    async fn task_detail_reads_follow_live_scope_and_saved_native_intent() {
        let root = std::env::temp_dir().join(format!("suplex-ui-reads-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let database_path = root.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let stamp = now.to_rfc3339();
        database.connection().execute(
            "INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('read_company','Read','active',?1)",
            [&stamp],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('read_project','read_company','Read','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker','{}',?1,?1)",
            [&stamp],
        ).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "read_company".into(), project_id: "read_project".into(),
            title: "Read the native task".into(), description: "Inspect activity".into(),
            configuration: json!({"branch":"task-reads","baseBranch":"main"}),
            idempotency_key: "reads-1".into(), request_hash: "reads-hash".into(),
            creator: TaskCreator::User(admin.user.id.clone()), delivery_target: "local_worktree".into(),
            delivery_intent: json!({"headBranch":"task-reads","baseBranch":"main"}),
            root_profile: json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            worker_profile: json!({"profileId":"profile_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            advisor_profiles: json!({}), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![],
        }, now).unwrap().task;
        let root_session = root_session_store::reserve_root(&mut database, &task.id, now).unwrap();
        root_session_store::ensure_initial_prompt(&mut database, &root_session, "Inspect", now)
            .unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "https://suplex.example.test:4113".into(),
                tailscale_exposure: "serve".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4113"));
        assert_eq!(
            activity(State(state.clone()), Path("".into()), headers.clone())
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            activity(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let activity_response =
            activity(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(activity_response.status(), StatusCode::OK);
        assert_eq!(
            activity_response.headers()[CACHE_CONTROL],
            "private, no-store"
        );
        let body = to_bytes(activity_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let document: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(document["sessions"][0]["id"], root_session.id);
        assert_eq!(document["sessions"][0]["profileId"], "profile_root");
        assert_eq!(document["sessions"][0]["harness"], "codex");
        assert_eq!(document["sessions"][0]["nativeSessionId"], Value::Null);
        assert_eq!(document["turns"][0]["prompt"], "Inspect");
        assert_eq!(document["shellPaneId"], Value::Null);
        let execution_response =
            execution(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(execution_response.status(), StatusCode::OK);
        let body = to_bytes(execution_response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"sessions":[]})
        );
        let diff_response =
            diff_summary(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(diff_response.status(), StatusCode::OK);
        let body = to_bytes(diff_response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"available":false,"files":0})
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
                rusqlite::params![
                    json!({"path":"/tmp/task-read-worktree","branch":"task-reads","baseSha":"a".repeat(40),"headSha":"a".repeat(40),"dirty":false}).to_string(),
                    task.id,
                ],
            ).unwrap();
        });
        assert_eq!(
            diff_summary(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::NOT_IMPLEMENTED
        );
        let member_hash = Sha256::digest(b"read_member_token")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        state.with_database(|database| {
            let connection = database.connection();
            connection.execute(
                "INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES ('read_member','Member','user_v1_read_member','member','active',?1,?1,1)",
                [&stamp],
            ).unwrap();
            connection.execute(
                "INSERT INTO suplex_memberships (user_id,company_id,created_at) VALUES ('read_member','read_company',?1)",
                [&stamp],
            ).unwrap();
            connection.execute(
                "INSERT INTO suplex_sessions (id,token_hash,user_id,expires_at,created_at,token_version) VALUES ('read_member_session',?1,'read_member',?2,?3,1)",
                rusqlite::params![member_hash, (now + chrono::Duration::days(1)).to_rfc3339(), stamp],
            ).unwrap();
            connection.execute(
                "UPDATE suplex_task_sessions SET pane_id = 'stale-pane' WHERE id = ?1",
                [&root_session.id],
            ).unwrap();
        });
        headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=read_member_token"),
        );
        assert_eq!(
            activity(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        state.with_database(|database| {
            database.connection().execute(
                "DELETE FROM suplex_memberships WHERE user_id = 'read_member' AND company_id = 'read_company'",
                [],
            ).unwrap();
        });
        assert_eq!(
            activity(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            execution(State(state.clone()), Path(task.id), headers)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires Node and the TypeScript native-app fixture"]
    async fn same_database_task_detail_http_responses_match_typescript() {
        let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut oracle = Command::new("node")
            .args([
                "node_modules/tsx/dist/cli.mjs",
                "tests/support/task-ui-read-interop.ts",
            ])
            .current_dir(repository)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = oracle.stdout.take().unwrap();
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "TypeScript fixture produced no response");
        let expected: Value = serde_json::from_str(&line).unwrap();
        let database_path = expected["databasePath"].as_str().unwrap();
        let task_id = expected["taskId"].as_str().unwrap().to_owned();
        let cookie = expected["cookie"].as_str().unwrap();
        let database =
            SuplexDatabase::open(std::path::Path::new(database_path), OpenMode::ReadWrite).unwrap();
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
        headers.insert("cookie", HeaderValue::from_str(cookie).unwrap());
        for case in expected["responses"].as_array().unwrap() {
            let response = match case["path"].as_str().unwrap() {
                "activity" => {
                    activity(State(state.clone()), Path(task_id.clone()), headers.clone()).await
                }
                "execution" => {
                    execution(State(state.clone()), Path(task_id.clone()), headers.clone()).await
                }
                "diff/summary" => {
                    diff_summary(State(state.clone()), Path(task_id.clone()), headers.clone()).await
                }
                path => panic!("Unexpected route: {path}"),
            };
            assert_eq!(
                response.status().as_u16(),
                case["status"].as_u64().unwrap() as u16
            );
            assert_eq!(
                response
                    .headers()
                    .get(CACHE_CONTROL)
                    .and_then(|value| value.to_str().ok()),
                case["cacheControl"].as_str(),
            );
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                case["body"]
            );
        }
        drop(state);
        oracle.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
        assert!(oracle.wait().unwrap().success());
    }
}
