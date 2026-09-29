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
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            root,
        );
        git(
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                local.to_str().unwrap(),
            ],
            root,
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
        let root = std::env::temp_dir().join(format!("suplex-agent-api-{}", uuid::Uuid::new_v4()));
        let local = repository(&root);
        let (state, path) = route_auth::tests::state();
        let state = state.with_artifact_root(root.join("artifacts"));
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
            8
        );
        let (_, capabilities) = agent
            .call(reqwest::Method::GET, "/api/agent/capabilities", None)
            .await;
        assert_eq!(capabilities, super::capabilities(true));
        assert_eq!(
            super::capabilities(false)["unavailableCommands"],
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
}
