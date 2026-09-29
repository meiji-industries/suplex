#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::git;

    use crate::http::validation::{test_body, test_path};
    use axum::extract::Path;

    // The handlers validate their params and body in extractors; these
    // adapters run that validation for direct calls.
    async fn create(
        state: State<AppState>,
        Path(company_id): Path<String>,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        match test_path(json!({"companyId": company_id})) {
            Ok(path) => super::create(state, path, headers, Ok(body)).await,
            Err(response) => *response,
        }
    }

    async fn list_company(
        state: State<AppState>,
        Path(company_id): Path<String>,
        uri: OriginalUri,
        headers: HeaderMap,
    ) -> Response {
        match test_path(json!({"companyId": company_id})) {
            Ok(path) => super::list_company(state, path, uri, headers).await,
            Err(response) => *response,
        }
    }

    macro_rules! task_path {
        ($($name:ident),*) => {$(
            async fn $name(state: State<AppState>, Path(id): Path<String>, headers: HeaderMap) -> Response {
                match test_path(json!({"taskId": id})) {
                    Ok(path) => super::$name(state, path, headers).await,
                    Err(response) => *response,
                }
            }
        )*};
    }

    macro_rules! task_body {
        ($($name:ident),*) => {$(
            async fn $name(
                state: State<AppState>,
                Path(id): Path<String>,
                headers: HeaderMap,
                body: Bytes,
            ) -> Response {
                let path = match test_path(json!({"taskId": id})) {
                    Ok(path) => path,
                    Err(response) => return *response,
                };
                match test_body(&headers, &body) {
                    Ok(body) => super::$name(state, path, headers, body).await,
                    Err(response) => *response,
                }
            }
        )*};
    }

    task_path!(get_one, cancel_pending, start_pending, unarchive_pending);
    task_body!(
        answer_pending,
        archive_pending,
        rename,
        replace_coordinator,
        replace_worker,
        send_note,
        update_details
    );
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{body::to_bytes, http::HeaderValue};
    use std::{
        fs,
        process::Command,
        task::{Context, Poll, Waker},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use uuid::Uuid;

    fn git(args: &[&str], cwd: &std::path::Path) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn local_backlog_create_fetches_git_and_returns_full_task_shape() {
        let root = std::env::temp_dir().join(format!("suplex-task-http-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let bare = root.join("origin.git");
        let local = root.join("repository");
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            &root,
        );
        git(
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                local.to_str().unwrap(),
            ],
            &root,
        );
        git(&["remote", "add", "origin", bare.to_str().unwrap()], &local);
        git(
            &[
                "-c",
                "user.name=Probe",
                "-c",
                "user.email=probe@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "base",
            ],
            &local,
        );
        git(&["push", "--quiet", "origin", "main"], &local);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "git@github.com:acme/demo.git",
            ],
            &local,
        );
        let rewrite = format!("url.file://{}.insteadOf", bare.display());
        git(
            &[
                "config",
                "--local",
                &rewrite,
                "https://github.com/acme/demo.git",
            ],
            &local,
        );
        let github = git::Github {
            api: Some(("https://api.github.com".into(), "fixture-token".into())),
            git: None,
        };
        assert_eq!(
            git::capture_local_task_heads(&github, &local, "main", "github")
                .await
                .unwrap()
                .len(),
            40
        );

        let db_path = root.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&db_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('task_http_company', 'Task company', 'active', ?1)",
            [now.to_rfc3339()],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('task_http_project', 'task_http_company', 'Task project', ?1, ?2, 'acme/demo', 'main', '', '', 'profile_native_root', 'profile_native_worker', ?3, ?4, ?4)",
            rusqlite::params![local.to_str().unwrap(), root.join("worktrees").to_str().unwrap(), json!({"workflowIds":["standard"],"defaultWorkflowId":"standard","rootProfileIds":["profile_native_root"],"workerProfileIds":["profile_native_worker"]}).to_string(), now.to_rfc3339()],
        ).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: address.port(),
                reachable_address: format!("http://127.0.0.1:{}", address.port()),
                tailscale_exposure: "none".into(),
            },
        )
        .with_artifact_root(root.join("artifacts"))
        .with_project_github(github);
        let app = crate::http::router(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let mut headers = HeaderMap::new();
        headers.insert(
            "host",
            HeaderValue::from_str(&format!("127.0.0.1:{}", address.port())).unwrap(),
        );
        headers.insert(
            "origin",
            HeaderValue::from_str(&format!("http://127.0.0.1:{}", address.port())).unwrap(),
        );
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let body = Bytes::from(
            json!({
                "projectId":"task_http_project", "title":"Build the task route",
                "idempotencyKey":"task-http-key", "deliveryTarget":"local_worktree",
                "images":[{"filename":"design.png","mimeType":"image/png","base64":"iVBORw0KGgo="}],
            })
            .to_string(),
        );
        let mut content_headers = HeaderMap::new();
        content_headers.insert("content-type", HeaderValue::from_static("application/json"));
        let invalid_workflow = create(
            State(state.clone()), Path("task_http_company".into()), content_headers.clone(),
            Bytes::from(json!({"projectId":"task_http_project","title":"Build","idempotencyKey":"abcdefgh","workflow":"wrong"}).to_string()),
        ).await;
        assert_eq!(invalid_workflow.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            to_bytes(invalid_workflow.into_body(), 1024)
                .await
                .unwrap()
                .as_ref(),
            br#"{"error":"The selected workflow does not exist"}"#
        );
        let invalid_body = create(
            State(state.clone()),
            Path("task_http_company".into()),
            content_headers.clone(),
            Bytes::from(
                json!({"projectId":"task_http_project","title":"","idempotencyKey":"abcdefgh"})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(invalid_body.status(), StatusCode::BAD_REQUEST);
        let oversized = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/api/companies/task_http_company/tasks",
                address.port()
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .header("origin", format!("http://127.0.0.1:{}", address.port()))
            .header("content-type", "application/json")
            .body(vec![b' '; images::MAX_TASK_REQUEST_BYTES + 1])
            .send()
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            oversized.text().await.unwrap(),
            "{\"error\":\"Request is too large\",\"findings\":[{\"code\":\"request-too-large\",\"field\":\"images\",\"message\":\"Attach fewer or smaller images and submit again\"}]}"
        );
        let mut wrong_origin_headers = headers.clone();
        wrong_origin_headers.insert(
            "origin",
            HeaderValue::from_static("https://wrong.example.test"),
        );
        let wrong_origin = create(
            State(state.clone()),
            Path("task_http_company".into()),
            wrong_origin_headers,
            body.clone(),
        )
        .await;
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        let mut connection = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!(
            "POST /api/companies/task_http_company/tasks HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://127.0.0.1:{}\r\nCookie: sid_v1={}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            address.port(),
            address.port(),
            admin.session_token,
            body.len(),
            std::str::from_utf8(&body).unwrap(),
        );
        connection.write_all(request.as_bytes()).await.unwrap();
        let mut wire = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            connection.read_to_end(&mut wire),
        )
        .await
        .unwrap()
        .unwrap();
        let wire = std::str::from_utf8(&wire).unwrap();
        let (head, wire_body) = wire.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 201"), "{head}\n{wire_body}");
        let raw = Bytes::copy_from_slice(wire_body.as_bytes());
        let value: Value = serde_json::from_slice(&raw).unwrap();
        let artifact_id = value["images"][0]["artifactId"].as_str().unwrap();
        let client = reqwest::Client::new();
        for alias in ["images", "artifacts"] {
            let response = client
                .get(format!(
                    "http://127.0.0.1:{}/api/tasks/{}/{}/{}",
                    address.port(),
                    value["id"].as_str().unwrap(),
                    alias,
                    artifact_id
                ))
                .header("cookie", format!("sid_v1={}", admin.session_token))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["cache-control"], "private, no-store");
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert_eq!(response.headers()["content-type"], "image/png");
            assert_eq!(
                response.bytes().await.unwrap().as_ref(),
                &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
            );
        }
        for (task_id, id) in [
            (value["id"].as_str().unwrap(), "missing-artifact"),
            ("missing-task", artifact_id),
        ] {
            let response = client
                .get(format!(
                    "http://127.0.0.1:{}/api/tasks/{}/images/{}",
                    address.port(),
                    task_id,
                    id
                ))
                .header("cookie", format!("sid_v1={}", admin.session_token))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(response.text().await.unwrap(), "{\"error\":\"Not found\"}");
        }
        let storage_path: String = state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT storage_path FROM suplex_artifacts WHERE id = ?1",
                    [artifact_id],
                    |row| row.get(0),
                )
                .unwrap()
        });
        let file_path = root.join("artifacts").join(&storage_path);
        fs::write(&file_path, b"changed").unwrap();
        let corrupt = client
            .get(format!(
                "http://127.0.0.1:{}/api/tasks/{}/images/{}",
                address.port(),
                value["id"].as_str().unwrap(),
                artifact_id
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .send()
            .await
            .unwrap();
        assert_eq!(corrupt.status(), StatusCode::CONFLICT);
        assert_eq!(
            corrupt.text().await.unwrap(),
            "{\"error\":\"The stored artifact failed its integrity check\"}"
        );
        fs::write(&file_path, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        assert_eq!(value["status"], "backlog");
        assert_eq!(value["workflow"], "standard");
        assert_eq!(value["configuration"]["repository"], "acme/demo");
        assert_eq!(
            value["configuration"]["baselineSha"]
                .as_str()
                .unwrap()
                .len(),
            40
        );
        assert!(
            value["configuration"]["branch"]
                .as_str()
                .unwrap()
                .ends_with(
                    &value["id"].as_str().unwrap()[value["id"].as_str().unwrap().len() - 6..]
                )
        );
        assert_eq!(value["limits"]["admittedTurns"], 0);
        let repeated = create(
            State(state.clone()),
            Path("task_http_company".into()),
            headers.clone(),
            body,
        )
        .await;
        assert_eq!(repeated.status(), StatusCode::OK);
        let repeated_raw = to_bytes(repeated.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(raw, repeated_raw);
        let task_id = value["id"].as_str().unwrap().to_owned();
        let detail = get_one(State(state.clone()), Path(task_id.clone()), headers.clone()).await;
        assert_eq!(detail.status(), StatusCode::OK);
        assert_eq!(to_bytes(detail.into_body(), 128 * 1024).await.unwrap(), raw);
        let refreshed = client
            .post(format!(
                "http://127.0.0.1:{}/api/tasks/{task_id}/refresh",
                address.port()
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .header("origin", format!("http://127.0.0.1:{}", address.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(refreshed.status(), StatusCode::OK);
        assert_eq!(refreshed.bytes().await.unwrap(), raw);
        let refused = client
            .post(format!(
                "http://127.0.0.1:{}/api/tasks/{task_id}/refresh",
                address.port()
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .header("origin", "https://wrong.example.test")
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        let checks = client
            .get(format!(
                "http://127.0.0.1:{}/api/tasks/{task_id}/checks",
                address.port()
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .send()
            .await
            .unwrap();
        assert_eq!(checks.status(), StatusCode::OK);
        assert_eq!(
            checks.text().await.unwrap(),
            r#"{"available":false,"runs":[]}"#
        );
        let listed = list_company(
            State(state.clone()),
            Path("task_http_company".into()),
            OriginalUri("/api/companies/task_http_company/tasks".parse().unwrap()),
            {
                let mut value = HeaderMap::new();
                value.insert(
                    "host",
                    HeaderValue::from_str(&format!("127.0.0.1:{}", address.port())).unwrap(),
                );
                value.insert(
                    "cookie",
                    HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
                );
                value
            },
        )
        .await;
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = to_bytes(listed.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            listed.as_ref(),
            format!("{{\"tasks\":[{}]}}", std::str::from_utf8(&raw).unwrap()).as_bytes()
        );
        let reviewed = create(
            State(state.clone()), Path("task_http_company".into()), headers.clone(),
            Bytes::from(json!({"projectId":"task_http_project","title":"Reviewed","idempotencyKey":"review-1","deliveryTarget":"local_worktree","workflow":"independent_review"}).to_string()),
        ).await;
        assert_eq!(reviewed.status(), StatusCode::CREATED);
        let reviewed: Value =
            serde_json::from_slice(&to_bytes(reviewed.into_body(), 128 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(reviewed["workflow"], "independent_review");
        assert_eq!(
            reviewed["advisorProfiles"]["reviewer"]["profileId"],
            "profile_native_independent"
        );
        let wrong_role = create(
            State(state.clone()), Path("task_http_company".into()), headers.clone(),
            Bytes::from(json!({"projectId":"task_http_project","title":"Wrong role","idempotencyKey":"review-2","deliveryTarget":"local_worktree","workflow":"independent_review","advisorProfileIds":{"reviewer":"profile_native_worker"}}).to_string()),
        ).await;
        assert_eq!(wrong_role.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let empty_edit = update_details(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(empty_edit.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            to_bytes(empty_edit.into_body(), 1024)
                .await
                .unwrap()
                .as_ref(),
            br#"{"error":"Internal server error"}"#
        );
        state.with_database(|database| database.connection().execute(
            "UPDATE suplex_profiles SET archived_at = ?1 WHERE id IN ('profile_native_root','profile_native_worker')",
            [Utc::now().to_rfc3339()],
        )).unwrap();
        let edited = update_details(
            State(state.clone()), Path(task_id.clone()), headers.clone(),
            Bytes::from(json!({"title":"  Edited objective  ","description":"  Check the edit  ","runProjectTests":false,"visualEvidence":"capture"}).to_string()),
        ).await;
        assert_eq!(edited.status(), StatusCode::OK);
        let edited_raw = to_bytes(edited.into_body(), 128 * 1024).await.unwrap();
        let edited_value: Value = serde_json::from_slice(&edited_raw).unwrap();
        assert_eq!(edited_value["title"], "Edited objective");
        assert_eq!(
            edited_value["rootProfile"]["profileId"],
            "profile_native_root"
        );
        assert_eq!(edited_value["configuration"]["runProjectTests"], false);
        let backlog_renamed = rename(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"title":"Backlog name"}"#),
        )
        .await;
        assert_eq!(backlog_renamed.status(), StatusCode::OK);
        let backlog_raw = to_bytes(backlog_renamed.into_body(), 128 * 1024)
            .await
            .unwrap();
        let backlog_value: Value = serde_json::from_slice(&backlog_raw).unwrap();
        assert_eq!(backlog_value["id"], task_id);
        assert_eq!(backlog_value["title"], "Backlog name");
        let objective: String = state
            .with_database(|database| {
                database.connection().query_row(
                    "SELECT objective FROM suplex_task_controls WHERE task_id = ?1",
                    [&task_id],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(objective, "Backlog name\n\nCheck the edit");
        state
            .with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
                    [&task_id],
                )
            })
            .unwrap();
        let active_renamed = rename(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"title":"Active name"}"#),
        )
        .await;
        assert_eq!(active_renamed.status(), StatusCode::OK);
        let active_raw = to_bytes(active_renamed.into_body(), 128 * 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&active_raw).unwrap()["title"],
            "Active name"
        );
        let objective_after: String = state
            .with_database(|database| {
                database.connection().query_row(
                    "SELECT objective FROM suplex_task_controls WHERE task_id = ?1",
                    [&task_id],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(objective_after, objective);
        let active_edit = update_details(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"title":"Too late"}"#),
        )
        .await;
        assert_eq!(active_edit.status(), StatusCode::CONFLICT);
        state
            .with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_tasks SET archived_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), task_id],
                )
            })
            .unwrap();
        let archived_rename = rename(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"title":"Archived name"}"#),
        )
        .await;
        assert_eq!(archived_rename.status(), StatusCode::CONFLICT);
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_tasks SET archived_at = NULL WHERE id = ?1",
                [&task_id],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'backlog', objective = (SELECT CASE WHEN description = '' THEN title ELSE title || char(10) || char(10) || description END FROM suplex_tasks WHERE id = ?1) WHERE task_id = ?1",
                [&task_id],
            )
        }).unwrap();
        state.with_database(|database| database.connection().execute(
            "UPDATE suplex_profiles SET archived_at = NULL WHERE id IN ('profile_native_root','profile_native_worker')", [],
        )).unwrap();
        let immediate_body = Bytes::from(
            json!({
                "projectId":"task_http_project", "title":"Start on creation",
                "idempotencyKey":"task-immediate-key", "deliveryTarget":"local_worktree",
                "startImmediately":true
            })
            .to_string(),
        );
        let immediate = create(
            State(state.clone()),
            Path("task_http_company".into()),
            headers.clone(),
            immediate_body.clone(),
        )
        .await;
        assert_eq!(immediate.status(), StatusCode::CREATED);
        let immediate_raw = to_bytes(immediate.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&immediate_raw).unwrap()["status"],
            "active"
        );
        let immediate_replay = create(
            State(state.clone()),
            Path("task_http_company".into()),
            headers.clone(),
            immediate_body,
        )
        .await;
        assert_eq!(immediate_replay.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(immediate_replay.into_body(), 128 * 1024)
                .await
                .unwrap(),
            immediate_raw
        );
        let immediate_id = serde_json::from_slice::<Value>(&immediate_raw).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (root_session, question_id) = state.with_database(|database| {
            let root = crate::coordination::root_session_store::reserve_root(
                database,
                &immediate_id,
                Utc::now(),
            )
            .unwrap();
            assert!(
                crate::coordination::root_session_store::ask_human_for_root(
                    database,
                    &immediate_id,
                    &root.id,
                    root.generation,
                    "Use main?",
                    &json!([]),
                    Utc::now(),
                )
                .unwrap()
            );
            let question_id: String = database
                .connection()
                .query_row(
                    "SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?1",
                    [&immediate_id],
                    |row| row.get(0),
                )
                .unwrap();
            (root.id, question_id)
        });
        assert!(!root_session.is_empty());
        let bad_answer = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            content_headers.clone(),
            Bytes::from_static(br#"{"questionId":"","answer":""}"#),
        )
        .await;
        assert_eq!(bad_answer.status(), StatusCode::BAD_REQUEST);
        let limit_answer = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from(
                json!({"questionId":question_id,"limitDecision":{"kind":"cancel_task"}})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(limit_answer.status(), StatusCode::CONFLICT);
        let missing_limit_answer = answer_pending(
            State(state.clone()),
            Path("task_missing".into()),
            headers.clone(),
            Bytes::from(
                json!({"questionId":question_id,"limitDecision":{"kind":"cancel_task"}})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(missing_limit_answer.status(), StatusCode::NOT_FOUND);
        let answer_body =
            Bytes::from(json!({"questionId":question_id,"answer":"  Proceed  "}).to_string());
        let answered = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            answer_body.clone(),
        )
        .await;
        assert_eq!(answered.status(), StatusCode::OK);
        let answered_raw = to_bytes(answered.into_body(), 128 * 1024).await.unwrap();
        let answered_value: Value = serde_json::from_slice(&answered_raw).unwrap();
        assert_eq!(answered_value["status"], "active");
        assert!(answered_value["humanQuestion"].is_null());
        let invalid_note = send_note(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"note":"   ","extra":true}"#),
        )
        .await;
        assert_eq!(invalid_note.status(), StatusCode::BAD_REQUEST);
        let noted = send_note(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"note":"  Check the current result.  "}"#),
        )
        .await;
        assert_eq!(noted.status(), StatusCode::OK);
        let noted_raw = to_bytes(noted.into_body(), 128 * 1024).await.unwrap();
        let noted_value: Value = serde_json::from_slice(&noted_raw).unwrap();
        assert_eq!(noted_value["id"], immediate_id);
        let (noted_root, noted_hash): (String, String) = state.with_database(|database| {
            database.connection().query_row(
                "SELECT session_id,prompt_hash FROM suplex_task_turns WHERE task_id = ?1 AND prompt_text = 'Human note:' || char(10) || 'Check the current result.'",
                [&immediate_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        }).unwrap();
        assert_eq!(noted_root, root_session);
        assert_eq!(
            noted_hash,
            "d41fa338e9f66d1b305d9678a1d2556a9c7559c0ec366d11abf1088a500507eb"
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'delivered',workflow = 'independent_review',workflow_state_json = json_set(workflow_state_json,'$.completion',json(?1)) WHERE task_id = ?2",
                rusqlite::params![r#"{"kind":"workflow","reviewedHead":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pullRequestNumber":1597,"observedAt":"2026-09-25T12:00:00.000Z"}"#, immediate_id],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'stopped',native_session_id = 'codex-retained',stopped_at = ?1 WHERE id = ?2",
                rusqlite::params![Utc::now().to_rfc3339(), root_session],
            ).unwrap();
        });
        let follow_up = send_note(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"note":"Fix the checks."}"#),
        )
        .await;
        assert_eq!(follow_up.status(), StatusCode::OK);
        let follow_up_raw = to_bytes(follow_up.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&follow_up_raw).unwrap()["status"],
            "active"
        );
        state.with_database(|database| {
            let (id, native): (String, String) = database.connection().query_row(
                "SELECT id,native_session_id FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1",
                [&immediate_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(id, root_session);
            assert_eq!(native, "codex-retained");
        });
        let stale_answer = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            answer_body,
        )
        .await;
        assert_eq!(stale_answer.status(), StatusCode::CONFLICT);
        let old_worker_id = state.with_database(|database| {
            let root =
                crate::coordination::root_session_store::current_root(database, &immediate_id)
                    .unwrap()
                    .unwrap();
            crate::coordination::root_session_store::launch_standard_worker(
                database,
                &root,
                "Finish the behavior",
                "Worker assignment: Finish the behavior",
                None,
                Utc::now(),
            )
            .unwrap()
            .id
        });
        let invalid_replacement = replace_worker(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"sessionId":"","reason":"  "}"#),
        )
        .await;
        assert_eq!(invalid_replacement.status(), StatusCode::BAD_REQUEST);
        let replacement_body = Bytes::from(json!({"sessionId":old_worker_id,"reason":"  Change strategy  ","handoff":"  Finish the checks  "}).to_string());
        let replacement_pause = json!({
            "kind":"task_limit", "reason":"budget",
            "limits":{"budgetUsd":15,"maxTurns":40},
            "usage":{"estimatedCostUsd":15,"admittedTurns":3},
            "proposedLimits":{"budgetUsd":25,"maxTurns":40}
        })
        .to_string();
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Raise limit?', human_question_id = 'replacement-limit', limit_pause_json = ?1 WHERE task_id = ?2",
                rusqlite::params![replacement_pause, immediate_id],
            )
        }).unwrap();
        let mut anonymous_headers = HeaderMap::new();
        anonymous_headers.insert("content-type", "application/json".parse().unwrap());
        let anonymous_replacement = replace_worker(
            State(state.clone()),
            Path(immediate_id.clone()),
            anonymous_headers,
            replacement_body.clone(),
        )
        .await;
        assert_eq!(anonymous_replacement.status(), StatusCode::UNAUTHORIZED);
        let replaced = replace_worker(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            replacement_body.clone(),
        )
        .await;
        assert_eq!(replaced.status(), StatusCode::OK);
        let replaced_raw = to_bytes(replaced.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&replaced_raw).unwrap()["status"],
            "waiting_human"
        );
        let replacement_id = state.with_database(|database| {
            let control: (String, String, String) = database.connection().query_row(
                "SELECT status,human_question_id,limit_pause_json FROM suplex_task_controls WHERE task_id = ?1",
                [&immediate_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(control.0, "waiting_human");
            assert_eq!(control.1, "replacement-limit");
            assert_eq!(control.2, replacement_pause);
            let worker =
                crate::coordination::root_session_store::current_worker(database, &immediate_id)
                    .unwrap()
                    .unwrap();
            assert_ne!(worker.id, old_worker_id);
            assert!(
                !crate::coordination::root_session_store::worker_replacement_ready(
                    database, &worker.id
                )
                .unwrap()
            );
            worker.id
        });
        let replayed = replace_worker(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            replacement_body,
        )
        .await;
        assert_eq!(replayed.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(replayed.into_body(), 128 * 1024).await.unwrap(),
            replaced_raw
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'active', human_question = NULL, human_question_id = NULL, limit_pause_json = NULL WHERE task_id = ?1",
                [&immediate_id],
            )
        }).unwrap();
        state
            .with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_task_sessions SET stopped_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), old_worker_id],
                )
            })
            .unwrap();
        assert!(
            state
                .with_database(|database| {
                    crate::coordination::root_session_store::worker_replacement_ready(
                        database,
                        &replacement_id,
                    )
                })
                .unwrap()
        );
        state.with_database(|database| {
            database.connection().execute(
                "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('replacement-root','Replacement Root','root','replacement-root','codex','gpt-6-sol','medium','default',?1,?1)",
                [Utc::now().to_rfc3339()],
            )
        }).unwrap();
        let invalid_coordinator = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"sessionId":"","rootProfileId":"","resume":true}"#),
        )
        .await;
        assert_eq!(invalid_coordinator.status(), StatusCode::BAD_REQUEST);
        let long_handoff = format!("Earlier work: {}", "x".repeat(20_000));
        let coordinator_body = Bytes::from(json!({"sessionId":root_session,"rootProfileId":"replacement-root","resume":false,"handoff":long_handoff}).to_string());
        let mut anonymous_coordinator_headers = HeaderMap::new();
        anonymous_coordinator_headers.insert("content-type", "application/json".parse().unwrap());
        let unauthorized_coordinator = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            anonymous_coordinator_headers,
            coordinator_body.clone(),
        )
        .await;
        assert_eq!(unauthorized_coordinator.status(), StatusCode::UNAUTHORIZED);
        let stale_coordinator = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from(
                json!({"sessionId":"unrelated","rootProfileId":"replacement-root","resume":false})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(stale_coordinator.status(), StatusCode::CONFLICT);
        let coordinator = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            coordinator_body.clone(),
        )
        .await;
        assert_eq!(coordinator.status(), StatusCode::OK);
        let coordinator_raw = to_bytes(coordinator.into_body(), 128 * 1024).await.unwrap();
        let new_root_id = state.with_database(|database| {
            let root =
                crate::coordination::root_session_store::current_root(database, &immediate_id)
                    .unwrap()
                    .unwrap();
            assert_ne!(root.id, root_session);
            assert!(
                !crate::coordination::root_session_store::worker_replacement_ready(
                    database, &root.id
                )
                .unwrap()
            );
            assert!(
                crate::coordination::root_session_store::pending_turns(database, &root.id)
                    .unwrap()
                    .iter()
                    .any(|turn| turn.prompt_text.contains(&long_handoff))
            );
            assert_eq!(
                crate::coordination::root_session_store::current_worker(database, &immediate_id)
                    .unwrap()
                    .unwrap()
                    .id,
                replacement_id
            );
            root.id
        });
        let coordinator_replay = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            coordinator_body,
        )
        .await;
        assert_eq!(coordinator_replay.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(coordinator_replay.into_body(), 128 * 1024)
                .await
                .unwrap(),
            coordinator_raw
        );
        let changed_coordinator = replace_coordinator(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from(json!({"sessionId":root_session,"rootProfileId":"replacement-root","resume":false,"handoff":"Different direction"}).to_string()),
        )
        .await;
        assert_eq!(changed_coordinator.status(), StatusCode::CONFLICT);
        state
            .with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_task_sessions SET stopped_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), root_session],
                )
            })
            .unwrap();
        assert!(
            state
                .with_database(|database| {
                    crate::coordination::root_session_store::worker_replacement_ready(
                        database,
                        &new_root_id,
                    )
                })
                .unwrap()
        );
        state.with_database(|database| database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human',human_question = 'Resolve provider failure?',human_question_id = 'coordinator-question',human_question_options_json = '[]' WHERE task_id = ?1",
            [&immediate_id],
        )).unwrap();
        let resumed = replace_coordinator(
            State(state.clone()),Path(immediate_id.clone()),headers.clone(),
            Bytes::from(json!({"sessionId":new_root_id,"rootProfileId":"replacement-root","resume":true,"questionId":"coordinator-question"}).to_string()),
        ).await;
        assert_eq!(resumed.status(), StatusCode::OK);
        let resumed_raw = to_bytes(resumed.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&resumed_raw).unwrap()["status"],
            "active"
        );
        state.with_database(|database| {
            let next =
                crate::coordination::root_session_store::current_root(database, &immediate_id)
                    .unwrap()
                    .unwrap();
            let prompt = crate::coordination::root_session_store::pending_turns(database, &next.id)
                .unwrap()
                .remove(0)
                .prompt_text;
            assert!(prompt.contains("Question coordinator-question:\nResolve provider failure?"));
        });
        let pause = json!({
            "kind":"task_limit", "reason":"budget",
            "limits":{"budgetUsd":15,"maxTurns":40},
            "usage":{"estimatedCostUsd":15,"admittedTurns":3},
            "proposedLimits":{"budgetUsd":25,"maxTurns":40}
        });
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Raise limit?', human_question_id = 'limit-http', limit_pause_json = ?1 WHERE task_id = ?2",
                rusqlite::params![pause.to_string(), immediate_id],
            )
        }).unwrap();
        let raised = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from(
                json!({"questionId":"limit-http","limitDecision":{"kind":"add_allowance"}})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(raised.status(), StatusCode::OK);
        let raised_raw = to_bytes(raised.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&raised_raw).unwrap()["limits"]["budgetUsd"],
            25
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Stop for limit?', human_question_id = 'limit-cancel-http', limit_pause_json = ?1 WHERE task_id = ?2",
                rusqlite::params![pause.to_string(), immediate_id],
            )
        }).unwrap();
        let stopped = answer_pending(
            State(state.clone()),
            Path(immediate_id.clone()),
            headers.clone(),
            Bytes::from(
                json!({"questionId":"limit-cancel-http","limitDecision":{"kind":"cancel_task"}})
                    .to_string(),
            ),
        )
        .await;
        assert_eq!(stopped.status(), StatusCode::OK);
        let stopped_raw = to_bytes(stopped.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&stopped_raw).unwrap()["status"],
            "cancelled"
        );
        let disconnected_body = json!({
            "projectId":"task_http_project",
            "title":"Continue after disconnect",
            "idempotencyKey":"task-disconnected-key",
            "deliveryTarget":"local_worktree",
        })
        .to_string();
        let mut dropped_waiter = Box::pin(create(
            State(state.clone()),
            Path("task_http_company".into()),
            headers.clone(),
            Bytes::from(disconnected_body),
        ));
        assert!(matches!(
            std::future::Future::poll(
                dropped_waiter.as_mut(),
                &mut Context::from_waker(Waker::noop()),
            ),
            Poll::Pending
        ));
        drop(dropped_waiter);
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let persisted: bool = state.with_database(|database| -> Result<bool, rusqlite::Error> {
                    database.connection().query_row(
                        "SELECT EXISTS(SELECT 1 FROM suplex_tasks WHERE idempotency_key = 'task-disconnected-key')",
                        [],
                        |row| row.get(0),
                    )
                }).unwrap();
                if persisted {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }).await.unwrap();
        let host = crate::tasks::host::spawn_task_host(db_path.clone(), root.clone(), Default::default());
        let host_state = state.clone().with_task_host(host.clone());
        let cancelled = cancel_pending(
            State(host_state.clone()),
            Path(task_id.clone()),
            headers.clone(),
        )
        .await;
        assert_eq!(cancelled.status(), StatusCode::OK);
        let cancelled_body = to_bytes(cancelled.into_body(), 128 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&cancelled_body).unwrap()["status"],
            "cancelled"
        );
        let cancelled_again =
            cancel_pending(State(host_state), Path(task_id.clone()), headers.clone()).await;
        assert_eq!(cancelled_again.status(), StatusCode::OK);
        host.stop().await;
        let disconnected_id: String = state
            .with_database(|database| {
                database.connection().query_row(
                    "SELECT id FROM suplex_tasks WHERE idempotency_key = 'task-disconnected-key'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        let started = start_pending(
            State(state.clone()),
            Path(disconnected_id.clone()),
            headers.clone(),
        )
        .await;
        assert_eq!(started.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(started.into_body(), 128 * 1024).await.unwrap()
            )
            .unwrap()["status"],
            "active"
        );
        let cancelled_without_host = cancel_pending(
            State(state.clone()),
            Path(disconnected_id.clone()),
            headers.clone(),
        )
        .await;
        assert_eq!(cancelled_without_host.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(cancelled_without_host.into_body(), 128 * 1024)
                    .await
                    .unwrap()
            )
            .unwrap()["status"],
            "cancelled"
        );
        let intent = crate::tasks::worktree::TaskWorktreeIntent {
            task_id: task_id.clone(),
            repository_path: PathBuf::from(
                value["configuration"]["repositoryPath"].as_str().unwrap(),
            ),
            worktree_root: PathBuf::from(value["configuration"]["worktreeRoot"].as_str().unwrap()),
            branch: value["configuration"]["branch"]
                .as_str()
                .unwrap()
                .to_owned(),
            starting_sha: value["configuration"]["startingSha"]
                .as_str()
                .unwrap()
                .to_owned(),
        };
        let worktree = crate::tasks::worktree::prepare_local_task_worktree(&intent, None).unwrap();
        fs::write(
            worktree.path.join("archive-dirty.txt"),
            "keep until confirmed\n",
        )
        .unwrap();
        let invalid_archive = archive_pending(
            State(state.clone()),
            Path(task_id.clone()),
            content_headers,
            Bytes::from(r#"{"confirmDiscardDirty":"yes"}"#),
        )
        .await;
        assert_eq!(invalid_archive.status(), StatusCode::BAD_REQUEST);
        let confirmation = archive_pending(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::new(),
        )
        .await;
        assert_eq!(confirmation.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(confirmation.into_body(), 128 * 1024).await.unwrap().as_ref(),
            br#"{"status":"confirmation_required","dirtyFileCount":1,"dirtyFilePaths":["archive-dirty.txt"]}"#,
        );
        assert!(worktree.path.exists());
        let archived = archive_pending(
            State(state.clone()),
            Path(task_id.clone()),
            headers.clone(),
            Bytes::from(r#"{"confirmDiscardDirty":true}"#),
        )
        .await;
        assert_eq!(archived.status(), StatusCode::OK);
        let archived_raw = to_bytes(archived.into_body(), 128 * 1024).await.unwrap();
        assert!(serde_json::from_slice::<Value>(&archived_raw).unwrap()["archivedAt"].is_string());
        assert!(!worktree.path.exists());
        let unarchived =
            unarchive_pending(State(state.clone()), Path(task_id.clone()), headers.clone()).await;
        assert_eq!(unarchived.status(), StatusCode::OK);
        let unarchived_raw = to_bytes(unarchived.into_body(), 128 * 1024).await.unwrap();
        assert!(serde_json::from_slice::<Value>(&unarchived_raw).unwrap()["archivedAt"].is_null());
        let disconnected_configuration: Value = state.with_database(|database| {
            let configuration: String = database
                .connection()
                .query_row(
                    "SELECT configuration_json FROM suplex_tasks WHERE id = ?1",
                    [&disconnected_id],
                    |row| row.get(0),
                )
                .unwrap();
            serde_json::from_str(&configuration).unwrap()
        });
        let disconnected_intent = crate::tasks::worktree::TaskWorktreeIntent {
            task_id: disconnected_id.clone(),
            repository_path: PathBuf::from(
                disconnected_configuration["repositoryPath"]
                    .as_str()
                    .unwrap(),
            ),
            worktree_root: PathBuf::from(
                disconnected_configuration["worktreeRoot"].as_str().unwrap(),
            ),
            branch: disconnected_configuration["branch"]
                .as_str()
                .unwrap()
                .to_owned(),
            starting_sha: disconnected_configuration["startingSha"]
                .as_str()
                .unwrap()
                .to_owned(),
        };
        let disconnected_worktree =
            crate::tasks::worktree::prepare_local_task_worktree(&disconnected_intent, None)
                .unwrap();
        let mut dropped_archive = Box::pin(archive_pending(
            State(state.clone()),
            Path(disconnected_id.clone()),
            headers.clone(),
            Bytes::new(),
        ));
        assert!(matches!(
            std::future::Future::poll(
                dropped_archive.as_mut(),
                &mut Context::from_waker(Waker::noop())
            ),
            Poll::Pending
        ));
        drop(dropped_archive);
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let archived: bool = state
                    .with_database(|database| {
                        database.connection().query_row(
                            "SELECT archived_at IS NOT NULL FROM suplex_tasks WHERE id = ?1",
                            [&disconnected_id],
                            |row| row.get(0),
                        )
                    })
                    .unwrap();
                if archived {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(!disconnected_worktree.path.exists());
        state.with_database(|database| -> Result<(), rusqlite::Error> {
            database.connection().execute(
                "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('task_other_company', 'Other', 'active', ?1)",
                [now.to_rfc3339()],
            )?;
            database.connection().execute(
                "INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES (?1, 'task_http_company', ?2)",
                rusqlite::params![admin.user.id, now.to_rfc3339()],
            )?;
            database.connection().execute(
                "UPDATE suplex_users SET role = 'member' WHERE id = ?1",
                [&admin.user.id],
            )?;
            database.connection().execute(
                "UPDATE suplex_projects SET company_id = 'task_other_company' WHERE id = 'task_http_project'",
                [],
            )?;
            Ok(())
        }).unwrap();
        let replay_without_project_scope = create(
            State(state.clone()),
            Path("task_http_company".into()),
            {
                let mut replay_headers = HeaderMap::new();
                replay_headers.insert(
                    "host",
                    HeaderValue::from_str(&format!("127.0.0.1:{}", address.port())).unwrap(),
                );
                replay_headers.insert(
                    "origin",
                    HeaderValue::from_str(&format!("http://127.0.0.1:{}", address.port())).unwrap(),
                );
                replay_headers.insert("content-type", HeaderValue::from_static("application/json"));
                replay_headers.insert(
                    "cookie",
                    HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
                );
                replay_headers
            },
            Bytes::from(
                json!({
                    "projectId":"task_http_project", "title":"Build the task route",
                    "idempotencyKey":"task-http-key", "deliveryTarget":"local_worktree",
                })
                .to_string(),
            ),
        )
        .await;
        assert_eq!(replay_without_project_scope.status(), StatusCode::NOT_FOUND);
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_tasks SET company_id = 'task_other_company' WHERE id = ?1",
                    [&task_id],
                )
                .unwrap()
        });
        let revoked = client
            .get(format!(
                "http://127.0.0.1:{}/api/tasks/{}/artifacts/{}",
                address.port(),
                task_id,
                artifact_id
            ))
            .header("cookie", format!("sid_v1={}", admin.session_token))
            .send()
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::NOT_FOUND);
        server.abort();
        let _ = server.await;
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn frozen_full_task_response_matches_typescript_source_revision() {
        let root =
            std::env::temp_dir().join(format!("suplex-task-response-parity-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database_path = root.join("suplex.sqlite");
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/parity/task-response-native/database.sqlite"
            ),
            &database_path,
        )
        .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let user_id: String = database
            .connection()
            .query_row("SELECT id FROM suplex_users LIMIT 1", [], |row| row.get(0))
            .unwrap();
        let token = identity_auth::create_session(&database, &user_id, Utc::now()).unwrap();
        let state = AppState::new(
            database,
            crate::http::session::SessionConfig {
                port: 4111,
                reachable_address: "http://127.0.0.1:4111".into(),
                tailscale_exposure: "none".into(),
            },
        );
        let expected: Value = serde_json::from_str(include_str!(
            "../../../tests/parity/task-response-native/expected.json"
        ))
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("127.0.0.1:4111"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={token}")).unwrap(),
        );
        let response = get_one(
            State(state.clone()),
            Path(expected["taskId"].as_str().unwrap().to_owned()),
            headers,
        )
        .await;
        assert_eq!(response.status().as_u16(), expected["status"]);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), expected["body"].as_str().unwrap().as_bytes());
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
