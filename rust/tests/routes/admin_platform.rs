#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        http::session::SessionConfig,
        platform::database::{OpenMode, SuplexDatabase},
    };

    struct Fixture {
        root: PathBuf,
        state: AppState,
        address: std::net::SocketAddr,
        server: tokio::task::JoinHandle<()>,
        cookie: std::sync::Mutex<Option<String>>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    async fn fixture() -> Fixture {
        let root =
            std::env::temp_dir().join(format!("suplex-admin-platform-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let database =
            SuplexDatabase::open(&data.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let state = AppState::new(
            database,
            SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".into(),
                tailscale_exposure: "off".into(),
            },
        )
        .with_artifact_root(data.join("artifacts"))
        .with_project_roots(root.join("repositories"), root.join("worktrees"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = crate::http::router(state.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await;
        });
        Fixture {
            root,
            state,
            address,
            server,
            cookie: Default::default(),
        }
    }

    impl Fixture {
        async fn call(
            &self,
            method: &str,
            uri: &str,
            content_type: Option<&str>,
            body: Vec<u8>,
        ) -> (StatusCode, HeaderMap, Vec<u8>) {
            let mut request = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap()
                .request(
                    method.parse().unwrap(),
                    format!("http://{}{uri}", self.address),
                )
                .header(header::HOST, "127.0.0.1:4113")
                .header(header::ORIGIN, "http://127.0.0.1:4113")
                .body(body);
            if let Some(content_type) = content_type {
                request = request.header(header::CONTENT_TYPE, content_type);
            }
            let cookie = self.cookie.lock().unwrap().clone();
            if let Some(cookie) = cookie {
                request = request.header(header::COOKIE, cookie);
            }
            let response = request.send().await.unwrap();
            if let Some(session) = response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .find_map(|value| {
                    value
                        .to_str()
                        .ok()
                        .filter(|value| value.starts_with("sid_v1="))
                })
            {
                *self.cookie.lock().unwrap() = session.split(';').next().map(str::to_owned);
            }
            let status = response.status();
            let headers = response.headers().clone();
            (status, headers, response.bytes().await.unwrap().to_vec())
        }
    }

    fn json_body(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    #[tokio::test]
    async fn environment_settings_default_and_persist_partial_administrator_updates() {
        let fixture = fixture().await;
        let state = &fixture.state;
        let (status, headers, body) = fixture
            .call("GET", "/api/admin/environment", None, vec![])
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
        assert_eq!(
            json_body(&body),
            json!({"minFreeDiskGb":5,"defaultBudgetUsd":15,"defaultMaxTurns":40,"todayPageEnabled":false,"hostTerminalEnabled":false,"git2Enabled":false,"telemetryEnabled":true})
        );
        let patch = |body: &str| {
            fixture.call(
                "PATCH",
                "/api/admin/environment",
                Some("application/json"),
                body.as_bytes().to_vec(),
            )
        };
        assert_eq!(
            json_body(&patch(r#"{"minFreeDiskGb":7.5}"#).await.2),
            json!({"minFreeDiskGb":7.5,"defaultBudgetUsd":15,"defaultMaxTurns":40,"todayPageEnabled":false,"hostTerminalEnabled":false,"git2Enabled":false,"telemetryEnabled":true})
        );
        assert_eq!(
            json_body(
                &patch(r#"{"defaultBudgetUsd":20,"defaultMaxTurns":30}"#)
                    .await
                    .2
            ),
            json!({"minFreeDiskGb":7.5,"defaultBudgetUsd":20,"defaultMaxTurns":30,"todayPageEnabled":false,"hostTerminalEnabled":false,"git2Enabled":false,"telemetryEnabled":true})
        );
        assert_eq!(
            json_body(&patch(r#"{"todayPageEnabled":true}"#).await.2)["todayPageEnabled"],
            true
        );
        assert_eq!(
            json_body(&patch(r#"{"hostTerminalEnabled":true}"#).await.2)["hostTerminalEnabled"],
            true
        );
        assert_eq!(
            json_body(&patch(r#"{"git2Enabled":true}"#).await.2)["git2Enabled"],
            true
        );
        assert_eq!(
            json_body(
                &fixture
                    .call("GET", "/api/admin/environment", None, vec![])
                    .await
                    .2
            ),
            json!({"minFreeDiskGb":7.5,"defaultBudgetUsd":20,"defaultMaxTurns":30,"todayPageEnabled":true,"hostTerminalEnabled":true,"git2Enabled":true,"telemetryEnabled":true})
        );
        // The transport is process-wide: put it back for parallel tests.
        assert_eq!(
            json_body(&patch(r#"{"git2Enabled":false}"#).await.2)["git2Enabled"],
            false
        );
        for invalid in [
            r#"{"defaultBudgetUsd":-1}"#,
            r#"{}"#,
            r#"{"other":1}"#,
            r#"{"defaultMaxTurns":1.5}"#,
            r#"{"minFreeDiskGb":2000}"#,
            r#"{"todayPageEnabled":"yes"}"#,
            r#"{"hostTerminalEnabled":"yes"}"#,
            r#"{"git2Enabled":"yes"}"#,
            r#"{"telemetryEnabled":"yes"}"#,
        ] {
            assert_eq!(patch(invalid).await.0, StatusCode::BAD_REQUEST, "{invalid}");
        }
        let audit: String = state.with_database(|database| database.connection().query_row("SELECT metadata_json FROM suplex_audit_events WHERE action = 'environment_settings_updated' ORDER BY created_at LIMIT 1", [], |row| row.get(0))).unwrap();
        assert_eq!(json_body(audit.as_bytes())["minFreeDiskGb"], "7.5");
        assert_eq!(
            json_body(&patch(r#"{"telemetryEnabled":false}"#).await.2)["telemetryEnabled"],
            false
        );
        // A build without a PostHog key never asks for the notice.
        let (status, _, body) = fixture.call("GET", "/api/telemetry", None, vec![]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            json_body(&body),
            json!({"noticeRequired": false, "enabled": false, "sessionReplayEnabled": false})
        );
        assert_eq!(
            fixture
                .call(
                    "POST",
                    "/api/admin/telemetry/replay",
                    Some("application/json"),
                    br#"{"enabled":true}"#.to_vec()
                )
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        let (_, _, body) = fixture.call("GET", "/api/telemetry", None, vec![]).await;
        assert_eq!(
            json_body(&body),
            json!({"noticeRequired": false, "enabled": false, "sessionReplayEnabled": true})
        );
        let pre_notice: (Option<String>, bool) = state.with_database(|database| database.connection().query_row("SELECT notice_at, session_replay_enabled FROM suplex_telemetry WHERE id = 'host'", [], |row| Ok((row.get(0)?, row.get(1)?)))).unwrap();
        assert!(pre_notice.0.is_none());
        assert!(pre_notice.1);
        let notice = |body: &str| {
            fixture.call(
                "POST",
                "/api/admin/telemetry/notice",
                Some("application/json"),
                body.as_bytes().to_vec(),
            )
        };
        assert_eq!(
            notice(r#"{"sessionReplayEnabled":"yes"}"#).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            notice(r#"{"sessionReplayEnabled":true}"#).await.0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            fixture
                .call(
                    "POST",
                    "/api/admin/telemetry/replay",
                    Some("application/json"),
                    br#"{"enabled":"yes"}"#.to_vec()
                )
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            fixture
                .call(
                    "POST",
                    "/api/admin/telemetry/replay",
                    Some("application/json"),
                    br#"{"enabled":false}"#.to_vec()
                )
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(notice("{}").await.0, StatusCode::NO_CONTENT);
        let stored: (Option<String>, bool) = state.with_database(|database| database.connection().query_row("SELECT notice_at, session_replay_enabled FROM suplex_telemetry WHERE id = 'host'", [], |row| Ok((row.get(0)?, row.get(1)?)))).unwrap();
        assert!(stored.0.is_some());
        assert!(
            !stored.1,
            "the later explicit false acknowledgement disables replay"
        );
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_users SET role = 'member'", [])
                .unwrap()
        });
        assert_eq!(
            fixture
                .call("GET", "/api/admin/environment", None, vec![])
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        // Members read the experiments that shape their navigation.
        let (status, _, body) = fixture.call("GET", "/api/experiments", None, vec![]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            json_body(&body),
            json!({"todayPage":true,"hostTerminal":true})
        );
        assert_eq!(notice("{}").await.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn administrators_create_list_download_and_restore_backups() {
        let fixture = fixture().await;
        assert_eq!(
            json_body(
                &fixture
                    .call("GET", "/api/admin/backups", None, vec![])
                    .await
                    .2
            ),
            json!({"backups":[]})
        );
        let (status, _, body) = fixture
            .call("POST", "/api/admin/backups", None, vec![])
            .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        let name = json_body(&body)["name"].as_str().unwrap().to_owned();
        assert!(
            regex::Regex::new(r"^suplex-backup-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.tar\.gz$")
                .unwrap()
                .is_match(&name)
        );
        let listed = json_body(
            &fixture
                .call("GET", "/api/admin/backups", None, vec![])
                .await
                .2,
        );
        assert_eq!(listed["backups"][0]["name"], name.as_str());
        let (status, headers, archive) = fixture
            .call("GET", &format!("/api/admin/backups/{name}"), None, vec![])
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers[header::CONTENT_DISPOSITION],
            format!("attachment; filename=\"{name}\"").as_str()
        );

        let before = json_body(
            &fixture
                .call("GET", "/api/admin/environment", None, vec![])
                .await
                .2,
        );
        fixture
            .call(
                "PATCH",
                "/api/admin/environment",
                Some("application/json"),
                br#"{"defaultMaxTurns":47}"#.to_vec(),
            )
            .await;
        let (status, _, body) = fixture
            .call(
                "POST",
                "/api/admin/backups/restore",
                Some("application/gzip"),
                archive,
            )
            .await;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "{}",
            String::from_utf8_lossy(&body)
        );
        // The same session still works, and the live connection reads the restored data.
        assert_eq!(
            json_body(
                &fixture
                    .call("GET", "/api/admin/environment", None, vec![])
                    .await
                    .2
            ),
            before
        );
        let (status, _, body) = fixture
            .call(
                "POST",
                "/api/admin/backups/restore",
                Some("application/gzip"),
                b"not a backup".to_vec(),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            json_body(&body),
            json!({"error":"The file is not a valid Suplex backup."})
        );
        assert_eq!(
            fixture
                .call("GET", "/api/admin/backups/..%2Fsuplex.sqlite", None, vec![])
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            fixture
                .call(
                    "GET",
                    "/api/admin/backups/suplex-backup-2000-01-01T00-00-00Z.tar.gz",
                    None,
                    vec![]
                )
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn factory_reset_waits_for_live_sessions_then_restores_a_first_start_database() {
        let fixture = fixture().await;
        let state = &fixture.state;
        // A signed-in request creates the Operator; the task below keeps a session live.
        fixture
            .call("GET", "/api/admin/environment", None, vec![])
            .await;
        state.with_database(|database| {
            development::seed_development_data(database, Utc::now()).unwrap();
            let connection = database.connection();
            let company: String = connection.query_row("SELECT id FROM suplex_companies", [], |row| row.get(0)).unwrap();
            connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('reset_project',?1,'Project','/tmp/repo','/tmp/worktrees',NULL,'main','','','root','worker','{}','2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z')", [&company]).unwrap();
            // A minimal active control row: every required column gets a placeholder.
            connection.execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON").unwrap();
            let required: Vec<String> = connection.prepare("SELECT name FROM pragma_table_info('suplex_task_controls') WHERE \"notnull\" = 1 AND dflt_value IS NULL AND name NOT IN ('task_id', 'status')").unwrap().query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
            connection.execute(&format!("INSERT INTO suplex_task_controls (task_id, status{}) VALUES ('task_live', 'active'{})", required.iter().map(|name| format!(", {name}")).collect::<String>(), ", '{}'".repeat(required.len())), []).unwrap();
            connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = OFF").unwrap();
        });
        let (status, _, body) = fixture
            .call("POST", "/api/admin/factory-reset", None, vec![])
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            json_body(&body)["error"],
            factory_reset::LIVE_SESSIONS_BLOCK_RESET
        );
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_task_controls SET status = 'cancelled'", [])
                .unwrap()
        });
        let artifacts = fixture.root.join("data/artifacts/company");
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(artifacts.join("attachment.png"), "artifact").unwrap();
        std::fs::create_dir_all(fixture.root.join("data/provider-instances/claude-home")).unwrap();
        let worktree = fixture.root.join("worktrees/external-work");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join("keep.txt"), "uncommitted work").unwrap();
        let (status, _, body) = fixture
            .call("POST", "/api/admin/factory-reset", None, vec![])
            .await;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "{}",
            String::from_utf8_lossy(&body)
        );
        state.with_database(|database| {
            // Local mode seeds the Operator and a first company again, so only their rows remain.
            for table in ["suplex_tasks", "suplex_projects", "suplex_sessions"] {
                let count: i64 = database
                    .connection()
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0, "{table}");
            }
            let companies: Vec<String> = database
                .connection()
                .prepare("SELECT name FROM suplex_companies")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_eq!(companies, ["My Company"]);
        });
        assert_eq!(
            std::fs::read_dir(fixture.root.join("data/artifacts"))
                .unwrap()
                .count(),
            0
        );
        assert!(!fixture.root.join("data/provider-instances").exists());
        assert_eq!(
            std::fs::read_to_string(worktree.join("keep.txt")).unwrap(),
            "uncommitted work"
        );
        let (status, headers, _) = fixture.call("GET", "/", None, vec![]).await;
        assert_eq!(status, StatusCode::FOUND);
        assert_eq!(headers[header::LOCATION], "/onboarding");
    }
}
