//! Native Codex session history with live, read-only observation.

use std::{error::Error, io, path::PathBuf, time::UNIX_EPOCH};

use axum::{
    Json, Router,
    extract::{
        Path, RawQuery, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::{
    coordination::root_session_store,
    http::{AppState, contracts::typed::finding, session, validation},
    identity::companies,
    platform::database::SuplexDatabase,
    runtimes::codex::{session_reader, transcript},
    tasks::commands::TaskFailure,
};

use super::auth;

const PAGE_SIZE: usize = 40;
const MAX_BUFFERED_BYTES: usize = 4 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/tasks/{task_id}/sessions/{session_id}/history",
            get(history),
        )
        .route(
            "/api/tasks/{task_id}/sessions/{session_id}/history/live",
            get(live),
        )
}

fn validate_params(task_id: &str, session_id: &str) -> Result<(), Box<Response>> {
    let mut findings = Vec::new();
    if task_id.is_empty() {
        findings.push(finding("too_small", &[json!("taskId")]));
    }
    if session_id.is_empty() {
        findings.push(finding("too_small", &[json!("sessionId")]));
    }
    if findings.is_empty() {
        Ok(())
    } else {
        Err(Box::new(validation::validation_error_public(findings)))
    }
}

fn before_query(query: Option<&str>) -> Result<Option<String>, Box<Response>> {
    let before = query
        .into_iter()
        .flat_map(|query| url::form_urlencoded::parse(query.as_bytes()))
        .filter(|(name, _)| name == "before")
        .map(|(_, value)| value.into_owned())
        .collect::<Vec<_>>();
    let code = if before.len() > 1 {
        Some("invalid_type")
    } else {
        before
            .first()
            .and_then(|value| match value.encode_utf16().count() {
                0 => Some("too_small"),
                1..=512 => None,
                _ => Some("too_big"),
            })
    };
    if let Some(code) = code {
        return Err(Box::new(validation::validation_error_public(vec![
            finding(code, &[json!("before")]),
        ])));
    }
    Ok(before.into_iter().next())
}

fn authorize(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, Vec<String>), Box<Response>> {
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(auth::service_error)
        .map_err(Box::new)?;
    match session.user {
        Some(user) => Ok((user.id, session.set_cookies)),
        None => {
            let mut response = auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
            auth::append_cookies(&mut response, session.set_cookies);
            Err(Box::new(response))
        }
    }
}

fn not_found() -> Box<dyn Error> {
    Box::new(TaskFailure {
        public_message: "Not found".into(),
        status_code: 404,
        code: "task_failure",
    })
}

#[derive(Clone)]
struct ScopedSession {
    database_path: PathBuf,
    session_id: String,
    current: bool,
    provider: String,
}

