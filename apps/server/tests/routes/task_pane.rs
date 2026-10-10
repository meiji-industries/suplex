#[cfg(test)]
pub(crate) mod tests {
    use std::{
        net::SocketAddr,
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    use axum::http::HeaderValue;
    use client::*;

    use super::*;
    use crate::{
        coordination::root_session_store,
        http::session::SessionConfig,
        identity::auth as identity_auth,
        integrations::{herdr::Herdr, herdr_bridge::tests::fake_terminal},
        platform::database::{OpenMode, SuplexDatabase},
        runtimes::task_display::tests::{FakeHerdr, scripted},
        tasks::repository::{self, PreparedTask, TaskCreator},
    };

    pub(crate) struct Fixture {
        pub state: AppState,
        pub task_id: String,
        pub root_session_id: String,
        pub cookie: String,
        pub root: PathBuf,
    }

    pub(crate) fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("suplex-pane-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut database =
            SuplexDatabase::open(&root.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let now = chrono::Utc::now();
        identity_auth::development_sign_in(&mut database, now).unwrap();
        let admin = identity_auth::create_session(&database, "user_development", now).unwrap();
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('pane_company','Pane','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('pane_project','pane_company','Pane','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker',?1,?1)", [&stamp]).unwrap();
        let profile = json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
        let task = repository::create(
            &mut database,
            &PreparedTask {
                id: repository::new_task_id(),
                company_id: "pane_company".into(),
                project_id: "pane_project".into(),
                title: "Terminal".into(),
                description: "Observe only".into(),
                configuration: json!({"repository":"owner/repo","repositoryPath":"/tmp/repo","worktreeRoot":"/tmp/worktrees","baselineSha":"head","startingSha":"head","capturedAt":stamp,"branch":"task-pane","baseBranch":"main"}),
                idempotency_key: "pane-1".into(),
                request_hash: "pane-hash".into(),
                creator: TaskCreator::User("user_development".into()),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-pane","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(profile.clone()).unwrap(),
                worker_profile: serde_json::from_value(profile).unwrap(),
                advisor_profiles: serde_json::from_value(json!({})).unwrap(),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
            },
            now,
        )
        .unwrap()
        .task;
        let session = root_session_store::reserve_root(&mut database, &task.id, now).unwrap();
        let state = AppState::new(
            database,
            SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".into(),
                tailscale_exposure: "off".into(),
            },
        );
        Fixture {
            state,
            task_id: task.id,
            root_session_id: session.id,
            cookie: format!("sid_v1={admin}"),
            root,
        }
    }

    impl Fixture {
        pub(crate) fn execute(&self, sql: &str, values: &[&dyn rusqlite::ToSql]) {
            self.state
                .with_database(|database| database.connection().execute(sql, values).unwrap());
        }

        pub(crate) async fn serve(&self) -> SocketAddr {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let app = crate::http::router(self.state.clone())
                .into_make_service_with_connect_info::<SocketAddr>();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            address
        }
    }

    /// Minimal WebSocket client over a raw TCP stream, enough to read frames
    /// and close codes in route tests without another crate.
    pub(crate) mod client {
        use std::net::SocketAddr;

        use base64::Engine;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpStream,
        };

        #[derive(Debug, PartialEq)]
        pub(crate) enum Frame {
            Text(String),
            Binary(Vec<u8>),
            Close(u16, String),
        }

        pub(crate) struct Client(TcpStream);

        pub(crate) async fn connect(
            address: SocketAddr,
            path: &str,
            headers: &[(&str, &str)],
        ) -> (u16, Client) {
            let mut stream = TcpStream::connect(address).await.unwrap();
            let key =
                base64::engine::general_purpose::STANDARD.encode(uuid::Uuid::new_v4().as_bytes());
            let mut request = format!(
                "GET {path} HTTP/1.1\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: {key}\r\n"
            );
            for (name, value) in headers {
                request.push_str(&format!("{name}: {value}\r\n"));
            }
            if !headers.iter().any(|(name, _)| *name == "host") {
                request.push_str("host: 127.0.0.1:4113\r\n");
            }
            request.push_str("\r\n");
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            let status = String::from_utf8_lossy(&head)[9..12].parse().unwrap();
            (status, Client(stream))
        }

        impl Client {
            pub(crate) async fn send(&mut self, opcode: u8, payload: &[u8]) {
                let mut frame = vec![0x80 | opcode];
                assert!(payload.len() < 126);
                frame.push(0x80 | payload.len() as u8);
                frame.extend_from_slice(&[0, 0, 0, 0]);
                frame.extend_from_slice(payload);
                self.0.write_all(&frame).await.unwrap();
            }

            pub(crate) async fn text(&mut self, text: &str) {
                self.send(1, text.as_bytes()).await;
            }

            pub(crate) async fn next(&mut self) -> Frame {
                let read = async {
                    let mut header = [0; 2];
                    self.0.read_exact(&mut header).await.unwrap();
                    let mut length = u64::from(header[1] & 0x7f);
                    if length == 126 {
                        let mut extended = [0; 2];
                        self.0.read_exact(&mut extended).await.unwrap();
                        length = u64::from(u16::from_be_bytes(extended));
                    } else if length == 127 {
                        let mut extended = [0; 8];
                        self.0.read_exact(&mut extended).await.unwrap();
                        length = u64::from_be_bytes(extended);
                    }
                    let mut payload = vec![0; length as usize];
                    self.0.read_exact(&mut payload).await.unwrap();
                    match header[0] & 0x0f {
                        1 => Frame::Text(String::from_utf8(payload).unwrap()),
                        2 => Frame::Binary(payload),
                        8 => Frame::Close(
                            u16::from_be_bytes([payload[0], payload[1]]),
                            String::from_utf8_lossy(&payload[2..]).into_owned(),
                        ),
                        _ => Frame::Binary(Vec::new()),
                    }
                };
                tokio::time::timeout(std::time::Duration::from_secs(5), read)
                    .await
                    .expect("websocket frame")
            }
        }
    }

    fn shell_state() -> Arc<Mutex<FakeHerdr>> {
        Arc::new(Mutex::new(FakeHerdr {
            missing_default: true,
            ..FakeHerdr::default()
        }))
    }

    pub(crate) fn enable_host_terminals(state: &AppState) {
        state.with_database(|database| {
            let mut settings = crate::platform::environment_settings::read(database).unwrap();
            settings.host_terminal_enabled = true;
            crate::platform::environment_settings::update(database, settings).unwrap();
        });
    }

    /// Reads frames until a binary frame contains `text`.
    pub(crate) async fn wait_for_output(client: &mut Client, text: &str) {
        let mut output = Vec::new();
        for _ in 0..500 {
            match client.next().await {
                Frame::Binary(bytes) => output.extend(bytes),
                Frame::Close(code, reason) => panic!("closed {code} {reason}"),
                Frame::Text(_) => {}
            }
            if String::from_utf8_lossy(&output).contains(text) {
                return;
            }
        }
        panic!("{text} did not arrive");
    }

    #[tokio::test]
    async fn host_terminals_open_the_shell_in_the_worktree_without_herdr_and_ignore_a_stale_stored_pane()
     {
        let mut fixture = fixture();
        fixture.state.herdr = Herdr::new(fixture.root.join("no-herdr").to_string_lossy());
        enable_host_terminals(&fixture.state);
        let worktree = fixture.root.join("worktree");
        fixture.execute(
            "UPDATE suplex_task_controls SET shell_pane_id = 'pane-gone', worktree_json = ?1 WHERE task_id = ?2",
            &[
                &json!({"path":worktree,"branch":"task-pane","baseSha":"head","headSha":"head","dirty":false}).to_string(),
                &fixture.task_id,
            ],
        );
        let address = fixture.serve().await;
        let shell_id = format!("host-shell-{}", fixture.task_id);
        let (task_id, cookie) = (&fixture.task_id, &fixture.cookie);
        let activity = move || async move {
            reqwest::Client::new()
                .get(format!("http://{address}/api/tasks/{task_id}/activity"))
                .header("host", "127.0.0.1:4113")
                .header("cookie", cookie)
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        };
        let path = format!(
            "/api/tasks/{}/pane/shell/terminal?cols=100&rows=30",
            fixture.task_id
        );
        // Without its worktree directory the task has no Shell.
        assert_eq!(activity().await["shellPaneId"], Value::Null);
        let (_, mut missing) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        assert_eq!(
            missing.next().await,
            Frame::Close(4404, "no shell pane".into())
        );
        assert!(fixture.state.host_terminals.task_ids().is_empty());
        std::fs::create_dir_all(&worktree).unwrap();
        let document = activity().await;
        assert_eq!(document["shellPaneId"], shell_id);
        assert_eq!(
            document["sessions"][0]["paneId"],
            format!("host-session-{}", fixture.root_session_id)
        );
        let path = format!(
            "/api/tasks/{}/pane/shell/terminal?cols=100&rows=30",
            fixture.task_id
        );
        for _ in 0..2 {
            let (_, mut shell) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
            let Frame::Text(opened) = shell.next().await else {
                panic!("open message")
            };
            assert_eq!(
                serde_json::from_str::<Value>(&opened).unwrap(),
                json!({"type":"open","paneId":shell_id,"readOnly":false,"cols":100,"rows":30,"scroll":"local"})
            );
            assert_eq!(
                shell.next().await,
                Frame::Text(r#"{"type":"replay","state":"start"}"#.into())
            );
            assert_eq!(
                shell.next().await,
                Frame::Text(r#"{"type":"size","cols":100,"rows":30}"#.into())
            );
            assert!(matches!(shell.next().await, Frame::Binary(_)));
            assert_eq!(
                shell.next().await,
                Frame::Text(r#"{"type":"replay","state":"end"}"#.into())
            );
            shell.send(2, b"echo host-$((6*7)):$(pwd -P)\n").await;
            let pwd = std::fs::canonicalize(&worktree).unwrap();
            wait_for_output(&mut shell, &format!("host-42:{}", pwd.display())).await;
            shell.send(8, &1000_u16.to_be_bytes()).await;
        }
        // Both connections shared one Shell, which the archive closes. A
        // running Shell stays when its worktree is removed.
        assert_eq!(fixture.state.host_terminals.task_ids(), [fixture.task_id.clone()]);
        std::fs::remove_dir_all(&worktree).unwrap();
        assert_eq!(activity().await["shellPaneId"], shell_id);
        let (_, mut again) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        assert!(matches!(again.next().await, Frame::Text(opened) if opened.contains(&shell_id)));
        assert_eq!(
            again.next().await,
            Frame::Text(r#"{"type":"replay","state":"start"}"#.into())
        );
        wait_for_output(&mut again, "host-42").await;
        again.send(8, &1000_u16.to_be_bytes()).await;
        fixture.state.host_terminals.close_all().await;
        assert!(fixture.state.host_terminals.task_ids().is_empty());
        let _ = std::fs::remove_dir_all(&fixture.root);
    }

    #[tokio::test]
    async fn terminal_origin_accepts_only_the_request_host_or_configured_origin() {
        let headers = |origin: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert("host", HeaderValue::from_static("127.0.0.1:4111"));
            headers.insert("origin", HeaderValue::from_static(origin));
            headers
        };
        assert!(origin_allowed(
            &headers("http://127.0.0.1:4111"),
            "https://suplex.example"
        ));
        assert!(origin_allowed(
            &headers("https://suplex.example"),
            "https://suplex.example"
        ));
        assert!(!origin_allowed(
            &headers("https://evil.example"),
            "https://suplex.example"
        ));
        assert!(terminal_size(Some("cols=19")).is_err());
        assert_eq!(terminal_size(Some("cols=100&rows=30")).unwrap(), (100, 30));
    }

    #[tokio::test]
    async fn observers_are_independent_read_only_and_close_on_binding_or_access_changes() {
        let mut fixture = fixture();
        let script = fake_terminal(&fixture.root.join("herdr"), &[&json!({"type":"terminal.frame","seq":1,"full":false,"width":100,"height":30,"bytes":base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "live output")}).to_string()]);
        fixture.state.herdr = Herdr::with_runner(
            script.to_string_lossy(),
            Arc::new(|args: &[String]| match args[1].as_str() {
                "read" => Ok(crate::integrations::herdr::RunOutput {
                    status: Some(0),
                    stdout: "screen\n".into(),
                    stderr: String::new(),
                }),
                "get" => crate::integrations::herdr::fake::envelope(
                    json!({"pane":{"pane_id":args[2],"scroll":{"viewport_rows":30}}}),
                ),
                _ => crate::integrations::herdr::fake::failed(
                    json!({"error":{"code":"unavailable"}}),
                ),
            }),
        );
        fixture.execute(
            "UPDATE suplex_task_sessions SET pane_id = 'pane-root' WHERE id = ?1",
            &[&fixture.root_session_id],
        );
        crate::http::routes::auth::tests::require_remote_login(&fixture.state);
        let address = fixture.serve().await;
        let path = format!("/api/tasks/{}/pane/root/terminal", fixture.task_id);
        let (status, _) = connect(address, &path, &[("host", "suplex.example.test:4113"), ("x-forwarded-host", "suplex.example.test:4111"), ("x-forwarded-proto", "https")]).await;
        assert_eq!(status, 401);
        let (status, mut observer) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        assert_eq!(status, 101);
        let (_, mut independent) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        assert!(matches!(independent.next().await, Frame::Text(_)));
        independent.send(8, &1000_u16.to_be_bytes()).await;
        let Frame::Text(opened) = observer.next().await else {
            panic!("open message")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&opened).unwrap(),
            json!({"type":"open","paneId":"pane-root","readOnly":true,"cols":80,"rows":24,"scroll":"remote"})
        );
        assert_eq!(
            observer.next().await,
            Frame::Text(r#"{"type":"size","cols":6,"rows":30}"#.into())
        );
        assert!(
            matches!(observer.next().await, Frame::Binary(bytes) if bytes.ends_with(b"screen\x1b[0m\x1b[?2026l"))
        );
        assert_eq!(
            observer.next().await,
            Frame::Text(r#"{"type":"size","cols":100,"rows":30}"#.into())
        );
        assert_eq!(
            observer.next().await,
            Frame::Binary(b"live output".to_vec())
        );
        observer.send(2, b"unapproved instruction").await;
        fixture.execute(
            "UPDATE suplex_task_sessions SET pane_id = 'pane-replacement' WHERE id = ?1",
            &[&fixture.root_session_id],
        );
        assert_eq!(
            observer.next().await,
            Frame::Close(4404, "attachment changed".into())
        );
        assert!(std::fs::read_to_string(fixture.root.join("herdr/stdin")).is_err());
        let (status, mut rejected) = connect(
            address,
            &path,
            &[
                ("cookie", &fixture.cookie),
                ("origin", "https://evil.example"),
            ],
        )
        .await;
        assert_eq!(status, 101);
        assert_eq!(rejected.next().await, Frame::Close(4403, "origin".into()));
        let (status, _) = connect(
            address,
            &format!("/api/tasks/{}/pane/advisor/terminal", fixture.task_id),
            &[("cookie", &fixture.cookie)],
        )
        .await;
        assert_eq!(status, 400);
        let (_, mut revoked) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        assert!(matches!(revoked.next().await, Frame::Text(_)));
        fixture.execute("UPDATE suplex_users SET role = 'member'", &[]);
        fixture.execute("DELETE FROM suplex_memberships", &[]);
        loop {
            if let Frame::Close(code, reason) = revoked.next().await {
                assert_eq!((code, reason.as_str()), (4403, "access revoked"));
                break;
            }
        }
        let _ = std::fs::remove_dir_all(&fixture.root);
    }

    #[tokio::test]
    async fn the_shell_terminal_is_writable_and_closes_4404_without_a_pane_and_4498_on_takeover() {
        let mut fixture = fixture();
        let script = fake_terminal(&fixture.root.join("herdr"), &[&json!({"type":"terminal.frame","seq":1,"full":true,"width":80,"height":24,"bytes":"aGk="}).to_string()]);
        let state = shell_state();
        // The scripted fake answers Herdr queries; the script is the terminal session.
        fixture.state.herdr = scripted(state.clone()).0;
        fixture.state.herdr.binary = script.to_string_lossy().into_owned();
        let address = fixture.serve().await;
        let path = format!(
            "/api/tasks/{}/pane/shell/terminal?cols=132&rows=43",
            fixture.task_id
        );
        let (_, mut missing) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        assert_eq!(
            missing.next().await,
            Frame::Close(4404, "no shell pane".into())
        );

        let mut pane = crate::integrations::herdr::Pane {
            pane_id: "pane-shell".into(),
            ..Default::default()
        };
        pane.tokens
            .insert("suplex_task_id".into(), fixture.task_id.clone());
        pane.tokens.insert("suplex_role".into(), "shell".into());
        pane.tokens.insert(
            "suplex_binding_id".into(),
            format!("{}:shell", fixture.task_id),
        );
        state
            .lock()
            .unwrap()
            .panes
            .insert("pane-shell".into(), pane);
        fixture.execute(
            "UPDATE suplex_task_controls SET shell_pane_id = 'pane-shell' WHERE task_id = ?1",
            &[&fixture.task_id],
        );
        let (_, mut shell) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        let Frame::Text(opened) = shell.next().await else {
            panic!("open message")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&opened).unwrap()["readOnly"],
            false
        );
        assert_eq!(
            shell.next().await,
            Frame::Text(r#"{"type":"size","cols":80,"rows":24}"#.into())
        );
        assert_eq!(shell.next().await, Frame::Binary(b"hi".to_vec()));
        shell.send(2, b"ls\n").await;
        shell
            .text(r#"{"type":"resize","cols":132,"rows":43}"#)
            .await;
        shell
            .text(r#"{"type":"scroll","direction":"up","lines":9}"#)
            .await;
        shell.text(r#"{"type":"mystery"}"#).await;
        let stdin = fixture.root.join("herdr/stdin");
        for _ in 0..100 {
            if std::fs::read_to_string(&stdin)
                .unwrap_or_default()
                .lines()
                .count()
                >= 3
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            std::fs::read_to_string(&stdin)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            [
                r#"{"type":"terminal.input","bytes":"bHMK"}"#,
                r#"{"type":"terminal.resize","cols":132,"rows":43}"#,
                r#"{"type":"terminal.scroll","direction":"up","lines":9}"#
            ]
        );
        assert!(
            std::fs::read_to_string(fixture.root.join("herdr/argv"))
                .unwrap()
                .contains("terminal session control pane-shell --takeover --cols 132 --rows 43")
        );
        let takeover = fake_terminal(
            &fixture.root.join("takeover"),
            &[r#"{"type":"terminal.closed","reason":"terminal attach taken over"}"#],
        );
        let mut state_with_takeover = fixture.state.clone();
        state_with_takeover.herdr.binary = takeover.to_string_lossy().into_owned();
        let takeover_fixture = Fixture {
            state: state_with_takeover,
            task_id: fixture.task_id.clone(),
            root_session_id: fixture.root_session_id.clone(),
            cookie: fixture.cookie.clone(),
            root: fixture.root.clone(),
        };
        let address = takeover_fixture.serve().await;
        let (_, mut displaced) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        assert!(matches!(displaced.next().await, Frame::Text(_)));
        assert_eq!(
            displaced.next().await,
            Frame::Close(4498, "terminal attach taken over".into())
        );
        let _ = std::fs::remove_dir_all(&fixture.root);
    }

    #[tokio::test]
    async fn only_an_admin_opens_the_shell_and_a_member_still_observes() {
        let fixture = fixture();
        fixture.execute("UPDATE suplex_users SET role = 'member'", &[]);
        fixture.execute("INSERT OR IGNORE INTO suplex_memberships (user_id, company_id, created_at) VALUES ('user_development', 'pane_company', '2026-01-01T00:00:00Z')", &[]);
        let address = fixture.serve().await;
        let headers = [("cookie", fixture.cookie.as_str())];
        let shell = format!("/api/tasks/{}/pane/shell/terminal?cols=80&rows=24", fixture.task_id);
        let root = format!("/api/tasks/{}/pane/root/terminal?cols=80&rows=24", fixture.task_id);
        assert_eq!(connect(address, &shell, &headers).await.0, 403);
        assert_eq!(connect(address, &root, &headers).await.0, 101);
        let _ = std::fs::remove_dir_all(&fixture.root);
    }
}
