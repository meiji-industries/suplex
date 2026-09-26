//! Live terminal views of task panes. Session panes are read-only observers;
//! the task Shell is interactive. Herdr owns the panes: a missing or recreated
//! pane closes the socket, and the browser reconnects to the current pane.

use crate::shared::time::now_millis_rfc3339;
use std::{error::Error, time::Duration};

use axum::{
    Router,
    extract::{
        Path, RawQuery, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::Response,
    routing::get,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::{
    http::{AppState, contracts::typed::finding, validation},
    integrations::herdr_bridge::{self, Bridge, BridgeEvent, Mode},
    runtimes::task_display::{ShellPaneRequest, ensure_task_shell_pane},
};

use super::{
    auth,
    profiles::authorize,
    task_worktree::{authorized_company, task_worktree, validated_task_id},
};

/// Close code for a terminal control bridge displaced by a newer controller.
pub const TERMINAL_TAKEOVER_CLOSE_CODE: u16 = 4498;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/tasks/{task_id}/pane/{role}/terminal", get(terminal))
}

pub(crate) fn origin_allowed(headers: &HeaderMap, reachable_address: &str) -> bool {
    let Some(origin) = headers.get("origin") else {
        return true;
    };
    let Some(origin) = origin
        .to_str()
        .ok()
        .and_then(|raw| url::Url::parse(raw).ok())
    else {
        return false;
    };
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    let authority = origin.host_str().map(|name| match origin.port() {
        Some(port) => format!("{name}:{port}"),
        None => name.to_owned(),
    });
    url::Url::parse(reachable_address).is_ok_and(|reachable| reachable.origin() == origin.origin())
        || (host.is_some() && authority.as_deref() == host)
}

/// `cols` and `rows` coerced like `z.coerce.number().int().min().max().default()`.
pub(crate) fn terminal_size(query: Option<&str>) -> Result<(i64, i64), Box<Response>> {
    let values = url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let mut findings = Vec::new();
    let mut read = |name: &str, default: f64, minimum: f64, maximum: f64| {
        let Some((_, raw)) = values.iter().find(|(key, _)| key == name) else {
            return default;
        };
        let trimmed = raw.trim();
        let number = if trimmed.is_empty() {
            Some(0.0)
        } else {
            trimmed.parse::<f64>().ok()
        };
        let code = match number {
            None => Some("invalid_type"),
            Some(value) if !value.is_finite() || value.fract() != 0.0 => Some("invalid_type"),
            Some(value) if value < minimum => Some("too_small"),
            Some(value) if value > maximum => Some("too_big"),
            Some(_) => None,
        };
        if let Some(code) = code {
            findings.push(finding(code, &[json!(name)]));
        }
        number.unwrap_or(default)
    };
    let cols = read("cols", 80.0, 20.0, 300.0);
    let rows = read("rows", 24.0, 5.0, 150.0);
    if findings.is_empty() {
        Ok((cols as i64, rows as i64))
    } else {
        Err(Box::new(validation::validation_error_public(findings)))
    }
}

async fn close(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.chars().take(100).collect::<String>().into(),
        })))
        .await;
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text
            .trim()
            .parse()
            .ok()
            .or(text.trim().is_empty().then_some(0.0)),
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        Value::Null => Some(0.0),
        _ => None,
    }
    .filter(|number| number.is_finite())
}

pub(crate) struct TerminalSession {
    pub pane_id: String,
    pub read_only: bool,
    pub cols: i64,
    pub rows: i64,
    /// Close code after the controller or observer ends normally.
    pub ended_code: u16,
}