fn scoped_session(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
    session_id: &str,
) -> Result<ScopedSession, Box<dyn Error>> {
    let company: Option<String> = database
        .connection()
        .query_row(
            "SELECT company_id FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    companies::require_company_access(database, user_id, &company.ok_or_else(not_found)?)?;
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let session = rows
        .sessions
        .iter()
        .find(|value| value["id"] == session_id)
        .ok_or_else(not_found)?;
    let fallback = if session["kind"] == "root" {
        &rows.control["rootProfile"]
    } else if let Some(role) = session["advisorRole"].as_str() {
        rows.control["advisorProfiles"]
            .get(role)
            .unwrap_or(&rows.control["rootProfile"])
    } else {
        &rows.control["workerProfile"]
    };
    let profile = if session["profile"].is_null() {
        fallback
    } else {
        &session["profile"]
    };
    Ok(ScopedSession {
        database_path: PathBuf::from(
            database
                .connection()
                .path()
                .ok_or("Task database has no path")?,
        ),
        session_id: session_id.to_owned(),
        current: session["current"] == true,
        provider: profile["provider"].as_str().unwrap_or_default().into(),
    })
}

fn response_error(error: Box<dyn Error>) -> Response {
    match error.downcast::<TaskFailure>() {
        Ok(failure) => auth::error(StatusCode::NOT_FOUND, &failure.public_message),
        Err(error) => auth::service_error(error),
    }
}

fn codex_history(scoped: &ScopedSession) -> io::Result<Vec<Value>> {
    if scoped.provider != "codex" {
        return Err(io::Error::other("Native session history is not available"));
    }
    let directory = session_reader::session_directory(&scoped.database_path, &scoped.session_id)?;
    let turns = session_reader::turns(&directory)?;
    Ok(turns
        .into_iter()
        .filter_map(|turn| {
            let text = transcript::result_text(&turn.events);
            if text.is_empty() {
                return None;
            }
            let created_at: i64 = turn
                .updated_at
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis()
                .try_into()
                .ok()?;
            Some(json!({
                "id":turn.id,"role":"assistant","createdAt":created_at,
                "content":[{"id":format!("{}:text",turn.id),"type":"text","text":text}],
            }))
        })
        .collect::<Vec<_>>())
}

fn page(messages: &[Value], before: Option<&str>) -> Result<Value, TaskFailure> {
    let end = match before {
        None => messages.len(),
        Some(before) => messages
            .iter()
            .position(|message| message["id"] == before)
            .ok_or_else(|| TaskFailure {
                public_message: "The session history cursor is not available".into(),
                status_code: 400,
                code: "cursor_invalid",
            })?,
    };
    let start = end.saturating_sub(PAGE_SIZE);
    Ok(json!({
        "messages": &messages[start..end],
        "olderCursor": (start > 0).then(|| messages[start]["id"].clone()),
    }))
}

async fn history(
    State(state): State<AppState>,
    Path((task_id, session_id)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = validate_params(&task_id, &session_id) {
        return *response;
    }
    let before = match before_query(query.as_deref()) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let scoped = match state
        .with_database(|database| scoped_session(database, &user_id, &task_id, &session_id))
    {
        Ok(value) => value,
        Err(error) => {
            let mut response = response_error(error);
            auth::append_cookies(&mut response, cookies);
            return response;
        }
    };
    let observed = tokio::task::spawn_blocking(move || codex_history(&scoped)).await;
    let result = match observed {
        Ok(Ok(messages)) => page(&messages, before.as_deref())
            .map_err(|failure| Box::new(failure) as Box<dyn Error>),
        Ok(Err(_)) | Err(_) => {
            let mut response = auth::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Session history is not available",
            );
            auth::append_cookies(&mut response, cookies);
            return response;
        }
    };
    let result = match result {
        Ok(result) => state
            .with_database(|database| scoped_session(database, &user_id, &task_id, &session_id))
            .map(|_| result),
        Err(error) => Err(error),
    };
    let mut response = match result {
        Ok(value) => {
            let mut response = Json(value).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                "private, no-store".parse().expect("cache header"),
            );
            response
        }
        Err(error) => match error.downcast::<TaskFailure>() {
            Ok(failure) => auth::error(
                StatusCode::from_u16(failure.status_code)
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                &failure.public_message,
            ),
            Err(error) => response_error(error),
        },
    };
    auth::append_cookies(&mut response, cookies);
    response
}

