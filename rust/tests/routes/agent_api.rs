#[cfg(test)]
pub(crate) mod tests {
    use std::process::Command;

    use chrono::Utc;
    use rusqlite::params;
    use serde_json::{Value, json};

    use crate::{
        http::routes::{
            auth as route_auth,
            external_agent_administration::tests::{Server, server},
        },
        identity::external_agents,
    };

    fn git(args: &[&str], cwd: &std::path::Path) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// A local repository whose `origin` fetch resolves to a bare repository.
    pub(crate) fn repository(root: &std::path::Path) -> std::path::PathBuf {
        let bare = root.join("origin.git");
        let local = root.join("repository");
        std::fs::create_dir_all(root).unwrap();
        git(
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                local.to_str().unwrap(),
            ],
            root,
        );
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
        // Clone and fetch rather than push, so the fixture needs no push permission.
        git(
            &[
                "clone",
                "--quiet",
                "--bare",
                local.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
            root,
        );
        git(&["remote", "add", "origin", bare.to_str().unwrap()], &local);
        git(&["fetch", "--quiet", "origin"], &local);
        git(
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/acme/demo.git",
            ],
            &local,
        );
        git(
            &[
                "config",
                "--local",
                &format!("url.file://{}.insteadOf", bare.display()),
                "https://github.com/acme/demo.git",
            ],
            &local,
        );
        local
    }

    pub(crate) struct Agent {
        pub server: Server,
        pub credential: String,
        pub agent_id: String,
        pub root: std::path::PathBuf,
    }

    impl Drop for Agent {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    pub(crate) fn pair(server: &Server, name: &str, projects: &[&str]) -> (String, String) {
        let admin = server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT id FROM suplex_users WHERE role = 'admin'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        });
        let projects = projects
            .iter()
            .map(|id| (*id).to_owned())
            .collect::<Vec<_>>();
        server.state.with_database(|database| {
            let issued = external_agents::create(
                database,
                &admin,
                external_agents::CreateInput {
                    name,
                    company_id: "company_api",
                    project_ids: &projects,
                    avatar_seed: None,
                },
                Utc::now(),
            )
            .unwrap();
            let paired = external_agents::exchange(
                database,
                &issued.pairing_code,
                Some("profile-bot"),
                Utc::now(),
            )
            .unwrap();
            (paired.credential, issued.agent.id)
        })
    }

    /// The agent API fixture: a project on a real repository with a local-worktree agent policy.
    pub(crate) async fn agent() -> Agent {
        agent_with(None).await
    }

    pub(crate) async fn agent_with(host: Option<crate::tasks::host::TaskHostHandle>) -> Agent {
        let root = std::env::temp_dir().join(format!("suplex-agent-api-{}", uuid::Uuid::new_v4()));
        let local = repository(&root);
        let (state, path) = route_auth::tests::state();
        let mut state = state.with_artifact_root(root.join("artifacts"));
        if let Some(host) = host {
            state = state.with_task_host(host);
        }
        let server = server(Some((state, path))).await;
        let policy = json!({"workflowIds": ["workflow_native_standard"], "defaultWorkflowId": "workflow_native_standard", "rootProfileIds": ["profile_native_root"], "workerProfileIds": ["profile_native_worker"], "deliveryTarget": "local_worktree"});
        server.state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_projects SET root_profile_id = 'profile_native_root', worker_profile_id = 'profile_native_worker', agent_task_policy_json = ?1 WHERE id IN ('project_api', 'project_api_2')",
                params![policy.to_string()],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_projects SET repository_path = ?1, worktree_root = ?2, repository_identity = 'acme/demo' WHERE id = 'project_api'",
                params![local.to_str().unwrap(), root.join("worktrees").to_str().unwrap()],
            ).unwrap();
        });
        let (credential, agent_id) = pair(&server, "AgentApi Bot", &["project_api"]);
        Agent {
            server,
            credential,
            agent_id,
            root,
        }
    }

    impl Agent {
        pub(crate) async fn call(
            &self,
            method: reqwest::Method,
            path: &str,
            body: Option<Value>,
        ) -> (u16, Value) {
            self.call_as(&self.credential, method, path, body).await
        }

        pub(crate) async fn call_as(
            &self,
            credential: &str,
            method: reqwest::Method,
            path: &str,
            body: Option<Value>,
        ) -> (u16, Value) {
            let bearer = format!("Bearer {credential}");
            let response = self
                .server
                .request(method, path, &[("authorization", bearer.as_str())], body)
                .await;
            let status = response.status().as_u16();
            let text = response.text().await.unwrap();
            (status, serde_json::from_str(&text).unwrap_or(Value::Null))
        }

        pub(crate) async fn create(&self, title: &str, key: &str) -> Value {
            let (status, task) = self
                .call(
                    reqwest::Method::POST,
                    "/api/agent/tasks",
                    Some(
                        json!({"projectId": "project_api", "title": title, "idempotencyKey": key}),
                    ),
                )
                .await;
            assert_eq!(status, 201, "{task}");
            task
        }
    }

    /// Make a created task Review and repair of pull request 7, the workflow
    /// with a Rater. Creating one directly would observe GitHub.
    pub(crate) fn review_and_repair(server: &Server, task_id: &str) {
        server.state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET workflow = 'refine_pull_request', delivery_target = 'merged' WHERE task_id = ?1",
                [task_id],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.source', json('{\"kind\":\"pull_request\",\"number\":7}'), '$.runProjectTests', json('true')) WHERE id = ?1",
                [task_id],
            ).unwrap();
        });
    }

    /// The profile a task stores for an Advisor role.
    pub(crate) fn stored_advisor(server: &Server, task_id: &str, role: &str) -> Option<String> {
        server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT json_extract(advisor_profiles_json, '$.' || ?2 || '.profileId') FROM suplex_task_controls WHERE task_id = ?1",
                    params![task_id, role],
                    |row| row.get(0),
                )
                .unwrap()
        })
    }

    /// Ports `tests/agent-machine-discovery.integration.test.ts`: the public map, pairing, and the contract agree.
    #[tokio::test]
    async fn a_paired_agent_follows_the_public_map_without_the_web_application() {
        let agent = agent().await;
        let (_, catalog) = agent
            .server
            .send(
                reqwest::Method::GET,
                "/.well-known/suplex/api-catalog.json",
                None,
                None,
            )
            .await;
        let admin = agent.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT id FROM suplex_users WHERE role = 'admin'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        });
        let projects = vec!["project_api".to_owned()];
        let issued = agent
            .server
            .state
            .with_database(|database| {
                external_agents::create(
                    database,
                    &admin,
                    external_agents::CreateInput {
                        name: "Journey agent",
                        company_id: "company_api",
                        project_ids: &projects,
                        avatar_seed: None,
                    },
                    Utc::now(),
                )
            })
            .unwrap();
        let (status, paired) = agent
            .server
            .send(
                reqwest::Method::POST,
                catalog["pairing"][0]["path"].as_str().unwrap(),
                None,
                Some(json!({"pairingCode": issued.pairing_code, "profileId": "journey"})),
            )
            .await;
        assert_eq!(status, 200);
        let credential = paired["credential"].as_str().unwrap();
        let (status, document) = agent
            .call_as(
                credential,
                reqwest::Method::GET,
                "/api/agent/openapi.json",
                None,
            )
            .await;
        assert_eq!(status, 200);
        for entry in catalog["runtime"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["path"].as_str().unwrap().contains('{'))
        {
            assert!(
                document["paths"][entry["path"].as_str().unwrap()].is_object(),
                "{entry}"
            );
        }
        assert!(document["paths"]["/api/agent/tasks"].is_object());
        let body = json!({"projectId": "project_api", "title": "Acknowledge the pairing", "idempotencyKey": "journey-ack-001"});
        let (first, created) = agent
            .call_as(
                credential,
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body.clone()),
            )
            .await;
        let (second, replay) = agent
            .call_as(
                credential,
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body),
            )
            .await;
        assert_eq!(
            (
                first,
                second,
                replay["id"].clone(),
                replay["status"].as_str()
            ),
            (201, 200, created["id"].clone(), Some("backlog"))
        );
        assert_eq!(
            agent
                .server
                .request(reqwest::Method::GET, "/api/agent/me", &[], None)
                .await
                .status(),
            401
        );
    }

    #[tokio::test]
    async fn rejected_credentials_and_board_sessions_cannot_reach_runtime_routes() {
        let agent = agent().await;
        let anonymous = agent
            .server
            .request(reqwest::Method::GET, "/api/agent/me", &[], None)
            .await;
        assert_eq!(anonymous.status(), 401);
        assert_eq!(
            anonymous.json::<Value>().await.unwrap(),
            json!({"error": "Authentication failed", "code": "credential_invalid"})
        );
        let board = agent
            .server
            .send(
                reqwest::Method::GET,
                "/api/agent/capabilities",
                Some(&agent.server.admin_cookie.clone()),
                None,
            )
            .await;
        assert_eq!(
            board,
            (
                401,
                json!({"error": "Authentication failed", "code": "credential_invalid"})
            )
        );
        for credential in ["wrong", "fha_invalid0000000000000000000000000000000000", ""] {
            assert_eq!(
                agent
                    .call_as(
                        credential,
                        reqwest::Method::GET,
                        "/api/hermes/openapi.json",
                        None
                    )
                    .await
                    .0,
                401
            );
            assert_eq!(
                agent
                    .call_as(
                        credential,
                        reqwest::Method::POST,
                        "/api/agent/tasks",
                        Some(json!({}))
                    )
                    .await
                    .0,
                401
            );
        }
        let admin = agent.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT id FROM suplex_users WHERE role = 'admin'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        });
        agent
            .server
            .state
            .with_database(|database| {
                external_agents::revoke(database, &admin, &agent.agent_id, Utc::now())
            })
            .unwrap();
        assert_eq!(
            agent
                .call(reqwest::Method::GET, "/api/agent/me", None)
                .await
                .0,
            401
        );
    }

    #[tokio::test]
    async fn identity_capabilities_contract_and_discovery_follow_live_grants() {
        let agent = agent().await;
        let (status, identity) = agent
            .call(reqwest::Method::GET, "/api/agent/me", None)
            .await;
        assert_eq!(status, 200);
        assert_eq!(
            identity["agent"],
            json!({"id": agent.agent_id, "name": "AgentApi Bot", "profileId": "profile-bot"})
        );
        assert_eq!(
            identity["projects"],
            json!([{"id": "project_api", "name": "API Project", "agentTaskPolicy": {"deliveryTargets": ["local_worktree"], "runProjectTests": true, "visualEvidence": "off"}}])
        );
        assert_eq!(
            identity["capabilities"]["taskCommands"]
                .as_array()
                .unwrap()
                .len(),
            8,
            "answer_human_question needs the answer grant"
        );
        let (_, capabilities) = agent
            .call(reqwest::Method::GET, "/api/agent/capabilities", None)
            .await;
        assert_eq!(capabilities, super::capabilities(true, false));
        assert_eq!(
            super::capabilities(false, false)["unavailableCommands"],
            json!([
                "answer_human_question",
                "deliver_task",
                "merge_pull_request"
            ])
        );
        let response = agent
            .server
            .request(
                reqwest::Method::GET,
                "/api/agent/openapi.json",
                &[("authorization", &format!("Bearer {}", agent.credential))],
                None,
            )
            .await;
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        let document = response.json::<Value>().await.unwrap();
        assert_eq!(document["openapi"], "3.0.3");
        assert!(document["paths"]["/api/agent/tasks/{taskId}/commands"]["post"].is_object());
        let (status, workflows) = agent
            .call(
                reqwest::Method::GET,
                "/api/agent/workflows?projectId=project_api",
                None,
            )
            .await;
        assert_eq!(status, 200);
        let standard = workflows["workflows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|workflow| workflow["id"] == "workflow_native_standard")
            .unwrap();
        assert_eq!(standard["permittedForAgentTaskCreation"], true);
        assert!(
            workflows["workflows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|workflow| workflow["permittedForAgentTaskCreation"] == true),
            "{workflows}"
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    "/api/agent/templates?projectId=project_api",
                    None
                )
                .await,
            (200, json!({"templates": []}))
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    "/api/agent/workflows?projectId=project_api_2",
                    None
                )
                .await,
            (404, json!({"error": "Not found", "code": "not_found"}))
        );
        let (status, invalid) = agent
            .call(
                reqwest::Method::GET,
                "/api/agent/workflows?projectId=project_api&extra=1",
                None,
            )
            .await;
        assert_eq!(
            (status, invalid["code"].as_str()),
            (400, Some("request_invalid"))
        );
    }

    #[tokio::test]
    async fn creation_is_idempotent_scoped_and_validated_and_dry_runs_write_nothing() {
        let agent = agent().await;
        let (status, preview) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Dry", "idempotencyKey": "dry-run-0001", "dryRun": true}))).await;
        assert_eq!(status, 200, "{preview}");
        assert_eq!(
            (
                preview["dryRun"].as_bool(),
                preview["wouldStart"].as_str(),
                preview["workflow"]["id"].as_str()
            ),
            (
                Some(true),
                Some("backlog"),
                Some("workflow_native_standard")
            )
        );
        let count = || {
            agent.server.state.with_database(|database| {
                database
                    .connection()
                    .query_row("SELECT COUNT(*) FROM suplex_tasks", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap()
            })
        };
        assert_eq!(count(), 0);
        let task = agent.create("Build the thing", "create-001").await;
        assert_eq!(
            (
                task["status"].as_str(),
                task["permittedCommands"][0].as_str(),
                task["workflowStage"].as_str()
            ),
            (Some("backlog"), Some("start_task"), Some("backlog"))
        );
        assert_eq!(task["integration"]["observation"], "observed");
        assert!(task["actionRequired"].is_null());
        let creator: Option<String> = agent.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT creator_agent_id FROM suplex_tasks WHERE id = ?1",
                    [task["id"].as_str().unwrap()],
                    |row| row.get(0),
                )
                .unwrap()
        });
        assert_eq!(creator.as_deref(), Some(agent.agent_id.as_str()));
        let (status, replay) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Build the thing", "idempotencyKey": "create-001"}))).await;
        assert_eq!((status, replay["id"].clone()), (200, task["id"].clone()));
        let (status, dry_replay) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Build the thing", "idempotencyKey": "create-001", "dryRun": true}))).await;
        assert_eq!(
            (status, dry_replay),
            (
                200,
                json!({"dryRun": true, "status": 200, "existingTaskId": task["id"]})
            )
        );
        let (status, conflict) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Different", "idempotencyKey": "create-001"}))).await;
        assert_eq!(
            (status, conflict["code"].as_str()),
            (409, Some("idempotency_conflict"))
        );
        let (status, unknown) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "T", "idempotencyKey": "key-00002", "surprise": true}))).await;
        assert_eq!(
            (status, unknown),
            (
                400,
                json!({"error": "Invalid request", "code": "request_invalid"})
            )
        );
        let (status, ignored) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Authority", "idempotencyKey": "key-00003", "companyId": "company_other", "agentId": "agent_other"}))).await;
        assert_eq!(status, 201, "{ignored}");
        let (status, missing) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api_2", "title": "T", "idempotencyKey": "key-00004"}))).await;
        assert_eq!(
            (status, missing),
            (
                422,
                json!({"error": "The project is not available.", "code": "project_not_found", "field": "projectId", "value": "project_api_2", "reason": "The project is not available."})
            )
        );
        let (status, delivery) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "T", "idempotencyKey": "key-00005", "deliveryTarget": "merged"}))).await;
        assert_eq!(
            (status, delivery["deliveryTarget"].as_str()),
            (201, Some("merged")),
            "{delivery}"
        );
        let (status, workflow) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "T", "idempotencyKey": "key-00006", "workflowId": "missing"}))).await;
        assert_eq!(
            (status, workflow["code"].as_str()),
            (422, Some("workflow_not_found"))
        );
        let (status, profile) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "T", "idempotencyKey": "key-00007", "rootProfileId": "profile_missing"}))).await;
        assert_eq!(
            (status, profile["code"].as_str(), profile["field"].as_str()),
            (422, Some("root_profile_not_found"), Some("rootProfileId"))
        );
        let (status, invalid) = agent
            .call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(json!({"projectId": "", "title": "T", "idempotencyKey": "k"})),
            )
            .await;
        assert_eq!(
            (
                status,
                invalid["code"].as_str(),
                invalid["findings"][0]["field"].as_str()
            ),
            (400, Some("request_invalid"), Some(".projectId"))
        );
    }

    #[tokio::test]
    async fn reads_poll_conditionally_page_by_cursor_and_share_commands_within_a_project() {
        let agent = agent().await;
        let first = agent.create("First", "read-001").await;
        agent.create("Second", "read-002").await;
        agent.create("Third", "read-003").await;
        let (other_credential, _) = pair(&agent.server, "Other agent", &["project_api"]);
        let (status, _) = agent
            .call_as(
                &other_credential,
                reqwest::Method::GET,
                &format!("/api/agent/tasks/{}", first["id"].as_str().unwrap()),
                None,
            )
            .await;
        assert_eq!(status, 200);
        let (_, foreign) = agent
            .call_as(
                &other_credential,
                reqwest::Method::GET,
                &format!("/api/agent/tasks/{}", first["id"].as_str().unwrap()),
                None,
            )
            .await;
        assert_eq!(
            foreign["permittedCommands"],
            json!(["start_task", "cancel_task", "archive_task", "duplicate_task"])
        );
        let (outside, _) = pair(&agent.server, "Outside agent", &["project_api_2"]);
        assert_eq!(
            agent
                .call_as(
                    &outside,
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks/{}", first["id"].as_str().unwrap()),
                    None
                )
                .await,
            (
                404,
                json!({"error": "Not found", "code": "resource_not_found"})
            )
        );
        assert_eq!(
            agent
                .call(reqwest::Method::GET, "/api/agent/tasks/task_missing", None)
                .await,
            (
                404,
                json!({"error": "Not found", "code": "resource_not_found"})
            )
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks/{}", "x".repeat(101)),
                    None
                )
                .await,
            (404, json!({"error": "Not found"}))
        );

        let path = format!("/api/agent/tasks/{}", first["id"].as_str().unwrap());
        let bearer = format!("Bearer {}", agent.credential);
        let etag = format!("\"{}\"", first["revision"].as_str().unwrap());
        let unchanged = agent
            .server
            .request(
                reqwest::Method::GET,
                &path,
                &[
                    ("authorization", bearer.as_str()),
                    ("if-none-match", etag.as_str()),
                ],
                None,
            )
            .await;
        assert_eq!(unchanged.status(), 304);
        assert_eq!(unchanged.headers()["etag"], etag.as_str());
        let stale = agent
            .server
            .request(
                reqwest::Method::GET,
                &path,
                &[("authorization", bearer.as_str()), ("if-match", "\"old\"")],
                None,
            )
            .await;
        assert_eq!(stale.status(), 412);

        let (status, page) = agent
            .call(reqwest::Method::GET, "/api/agent/tasks?limit=2", None)
            .await;
        assert_eq!(status, 200);
        assert_eq!(page["tasks"].as_array().unwrap().len(), 2);
        assert!(page["tasks"][0]["integration"].is_object());
        let cursor = page["nextCursor"].as_str().unwrap().to_owned();
        let encoded = url::form_urlencoded::byte_serialize(cursor.as_bytes()).collect::<String>();
        let (_, next) = agent
            .call(
                reqwest::Method::GET,
                &format!("/api/agent/tasks?limit=2&cursor={encoded}"),
                None,
            )
            .await;
        assert_eq!(
            (
                next["tasks"].as_array().unwrap().len(),
                next["nextCursor"].clone()
            ),
            (1, Value::Null)
        );
        assert_eq!(
            agent
                .call_as(
                    &other_credential,
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks?limit=2&cursor={encoded}"),
                    None
                )
                .await
                .1["code"],
            "cursor_invalid"
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks?limit=2&status=active&cursor={encoded}"),
                    None
                )
                .await
                .0,
            400
        );
        let (_, summary) = agent
            .call(
                reqwest::Method::GET,
                "/api/agent/tasks?view=summary&titleContains=secon",
                None,
            )
            .await;
        assert_eq!(summary["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(
            summary["tasks"][0]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            [
                "id",
                "title",
                "status",
                "archived",
                "workflow",
                "dependsOn",
                "updatedAt"
            ]
        );
        let (status, invalid) = agent
            .call(reqwest::Method::GET, "/api/agent/tasks?limit=0", None)
            .await;
        assert_eq!((status, invalid.get("code").is_none()), (400, true));
    }

    #[tokio::test]
    async fn lifecycle_commands_use_revisions_receipts_note_attribution_and_duplicate_provenance() {
        let agent = agent().await;
        let task = agent.create("Command target", "command-001").await;
        let id = task["id"].as_str().unwrap().to_owned();
        let path = format!("/api/agent/tasks/{id}/commands");
        let command = |body: Value| agent.call(reqwest::Method::POST, &path, Some(body));
        let (status, started) = command(json!({"command": "start_task", "revision": task["revision"], "idempotencyKey": "start-001"})).await;
        assert_eq!(
            (status, started["status"].as_str()),
            (200, Some("active")),
            "{started}"
        );
        assert_eq!(command(json!({"command": "start_task", "revision": task["revision"], "idempotencyKey": "start-001"})).await, (200, started.clone()));
        let (status, stale) = command(json!({"command": "cancel_task", "revision": task["revision"], "idempotencyKey": "stale-001"})).await;
        assert_eq!(
            (status, stale["code"].as_str()),
            (412, Some("revision_stale"))
        );
        let (status, illegal) = command(json!({"command": "start_task", "revision": started["revision"], "idempotencyKey": "illegal-001"})).await;
        assert_eq!(
            (status, illegal["code"].as_str()),
            (409, Some("illegal_command"))
        );
        let (status, noted) = command(json!({"command": "send_task_note", "revision": started["revision"], "idempotencyKey": "note-001", "note": "Machine progress note"})).await;
        assert_eq!(status, 200, "{noted}");
        let prompt: String = agent.server.state.with_database(|database| database.connection().query_row("SELECT prompt_text FROM suplex_task_turns WHERE task_id = ?1 AND prompt_text LIKE '%Machine progress%'", [&id], |row| row.get(0)).unwrap());
        assert_eq!(
            prompt,
            format!("Agent note ({}):\nMachine progress note", agent.agent_id)
        );
        let (status, duplicate) = command(json!({"command": "duplicate_task", "revision": noted["revision"], "idempotencyKey": "duplicate-001"})).await;
        assert_eq!(
            (
                status,
                duplicate["status"].as_str(),
                duplicate["title"].as_str()
            ),
            (200, Some("backlog"), Some("Command target (2)")),
            "{duplicate}"
        );
        let copied: Option<String> = agent.server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT copied_from_task_id FROM suplex_tasks WHERE id = ?1",
                    [duplicate["id"].as_str().unwrap()],
                    |row| row.get(0),
                )
                .unwrap()
        });
        assert_eq!(copied.as_deref(), Some(id.as_str()));
        let (_, current) = agent
            .call(
                reqwest::Method::GET,
                &format!("/api/agent/tasks/{id}"),
                None,
            )
            .await;
        let (status, cancelled) = command(json!({"command": "cancel_task", "revision": current["revision"], "idempotencyKey": "cancel-001"})).await;
        assert_eq!(
            (status, cancelled["status"].as_str()),
            (200, Some("cancelled")),
            "{cancelled}"
        );
        let (status, archived) = command(json!({"command": "archive_task", "revision": cancelled["revision"], "idempotencyKey": "archive-001"})).await;
        assert_eq!(
            (status, archived["archived"].as_bool()),
            (200, Some(true)),
            "{archived}"
        );
        let (status, reopened) = command(json!({"command": "unarchive_task", "revision": archived["revision"], "idempotencyKey": "unarchive-001"})).await;
        assert_eq!(
            (status, reopened["archived"].as_bool()),
            (200, Some(false)),
            "{reopened}"
        );
        let audits: i64 = agent.server.state.with_database(|database| database.connection().query_row("SELECT COUNT(*) FROM suplex_audit_events WHERE actor_agent_id = ?1 AND action IN ('task_started', 'task_note_added', 'task_duplicated', 'task_cancelled', 'task_archived', 'task_unarchived')", [&agent.agent_id], |row| row.get(0)).unwrap());
        assert_eq!(audits, 6);
        let (other, _) = pair(&agent.server, "Other commander", &["project_api"]);
        let (status, shared) = agent.call_as(&other, reqwest::Method::POST, &format!("/api/agent/tasks/{id}/commands"), Some(json!({"command": "archive_task", "revision": reopened["revision"], "idempotencyKey": "other-001"}))).await;
        assert_eq!((status, shared["archived"].as_bool()), (200, Some(true)), "{shared}");
    }

    #[tokio::test]
    async fn dependencies_are_replaced_previewed_and_reject_cycles_and_foreign_tasks() {
        let agent = agent().await;
        let upstream = agent.create("Upstream", "dependency-001").await;
        let downstream = agent.create("Downstream", "dependency-002").await;
        let (up, down) = (
            upstream["id"].as_str().unwrap(),
            downstream["id"].as_str().unwrap(),
        );
        let (status, preview) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{down}/dependencies"),
                Some(json!({"dependsOn": [up], "dryRun": true})),
            )
            .await;
        assert_eq!(
            (status, preview),
            (
                200,
                json!({"dryRun": true, "dependsOn": [up], "wouldStart": "backlog", "blockingPrerequisiteIds": []})
            )
        );
        assert_eq!(
            agent
                .call(
                    reqwest::Method::GET,
                    &format!("/api/agent/tasks/{down}"),
                    None
                )
                .await
                .1["dependsOn"],
            json!([])
        );
        let (status, set) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{down}/dependencies"),
                Some(json!({"dependsOn": [up]})),
            )
            .await;
        assert_eq!(
            (
                status,
                set["dependsOn"].clone(),
                set["blockedBy"][0]["id"].as_str()
            ),
            (200, json!([up]), Some(up)),
            "{set}"
        );
        let (status, cycle) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{up}/dependencies"),
                Some(json!({"dependsOn": [down]})),
            )
            .await;
        assert_eq!(
            (status, cycle["error"].as_str()),
            (422, Some("The dependency creates a cycle"))
        );
        let (status, missing) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{down}/dependencies"),
                Some(json!({"dependsOn": ["task_missing"]})),
            )
            .await;
        assert_eq!(
            (status, missing["code"].as_str(), missing["value"].as_str()),
            (422, Some("dependency_not_found"), Some("task_missing"))
        );
        let (status, strict) = agent
            .call(
                reqwest::Method::PUT,
                &format!("/api/agent/tasks/{down}/dependencies"),
                Some(json!({"dependsOn": [], "extra": 1})),
            )
            .await;
        assert_eq!(
            (status, strict["code"].as_str()),
            (400, Some("request_invalid"))
        );
    }

    #[tokio::test]
    async fn concurrent_creation_replays_one_effect_after_project_policy_changes() {
        let agent = agent().await;
        let body = json!({"projectId":"project_api", "title":"Concurrent admission", "idempotencyKey":"agent-concurrent-create-001"});
        let (a, b, c, d) = tokio::join!(
            agent.call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body.clone())
            ),
            agent.call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body.clone())
            ),
            agent.call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body.clone())
            ),
            agent.call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body.clone())
            ),
        );
        let responses = [a, b, c, d];
        let mut statuses = responses
            .iter()
            .map(|(status, _)| *status)
            .collect::<Vec<_>>();
        statuses.sort();
        assert_eq!(statuses, [200, 200, 200, 201], "{responses:?}");
        let id = responses[0].1["id"].as_str().unwrap();
        assert!(responses.iter().all(|(_, body)| body["id"] == id));
        agent.server.state.with_database(|database| {
            database.connection().execute("UPDATE suplex_projects SET setup_command = 'changed after create' WHERE id = 'project_api'", []).unwrap();
        });
        let (status, replay) = agent
            .call(
                reqwest::Method::POST,
                "/api/agent/tasks",
                Some(body.clone()),
            )
            .await;
        assert_eq!((status, replay["id"].as_str()), (200, Some(id)));
        let (status, conflict) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId":"project_api", "title":"Different", "idempotencyKey":"agent-concurrent-create-001"}))).await;
        assert_eq!(
            (status, conflict["code"].as_str()),
            (409, Some("idempotency_conflict"))
        );
        let counts: (i64, i64, i64) = agent.server.state.with_database(|database| {
            database.connection().query_row("SELECT (SELECT COUNT(*) FROM suplex_tasks WHERE creator_agent_id = ?1), (SELECT COUNT(*) FROM suplex_task_controls WHERE task_id = ?2), (SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'task_created' AND actor_agent_id = ?1)", rusqlite::params![agent.agent_id, id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap()
        });
        assert_eq!(counts, (1, 1, 1));
    }

    /// Any available workflow or project template can be used, the caller's
    /// delivery settings stand, and an unnamed workflow is Standard.
    #[tokio::test]
    async fn workflows_templates_and_delivery_settings_are_the_callers_choice() {
        let agent = agent().await;
        let template = uuid::Uuid::new_v4().to_string();
        agent.server.state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_projects SET agent_task_policy_json = json_set(agent_task_policy_json, '$.defaultWorkflowId', 'workflow_native_direct_build') WHERE id = 'project_api'",
                [],
            ).unwrap();
            let now = chrono::Utc::now().to_rfc3339();
            database.connection().execute("INSERT INTO suplex_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?1, 'project_api', 'Build', ?2, ?3, ?3)", params![template, json!({"name":"Build", "workflow":"direct_build", "advisorProfileIds":{}}).to_string(), now]).unwrap();
        });
        let create = |key: &str, extra: Value| {
            let mut body = json!({"projectId":"project_api", "title":"Choice", "idempotencyKey": key});
            body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            body
        };
        let (status, task) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(create("choice-workflow", json!({"workflowId":"workflow_native_direct_build"})))).await;
        assert_eq!((status, task["workflow"]["id"].as_str()), (201, Some("workflow_native_direct_build")), "{task}");
        let (status, task) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(create("choice-template", json!({"templateId": template})))).await;
        assert_eq!((status, task["templateId"].as_str()), (201, Some(template.as_str())), "{task}");
        let (status, task) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(create("choice-delivery", json!({"deliveryTarget":"pull_request_draft", "runProjectTests": false, "visualEvidence": "capture"})))).await;
        assert_eq!(
            (status, task["deliveryTarget"].as_str(), task["runProjectTests"].as_bool(), task["visualEvidence"].as_str()),
            (201, Some("pull_request_draft"), Some(false), Some("capture")),
            "{task}"
        );
        let (status, task) = agent.call(reqwest::Method::POST, "/api/agent/tasks", Some(create("choice-defaults", json!({})))).await;
        assert_eq!(
            (status, task["workflow"]["id"].as_str(), task["deliveryTarget"].as_str()),
            (201, Some("workflow_native_standard"), Some("local_worktree")),
            "{task}"
        );
    }

    /// An unnamed role uses its workflow or project default; a named profile
    /// must exist with the role it fills.
    #[tokio::test]
    async fn profiles_follow_defaults_or_an_existing_named_profile() {
        let agent = agent().await;
        agent.server.state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_projects SET agent_task_policy_json = json_set(agent_task_policy_json, '$.workflowIds', json('[\"workflow_native_standard\",\"workflow_native_independent_review\"]'), '$.workerProfileIds', json('[\"profile_elsewhere\"]')) WHERE id = 'project_api'",
                [],
            ).unwrap();
        });
        let (status, task) = agent
            .call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId":"project_api", "title":"Named agents", "idempotencyKey":"named-agents-001", "rootProfileId":"profile_native_independent", "workerProfileId":"profile_native_worker"})))
            .await;
        assert_eq!(status, 201, "a named, existing Coordinator or Worker is refused: {task}");
        let (status, missing) = agent
            .call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId":"project_api", "title":"Missing agent", "idempotencyKey":"named-agents-002", "rootProfileId":"profile_missing"})))
            .await;
        assert_eq!(
            (status, missing["code"].as_str()),
            (422, Some("root_profile_not_found")),
            "{missing}"
        );
        let body = |key: &str, advisors: Value| {
            json!({"projectId":"project_api", "title":"Second opinion", "idempotencyKey": key, "workflowId":"workflow_native_independent_review", "advisorProfileIds": advisors})
        };
        let (status, task) = agent
            .call(reqwest::Method::POST, "/api/agent/tasks", Some(body("advisor-default-001", json!({}))))
            .await;
        assert_eq!(status, 201, "the workflow default Reviewer is refused: {task}");
        let (status, task) = agent
            .call(reqwest::Method::POST, "/api/agent/tasks", Some(body("advisor-named-001", json!({"reviewer":"profile_native_root"}))))
            .await;
        assert_eq!(status, 201, "a named, existing Reviewer is refused: {task}");
        let (status, missing) = agent
            .call(reqwest::Method::POST, "/api/agent/tasks", Some(body("advisor-missing-001", json!({"reviewer":"profile_missing"}))))
            .await;
        assert_eq!(
            (status, missing["code"].as_str()),
            (422, Some("advisor_profile_not_found")),
            "{missing}"
        );
    }

    /// A backlog or queued task takes a detail update under its revision and
    /// receipt. Disarm, update, and start hold a queued task while it changes.
    #[tokio::test]
    async fn updates_change_backlog_and_queued_tasks_under_revisions_and_receipts() {
        let agent = agent().await;
        let prerequisite = agent.create("Update prerequisite", "update-prerequisite").await;
        let prerequisite_id = prerequisite["id"].as_str().unwrap();
        let (status, queued) = agent
            .call(reqwest::Method::POST, "/api/agent/tasks", Some(json!({"projectId": "project_api", "title": "Update target", "idempotencyKey": "update-target", "dependsOn": [prerequisite_id], "queue": true})))
            .await;
        assert_eq!((status, queued["status"].as_str()), (201, Some("queued")), "{queued}");
        let id = queued["id"].as_str().unwrap().to_owned();
        review_and_repair(&agent.server, &id);
        let path = format!("/api/agent/tasks/{id}");
        let update = |body: Value| agent.call(reqwest::Method::PATCH, &path, Some(body));
        let commands = format!("{path}/commands");
        let command = |body: Value| agent.call(reqwest::Method::POST, &commands, Some(body));
        let audits = || -> i64 {
            agent.server.state.with_database(|database| database.connection().query_row("SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'task_details_updated' AND actor_agent_id = ?1", [&agent.agent_id], |row| row.get(0)).unwrap())
        };
        let (_, current) = agent.call(reqwest::Method::GET, &path, None).await;

        let body = json!({"revision": current["revision"], "idempotencyKey": "update-001", "advisorProfileIds": {"rater": "profile_native_root"}});
        let (status, updated) = update(body.clone()).await;
        assert_eq!((status, updated["status"].as_str()), (200, Some("queued")), "{updated}");
        assert_ne!(updated["revision"], current["revision"]);
        assert_eq!(
            (updated["dependsOn"].clone(), updated["queue"].clone()),
            (current["dependsOn"].clone(), current["queue"].clone())
        );
        assert_eq!(stored_advisor(&agent.server, &id, "rater").as_deref(), Some("profile_native_root"));
        assert_eq!(audits(), 1);
        assert_eq!(update(body).await, (200, updated.clone()), "a repeated request replays its result");
        let (status, conflict) = update(json!({"revision": updated["revision"], "idempotencyKey": "update-001", "title": "Other"})).await;
        assert_eq!((status, conflict["code"].as_str()), (409, Some("idempotency_conflict")));
        let (status, stale) = update(json!({"revision": current["revision"], "idempotencyKey": "update-002", "title": "Stale"})).await;
        assert_eq!((status, stale["code"].as_str()), (412, Some("revision_stale")));
        assert_eq!(audits(), 1);

        let (status, refused) = update(json!({"revision": updated["revision"], "idempotencyKey": "update-003", "advisorProfileIds": {"rater": "profile_native_worker"}})).await;
        assert_eq!(
            (status, refused["code"].as_str(), refused["field"].as_str(), refused["value"].as_str()),
            (422, Some("advisor_profile_not_found"), Some("advisorProfileIds.rater"), Some("profile_native_worker")),
            "{refused}"
        );
        let (status, refused) = update(json!({"revision": updated["revision"], "idempotencyKey": "update-004", "workflowId": "workflow_missing"})).await;
        assert_eq!(
            (status, refused["code"].as_str(), refused["field"].as_str()),
            (422, Some("workflow_not_found"), Some("workflowId")),
            "{refused}"
        );
        let (status, empty) = update(json!({"revision": updated["revision"], "idempotencyKey": "update-005"})).await;
        assert_eq!((status, empty["code"].as_str()), (400, Some("request_invalid")));
        assert_eq!(
            agent.call(reqwest::Method::GET, &path, None).await.1["revision"],
            updated["revision"],
            "a refused update keeps the revision"
        );

        let (status, disarmed) = command(json!({"command": "disarm_task", "revision": updated["revision"], "idempotencyKey": "update-disarm"})).await;
        assert_eq!((status, disarmed["status"].as_str()), (200, Some("backlog")), "{disarmed}");
        let (status, changed) = update(json!({"revision": disarmed["revision"], "idempotencyKey": "update-006", "title": "Update target changed", "advisorProfileIds": {"rater": "profile_native_independent"}})).await;
        assert_eq!(
            (status, changed["status"].as_str(), changed["title"].as_str()),
            (200, Some("backlog"), Some("Update target changed")),
            "{changed}"
        );
        let (status, rearmed) = command(json!({"command": "start_task", "revision": changed["revision"], "idempotencyKey": "update-rearm"})).await;
        assert_eq!((status, rearmed["status"].as_str()), (200, Some("queued")), "{rearmed}");
        assert_eq!(
            (rearmed["dependsOn"].clone(), rearmed["queue"].clone()),
            (current["dependsOn"].clone(), current["queue"].clone())
        );
        assert_eq!(stored_advisor(&agent.server, &id, "rater").as_deref(), Some("profile_native_independent"));

        let (status, reviewed) = update(json!({"revision": rearmed["revision"], "idempotencyKey": "update-007", "workflowId": "workflow_native_independent_review", "advisorProfileIds": {"reviewer": "profile_native_root"}})).await;
        assert_eq!(
            (status, reviewed["workflow"]["id"].as_str(), reviewed["workflow"]["engine"].as_str()),
            (200, Some("workflow_native_independent_review"), Some("independent_review")),
            "{reviewed}"
        );
        assert_eq!(stored_advisor(&agent.server, &id, "reviewer").as_deref(), Some("profile_native_root"));
        assert_eq!(stored_advisor(&agent.server, &id, "rater"), None);
        assert_eq!(audits(), 3);

        let prerequisite_path = format!("/api/agent/tasks/{prerequisite_id}");
        let (status, started) = agent.call(reqwest::Method::POST, &format!("{prerequisite_path}/commands"), Some(json!({"command": "start_task", "revision": prerequisite["revision"], "idempotencyKey": "update-start"}))).await;
        assert_eq!((status, started["status"].as_str()), (200, Some("active")), "{started}");
        let (status, active) = agent.call(reqwest::Method::PATCH, &prerequisite_path, Some(json!({"revision": started["revision"], "idempotencyKey": "update-active", "title": "Too late"}))).await;
        assert_eq!((status, active["code"].as_str()), (409, Some("illegal_command")), "{active}");
        assert_eq!(audits(), 3);

        let (outsider, _) = pair(&agent.server, "Outside agent", &["project_api_2"]);
        let (status, hidden) = agent.call_as(&outsider, reqwest::Method::PATCH, &path, Some(json!({"revision": reviewed["revision"], "idempotencyKey": "update-outside", "title": "Outside"}))).await;
        assert_eq!((status, hidden["code"].as_str()), (404, Some("not_found")), "{hidden}");
    }

    /// `suplex_update_task` reaches the same update over the stdio bridge and OAuth `/mcp`.
    #[tokio::test]
    async fn mcp_updates_a_task_over_the_bridge_and_http() {
        use crate::integrations::suplex::{
            self as mcp,
            bridge::{Bridge, Settings},
        };
        let agent = agent().await;
        let arguments = |value: Value| value.as_object().unwrap().clone();
        let bridge = Bridge::new(Settings {
            base_url: agent.server.base.clone(),
            credential: agent.credential.clone(),
        });
        let task = agent.create("MCP update", "mcp-update-001").await;
        let id = task["id"].as_str().unwrap().to_owned();
        let updated = bridge
            .result("suplex_update_task", &arguments(json!({"taskId": id, "revision": task["revision"], "idempotencyKey": "bridge-update-1", "title": "Updated over stdio", "workflowId": "workflow_native_independent_review", "advisorProfileIds": {"reviewer": "profile_native_root"}})))
            .await
            .structured_content
            .unwrap();
        let (_, read) = agent.call(reqwest::Method::GET, &format!("/api/agent/tasks/{id}"), None).await;
        assert_eq!(
            (updated["status"].as_u64(), &updated["body"]["revision"]),
            (Some(200), &read["revision"]),
            "{updated}"
        );
        assert_eq!(
            (read["title"].as_str(), read["workflow"]["engine"].as_str()),
            (Some("Updated over stdio"), Some("independent_review"))
        );
        assert_eq!(stored_advisor(&agent.server, &id, "reviewer").as_deref(), Some("profile_native_root"));
        let stale = bridge
            .result("suplex_update_task", &arguments(json!({"taskId": id, "revision": task["revision"], "idempotencyKey": "bridge-update-2", "title": "Stale"})))
            .await
            .structured_content
            .unwrap();
        assert_eq!(stale, json!({"status": 412, "body": {"error": "Task revision is stale", "code": "revision_stale"}}));

        let server = &agent.server;
        let client = crate::http::routes::oauth::tests::register(server, "Update client").await;
        let verifier = "u".repeat(43);
        let code = crate::http::routes::oauth::tests::authorize(server, &client, &verifier, "update-state").await;
        let token = crate::http::routes::oauth::tests::exchange(server, &client, &code, &verifier).await.1["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let bearer = format!("Bearer {token}");
        let rpc = async |id: u64, method: &str, params: Value| {
            let response = server
                .request(
                    reqwest::Method::POST,
                    "/mcp",
                    &[
                        ("authorization", bearer.as_str()),
                        ("accept", "application/json, text/event-stream"),
                        ("mcp-protocol-version", "2025-06-18"),
                    ],
                    Some(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})),
                )
                .await;
            assert_eq!(response.status(), 200);
            response.json::<Value>().await.unwrap()
        };
        rpc(1, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})).await;
        let listed = rpc(2, "tools/list", json!({})).await;
        assert!(listed["result"]["tools"].as_array().unwrap().iter().any(|tool| tool["name"] == "suplex_update_task"));
        let updated = rpc(3, "tools/call", json!({"name": "suplex_update_task", "arguments": {"taskId": id, "revision": read["revision"], "idempotencyKey": "oauth-update-1", "advisorProfileIds": {}}})).await;
        let (_, reread) = agent.call(reqwest::Method::GET, &format!("/api/agent/tasks/{id}"), None).await;
        assert_eq!(
            (
                updated["result"]["structuredContent"]["status"].as_u64(),
                &updated["result"]["structuredContent"]["body"]["revision"]
            ),
            (Some(200), &reread["revision"]),
            "{updated}"
        );
        assert_ne!(stored_advisor(&agent.server, &id, "reviewer").as_deref(), Some("profile_native_root"));
        let refused = rpc(4, "tools/call", json!({"name": "suplex_update_task", "arguments": {"taskId": id, "revision": reread["revision"], "idempotencyKey": "oauth-update-2", "workerProfileId": "profile_missing"}})).await;
        assert_eq!(
            refused["result"]["structuredContent"],
            json!({"status": 422, "body": {"error": "The selected agent profile does not exist", "code": "worker_profile_not_found"}})
        );

        let openapi: Value = serde_json::from_str(include_str!("../../src/http/routes/agent_api_openapi.json")).unwrap();
        let body = &openapi["paths"]["/api/agent/tasks/{taskId}"]["patch"]["requestBody"]["content"]["application/json"]["schema"]["properties"];
        let mut expected = body.as_object().unwrap().keys().cloned().chain(["taskId".to_owned()]).collect::<Vec<_>>();
        let schema = serde_json::to_value(&mcp::tool("suplex_update_task").unwrap().input_schema).unwrap();
        let mut actual = schema["properties"].as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected, "the MCP tool takes the HTTP body and the task ID");
    }

    #[tokio::test]
    async fn completed_command_receipt_replays_on_stale_revision_without_another_effect() {
        let agent = agent().await;
        let task = agent
            .create("Receipt replay", "agent-command-receipt-001")
            .await;
        let id = task["id"].as_str().unwrap();
        let revision = task["revision"].as_str().unwrap();
        let path = format!("/api/agent/tasks/{id}/commands");
        let body = json!({"command":"cancel_task", "revision":revision, "idempotencyKey":"agent-cancel-receipt-001"});
        let (status, first) = agent
            .call(reqwest::Method::POST, &path, Some(body.clone()))
            .await;
        assert_eq!(status, 200, "{first}");
        let before: (i64, i64, i64) = agent.server.state.with_database(|database| database.connection().query_row("SELECT command_revision, (SELECT COUNT(*) FROM suplex_hermes_task_command_receipts WHERE task_id = ?1), (SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'task_cancelled' AND actor_agent_id = ?2) FROM suplex_tasks WHERE id = ?1", rusqlite::params![id, agent.agent_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap());
        assert_eq!(
            agent
                .call(reqwest::Method::POST, &path, Some(body.clone()))
                .await,
            (200, first)
        );
        let (status, stale) = agent.call(reqwest::Method::POST, &path, Some(json!({"command":"cancel_task", "revision":revision, "idempotencyKey":"other-cancel"}))).await;
        assert_eq!(
            (status, stale["code"].as_str()),
            (412, Some("revision_stale"))
        );
        let (status, conflict) = agent.call(reqwest::Method::POST, &path, Some(json!({"command":"archive_task", "revision":revision, "idempotencyKey":"agent-cancel-receipt-001"}))).await;
        assert_eq!(
            (status, conflict["code"].as_str()),
            (409, Some("idempotency_conflict"))
        );
        let after: (i64, i64, i64) = agent.server.state.with_database(|database| database.connection().query_row("SELECT command_revision, (SELECT COUNT(*) FROM suplex_hermes_task_command_receipts WHERE task_id = ?1), (SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'task_cancelled' AND actor_agent_id = ?2) FROM suplex_tasks WHERE id = ?1", rusqlite::params![id, agent.agent_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap());
        assert_eq!(before, after);
        assert_eq!(after.1, 1);
        assert_eq!(after.2, 1);
    }

    #[tokio::test]
    async fn notes_and_cancels_survive_host_observation_but_not_real_changes() {
        let agent = agent().await;
        let task = agent.create("Observed target", "observed-001").await;
        let id = task["id"].as_str().unwrap().to_owned();
        let path = format!("/api/agent/tasks/{id}/commands");
        let command = |body: Value| agent.call(reqwest::Method::POST, &path, Some(body));
        let task_path = format!("/api/agent/tasks/{id}");
        let read = || agent.call(reqwest::Method::GET, &task_path, None);
        // The host sweep and pull request observation write only observed fields.
        let observe = |seconds: i64, state: &str| {
            let later = Utc::now() + chrono::Duration::seconds(seconds);
            agent.server.state.with_database(|database| {
                crate::tasks::repository::schedule_next_sweep(database, &id, later).unwrap();
                database.connection().execute(
                    "UPDATE suplex_task_controls SET pull_request_json = ?1, updated_at = ?2 WHERE task_id = ?3",
                    params![json!({"repository": "acme/demo", "number": 7, "url": "https://github.com/acme/demo/pull/7", "headSha": "abc", "state": state, "mergedAt": null}).to_string(), crate::shared::time::rfc3339_millis(later), id],
                ).unwrap();
            });
        };
        let (status, started) = command(json!({"command": "start_task", "revision": task["revision"], "idempotencyKey": "observed-start"})).await;
        assert_eq!(status, 200, "{started}");
        let (_, before) = read().await;
        observe(5, "open");
        let (_, after) = read().await;
        assert_ne!(before["revision"], after["revision"], "a poll still sees observed changes");
        let (status, noted) = command(json!({"command": "send_task_note", "revision": before["revision"], "idempotencyKey": "observed-note", "note": "Still going"})).await;
        assert_eq!(status, 200, "{noted}");
        observe(10, "closed");
        let (status, cancelled) = command(json!({"command": "cancel_task", "revision": noted["revision"], "idempotencyKey": "observed-cancel"})).await;
        assert_eq!((status, cancelled["status"].as_str()), (200, Some("cancelled")), "{cancelled}");
        let (status, stale) = command(json!({"command": "cancel_task", "revision": noted["revision"], "idempotencyKey": "observed-cancel-again"})).await;
        assert_eq!((status, stale["code"].as_str()), (412, Some("revision_stale")));
        let (status, illegal) = command(json!({"command": "send_task_note", "revision": cancelled["revision"], "idempotencyKey": "observed-note-late", "note": "Too late"})).await;
        assert_eq!((status, illegal["code"].as_str()), (409, Some("illegal_command")));

        let edited = agent.create("Edited target", "observed-002").await;
        agent.server.state.with_database(|database| database.connection().execute("UPDATE suplex_tasks SET title = 'Renamed target' WHERE id = ?1", [edited["id"].as_str().unwrap()]).unwrap());
        let (status, stale) = agent.call(reqwest::Method::POST, &format!("/api/agent/tasks/{}/commands", edited["id"].as_str().unwrap()), Some(json!({"command": "cancel_task", "revision": edited["revision"], "idempotencyKey": "observed-edited-cancel"}))).await;
        assert_eq!((status, stale["code"].as_str()), (412, Some("revision_stale")));
    }

    #[tokio::test]
    async fn template_description_omission_and_explicit_empty_value_remain_distinct_requests() {
        let agent = agent().await;
        let template = "agent_description_template";
        let now = Utc::now().to_rfc3339();
        let policy = json!({"workflowIds":["workflow_native_standard"], "defaultWorkflowId":"workflow_native_standard", "templateIds":[template], "rootProfileIds":["profile_native_root"], "workerProfileIds":["profile_native_worker"], "deliveryTarget":"local_worktree"});
        agent.server.state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?1, 'project_api', 'Description', ?2, ?3, ?3)", rusqlite::params![template, json!({"name":"Description", "description":"Template brief", "workflow":"standard", "advisorProfileIds":{}}).to_string(), now]).unwrap();
            database.connection().execute("UPDATE suplex_projects SET agent_task_policy_json = ?1 WHERE id = 'project_api'", [policy.to_string()]).unwrap();
        });
        let create = |title: &str, key: &str, description: Option<&str>| {
            let mut body = json!({"projectId":"project_api", "title":title, "idempotencyKey":key, "templateId":template});
            if let Some(description) = description {
                body["description"] = json!(description);
            }
            body
        };
        let mut ids = Vec::new();
        for (title, key, description) in [
            ("Omitted description", "template-omitted-001", None),
            ("Empty description", "template-empty-001", Some("")),
            (
                "Caller description",
                "template-explicit-001",
                Some("Caller brief"),
            ),
        ] {
            let (status, task) = agent
                .call(
                    reqwest::Method::POST,
                    "/api/agent/tasks",
                    Some(create(title, key, description)),
                )
                .await;
            assert_eq!(status, 201, "{task}");
            ids.push(task["id"].as_str().unwrap().to_owned());
        }
        let descriptions = agent.server.state.with_database(|database| {
            ids.iter()
                .map(|id| {
                    database
                        .connection()
                        .query_row(
                            "SELECT description FROM suplex_tasks WHERE id = ?1",
                            [id],
                            |row| row.get::<_, String>(0),
                        )
                        .unwrap()
                })
                .collect::<Vec<_>>()
        });
        assert_eq!(descriptions, ["Template brief", "", "Caller brief"]);
        let body = create("Hash omission", "template-hash-001", None);
        assert_eq!(
            agent
                .call(
                    reqwest::Method::POST,
                    "/api/agent/tasks",
                    Some(body.clone())
                )
                .await
                .0,
            201
        );
        let mut changed = body;
        changed["description"] = json!("");
        let (status, conflict) = agent
            .call(reqwest::Method::POST, "/api/agent/tasks", Some(changed))
            .await;
        assert_eq!(
            (status, conflict["code"].as_str()),
            (409, Some("idempotency_conflict"))
        );
    }

    #[tokio::test]
    async fn hundred_task_summary_stays_under_twenty_kibibytes() {
        let agent = agent().await;
        for index in 0..100 {
            let title = format!("Compact task {index}");
            let key = format!("compact-task-{index:03}");
            agent.create(&title, &key).await;
        }
        let bearer = format!("Bearer {}", agent.credential);
        let response = agent
            .server
            .request(
                reqwest::Method::GET,
                "/api/agent/tasks?view=summary&limit=100",
                &[("authorization", bearer.as_str())],
                None,
            )
            .await;
        assert_eq!(response.status(), 200);
        let bytes = response.bytes().await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["tasks"].as_array().unwrap().len(), 100);
        assert!(bytes.len() < 20 * 1024, "{} bytes", bytes.len());
    }

    pub(crate) fn admin_id(server: &Server) -> String {
        server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT id FROM suplex_users WHERE role = 'admin'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        })
    }

    /// The administrator lets the agent answer questions on their behalf, or stops it.
    pub(crate) async fn grant_answers(server: &Server, agent_id: &str, granted: bool) -> Value {
        let (status, body) = server
            .send(
                reqwest::Method::PUT,
                &format!("/api/admin/external-agents/{agent_id}/answer-grant"),
                Some(&server.admin_cookie),
                Some(json!({"granted": granted})),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }

    /// An active task whose Coordinator asks a question with two options; returns its id.
    pub(crate) fn ask(server: &Server, task_id: &str, question: &str) -> String {
        server.state.with_database(|database| {
            let root = crate::coordination::root_session_store::reserve_root(
                database,
                task_id,
                Utc::now(),
            )
            .unwrap();
            let options = json!([
                {"label": "Main", "description": "Use main", "recommended": true},
                {"label": "Branch", "description": "Use a branch", "recommended": false}
            ]);
            assert!(
                crate::coordination::root_session_store::ask_human_for_root(
                    database,
                    task_id,
                    &root.id,
                    root.generation,
                    question,
                    &options,
                    Utc::now(),
                )
                .unwrap()
            );
            database
                .connection()
                .query_row(
                    "SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?1",
                    [task_id],
                    |row| row.get(0),
                )
                .unwrap()
        })
    }

    /// Create and start a task, then let its Coordinator ask; returns the task id and question id.
    pub(crate) async fn waiting_task(agent: &Agent, key: &str) -> (String, String) {
        let task = agent.create("Question target", key).await;
        let id = task["id"].as_str().unwrap().to_owned();
        let (status, started) = agent
            .call(
                reqwest::Method::POST,
                &format!("/api/agent/tasks/{id}/commands"),
                Some(json!({"command": "start_task", "revision": task["revision"], "idempotencyKey": format!("{key}-start")})),
            )
            .await;
        assert_eq!(status, 200, "{started}");
        let question = ask(&agent.server, &id, "Use main?");
        (id, question)
    }

    /// Status, question id, command revision, and Coordinator turns: all that an answer changes.
    fn answer_state(server: &Server, task_id: &str) -> (String, Option<String>, i64, i64) {
        server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT c.status, c.human_question_id, t.command_revision, (SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = t.id) FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
                    [task_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap()
        })
    }

    fn latest_prompt(server: &Server, task_id: &str) -> Value {
        server.state.with_database(|database| {
            let prompt: String = database
                .connection()
                .query_row(
                    "SELECT prompt_text FROM suplex_task_turns WHERE task_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
                    [task_id],
                    |row| row.get(0),
                )
                .unwrap();
            serde_json::from_str(&prompt).unwrap()
        })
    }

    #[tokio::test]
    async fn an_agent_answers_a_question_only_while_an_administrator_grants_it() {
        let (host, mut wakes) = crate::tasks::host::TaskHostHandle::recording();
        let agent = agent_with(Some(host)).await;
        let admin = admin_id(&agent.server);
        let (id, question) = waiting_task(&agent, "answer-001").await;
        let path = format!("/api/agent/tasks/{id}/commands");
        let read = async || {
            agent
                .call(reqwest::Method::GET, &format!("/api/agent/tasks/{id}"), None)
                .await
                .1
        };
        let task = read().await;
        assert_eq!(
            task["question"],
            json!({"id": question, "kind": "question", "requiresCommandCleanup": false, "options": [
                {"id": "option-1", "label": "Main", "description": "Use main", "recommended": true},
                {"id": "option-2", "label": "Branch", "description": "Use a branch", "recommended": false}
            ]})
        );
        assert_eq!(task["permittedCommands"], json!(["cancel_task", "duplicate_task"]));

        // Off by default: identity, capabilities, and the command all agree.
        let (_, identity) = agent.call(reqwest::Method::GET, "/api/agent/me", None).await;
        assert_eq!(
            (identity["capabilities"]["humanAnswers"].clone(), identity["answerGrant"].clone()),
            (json!(false), Value::Null)
        );
        let (_, capabilities) = agent
            .call(reqwest::Method::GET, "/api/agent/capabilities", None)
            .await;
        assert_eq!(capabilities, super::capabilities(true, false));
        assert!(capabilities["unavailableCommands"]
            .as_array()
            .unwrap()
            .contains(&json!("answer_human_question")));
        let before = answer_state(&agent.server, &id);
        let (status, refused) = agent.call(reqwest::Method::POST, &path, Some(json!({"command": "answer_human_question", "revision": task["revision"], "idempotencyKey": "answer-ungranted", "questionId": question, "optionId": "option-1"}))).await;
        assert_eq!(
            (status, refused["code"].as_str()),
            (403, Some("answer_grant_required"))
        );
        assert_eq!(answer_state(&agent.server, &id), before);
        assert_eq!(before.0, "waiting_human");
        assert_eq!(before.1.as_deref(), Some(question.as_str()));

        // Only an administrator changes the grant.
        route_auth::tests::require_passkeys(&agent.server.state);
        let grant_path = format!("/api/admin/external-agents/{}/answer-grant", agent.agent_id);
        let body = Some(json!({"granted": true}));
        assert_eq!(
            agent.server.send(reqwest::Method::PUT, &grant_path, Some(&agent.server.member_cookie), body.clone()).await.0,
            404
        );
        assert_eq!(
            agent.server.send(reqwest::Method::PUT, &grant_path, None, body.clone()).await.0,
            401
        );
        let (status, _) = agent.call(reqwest::Method::PUT, &grant_path, body).await;
        assert_eq!(status, 401);
        let granted = grant_answers(&agent.server, &agent.agent_id, true).await;
        assert_eq!(granted["agent"]["answerGrantedByUserId"], json!(admin));
        assert!(granted["agent"]["answerGrantedAt"].is_string());
        let audit: (Option<String>, Option<String>, String) = agent.server.state.with_database(|database| database.connection().query_row(
            "SELECT actor_user_id, actor_agent_id, metadata_json FROM suplex_audit_events WHERE action = 'external_agent_answer_grant_updated'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap());
        assert_eq!((audit.0.as_deref(), audit.1), (Some(admin.as_str()), None));
        assert_eq!(
            serde_json::from_str::<Value>(&audit.2).unwrap(),
            json!({"agentId": agent.agent_id, "answerGranted": true})
        );

        let (_, identity) = agent.call(reqwest::Method::GET, "/api/agent/me", None).await;
        assert_eq!(identity["capabilities"]["humanAnswers"], true);
        assert_eq!(identity["answerGrant"]["userId"], json!(admin));
        assert!(identity["capabilities"]["taskCommands"]
            .as_array()
            .unwrap()
            .contains(&json!("answer_human_question")));
        let (_, capabilities) = agent
            .call(reqwest::Method::GET, "/api/agent/capabilities", None)
            .await;
        assert_eq!(capabilities, super::capabilities(true, true));
        assert!(capabilities["autonomousCommands"]
            .as_array()
            .unwrap()
            .contains(&json!("answer_human_question")));
        assert_eq!(capabilities["capabilities"]["humanDecisions"], true);
        assert!(!capabilities["unavailableCommands"]
            .as_array()
            .unwrap()
            .contains(&json!("answer_human_question")));

        let task = read().await;
        assert_eq!(
            task["permittedCommands"],
            json!(["cancel_task", "duplicate_task", "answer_human_question"])
        );
        let revision = task["revision"].clone();
        let command = |body: Value| agent.call(reqwest::Method::POST, &path, Some(body));
        let before = answer_state(&agent.server, &id);
        let (status, stale) = command(json!({"command": "answer_human_question", "revision": revision, "idempotencyKey": "answer-stale", "questionId": "not-the-question", "optionId": "option-1"})).await;
        assert_eq!((status, stale["code"].as_str()), (409, Some("question_stale")));
        let (status, unknown) = command(json!({"command": "answer_human_question", "revision": revision, "idempotencyKey": "answer-unknown", "questionId": question, "optionId": "option-3"})).await;
        assert_eq!((status, unknown["code"].as_str()), (422, Some("option_not_offered")));
        for invalid in [
            json!({"command": "answer_human_question", "revision": revision, "idempotencyKey": "answer-both", "questionId": question, "optionId": "option-1", "answer": "Main"}),
            json!({"command": "answer_human_question", "revision": revision, "idempotencyKey": "answer-none", "questionId": question}),
            json!({"command": "answer_human_question", "revision": revision, "idempotencyKey": "answer-no-question", "answer": "Main"}),
            json!({"command": "cancel_task", "revision": revision, "idempotencyKey": "answer-foreign", "questionId": question, "answer": "Main"}),
        ] {
            let (status, body) = command(invalid).await;
            assert_eq!((status, body["code"].as_str()), (400, Some("request_invalid")), "{body}");
        }
        assert_eq!(answer_state(&agent.server, &id), before);

        let answer = json!({"command": "answer_human_question", "revision": revision, "idempotencyKey": "answer-option", "questionId": question, "optionId": "option-2"});
        let (status, answered) = command(answer.clone()).await;
        assert_eq!(
            (status, answered["status"].as_str(), answered["question"].clone()),
            (200, Some("active"), Value::Null),
            "{answered}"
        );
        assert_eq!(wakes.try_recv().ok().as_deref(), Some(id.as_str()));
        let admin_name: String = agent.server.state.with_database(|database| database.connection().query_row("SELECT display_name FROM suplex_users WHERE id = ?1", [&admin], |row| row.get(0)).unwrap());
        assert_eq!(
            latest_prompt(&agent.server, &id),
            json!({"question": "Use main?", "answer": "Branch: Use a branch", "answeredBy": {"agentId": agent.agent_id, "agentName": "AgentApi Bot", "userId": admin, "userName": admin_name}})
        );
        let audit: (Option<String>, String) = agent.server.state.with_database(|database| database.connection().query_row(
            "SELECT actor_user_id, metadata_json FROM suplex_audit_events WHERE action = 'task_answered' AND actor_agent_id = ?1",
            [&agent.agent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap());
        assert_eq!(audit.0, None);
        assert_eq!(serde_json::from_str::<Value>(&audit.1).unwrap()["answeredForUserId"], json!(admin));

        // The receipt replays without a second answer; the key cannot carry another request.
        let after = answer_state(&agent.server, &id);
        assert_eq!(command(answer.clone()).await, (200, answered.clone()));
        assert_eq!(answer_state(&agent.server, &id), after);
        let (status, conflict) = command(json!({"command": "answer_human_question", "revision": revision, "idempotencyKey": "answer-option", "questionId": question, "answer": "Other"})).await;
        assert_eq!((status, conflict["code"].as_str()), (409, Some("idempotency_conflict")));
        let (status, stale) = command(json!({"command": "answer_human_question", "revision": revision, "idempotencyKey": "answer-stale-revision", "questionId": question, "answer": "Other"})).await;
        assert_eq!((status, stale["code"].as_str()), (412, Some("revision_stale")));
        let (status, idle) = command(json!({"command": "answer_human_question", "revision": answered["revision"], "idempotencyKey": "answer-idle", "questionId": question, "answer": "Other"})).await;
        assert_eq!((status, idle["code"].as_str()), (409, Some("task_not_waiting")));
        assert_eq!(answer_state(&agent.server, &id), after);

        // Clearing the grant applies to the next request.
        let question = ask(&agent.server, &id, "Use main again?");
        grant_answers(&agent.server, &agent.agent_id, false).await;
        let task = read().await;
        let (status, revoked) = command(json!({"command": "answer_human_question", "revision": task["revision"], "idempotencyKey": "answer-revoked", "questionId": question, "answer": "Main"})).await;
        assert_eq!((status, revoked["code"].as_str()), (403, Some("answer_grant_required")));
        let (_, identity) = agent.call(reqwest::Method::GET, "/api/agent/me", None).await;
        assert_eq!(identity["capabilities"]["humanAnswers"], false);
    }

    #[tokio::test]
    async fn agent_answers_take_free_text_and_leave_human_only_decisions_and_other_projects_alone() {
        let agent = agent().await;
        grant_answers(&agent.server, &agent.agent_id, true).await;
        let (id, question) = waiting_task(&agent, "free-001").await;
        let path = format!("/api/agent/tasks/{id}/commands");
        let read = async |id: &str| {
            agent
                .call(reqwest::Method::GET, &format!("/api/agent/tasks/{id}"), None)
                .await
                .1
        };
        let task = read(&id).await;
        let (status, answered) = agent.call(reqwest::Method::POST, &path, Some(json!({"command": "answer_human_question", "revision": task["revision"], "idempotencyKey": "free-answer", "questionId": question, "answer": "  Use the release branch  "}))).await;
        assert_eq!((status, answered["status"].as_str()), (200, Some("active")), "{answered}");
        assert_eq!(latest_prompt(&agent.server, &id)["answer"], "Use the release branch");

        // A question whose interrupted commands need confirmation stays human-only.
        let question = ask(&agent.server, &id, "Did the commands stop?");
        agent.server.state.with_database(|database| database.connection().execute(
            "UPDATE suplex_task_controls SET recovery_turn_id = (SELECT id FROM suplex_task_turns WHERE task_id = ?1 LIMIT 1) WHERE task_id = ?1",
            [&id],
        )).unwrap();
        let task = read(&id).await;
        assert_eq!(task["question"]["requiresCommandCleanup"], true);
        assert!(!task["permittedCommands"].as_array().unwrap().contains(&json!("answer_human_question")));
        let before = answer_state(&agent.server, &id);
        let (status, cleanup) = agent.call(reqwest::Method::POST, &path, Some(json!({"command": "answer_human_question", "revision": task["revision"], "idempotencyKey": "cleanup-answer", "questionId": question, "answer": "Stopped"}))).await;
        assert_eq!((status, cleanup["code"].as_str()), (409, Some("human_decision_required")));
        assert_eq!(answer_state(&agent.server, &id), before);

        // A task limit decision stays human-only.
        let pause = json!({"kind":"task_limit", "reason":"budget", "limits":{"budgetUsd":15,"maxTurns":40}, "usage":{"estimatedCostUsd":15,"admittedTurns":3}, "proposedLimits":{"budgetUsd":25,"maxTurns":40}}).to_string();
        agent.server.state.with_database(|database| database.connection().execute(
            "UPDATE suplex_task_controls SET recovery_turn_id = NULL, human_question = 'Raise limit?', human_question_id = 'limit-question', limit_pause_json = ?1 WHERE task_id = ?2",
            params![pause, id],
        )).unwrap();
        let task = read(&id).await;
        assert_eq!(task["question"]["kind"], "task_limit");
        let before = answer_state(&agent.server, &id);
        let (status, limit) = agent.call(reqwest::Method::POST, &path, Some(json!({"command": "answer_human_question", "revision": task["revision"], "idempotencyKey": "limit-answer", "questionId": "limit-question", "answer": "Raise it"}))).await;
        assert_eq!((status, limit["code"].as_str()), (409, Some("human_decision_required")));
        assert_eq!(answer_state(&agent.server, &id), before);

        // A task outside the agent's granted projects is not found.
        let (foreign_id, foreign_question) = waiting_task(&agent, "foreign-001").await;
        let (status, _) = agent
            .server
            .send(
                reqwest::Method::PUT,
                &format!("/api/admin/external-agents/{}/projects", agent.agent_id),
                Some(&agent.server.admin_cookie),
                Some(json!({"projectIds": ["project_api_2"]})),
            )
            .await;
        assert_eq!(status, 200);
        let before = answer_state(&agent.server, &foreign_id);
        let (status, outside) = agent.call(reqwest::Method::POST, &format!("/api/agent/tasks/{foreign_id}/commands"), Some(json!({"command": "answer_human_question", "revision": "any", "idempotencyKey": "foreign-answer", "questionId": foreign_question, "answer": "Main"}))).await;
        assert_eq!((status, outside["code"].as_str()), (404, Some("not_found")));
        assert_eq!(answer_state(&agent.server, &foreign_id), before);
    }

    #[tokio::test]
    async fn the_stdio_bridge_answers_a_question_for_the_granting_administrator() {
        use crate::integrations::suplex::bridge::{Bridge, Settings};
        let agent = agent().await;
        grant_answers(&agent.server, &agent.agent_id, true).await;
        let (task_id, question) = waiting_task(&agent, "bridge-answer").await;
        let bridge = Bridge::new(Settings {
            base_url: agent.server.base.clone(),
            credential: agent.credential.clone(),
        });
        let call = async |name: &str, args: Value| {
            let result = bridge.result(name, args.as_object().unwrap()).await;
            (result.is_error, result.structured_content.unwrap())
        };
        let (_, read) = call("suplex_get_task", json!({"taskId": task_id})).await;
        assert_eq!(read["body"]["question"]["id"], json!(question));
        let (error, answered) = call("suplex_command_task", json!({"taskId": task_id, "command": "answer_human_question", "revision": read["body"]["revision"], "idempotencyKey": "bridge-answer-1", "questionId": question, "optionId": "option-1"})).await;
        assert_eq!(
            (error, answered["status"].as_u64(), answered["body"]["status"].as_str()),
            (None, Some(200), Some("active")),
            "{answered}"
        );
        assert_eq!(latest_prompt(&agent.server, &task_id)["answer"], "Main: Use main");
    }

    #[tokio::test]
    async fn http_mcp_answers_a_question_once_the_oauth_agent_is_granted() {
        use crate::http::routes::oauth::tests::{authorize, exchange, register};
        let agent = agent().await;
        let server = &agent.server;
        let client = register(server, "Answering client").await;
        let verifier = "s".repeat(43);
        let code = authorize(server, &client, &verifier, "answer-state").await;
        let token = exchange(server, &client, &code, &verifier).await.1["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let bearer = format!("Bearer {token}");
        let mut id = 0;
        let mut rpc = async |method: &str, params: Value| {
            id += 1;
            let response = server
                .request(
                    reqwest::Method::POST,
                    "/mcp",
                    &[
                        ("authorization", bearer.as_str()),
                        ("accept", "application/json, text/event-stream"),
                        ("mcp-protocol-version", "2025-06-18"),
                    ],
                    Some(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})),
                )
                .await;
            assert_eq!(response.status(), 200);
            response.json::<Value>().await.unwrap()["result"]["structuredContent"].clone()
        };
        rpc("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})).await;
        let tool = |name: &str, arguments: Value| json!({"name": name, "arguments": arguments});
        let whoami = rpc("tools/call", tool("suplex_whoami", json!({}))).await;
        assert_eq!(whoami["body"]["answerGrant"], Value::Null, "{whoami}");
        let oauth_agent = whoami["body"]["agent"]["id"].as_str().unwrap().to_owned();
        let (task_id, question) = waiting_task(&agent, "oauth-answer").await;
        let read = rpc("tools/call", tool("suplex_get_task", json!({"taskId": task_id}))).await;
        let answer = json!({"taskId": task_id, "command": "answer_human_question", "revision": read["body"]["revision"], "idempotencyKey": "oauth-answer-1", "questionId": question, "answer": "Use main"});
        let refused = rpc("tools/call", tool("suplex_command_task", answer.clone())).await;
        assert_eq!(
            (refused["status"].as_u64(), refused["body"]["code"].as_str()),
            (Some(403), Some("answer_grant_required"))
        );
        grant_answers(server, &oauth_agent, true).await;
        let capabilities = rpc("tools/call", tool("suplex_capabilities", json!({}))).await;
        assert_eq!(capabilities["body"], super::capabilities(true, true));
        // The grant adds answer_human_question to permittedCommands, so the revision moves.
        let read = rpc("tools/call", tool("suplex_get_task", json!({"taskId": task_id}))).await;
        let mut answer = answer;
        answer["revision"] = read["body"]["revision"].clone();
        let answered = rpc("tools/call", tool("suplex_command_task", answer)).await;
        assert_eq!(
            (answered["status"].as_u64(), answered["body"]["status"].as_str()),
            (Some(200), Some("active")),
            "{answered}"
        );
        assert_eq!(latest_prompt(server, &task_id)["answeredBy"]["agentId"], json!(oauth_agent));
    }
}
