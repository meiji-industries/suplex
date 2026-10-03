#[cfg(test)]
pub(crate) mod tests {
    use crate::shared::time::rfc3339_millis;
    use rusqlite::params;
    use serde_json::{Value, json};

    use crate::{
        http::{AppState, routes::auth},
    };

    pub(crate) struct Server {
        pub base: String,
        pub state: AppState,
        pub admin_cookie: String,
        pub member_cookie: String,
        pub client: reqwest::Client,
        pub path: std::path::PathBuf,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.path.display()));
            }
        }
    }

    pub(crate) const ORIGIN: &str = "https://suplex.example.test:4111";
    pub(crate) const HOST: &str = "suplex.example.test:4111";

    /// A served app with an admin session, a member session, a company, and two projects.
    pub(crate) async fn server(state: Option<(AppState, std::path::PathBuf)>) -> Server {
        let (mut state, path) = state.unwrap_or_else(auth::tests::state);
        let now = chrono::Utc::now();
        let stamp = rfc3339_millis(now);
        let admin = auth::tests::operator_passkey(&state, now);
        let member = state.with_database(|database| {
            let connection = database.connection();
            connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member_user', 'Member', 'user_v1_member_user', 'member', 'active', ?1, ?1, 1)", [&stamp]).unwrap();
            connection.execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_api', 'Agent API Company', 'active', ?1)", [&stamp]).unwrap();
            for (id, name) in [("project_api", "API Project"), ("project_api_2", "API Project 2")] {
                connection.execute("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES (?1, 'company_api', ?2, ?3, ?4, ?5, 'main', '', '', ?6, ?6)", params![id, name, format!("/tmp/{id}"), format!("/tmp/{id}-worktrees"), format!("meiji/{id}"), stamp]).unwrap();
            }
            connection.execute("INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES ('member_user', 'company_api', ?1)", [&stamp]).unwrap();
            auth::tests::verified_session(database, "member_user", now).unwrap()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        state.session_config.port = listener.local_addr().unwrap().port();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = crate::http::router(state.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Server {
            base,
            state,
            admin_cookie: format!("sid_v1={admin}"),
            member_cookie: format!("sid_v1={member}"),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            path,
            task,
        }
    }

    impl Server {
        pub(crate) async fn request(
            &self,
            method: reqwest::Method,
            path: &str,
            headers: &[(&str, &str)],
            body: Option<Value>,
        ) -> reqwest::Response {
            let mut request = self
                .client
                .request(method, format!("{}{path}", self.base))
                .header("host", HOST)
                .header("x-forwarded-host", HOST)
                .header("x-forwarded-proto", "https");
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            if let Some(body) = body {
                request = request.json(&body);
            }
            request.send().await.unwrap()
        }

        pub(crate) async fn send(
            &self,
            method: reqwest::Method,
            path: &str,
            cookie: Option<&str>,
            body: Option<Value>,
        ) -> (u16, Value) {
            let mut headers = vec![("origin", ORIGIN)];
            if let Some(cookie) = cookie {
                headers.push(("cookie", cookie));
            }
            let response = self.request(method, path, &headers, body).await;
            let status = response.status().as_u16();
            let text = response.text().await.unwrap();
            (status, serde_json::from_str(&text).unwrap_or(Value::Null))
        }
    }

    #[tokio::test]
    async fn admin_lifecycle_creates_lists_scopes_reissues_rotates_and_revokes() {
        let server = server(None).await;
        let admin = Some(server.admin_cookie.as_str());
        let (status, created) = server.send(reqwest::Method::POST, "/api/admin/external-agents", admin, Some(json!({"name": "External agent 1", "companyId": "company_api", "projectIds": ["project_api"]}))).await;
        assert_eq!(status, 201, "{created}");
        assert_eq!(
            (
                created["agent"]["name"].as_str(),
                created["agent"]["status"].as_str()
            ),
            (Some("External agent 1"), Some("pending"))
        );
        assert_eq!(created["agent"]["projectIds"], json!(["project_api"]));
        assert_eq!(
            (
                created["agent"]["answerGrantedByUserId"].clone(),
                created["agent"]["answerGrantedAt"].clone()
            ),
            (Value::Null, Value::Null)
        );
        assert!(created["pairingCode"].as_str().unwrap().starts_with("fhp_"));
        let id = created["agent"]["id"].as_str().unwrap().to_owned();

        let (status, listed) = server
            .send(
                reqwest::Method::GET,
                "/api/admin/external-agents",
                admin,
                None,
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(listed["agents"].as_array().unwrap().len(), 1);
        assert!(listed["agents"][0].get("hermesProfileId").is_none());
        let (_, legacy) = server
            .send(
                reqwest::Method::GET,
                "/api/admin/hermes-agents",
                admin,
                None,
            )
            .await;
        assert_eq!(legacy, listed);

        let (status, scoped) = server
            .send(
                reqwest::Method::PUT,
                &format!("/api/admin/external-agents/{id}/projects"),
                admin,
                Some(json!({"projectIds": ["project_api", "project_api_2"]})),
            )
            .await;
        assert_eq!(
            (status, scoped["agent"]["projectIds"].clone()),
            (200, json!(["project_api", "project_api_2"]))
        );

        let (status, reissued) = server
            .send(
                reqwest::Method::POST,
                &format!("/api/admin/external-agents/{id}/pairing-code"),
                admin,
                Some(json!({})),
            )
            .await;
        assert_eq!(status, 200);
        assert_ne!(reissued["pairingCode"], created["pairingCode"]);

        let (status, paired) = server
            .send(
                reqwest::Method::POST,
                "/api/agent/pairing/exchange",
                None,
                Some(
                    json!({"pairingCode": reissued["pairingCode"], "profileId": "profile-test-1"}),
                ),
            )
            .await;
        assert_eq!(status, 200, "{paired}");
        assert_eq!(
            (
                paired["agent"]["status"].as_str(),
                paired["agent"]["profileId"].as_str()
            ),
            (Some("paired"), Some("profile-test-1"))
        );
        assert!(paired["credential"].as_str().unwrap().starts_with("fha_"));

        let (status, rotated) = server
            .send(
                reqwest::Method::POST,
                &format!("/api/admin/external-agents/{id}/rotate"),
                admin,
                Some(json!({})),
            )
            .await;
        assert_eq!(status, 200);
        let (status, _) = server
            .send(
                reqwest::Method::POST,
                "/api/agent/pair",
                None,
                Some(json!({"pairingCode": rotated["pairingCode"], "profileId": "profile-test-1"})),
            )
            .await;
        assert_eq!(status, 200);
        let (status, replay) = server
            .send(
                reqwest::Method::POST,
                "/api/hermes/pair",
                None,
                Some(json!({"pairingCode": rotated["pairingCode"]})),
            )
            .await;
        assert_eq!(
            (status, replay),
            (
                401,
                json!({"error": "Pairing failed", "code": "pairing_invalid"})
            )
        );

        let (status, _) = server
            .send(
                reqwest::Method::POST,
                &format!("/api/admin/external-agents/{id}/revoke"),
                admin,
                Some(json!({})),
            )
            .await;
        assert_eq!(status, 204);
        let (_, finally) = server
            .send(
                reqwest::Method::GET,
                "/api/admin/external-agents",
                admin,
                None,
            )
            .await;
        assert_eq!(finally["agents"][0]["status"], "revoked");
    }

    #[tokio::test]
    async fn only_live_administrators_manage_agents_and_validation_precedes_authority() {
        let server = server(None).await;
        auth::tests::require_passkeys(&server.state);
        let body =
            json!({"name": "Anon", "companyId": "company_api", "projectIds": ["project_api"]});
        assert_eq!(
            server
                .send(
                    reqwest::Method::GET,
                    "/api/admin/external-agents",
                    None,
                    None
                )
                .await
                .0,
            401
        );
        assert_eq!(
            server
                .send(
                    reqwest::Method::POST,
                    "/api/admin/external-agents",
                    None,
                    Some(body.clone())
                )
                .await
                .0,
            401
        );
        let member = Some(server.member_cookie.as_str());
        assert_eq!(
            server
                .send(
                    reqwest::Method::GET,
                    "/api/admin/external-agents",
                    member,
                    None
                )
                .await,
            (404, json!({"error": "Not found", "code": "not_found"}))
        );
        assert_eq!(
            server
                .send(
                    reqwest::Method::POST,
                    "/api/admin/external-agents",
                    member,
                    Some(body)
                )
                .await
                .0,
            404
        );
        let (status, invalid) = server
            .send(
                reqwest::Method::POST,
                "/api/admin/external-agents",
                None,
                Some(json!({"name": " "})),
            )
            .await;
        assert_eq!(status, 400);
        assert_eq!(invalid["error"], "Invalid request");
        assert!(invalid.get("code").is_none());
    }
}
