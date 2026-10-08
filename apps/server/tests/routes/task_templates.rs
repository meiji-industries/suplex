#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::validation::test_path;

    async fn list(state: State<AppState>, Path(id): Path<String>, headers: HeaderMap) -> Response {
        match test_path(json!({"projectId": id})) {
            Ok(path) => super::list(state, path, headers).await,
            Err(response) => *response,
        }
    }
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::{body::to_bytes, http::HeaderValue};
    use serde_json::Value;
    use std::fs;

    #[tokio::test]
    async fn templates_use_profile_defaults_support_reset_and_delete() {
        let (state, filename) = super::super::auth::tests::state();
        let now = Utc::now();
        let (admin, project) = state.with_database(|database| {
            let admin = crate::http::routes::auth::tests::verified_sign_in(database, now).unwrap();
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
            tokio::spawn(axum::serve(listener, crate::http::router(state.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>()).into_future());
        let client = reqwest::Client::new();
        let cookie = format!("sid_v1={}", admin.session_token);
        let send = |method: reqwest::Method, path: &str, body: Option<Value>| {
            let request = client
                .request(method, format!("http://{address}{path}"))
                .header("host", "suplex.example.test:4111")
                .header("x-forwarded-host", "suplex.example.test:4111")
                .header("x-forwarded-proto", "https")
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
            json!({"error":"The Simple task workflow has no Reviewer Advisor"})
        );
        let skipped = send(
            reqwest::Method::PATCH,
            &format!("/api/task-templates/{id}"),
            Some(json!({"runProjectTests":false})),
        )
        .await
        .unwrap();
        assert_eq!(skipped.status(), StatusCode::OK);
        // Switching to repair replaces the inherited delivery target and keeps the project tests choice.
        let repair = send(
            reqwest::Method::PATCH,
            &format!("/api/task-templates/{id}"),
            Some(json!({"workflow":"refine_pull_request"})),
        )
        .await
        .unwrap();
        let repair: Value = repair.json().await.unwrap();
        assert_eq!(repair["deliveryTarget"], "merged");
        assert_eq!(repair["runProjectTests"], false);
        for tests in [true, false] {
            let changed = send(
                reqwest::Method::PATCH,
                &format!("/api/task-templates/{id}"),
                Some(json!({"runProjectTests":tests})),
            )
            .await
            .unwrap();
            assert_eq!(changed.status(), StatusCode::OK);
            assert_eq!(changed.json::<Value>().await.unwrap()["runProjectTests"], tests);
        }
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
                configuration: json!({"repositoryPath":project.repository_path,"worktreeRoot":project.worktree_root,"startingSha":"head","capturedAt":now.to_rfc3339(),"repository":"owner/repo","branch":"task-saved","baseBranch":"main","baselineSha":"head","runProjectTests":false,"visualEvidence":"capture"}),
                idempotency_key: "saved-task-key".into(),
                request_hash: "saved-task-hash".into(),
                creator: crate::tasks::repository::TaskCreator::User(admin.user.id.clone()),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-saved","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(json!({"profileId":"profile_native_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                worker_profile: serde_json::from_value(json!({"profileId":"profile_native_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                advisor_profiles: serde_json::from_value(json!({})).unwrap(),
                issue: None,
                start_queued: false,
                copied_from_task_id: None,
                depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
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
    async fn frozen_template_list_response_matches_typescript_source_revision() {
        let root =
            std::env::temp_dir().join(format!("suplex-template-parity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database_path = root.join("suplex.sqlite");
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/parity/task-template-native/database.sqlite"
            ),
            &database_path,
        )
        .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let user_id: String = database
            .connection()
            .query_row("SELECT id FROM suplex_users LIMIT 1", [], |row| row.get(0))
            .unwrap();
        let token = crate::http::routes::auth::tests::verified_session(&database, &user_id, Utc::now()).unwrap();
        let state = AppState::new(
            database,
            crate::http::session::SessionConfig {
                port: 4111,
                reachable_address: "http://127.0.0.1:4111".into(),
                tailscale_exposure: "none".into(),
            },
        );
        let expected: Value = serde_json::from_str(include_str!(
            "../../../../tests/parity/task-template-native/expected.json"
        ))
        .unwrap();
        let case = &expected[0];
        let mut headers = HeaderMap::new();
        headers.insert(crate::http::session::VERIFIED_HTTPS_HEADER, "1".parse().unwrap());
        headers.insert("host", HeaderValue::from_static("127.0.0.1:4111"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={token}")).unwrap(),
        );
        let response = list(
            State(state.clone()),
            Path(case["projectId"].as_str().unwrap().to_owned()),
            headers,
        )
        .await;
        assert_eq!(response.status().as_u16(), case["status"]);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            case["body"]
        );
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
