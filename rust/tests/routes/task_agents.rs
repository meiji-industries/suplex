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

    async fn task_agents(state: State<AppState>, Path(id): Path<String>, headers: HeaderMap) -> Response {
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
