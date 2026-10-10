#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[tokio::test]
    async fn moves_validate_inputs_record_runs_and_replay_a_start() {
        let (state, _filename) = super::super::auth::tests::state();
        let now = Utc::now();
        let (admin, company_id) = state.with_database(|database| {
            let admin = crate::http::routes::auth::tests::verified_sign_in(database, now).unwrap();
            let company =
                crate::identity::companies::create_company(database, &admin.user.id, "Moves", now)
                    .unwrap();
            database.connection().execute(
                "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, created_at, updated_at) VALUES ('project_moves', ?1, 'Moves', '/tmp/suplex-moves-missing', '/tmp/suplex-moves-missing-worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', ?2, ?2)",
                rusqlite::params![company.id, now.to_rfc3339()],
            ).unwrap();
            (admin, company.id)
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                crate::http::router(state.clone())
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .into_future(),
        );
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
        let moves_url = format!("/api/companies/{company_id}/moves");
        let release = json!({"projectId":"project_moves","name":"Release","prompt":"Run `mise run release:{{bump: patch | minor | major}}`. Notes: {{notes}}","runner":"prompt","confirm":true});

        let created = send(reqwest::Method::POST, &moves_url, Some(release.clone()))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let created: Value = created.json().await.unwrap();
        assert_eq!(
            created["inputs"],
            json!([{"name":"bump","options":["patch","minor","major"]},{"name":"notes","options":[]}])
        );
        assert_eq!(created["lastRun"], Value::Null);
        let duplicate = send(reqwest::Method::POST, &moves_url, Some(release.clone()))
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        let empty = send(
            reqwest::Method::POST,
            &moves_url,
            Some(json!({"projectId":"project_moves","name":"Empty","prompt":" ","runner":"prompt","confirm":false})),
        )
        .await
        .unwrap();
        assert_eq!(empty.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let pull_requests = send(
            reqwest::Method::POST,
            &moves_url,
            Some(json!({"projectId":"project_moves","name":"Repair pull requests","prompt":"","runner":"pull_request_tasks","confirm":false})),
        )
        .await
        .unwrap();
        assert_eq!(pull_requests.status(), StatusCode::CREATED);
        let unknown_agent = send(
            reqwest::Method::POST,
            &moves_url,
            Some(json!({"projectId":"project_moves","name":"Ask","prompt":"Say hi","runner":"prompt","profileId":"profile_missing","confirm":false})),
        )
        .await
        .unwrap();
        assert_eq!(unknown_agent.status(), StatusCode::UNPROCESSABLE_ENTITY);
        // A script runs as written, so it keeps no agent profile.
        let script: Value = send(
            reqwest::Method::POST,
            &moves_url,
            Some(json!({"projectId":"project_moves","name":"Build","prompt":"mise run build","runner":"script","profileId":"profile_missing","confirm":false})),
        )
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!((&script["runner"], &script["profileId"]), (&json!("script"), &Value::Null));
        let script_id = script["id"].as_str().unwrap();
        send(reqwest::Method::DELETE, &format!("/api/moves/{script_id}"), None)
            .await
            .unwrap();

        let id = created["id"].as_str().unwrap();
        let runs_url = format!("/api/moves/{id}/runs");
        let outside = send(
            reqwest::Method::POST,
            &runs_url,
            Some(json!({"inputs":{"bump":"huge"},"excludedPullRequests":[],"idempotencyKey":"k0"})),
        )
        .await
        .unwrap();
        assert_eq!(outside.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let start = json!({"inputs":{"bump":"minor","notes":"say \"hi\""},"excludedPullRequests":[],"idempotencyKey":"k1"});
        let missing = send(reqwest::Method::POST, &runs_url, Some(start.clone()))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let rendered = "Run `mise run release:minor`. Notes: \"say \\\"hi\\\"\"";
        state.with_database(|database| {
            database.connection().execute(
                "INSERT INTO suplex_move_runs (id, move_id, company_id, project_id, move_name, runner, prompt, inputs_json, started_by_user_id, started_at, idempotency_key) VALUES ('moverun_a', ?1, ?2, 'project_moves', 'Release', 'prompt', ?3, '{\"bump\":\"minor\"}', ?4, ?5, 'k1')",
                rusqlite::params![id, company_id, rendered, admin.user.id, now.to_rfc3339()],
            ).unwrap();
        });
        let replay = send(reqwest::Method::POST, &runs_url, Some(start))
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::OK);
        let run: Value = replay.json().await.unwrap();
        assert_eq!(run["id"], "moverun_a");
        assert_eq!(run["live"], false);
        let read: Value = send(reqwest::Method::GET, "/api/move-runs/moverun_a", None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(read["prompt"], rendered);
        let ended = send(reqwest::Method::DELETE, "/api/move-runs/moverun_a/terminal", None)
            .await
            .unwrap();
        assert_eq!(ended.status(), StatusCode::NO_CONTENT);

        let history: Value = send(reqwest::Method::GET, &runs_url, None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(history["runs"].as_array().unwrap().len(), 1);
        let listed: Value = send(reqwest::Method::GET, &moves_url, None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let names = listed["moves"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, ["Release", "Repair pull requests"]);
        assert_eq!(listed["moves"][0]["lastRun"]["id"], run["id"]);

        let unsaved = send(reqwest::Method::GET, "/api/move-runs/moverun_a/transcript", None)
            .await
            .unwrap();
        assert_eq!(unsaved.status(), StatusCode::NOT_FOUND);
        state.with_database(|database| {
            save_transcript_for_test(database, "moverun_a");
        });
        let saved: Value = send(reqwest::Method::GET, "/api/move-runs/moverun_a/transcript", None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(saved, json!({"cols":80,"rows":24,"output":"done\r\n"}));

        for _ in 0..2 {
            let archived = send(reqwest::Method::POST, "/api/move-runs/moverun_a/archive", None)
                .await
                .unwrap();
            assert_eq!(archived.status(), StatusCode::NO_CONTENT);
        }
        let history: Value = send(reqwest::Method::GET, &runs_url, None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(history["runs"], json!([]));
        let listed: Value = send(reqwest::Method::GET, &moves_url, None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed["moves"][0]["lastRun"], Value::Null);
        let still_readable = send(reqwest::Method::GET, "/api/move-runs/moverun_a", None)
            .await
            .unwrap();
        assert_eq!(still_readable.status(), StatusCode::OK);

        // A prompt or script runner opens a host terminal, so a member can
        // read its runs but cannot set one up or start one.
        let set_role = |role: &str| {
            state.with_database(|database| {
                database.connection().execute("INSERT OR IGNORE INTO suplex_memberships (user_id, company_id, created_at) VALUES (?1, ?2, ?3)", rusqlite::params![admin.user.id, company_id, now.to_rfc3339()]).unwrap();
                database.connection().execute("UPDATE suplex_users SET role = ?1 WHERE id = ?2", rusqlite::params![role, admin.user.id]).unwrap();
            });
        };
        set_role("member");
        let script = json!({"projectId":"project_moves","name":"Member script","prompt":"cat ~/.ssh/id_rsa","runner":"script","confirm":false});
        let denied = [
            send(reqwest::Method::POST, &moves_url, Some(script)).await.unwrap(),
            send(reqwest::Method::PATCH, &format!("/api/moves/{id}"), Some(release.clone())).await.unwrap(),
            send(reqwest::Method::POST, &runs_url, Some(json!({"inputs":{"bump":"minor","notes":"x"},"excludedPullRequests":[],"idempotencyKey":"member"}))).await.unwrap(),
        ];
        for response in denied {
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        let member_read = send(reqwest::Method::GET, "/api/move-runs/moverun_a", None)
            .await
            .unwrap();
        assert_eq!(member_read.status(), StatusCode::OK);
        set_role("admin");

        let deleted = send(reqwest::Method::DELETE, &format!("/api/moves/{id}"), None)
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        let gone = send(reqwest::Method::GET, &runs_url, None).await.unwrap();
        assert_eq!(gone.status(), StatusCode::NOT_FOUND);
        server.abort();
    }

    #[tokio::test]
    async fn task_moves_keep_their_settings_and_start_one_task() {
        let _transport = crate::projects::git::fixtures::Libgit2Transport::on();
        let root = crate::projects::git::fixtures::temporary("suplex-task-move");
        let local = root.join("repository");
        crate::projects::git::fixtures::github_checkout(&local, &root.join("origin.git"), "acme/demo");
        let (state, _filename) = super::super::auth::tests::state();
        let state = state
            .with_artifact_root(root.join("artifacts"))
            .with_project_github(crate::projects::git::Github {
                api: Some(("https://api.github.com".into(), "fixture-token".into())),
                git: None,
            });
        let now = Utc::now();
        let (admin, company_id) = state.with_database(|database| {
            let admin = crate::http::routes::auth::tests::verified_sign_in(database, now).unwrap();
            let company =
                crate::identity::companies::create_company(database, &admin.user.id, "Task moves", now)
                    .unwrap();
            database.connection().execute(
                "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, created_at, updated_at) VALUES ('project_task_moves', ?1, 'Task moves', ?2, ?3, 'acme/demo', 'main', '', 'make test', 'profile_native_root', 'profile_native_worker', ?4, ?4)",
                rusqlite::params![
                    company.id,
                    local.to_str().unwrap(),
                    root.join("worktrees").to_str().unwrap(),
                    now.to_rfc3339(),
                ],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_profiles SET archived_at = NULL WHERE id IN ('profile_native_root','profile_native_worker')",
                [],
            ).unwrap();
            (admin, company.id)
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                crate::http::router(state.clone())
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .into_future(),
        );
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
        let moves_url = format!("/api/companies/{company_id}/moves");
        let repair = json!({"projectId":"project_task_moves","name":"Repair test suite","prompt":"Run `make test`, fix any failures","runner":"task","workflow":"direct_build","deliveryTarget":"merged","runProjectTests":false,"visualEvidence":"capture","profileId":"profile_native_worker","confirm":true});

        for (change, status) in [
            (json!({"workflow": null}), StatusCode::UNPROCESSABLE_ENTITY),
            (json!({"workflow": "refine_pull_request"}), StatusCode::UNPROCESSABLE_ENTITY),
            (json!({"deliveryTarget": null}), StatusCode::UNPROCESSABLE_ENTITY),
            (json!({"workflow": "wrong"}), StatusCode::BAD_REQUEST),
        ] {
            let mut body = repair.clone();
            body.as_object_mut().unwrap().extend(change.as_object().unwrap().clone());
            let rejected = send(reqwest::Method::POST, &moves_url, Some(body)).await.unwrap();
            assert_eq!(rejected.status(), status, "{change}");
        }

        let created = send(reqwest::Method::POST, &moves_url, Some(repair.clone()))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let created: Value = created.json().await.unwrap();
        // A task move uses the project's agents and starts without a confirmation.
        assert_eq!(
            [&created["runner"], &created["workflow"], &created["deliveryTarget"], &created["runProjectTests"], &created["visualEvidence"], &created["profileId"], &created["confirm"]],
            [&json!("task"), &json!("direct_build"), &json!("merged"), &json!(false), &json!("capture"), &Value::Null, &json!(false)]
        );
        let id = created["id"].as_str().unwrap();
        let mut edited = repair.clone();
        edited["deliveryTarget"] = json!("remote_branch");
        edited["runProjectTests"] = json!(true);
        let updated: Value = send(reqwest::Method::PATCH, &format!("/api/moves/{id}"), Some(edited))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            [&updated["workflow"], &updated["deliveryTarget"], &updated["runProjectTests"], &updated["visualEvidence"]],
            [&json!("direct_build"), &json!("remote_branch"), &json!(true), &json!("capture")]
        );
        let mut merged = repair.clone();
        merged["runProjectTests"] = json!(true);
        send(reqwest::Method::PATCH, &format!("/api/moves/{id}"), Some(merged))
            .await
            .unwrap();

        let runs_url = format!("/api/moves/{id}/runs");
        let start = json!({"inputs":{},"excludedPullRequests":[],"idempotencyKey":"repair-1"});
        let started = send(reqwest::Method::POST, &runs_url, Some(start.clone()))
            .await
            .unwrap();
        assert_eq!(started.status(), StatusCode::CREATED);
        let run: Value = started.json().await.unwrap();
        assert_eq!(run["outcomes"].as_array().unwrap().len(), 1, "{run}");
        assert_eq!(run["outcomes"][0]["kind"], "created", "{run}");
        let attribution = state.with_database(|database| database.connection().query_row(
            "SELECT started_by_user_id, started_by_external_agent_id FROM suplex_move_runs WHERE id = ?1",
            [run["id"].as_str().unwrap()], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?))
        ).unwrap());
        assert_eq!(attribution, (Some(admin.user.id.clone()), None));
        assert_eq!(run["startedBy"], admin.user.display_name);
        let task_id = run["outcomes"][0]["taskId"].as_str().unwrap();
        let task: Value = send(reqwest::Method::GET, &format!("/api/tasks/{task_id}"), None)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            [&task["title"], &task["description"], &task["workflow"], &task["deliveryTarget"], &task["status"]],
            [&json!("Repair test suite"), &json!("Run `make test`, fix any failures"), &json!("direct_build"), &json!("merged"), &json!("active")],
            "{task}"
        );
        assert_eq!(
            [&task["configuration"]["runProjectTests"], &task["configuration"]["visualEvidence"]],
            [&json!(true), &json!("capture")],
            "{task}"
        );

        let replay = send(reqwest::Method::POST, &runs_url, Some(start)).await.unwrap();
        assert_eq!(replay.status(), StatusCode::OK);
        assert_eq!(replay.json::<Value>().await.unwrap()["id"], run["id"]);
        let tasks: i64 = state.with_database(|database| {
            database
                .connection()
                .query_row("SELECT COUNT(*) FROM suplex_tasks", [], |row| row.get(0))
                .unwrap()
        });
        assert_eq!(tasks, 1);
        server.abort();
    }

    fn save_transcript_for_test(database: &crate::platform::database::SuplexDatabase, run_id: &str) {
        let transcript = crate::terminals::host::Transcript {
            cols: 80,
            rows: 24,
            output: b"done\r\n".to_vec(),
        };
        crate::moves::save_transcript(database, run_id, transcript).unwrap();
    }

    #[test]
    fn pull_request_plans_exclude_and_skip_owned_pull_requests() {
        let open = [
            (12, false),
            (13, false),
            (14, true),
        ]
        .map(|(number, has_task)| crate::moves::OpenPullRequest {
            number,
            title: format!("PR {number}"),
            has_task,
        });
        let kinds = crate::moves::plan_pull_requests(&open, &[13])
            .into_iter()
            .map(|outcome| (outcome.pull_request.unwrap(), outcome.kind))
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                (12, crate::moves::MoveOutcomeKind::Created),
                (13, crate::moves::MoveOutcomeKind::Excluded),
                (14, crate::moves::MoveOutcomeKind::HasTask),
            ]
        );
    }
}