fn origin_allowed(headers: &HeaderMap, reachable_address: &str) -> bool {
    let Some(origin) = headers.get("origin") else {
        return true;
    };
    let Ok(origin) = origin
        .to_str()
        .ok()
        .and_then(|raw| url::Url::parse(raw).ok())
        .ok_or(())
    else {
        return false;
    };
    let reachable = url::Url::parse(reachable_address).ok();
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    reachable
        .as_ref()
        .is_some_and(|value| value.origin() == origin.origin())
        || host.is_some_and(|host| {
            origin.host_str().is_some_and(|name| {
                origin
                    .port()
                    .map_or(name.to_owned(), |port| format!("{name}:{port}"))
                    == host
            })
        })
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

#[derive(Clone, Copy)]
enum LiveFailure {
    Missing,
    Access,
    Native,
}

fn live_scope_error(error: Box<dyn Error>) -> LiveFailure {
    if error.is::<TaskFailure>() {
        LiveFailure::Missing
    } else {
        // The source websocket treats any failed fresh task/session lookup as
        // revoked access. Native read failures are classified separately.
        LiveFailure::Access
    }
}

async fn read_live(
    state: &AppState,
    user_id: &str,
    task_id: &str,
    session_id: &str,
) -> Result<(ScopedSession, Vec<Value>), LiveFailure> {
    let scoped = state
        .with_database(|database| scoped_session(database, user_id, task_id, session_id))
        .map_err(live_scope_error)?;
    let reading = scoped.clone();
    let messages = tokio::task::spawn_blocking(move || codex_history(&reading))
        .await
        .map_err(|_| LiveFailure::Native)?
        .map_err(|_| LiveFailure::Native)?;
    state
        .with_database(|database| scoped_session(database, user_id, task_id, session_id))
        .map_err(live_scope_error)?;
    Ok((scoped, messages))
}

fn live_change(previous: &[Value], next: &[Value]) -> Option<Value> {
    let previous_ids = previous
        .iter()
        .map(|message| message["id"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    let order = next
        .iter()
        .map(|message| message["id"].clone())
        .collect::<Vec<_>>();
    let changed = next
        .iter()
        .filter(|message| previous.iter().find(|old| old["id"] == message["id"]) != Some(*message))
        .cloned()
        .collect::<Vec<_>>();
    let removed = previous_ids
        .iter()
        .filter(|id| !next.iter().any(|message| message["id"] == **id))
        .map(|id| json!(id))
        .collect::<Vec<_>>();
    if changed.is_empty()
        && removed.is_empty()
        && previous
            .iter()
            .map(|message| &message["id"])
            .eq(order.iter())
    {
        None
    } else {
        Some(json!({"type":"update","messages":changed,"removedIds":removed,"order":order}))
    }
}

async fn live_socket(
    mut socket: WebSocket,
    state: AppState,
    user_id: String,
    task_id: String,
    session_id: String,
    headers: HeaderMap,
) {
    if !origin_allowed(&headers, &state.session_config.reachable_address) {
        close(&mut socket, 4403, "origin").await;
        return;
    }
    if state
        .with_database(|database| scoped_session(database, &user_id, &task_id, &session_id))
        .is_err()
    {
        close(&mut socket, 4404, "not found").await;
        return;
    }
    let mut previous = Vec::new();
    let mut snapshot = false;
    let mut recovered = false;
    let mut failures = 0u32;
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
    loop {
        tokio::select! {
            _ = state.history_shutdown.cancelled() => {
                close(&mut socket, 1012, "server closing").await;
                return;
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(_)) => { close(&mut socket, 1008, "read only").await; return; }
                }
            }
            _ = interval.tick() => {
                let observed = tokio::select! {
                    _ = state.history_shutdown.cancelled() => {
                        close(&mut socket, 1012, "server closing").await;
                        return;
                    }
                    message = socket.recv() => {
                        match message {
                            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                            Some(Ok(_)) => { close(&mut socket, 1008, "read only").await; return; }
                        }
                    }
                    observed = read_live(&state, &user_id, &task_id, &session_id) => observed,
                };
                match observed {
                    Ok((scoped, messages)) => {
                        let value = if !snapshot || recovered {
                            page(&messages, None).ok().map(|page| json!({"type":"snapshot","page":page,"order":messages.iter().map(|message| message["id"].clone()).collect::<Vec<_>>()}))
                        } else { live_change(&previous, &messages) };
                        if let Some(value) = value {
                            let payload = value.to_string();
                            if payload.len() > MAX_BUFFERED_BYTES || !matches!(tokio::time::timeout(std::time::Duration::from_secs(1), socket.send(Message::Text(payload.into()))).await, Ok(Ok(()))) {
                                close(&mut socket, 1013, "client too slow").await;
                                return;
                            }
                        }
                        previous = messages;
                        snapshot = true;
                        recovered = false;
                        failures = 0;
                        interval = tokio::time::interval(std::time::Duration::from_millis(if scoped.current {500} else {2_000}));
                        interval.tick().await;
                    }
                    Err(LiveFailure::Missing) => { close(&mut socket, 4404, if snapshot { "session removed" } else { "not found" }).await; return; }
                    Err(LiveFailure::Access) => { close(&mut socket, 4403, "access revoked").await; return; }
                    Err(LiveFailure::Native) => {
                        match state.with_database(|database| scoped_session(database, &user_id, &task_id, &session_id)).map_err(live_scope_error) {
                            Err(LiveFailure::Missing) => { close(&mut socket, 4404, if snapshot { "session removed" } else { "not found" }).await; return; }
                            Err(LiveFailure::Access) => { close(&mut socket, 4403, "access revoked").await; return; }
                            _ => {}
                        }
                        let payload = json!({"type":"error","message":"Live output is not available. Suplex will retry."}).to_string();
                        if socket.send(Message::Text(payload.into())).await.is_err() { return; }
                        recovered = true;
                        failures = failures.saturating_add(1);
                        let base = 500_u64.saturating_mul(2_u64.saturating_pow(failures.min(8)));
                        interval = tokio::time::interval(std::time::Duration::from_millis(base.min(8_000)));
                        interval.tick().await;
                    }
                }
            }
        }
    }
}

async fn live(
    State(state): State<AppState>,
    Path((task_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Err(response) = validate_params(&task_id, &session_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let mut response = upgrade.on_upgrade(move |socket| {
        live_socket(socket, state, user_id, task_id, session_id, headers)
    });
    auth::append_cookies(&mut response, cookies);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::{body::to_bytes, http::HeaderValue};
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn page_cursor_and_live_delta_follow_native_message_ids() {
        let messages = (0..45)
            .map(|index| json!({"id":format!("msg_{index}"),"text":format!("text {index}")}))
            .collect::<Vec<_>>();
        let latest = page(&messages, None).unwrap();
        assert_eq!(latest["messages"].as_array().unwrap().len(), 40);
        assert_eq!(latest["olderCursor"], "msg_5");
        let earlier = page(&messages, Some("msg_5")).unwrap();
        assert_eq!(earlier["messages"].as_array().unwrap().len(), 5);
        assert!(page(&messages, Some("missing")).is_err());
        let next = vec![messages[0].clone(), json!({"id":"msg_1","text":"changed"})];
        let change = live_change(&messages[..2], &next).unwrap();
        assert_eq!(change["messages"], json!([next[1]]));
        assert_eq!(change["removedIds"], json!([]));
        assert!(live_change(&next, &next).is_none());
    }

    #[tokio::test]
    async fn history_cursor_query_uses_public_zod_findings() {
        assert_eq!(before_query(None).unwrap(), None);
        assert_eq!(
            before_query(Some("before=msg_1&ignored=x")).unwrap(),
            Some("msg_1".into())
        );
        for (query, code) in [
            ("before=", "invalid-too_small"),
            ("before=a&before=b", "invalid-invalid_type"),
        ] {
            let response = *before_query(Some(query)).unwrap_err();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            let value: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["findings"][0]["code"], code);
            assert_eq!(value["findings"][0]["field"], ".before");
        }
        let long = format!("before={}", "a".repeat(513));
        let response = *before_query(Some(&long)).unwrap_err();
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["findings"][0]["code"], "invalid-too_big");
    }

    struct LiveClient {
        stream: tokio::net::TcpStream,
        pending: Vec<u8>,
    }

    impl LiveClient {
        async fn ensure(&mut self, size: usize) {
            while self.pending.len() < size {
                let mut chunk = [0_u8; 4096];
                let read = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    self.stream.read(&mut chunk),
                )
                .await
                .unwrap()
                .unwrap();
                assert!(read > 0, "WebSocket closed before the expected frame");
                self.pending.extend_from_slice(&chunk[..read]);
            }
        }

        async fn frame(&mut self) -> (u8, Vec<u8>) {
            self.ensure(2).await;
            let opcode = self.pending[0] & 0x0f;
            assert_eq!(self.pending[1] & 0x80, 0, "server frames are not masked");
            let (header_len, length) = match self.pending[1] & 0x7f {
                size @ 0..=125 => (2, usize::from(size)),
                126 => {
                    self.ensure(4).await;
                    (
                        4,
                        usize::from(u16::from_be_bytes([self.pending[2], self.pending[3]])),
                    )
                }
                127 => {
                    self.ensure(10).await;
                    (
                        10,
                        usize::try_from(u64::from_be_bytes(
                            self.pending[2..10].try_into().unwrap(),
                        ))
                        .unwrap(),
                    )
                }
                _ => unreachable!(),
            };
            self.ensure(header_len + length).await;
            let payload = self.pending[header_len..header_len + length].to_vec();
            self.pending.drain(..header_len + length);
            (opcode, payload)
        }

        async fn json(&mut self) -> Value {
            let (opcode, payload) = self.frame().await;
            assert_eq!(opcode, 1);
            serde_json::from_slice(&payload).unwrap()
        }
    }

    async fn open_live(
        address: std::net::SocketAddr,
        task_id: &str,
        session_id: &str,
        cookie: &str,
    ) -> (LiveClient, Value) {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!(
            "GET /api/tasks/{task_id}/sessions/{session_id}/history/live HTTP/1.1\r\nHost: {address}\r\nOrigin: http://{address}\r\nCookie: {cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0_u8; 4096];
            let read =
                tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
                    .await
                    .unwrap()
                    .unwrap();
            assert!(read > 0, "WebSocket closed before the first event");
            bytes.extend_from_slice(&chunk[..read]);
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let header_end = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert!(bytes.starts_with(b"HTTP/1.1 101"));
        let mut client = LiveClient {
            stream,
            pending: bytes.split_off(header_end),
        };
        let first = client.json().await;
        (client, first)
    }

    #[tokio::test]
    #[ignore = "requires Node and the TypeScript native-app fixture"]
    async fn same_database_history_page_and_live_snapshot_match_typescript() {
        let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut oracle = Command::new("node")
            .args([
                "node_modules/tsx/dist/cli.mjs",
                "tests/support/task-history-read-interop.ts",
            ])
            .current_dir(repository)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        let mut oracle_output = BufReader::new(oracle.stdout.take().unwrap());
        oracle_output.read_line(&mut line).unwrap();
        assert!(
            !line.is_empty(),
            "TypeScript history fixture produced no response"
        );
        let expected: Value = serde_json::from_str(&line).unwrap();
        let database = SuplexDatabase::open(
            std::path::Path::new(expected["databasePath"].as_str().unwrap()),
            OpenMode::ReadWrite,
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: address.port(),
                reachable_address: format!("http://{address}"),
                tailscale_exposure: "none".into(),
            },
        );
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, crate::http::router(server_state))
                .await
                .unwrap();
        });
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_str(&address.to_string()).unwrap());
        headers.insert(
            "cookie",
            HeaderValue::from_str(expected["cookie"].as_str().unwrap()).unwrap(),
        );
        let task_id = expected["taskId"].as_str().unwrap().to_owned();
        let session_id = expected["sessionId"].as_str().unwrap().to_owned();
        let response = history(
            State(state.clone()),
            Path((task_id.clone(), session_id.clone())),
            RawQuery(None),
            headers,
        )
        .await;
        assert_eq!(response.status().as_u16(), expected["page"]["status"]);
        assert_eq!(
            response
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            expected["page"]["cacheControl"].as_str()
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            expected["page"]["body"]
        );
        let (mut live, snapshot) = open_live(
            address,
            &task_id,
            &session_id,
            expected["cookie"].as_str().unwrap(),
        )
        .await;
        assert_eq!(snapshot, expected["live"]);
        oracle
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"advance\n")
            .unwrap();
        let mut next_line = String::new();
        oracle_output.read_line(&mut next_line).unwrap();
        let next_expected: Value = serde_json::from_str(&next_line).unwrap();
        assert_eq!(live.json().await, next_expected["update"]);
        let (mut reconnected, resumed) = open_live(
            address,
            &task_id,
            &session_id,
            expected["cookie"].as_str().unwrap(),
        )
        .await;
        assert_eq!(resumed, next_expected["reconnect"]);
        state.shutdown_history();
        for client in [&mut live, &mut reconnected] {
            let (opcode, payload) = client.frame().await;
            assert_eq!(opcode, 8);
            assert_eq!(u16::from_be_bytes(payload[..2].try_into().unwrap()), 1012);
            assert_eq!(&payload[2..], b"server closing");
        }
        server.abort();
        oracle
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"close\n")
            .unwrap();
        assert!(oracle.wait().unwrap().success());
    }
}