/// Streams bridge events to the browser and forwards control input. Runs
/// until either side closes or `access` returns a close code and reason.
pub(crate) async fn run_terminal(
    mut socket: WebSocket,
    session: TerminalSession,
    bridge: Bridge,
    mut events: UnboundedReceiver<BridgeEvent>,
    mut access: impl FnMut() -> Option<(u16, &'static str)>,
) {
    let opened = json!({"type":"open","paneId":session.pane_id,"readOnly":session.read_only,"cols":session.cols,"rows":session.rows});
    if socket
        .send(Message::Text(opened.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.tick().await;
    loop {
        tokio::select! {
            message = socket.recv() => match message {
                Some(Ok(Message::Binary(bytes))) if !session.read_only => bridge.input(bytes.to_vec()),
                Some(Ok(Message::Text(text))) if !session.read_only => {
                    let Ok(message) = serde_json::from_str::<Value>(&text) else { continue };
                    match (message["type"].as_str(), message["direction"].as_str()) {
                        (Some("resize"), _) => if let (Some(cols), Some(rows)) = (number(&message["cols"]), number(&message["rows"])) {
                            bridge.resize(cols, rows);
                        },
                        (Some("scroll"), Some(direction @ ("up" | "down"))) => if let Some(lines) = number(&message["lines"]) {
                            bridge.scroll(if direction == "up" { "up" } else { "down" }, lines);
                        },
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            event = events.recv() => match event {
                Some(BridgeEvent::Frame { width, height, bytes, .. }) => {
                    let size = json!({"type":"size","cols":width,"rows":height}).to_string();
                    if socket.send(Message::Text(size.into())).await.is_err()
                        || socket.send(Message::Binary(bytes.into())).await.is_err()
                    {
                        break;
                    }
                }
                Some(BridgeEvent::Closed(reason)) => {
                    let code = if reason.contains("taken over") { TERMINAL_TAKEOVER_CLOSE_CODE } else { session.ended_code };
                    close(&mut socket, code, &reason).await;
                    break;
                }
                Some(BridgeEvent::Error(message)) => {
                    let payload = json!({"type":"error","message":message}).to_string();
                    if socket.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            _ = interval.tick() => {
                if let Some((code, reason)) = access() {
                    close(&mut socket, code, reason).await;
                    break;
                }
            }
        }
    }
    bridge.release();
}

/// The pane id the task currently binds for `role`: the Shell binding, or the
/// current session of that kind.
fn bound_pane(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    role: &str,
) -> Result<Option<String>, Box<dyn Error>> {
    state.with_database(|database| {
        authorized_company(database, user_id, task_id)?;
        let pane = if role == "shell" {
            database
                .connection()
                .query_row(
                    "SELECT shell_pane_id FROM suplex_task_controls WHERE task_id = ?1",
                    [task_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
        } else {
            database
                .connection()
                .query_row(
                    "SELECT pane_id FROM suplex_task_sessions WHERE task_id = ?1 AND kind = ?2 AND is_current = 1 ORDER BY created_at, id LIMIT 1",
                    params![task_id, role],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
        };
        Ok(pane.flatten())
    })
}

/// Resolves the task's Shell pane from Herdr, rediscovering it when the
/// saved binding is stale. It never creates a workspace.
fn task_shell_pane(
    state: &AppState,
    user_id: &str,
    task_id: &str,
) -> Result<Option<String>, Box<dyn Error>> {
    let (shell, excluded, cwd) = state.with_database(|database| -> Result<_, Box<dyn Error>> {
        let (_, worktree) = task_worktree(database, user_id, task_id)?;
        let shell = database.connection().query_row(
            "SELECT shell_pane_id FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get::<_, Option<String>>(0),
        )?;
        let mut statement = database.connection().prepare(
            "SELECT pane_id FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY created_at, id",
        )?;
        let excluded = statement
            .query_map([task_id], |row| row.get::<_, Option<String>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((shell, excluded, worktree))
    })?;
    let cwd = cwd.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let pane = ensure_task_shell_pane(
        &state.herdr,
        &ShellPaneRequest {
            task_id,
            cwd: &cwd,
            pane_id: shell.as_deref(),
            exclude_pane_ids: &excluded,
            create: false,
        },
        &mut |pane_id| {
            state.with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_task_controls SET shell_pane_id = ?1, updated_at = ?2 WHERE task_id = ?3",
                    params![pane_id, now_millis_rfc3339(), task_id],
                )
            })?;
            Ok(())
        },
    );
    Ok(pane.ok().flatten().map(|pane| pane.pane_id))
}

async fn terminal(
    State(state): State<AppState>,
    Path((task_id, role)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Err(response) = validated_task_id(&task_id) {
        return *response;
    }
    if !["root", "worker", "shell"].contains(&role.as_str()) {
        return validation::validation_error_public(vec![finding(
            "invalid_union",
            &[json!("role")],
        )]);
    }
    let (cols, rows) = match terminal_size(query.as_deref()) {
        Ok(size) => size,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = upgrade.on_upgrade(move |mut socket| async move {
        if !origin_allowed(&headers, &state.session_config.reachable_address) {
            return close(&mut socket, 4403, "origin").await;
        }
        let shell = role == "shell";
        let pane_id = if shell {
            let resolver = state.clone();
            let (user, task) = (user_id.clone(), task_id.clone());
            match tokio::task::spawn_blocking(move || {
                task_shell_pane(&resolver, &user, &task).map_err(|error| error.to_string())
            })
            .await
            {
                Ok(Ok(Some(pane_id))) => pane_id,
                Ok(Ok(None)) => return close(&mut socket, 4404, "no shell pane").await,
                _ => return close(&mut socket, 4404, "not found").await,
            }
        } else {
            let bound = bound_pane(&state, &user_id, &task_id, &role).map_err(|_| ());
            match bound {
                Ok(Some(pane_id)) => pane_id,
                Ok(None) => return close(&mut socket, 4404, "no attachment").await,
                Err(_) => return close(&mut socket, 4404, "not found").await,
            }
        };
        let (bridge, events) = herdr_bridge::open(
            state.herdr.clone(),
            pane_id.clone(),
            shell.then_some(cols as f64),
            shell.then_some(rows as f64),
            if shell { Mode::Control } else { Mode::Observe },
        );
        let session = TerminalSession {
            pane_id: pane_id.clone(),
            read_only: !shell,
            cols,
            rows,
            ended_code: if shell { 1000 } else { 1012 },
        };
        run_terminal(socket, session, bridge, events, || {
            match bound_pane(&state, &user_id, &task_id, &role) {
                Ok(current) if current.as_deref() == Some(pane_id.as_str()) => None,
                Ok(_) => Some((4404, "attachment changed")),
                Err(_) => Some((4403, "access revoked")),
            }
        })
        .await;
    });
    auth::append_cookies(&mut response, cookies);
    response
}

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
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('pane_company','Pane','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('pane_project','pane_company','Pane','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker','{}',?1,?1)", [&stamp]).unwrap();
        let profile = json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
        let task = repository::create(
            &mut database,
            &PreparedTask {
                id: repository::new_task_id(),
                company_id: "pane_company".into(),
                project_id: "pane_project".into(),
                title: "Terminal".into(),
                description: "Observe only".into(),
                configuration: json!({"branch":"task-pane","baseBranch":"main"}),
                idempotency_key: "pane-1".into(),
                request_hash: "pane-hash".into(),
                creator: TaskCreator::User(admin.user.id.clone()),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-pane","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(profile.clone()).unwrap(),
                worker_profile: serde_json::from_value(profile).unwrap(),
                advisor_profiles: serde_json::from_value(json!({})).unwrap(),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![],
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
            cookie: format!("sid_v1={}", admin.session_token),
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
    async fn observers_are_read_only_and_close_when_the_pane_binding_changes() {
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
        let address = fixture.serve().await;
        let path = format!("/api/tasks/{}/pane/root/terminal", fixture.task_id);
        let (status, _) = connect(address, &path, &[("host", "suplex.example.test:4113")]).await;
        assert_eq!(status, 401);
        let (status, mut observer) = connect(address, &path, &[("cookie", &fixture.cookie)]).await;
        assert_eq!(status, 101);
        let Frame::Text(opened) = observer.next().await else {
            panic!("open message")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&opened).unwrap(),
            json!({"type":"open","paneId":"pane-root","readOnly":true,"cols":80,"rows":24})
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
}
