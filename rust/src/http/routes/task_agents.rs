//! Current task-agent rows use saved session intent and live native process observation.

use crate::shared::time::rfc3339_millis;
use crate::tasks::TaskError;
use crate::tasks::control::{SessionKind, SessionLifecycle, SessionRow, TaskProfile, TaskStatus};
use std::{error::Error, path::PathBuf};

use axum::{
    Json, Router,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::{
    coordination::{
        advisor_bridge::AdvisorRole,
        root_session_store::{self, RootObservationRows},
        workflows,
    },
    http::{
        AppState,
        contracts::typed::{self, finding, tasks as task_contracts},
        session, validation,
    },
    identity::companies,
    platform::database::SuplexDatabase,
    runtimes::{task_harness::ReaderSession, task_harness_registry},
    tasks::repository,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/{task_id}/agents", get(task_agents))
        .route(
            "/api/companies/{company_id}/task-agents",
            get(company_task_agents),
        )
}

fn validate_task_id(task_id: &str) -> Result<(), Box<Response>> {
    match task_contracts::parse_task_id_params(Some(&json!({"taskId":task_id}))) {
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

fn validate_company_id(company_id: &str) -> Result<(), Box<Response>> {
    let code = match company_id.encode_utf16().count() {
        0 => Some("too_small"),
        1..=256 => None,
        _ => Some("too_big"),
    };
    match code {
        Some(code) => Err(Box::new(validation::validation_error_public(vec![
            finding(code, &[json!("companyId")]),
        ]))),
        None => Ok(()),
    }
}

fn task_ids(query: Option<&str>) -> Result<Vec<String>, Box<Response>> {
    let values = query
        .into_iter()
        .flat_map(|query| url::form_urlencoded::parse(query.as_bytes()))
        .filter(|(name, _)| name == "taskId")
        .map(|(_, value)| value.into_owned())
        .collect::<Vec<_>>();
    let mut findings = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let code = match value.encode_utf16().count() {
            0 => Some("too_small"),
            1..=256 => None,
            _ => Some("too_big"),
        };
        if let Some(code) = code {
            let path = if values.len() == 1 {
                vec![json!("taskId")]
            } else {
                vec![json!("taskId"), json!(index)]
            };
            findings.push(finding(code, &path));
        }
    }
    if values.len() > 10 {
        findings.push(finding("too_big", &[json!("taskId")]));
    }
    if !findings.is_empty() {
        return Err(Box::new(validation::validation_error_public(findings)));
    }
    let mut ids = values;
    ids.sort();
    ids.dedup();
    Ok(ids)
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
        Err(error) => auth::service_error(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

struct AgentTask {
    id: String,
    status: TaskStatus,
    rows: RootObservationRows,
}

fn task(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<AgentTask, Box<dyn Error>> {
    let record = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
    companies::require_company_access(database, user_id, &record.company_id)?;
    Ok(AgentTask {
        id: record.id,
        status: record.status,
        rows: root_session_store::root_observation_rows(database, task_id)?,
    })
}

fn visible_tasks(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
    ids: &[String],
) -> Result<Vec<AgentTask>, Box<dyn Error>> {
    companies::require_company_access(database, user_id, company_id)?;
    let mut tasks = Vec::new();
    for id in ids {
        let archived: Option<Option<String>> = database
            .connection()
            .query_row(
                "SELECT archived_at FROM suplex_tasks WHERE id = ?1 AND company_id = ?2",
                rusqlite::params![id, company_id],
                |row| row.get(0),
            )
            .optional()?;
        if archived != Some(None) {
            continue;
        }
        tasks.push(task(database, user_id, id)?);
    }
    Ok(tasks)
}

fn label(session: &SessionRow) -> &'static str {
    workflows::role_label(
        session.kind.as_str(),
        session.advisor_role.map(AdvisorRole::as_str),
    )
}

/// TypeScript `observeSession`: the runtime that owns the native session reports its status.
fn native_status(
    database_path: &std::path::Path,
    session: &SessionRow,
) -> Option<(&'static str, f64)> {
    let native_session_id = session.native_session_id.as_deref()?;
    task_harness_registry::native_session_reader(native_session_id)?
        .status(&ReaderSession {
            database_path,
            session_id: &session.id,
            native_session_id,
            instance_home_directory: session
                .profile
                .as_ref()
                .and_then(TaskProfile::instance_home_directory)
                .map(std::path::Path::new),
        })
        .ok()
}

/// TypeScript `isoTimestamp`: null when the native time is not a valid date.
fn iso_timestamp(value: f64) -> Value {
    DateTime::<Utc>::from_timestamp_millis(value as i64)
        .filter(|_| value.is_finite())
        .map_or(Value::Null, |time| json!(rfc3339_millis(time)))
}

fn agents(task: &AgentTask, database_path: &std::path::Path) -> Vec<Value> {
    task.rows
        .sessions
        .iter()
        .filter(|session| session.current)
        .map(|session| {
            let (status, changed_at) = if matches!(
                session.lifecycle,
                SessionLifecycle::Stopped | SessionLifecycle::Cancelled
            ) {
                let changed = session
                    .stopped_at
                    .as_ref()
                    .or(session.stop_requested_at.as_ref());
                ("stopped", json!(changed))
            } else if session.native_session_id.is_none() {
                ("queued", Value::Null)
            } else {
                match native_status(database_path, session) {
                    Some(("busy", _)) => ("working", Value::Null),
                    Some(("retry", _)) => ("retrying", Value::Null),
                    Some(_)
                        if session.kind == SessionKind::Root
                            && task.status == TaskStatus::WaitingHuman =>
                    {
                        ("waiting_human", Value::Null)
                    }
                    Some((_, time)) => ("idle", iso_timestamp(time)),
                    None => ("unknown", Value::Null),
                }
            };
            json!({
                "id":session.id, "role":session.kind,
                "advisorRole":session.advisor_role, "label":label(session),
                "paneId":session.pane_id, "status":status,
                "statusChangedAt":changed_at,
            })
        })
        .collect()
}

fn database_path(database: &SuplexDatabase) -> Result<PathBuf, Box<dyn Error>> {
    Ok(PathBuf::from(
        database
            .connection()
            .path()
            .ok_or("Task database has no file path")?,
    ))
}

async fn task_agents(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_task_id(&task_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (task_snapshot, database_path) = match state.with_database(|database| {
        Ok::<_, Box<dyn Error>>((
            task(database, &user_id, &task_id)?,
            database_path(database)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => return respond(Err(error), cookies),
    };
    let result = match tokio::task::spawn_blocking(
        move || json!({"agents":agents(&task_snapshot, &database_path)}),
    )
    .await
    {
        Ok(value) => state
            .with_database(|database| task(database, &user_id, &task_id))
            .map(|_| value),
        Err(error) => Err(Box::new(error) as Box<dyn Error>),
    };
    respond(result, cookies)
}

async fn company_task_agents(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_company_id(&company_id) {
        return *response;
    }
    let ids = match task_ids(query.as_deref()) {
        Ok(ids) => ids,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (tasks, database_path) = match state.with_database(|database| {
        Ok::<_, Box<dyn Error>>((
            visible_tasks(database, &user_id, &company_id, &ids)?,
            database_path(database)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => return respond(Err(error), cookies),
    };
    let results = match tokio::task::spawn_blocking(move || {
        tasks
            .iter()
            .map(|task| json!({"taskId":task.id,"agents":agents(task,&database_path)}))
            .collect::<Vec<_>>()
    })
    .await
    {
        Ok(value) => value,
        Err(error) => return respond(Err(Box::new(error)), cookies),
    };
    let result = state
        .with_database(|database| visible_tasks(database, &user_id, &company_id, &ids))
        .map(|visible| {
            let ids = visible.into_iter().map(|task| task.id).collect::<std::collections::HashSet<_>>();
            json!({"tasks":results.into_iter().filter(|task| task["taskId"].as_str().is_some_and(|id| ids.contains(id))).collect::<Vec<_>>()})
        });
    respond(result, cookies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::OpenMode;
    use axum::{body::to_bytes, http::HeaderValue};
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };

    async fn response_value(response: Response) -> Value {
        let status = response.status().as_u16();
        let cache_control = response
            .headers()
            .get(CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        json!({
            "status":status,
            "body":serde_json::from_slice::<Value>(&body).unwrap(),
            "cacheControl":cache_control,
        })
    }

    #[tokio::test]
    async fn an_opencode_session_reports_its_native_busy_status() {
        let root =
            std::env::temp_dir().join(format!("suplex-task-agents-{}", uuid::Uuid::new_v4()));
        let (url, _) = crate::runtimes::opencode::client::fake::serve(|request| {
            match request.path.as_str() {
                "/session/ses_live" => (200, json!({"id":"ses_live","projectID":"p","directory":"/repo","title":"t","version":"1","time":{"created":1,"updated":9}}).to_string()),
                "/session/status" => (200, json!({"ses_live":{"type":"busy"}}).to_string()),
                _ => (404, "{}".into()),
            }
        })
        .await;
        let database = root.join("suplex.sqlite");
        let runtime = crate::runtimes::task_harness::task_session_runtime_directory(
            &database,
            "session-opencode",
        )
        .unwrap();
        std::fs::create_dir_all(&runtime).unwrap();
        let reference = json!({"pid":4321,"baseUrl":url,"password":"a".repeat(64),"directory":"/repo","executable":"/bin/opencode","generation":"b775df17-718a-4cb2-8e23-6912b8aa0d39","configHash":"a".repeat(64),"processIdentity":{"command":"opencode serve","executable":"/bin/opencode","argv":["opencode","serve"],"processGroup":4321,"startTime":"start","ownerUid":501}});
        std::fs::write(runtime.join("server.json"), reference.to_string()).unwrap();
        let task = AgentTask {
            id: "task".into(),
            status: TaskStatus::Active,
            rows: RootObservationRows {
                control: crate::tasks::control::TaskControlRow::fixture(),
                context: Value::Null,
                dependencies: Vec::new(),
                root: None,
                worker: None,
                workers: Vec::new(),
                sessions: vec![SessionRow {
                    lifecycle: SessionLifecycle::Live,
                    native_session_id: Some("ses_live".into()),
                    ..SessionRow::fixture("session-opencode", SessionKind::Root)
                }],
                turns: Vec::new(),
            },
        };
        let path = database.clone();
        let agents = tokio::task::spawn_blocking(move || agents(&task, &path))
            .await
            .unwrap();
        assert_eq!(agents[0]["status"], "working");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn array_query_reports_element_before_array_size() {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs((0..10).map(|_| ("taskId", "x")).chain([("taskId", "")]))
            .finish();
        let response = *task_ids(Some(&query)).unwrap_err();
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["findings"][0]["code"], "invalid-too_small");
        assert_eq!(value["findings"][0]["field"], ".taskId.10");
        assert_eq!(value["findings"][1]["code"], "invalid-too_big");
        assert_eq!(value["findings"][1]["field"], ".taskId");
    }

    #[tokio::test]
    #[ignore = "requires Node and the TypeScript native-app fixture"]
    async fn same_database_agent_reads_match_typescript_and_refresh_native_state() {
        let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut oracle = Command::new("node")
            .args([
                "node_modules/tsx/dist/cli.mjs",
                "tests/support/task-agents-read-interop.ts",
            ])
            .current_dir(repository)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(oracle.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert!(
            !line.is_empty(),
            "TypeScript agent fixture produced no output"
        );
        let expected: Value = serde_json::from_str(&line).unwrap();
        let database = SuplexDatabase::open(
            std::path::Path::new(expected["databasePath"].as_str().unwrap()),
            OpenMode::ReadWrite,
        )
        .unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "http://remote.test:4113".into(),
                tailscale_exposure: "none".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("remote.test:4113"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(expected["cookie"].as_str().unwrap()).unwrap(),
        );
        let company_id = expected["companyId"].as_str().unwrap().to_owned();
        let first_id = expected["firstId"].as_str().unwrap().to_owned();
        let idle_id = expected["idleId"].as_str().unwrap().to_owned();
        let query = expected["batchPath"]
            .as_str()
            .unwrap()
            .split_once('?')
            .unwrap()
            .1
            .to_owned();
        let batch = company_task_agents(
            State(state.clone()),
            Path(company_id.clone()),
            RawQuery(Some(query.clone())),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(batch).await, expected["batch"]);
        let first = task_agents(State(state.clone()), Path(first_id), headers.clone()).await;
        assert_eq!(response_value(first).await, expected["first"]);
        let idle = task_agents(State(state.clone()), Path(idle_id.clone()), headers.clone()).await;
        assert_eq!(response_value(idle).await, expected["idle"]);
        let empty = company_task_agents(
            State(state.clone()),
            Path(company_id.clone()),
            RawQuery(None),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(empty).await, expected["empty"]);
        let invalid = company_task_agents(
            State(state.clone()),
            Path(company_id.clone()),
            RawQuery(Some("taskId=".into())),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(invalid).await, expected["invalid"]);
        let too_many = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs((0..11).map(|index| ("taskId", index.to_string())))
            .finish();
        let invalid_many = company_task_agents(
            State(state.clone()),
            Path(company_id.clone()),
            RawQuery(Some(too_many)),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(invalid_many).await, expected["tooMany"]);
        oracle
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"advance\n")
            .unwrap();
        let mut refreshed = String::new();
        output.read_line(&mut refreshed).unwrap();
        let refreshed: Value = serde_json::from_str(&refreshed).unwrap();
        let batch = company_task_agents(
            State(state.clone()),
            Path(company_id.clone()),
            RawQuery(Some(query.clone())),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(batch).await, refreshed["batch"]);
        let idle = task_agents(State(state.clone()), Path(idle_id.clone()), headers.clone()).await;
        assert_eq!(response_value(idle).await, refreshed["idle"]);
        oracle
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"revoke\n")
            .unwrap();
        let mut revoked = String::new();
        output.read_line(&mut revoked).unwrap();
        let revoked: Value = serde_json::from_str(&revoked).unwrap();
        let batch = company_task_agents(
            State(state.clone()),
            Path(company_id),
            RawQuery(Some(query)),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(batch).await, revoked["batch"]);
        let idle = task_agents(State(state), Path(idle_id), headers).await;
        assert_eq!(response_value(idle).await, revoked["idle"]);
        oracle
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"close\n")
            .unwrap();
        assert!(oracle.wait().unwrap().success());
    }
}
