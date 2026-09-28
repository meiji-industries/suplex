#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::validation::test_path;
    use axum::extract::Path;

    // The handlers validate their params in an extractor; these adapters run
    // that validation for direct calls.
    fn task_ids(query: Option<&str>) -> Result<Vec<String>, Box<Response>> {
        crate::http::validation::valid::<TaskAgentsBatchQuery>(query_object(query))
            .map(|query| query.task_id)
    }

    async fn task_agents(
        state: State<AppState>,
        Path(id): Path<String>,
        headers: HeaderMap,
    ) -> Response {
        match test_path(json!({"taskId": id})) {
            Ok(path) => super::task_agents(state, path, headers).await,
            Err(response) => *response,
        }
    }

    async fn company_task_agents(
        state: State<AppState>,
        Path(id): Path<String>,
        query: RawQuery,
        headers: HeaderMap,
    ) -> Response {
        match test_path(json!({"companyId": id})) {
            Ok(path) => super::company_task_agents(state, path, query, headers).await,
            Err(response) => *response,
        }
    }
    use crate::http::session;
    use crate::platform::database::OpenMode;
    use axum::{body::to_bytes, http::HeaderValue};
    use std::{
        fs,
        time::{Duration, SystemTime},
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
    async fn batch_authority_is_rechecked_after_native_observation() {
        for change in ["archive", "revoke", "database"] {
            let root =
                std::env::temp_dir().join(format!("suplex-agent-race-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let path = root.join("suplex.sqlite");
            fs::copy(
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../tests/parity/task-agents-native/database.sqlite"
                ),
                &path,
            )
            .unwrap();
            let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
            let admin =
                crate::identity::auth::development_sign_in(&mut database, Utc::now()).unwrap();
            let (session_id, task_id, company_id): (String,String,String) = database.connection().query_row("SELECT s.id,s.task_id,t.company_id FROM suplex_task_sessions s JOIN suplex_tasks t ON t.id=s.task_id WHERE s.native_session_id='codex-idle'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_sessions SET native_session_id='ses_live' WHERE id=?1",
                    [&session_id],
                )
                .unwrap();
            let state = AppState::new(
                database,
                session::SessionConfig {
                    port: 4113,
                    reachable_address: "https://remote.test:4113".into(),
                    tailscale_exposure: "serve".into(),
                },
            );
            let observed_state = state.clone();
            let observed_task = task_id.clone();
            let user_id = admin.user.id;
            let (url, _) = crate::runtimes::opencode::client::fake::serve(move |request| {
                match request.path.as_str() {
                    "/session/ses_live" => (200, json!({"id":"ses_live","projectID":"p","directory":"/repo","title":"t","version":"1","time":{"created":1,"updated":9}}).to_string()),
                    "/session/status" => {
                        observed_state.with_database(|database| match change {
                            "archive" => database.connection().execute("UPDATE suplex_tasks SET archived_at='now' WHERE id=?1", [&observed_task]).unwrap(),
                            "revoke" => database.connection().execute("UPDATE suplex_users SET status='revoked' WHERE id=?1", [&user_id]).unwrap(),
                            _ => database.connection().execute("ALTER TABLE suplex_companies RENAME TO unavailable_companies", []).unwrap(),
                        });
                        (200, json!({"ses_live":{"type":"busy"}}).to_string())
                    },
                    _ => (404, "{}".into()),
                }
            }).await;
            let runtime =
                crate::runtimes::task_harness::task_session_runtime_directory(&path, &session_id)
                    .unwrap();
            fs::create_dir_all(&runtime).unwrap();
            fs::write(runtime.join("server.json"), json!({"pid":4321,"baseUrl":url,"password":"a".repeat(64),"directory":"/repo","executable":"/bin/opencode","generation":"b775df17-718a-4cb2-8e23-6912b8aa0d39","configHash":"a".repeat(64),"processIdentity":{"command":"opencode serve","executable":"/bin/opencode","argv":["opencode","serve"],"processGroup":4321,"startTime":"start","ownerUid":501}}).to_string()).unwrap();
            let mut headers = HeaderMap::new();
            headers.insert("host", HeaderValue::from_static("remote.test:4113"));
            headers.insert(
                "cookie",
                format!("sid_v1={}", admin.session_token).parse().unwrap(),
            );
            let response = company_task_agents(
                State(state),
                Path(company_id),
                RawQuery(Some(format!("taskId={task_id}"))),
                headers,
            )
            .await;
            let value = response_value(response).await;
            assert_eq!(
                value["status"],
                match change {
                    "archive" => 200,
                    "revoke" => 401,
                    _ => 500,
                },
                "{change}: {value}"
            );
            if change == "archive" {
                assert_eq!(value["body"], json!({"tasks":[]}));
            }
            fs::remove_dir_all(root).unwrap();
        }
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
    async fn frozen_agent_reads_refresh_and_revocation_match_typescript_source_revision() {
        let root =
            std::env::temp_dir().join(format!("suplex-agents-parity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database_path = root.join("suplex.sqlite");
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/parity/task-agents-native/database.sqlite"
            ),
            &database_path,
        )
        .unwrap();
        let expected: Value = serde_json::from_str(include_str!(
            "../../../tests/parity/task-agents-native/expected.json"
        ))
        .unwrap();
        let initial = &expected[0];
        let database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let user_id: String = database
            .connection()
            .query_row("SELECT id FROM suplex_users LIMIT 1", [], |row| row.get(0))
            .unwrap();
        let idle_session_id: String = database
            .connection()
            .query_row(
                "SELECT id FROM suplex_task_sessions WHERE native_session_id = 'codex-idle'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let runtime = crate::runtimes::task_harness::task_session_runtime_directory(
            &database_path,
            &idle_session_id,
        )
        .unwrap();
        fs::create_dir_all(&runtime).unwrap();
        let record = runtime.join("turn.json");
        let fixture_record = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/parity/task-agents-native/runtime")
            .join(&idle_session_id)
            .join("turn.json");
        fs::copy(fixture_record, &record).unwrap();
        fs::File::open(&record)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(1790339696000)),
            )
            .unwrap();
        let token =
            crate::identity::auth::create_session(&database, &user_id, chrono::Utc::now()).unwrap();
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
            HeaderValue::from_str(&format!("sid_v1={token}")).unwrap(),
        );
        let company_id = initial["companyId"].as_str().unwrap().to_owned();
        let first_id = initial["firstId"].as_str().unwrap().to_owned();
        let idle_id = initial["idleId"].as_str().unwrap().to_owned();
        let query = initial["batchPath"]
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
        assert_eq!(response_value(batch).await, initial["batch"]);
        let first = task_agents(
            State(state.clone()),
            Path(first_id.clone()),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(first).await, initial["first"]);
        let idle = task_agents(State(state.clone()), Path(idle_id.clone()), headers.clone()).await;
        assert_eq!(response_value(idle).await, initial["idle"]);
        let empty = company_task_agents(
            State(state.clone()),
            Path(company_id.clone()),
            RawQuery(None),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(empty).await, initial["empty"]);
        let invalid = company_task_agents(
            State(state.clone()),
            Path(company_id.clone()),
            RawQuery(Some("taskId=".into())),
            headers.clone(),
        )
        .await;
        assert_eq!(response_value(invalid).await, initial["invalid"]);
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
        assert_eq!(response_value(invalid_many).await, initial["tooMany"]);
        state.with_database(|database| {
            database.connection().execute("UPDATE suplex_tasks SET archived_at = '2026-09-25T12:34:56.000Z' WHERE id = ?1", [&first_id]).unwrap();
        });
        fs::remove_file(&record).unwrap();
        let refreshed = &expected[1];
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
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_users SET status = 'revoked' WHERE id = ?1",
                    [&user_id],
                )
                .unwrap();
        });
        let revoked = &expected[2];
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
        fs::remove_dir_all(root).unwrap();
    }
}
