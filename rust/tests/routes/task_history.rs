#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::http::{
        contracts::typed::{agent_api::query_object, tasks::TaskHistoryQuery},
        validation::test_path,
    };

    fn before_query(query: Option<&str>) -> Result<Option<String>, Box<Response>> {
        valid::<TaskHistoryQuery>(query_object(query)).map(|query| query.before)
    }

    // The handler validates its params in an extractor; this adapter runs
    // that validation for direct calls.
    async fn history(
        state: State<AppState>,
        Path((task_id, session_id)): Path<(String, String)>,
        query: RawQuery,
        headers: HeaderMap,
    ) -> Response {
        match test_path(json!({"taskId": task_id, "sessionId": session_id})) {
            Ok(path) => super::history(state, path, query, headers).await,
            Err(response) => *response,
        }
    }
    use crate::http::session;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::{body::to_bytes, http::HeaderValue};
    use std::{
        fs,
        time::{Duration, SystemTime},
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
        let duplicate = page(
            &[
                json!({"id":"same","text":"old"}),
                json!({"id":"other","text":"other"}),
                json!({"id":"same","text":"latest"}),
            ],
            None,
        )
        .unwrap();
        assert_eq!(
            duplicate["messages"],
            json!([
                {"id":"same","text":"latest"},
                {"id":"other","text":"other"}
            ])
        );
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

    pub(crate) struct LiveClient {
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

        pub(crate) async fn frame(&mut self) -> (u8, Vec<u8>) {
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

        pub(crate) async fn json(&mut self) -> Value {
            let (opcode, payload) = self.frame().await;
            assert_eq!(opcode, 1);
            serde_json::from_slice(&payload).unwrap()
        }

        /// A short text frame. A client frame carries a mask; a zero mask leaves the text as it is.
        pub(crate) async fn send_text(&mut self, text: &str) {
            let mut frame = vec![0x81, 0x80 | u8::try_from(text.len()).unwrap(), 0, 0, 0, 0];
            frame.extend_from_slice(text.as_bytes());
            self.stream.write_all(&frame).await.unwrap();
        }
    }

    /// The first 12 bytes of the response, such as `HTTP/1.1 101`, and the socket.
    pub(crate) async fn connect(
        address: std::net::SocketAddr,
        path: &str,
        origin: &str,
        cookie: &str,
    ) -> (String, LiveClient) {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {address}\r\nOrigin: {origin}\r\nCookie: {cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
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
        let status = String::from_utf8_lossy(&bytes[..12]).into_owned();
        let client = LiveClient {
            stream,
            pending: bytes.split_off(header_end),
        };
        (status, client)
    }

    async fn open_live(
        address: std::net::SocketAddr,
        task_id: &str,
        session_id: &str,
        cookie: &str,
    ) -> (LiveClient, Value) {
        let (status, mut client) = connect(
            address,
            &format!("/api/tasks/{task_id}/sessions/{session_id}/history/live"),
            &format!("http://{address}"),
            cookie,
        )
        .await;
        assert_eq!(status, "HTTP/1.1 101");
        let first = client.json().await;
        (client, first)
    }

    #[tokio::test]
    async fn frozen_history_page_live_update_and_reconnect_match_typescript_source_revision() {
        let root =
            std::env::temp_dir().join(format!("suplex-history-parity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database_path = root.join("suplex.sqlite");
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/parity/task-history-native/database.sqlite"
            ),
            &database_path,
        )
        .unwrap();
        let expected: Value = serde_json::from_str(include_str!(
            "../../../tests/parity/task-history-native/expected.json"
        ))
        .unwrap();
        let initial = &expected[0];
        let database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let user_id: String = database
            .connection()
            .query_row("SELECT id FROM suplex_users LIMIT 1", [], |row| row.get(0))
            .unwrap();
        let token =
            crate::http::routes::auth::tests::verified_session(&database, &user_id, chrono::Utc::now()).unwrap();
        let session_id = initial["sessionId"].as_str().unwrap().to_owned();
        let runtime = crate::runtimes::task_harness::task_session_runtime_directory(
            &database_path,
            &session_id,
        )
        .unwrap();
        fs::create_dir_all(&runtime).unwrap();
        for (name, message) in [
            (
                "turn-msg_history.jsonl",
                &initial["page"]["body"]["messages"][0],
            ),
            (
                "turn-msg_second.jsonl",
                &initial["page"]["body"]["messages"][1],
            ),
        ] {
            let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/parity/task-history-native/runtime")
                .join(&session_id)
                .join(name);
            let target = runtime.join(name);
            fs::copy(source, &target).unwrap();
            let millis = message["createdAt"].as_u64().unwrap();
            fs::File::open(target)
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(millis)),
                )
                .unwrap();
        }
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
            axum::serve(listener, crate::http::router(server_state).into_make_service_with_connect_info::<std::net::SocketAddr>())
                .await
                .unwrap();
        });
        let mut headers = HeaderMap::new();
        headers.insert(crate::http::session::VERIFIED_HTTPS_HEADER, "1".parse().unwrap());
        headers.insert("host", HeaderValue::from_str(&address.to_string()).unwrap());
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={token}")).unwrap(),
        );
        let task_id = initial["taskId"].as_str().unwrap().to_owned();
        let session_id = initial["sessionId"].as_str().unwrap().to_owned();
        let response = history(
            State(state.clone()),
            Path((task_id.clone(), session_id.clone())),
            RawQuery(None),
            headers,
        )
        .await;
        assert_eq!(response.status().as_u16(), initial["page"]["status"]);
        assert_eq!(
            response
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            initial["page"]["cacheControl"].as_str()
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            initial["page"]["body"]
        );
        let (mut live, snapshot) =
            open_live(address, &task_id, &session_id, &format!("sid_v1={token}")).await;
        assert_eq!(snapshot, initial["live"]);
        let next_expected = &expected[1];
        let next_message = &next_expected["update"]["messages"][0];
        let third = runtime.join("turn-msg_third.jsonl");
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/parity/task-history-native/turn-msg_third.jsonl"
            ),
            &third,
        )
        .unwrap();
        let millis = next_message["createdAt"].as_u64().unwrap();
        fs::File::open(third)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(millis)),
            )
            .unwrap();
        assert_eq!(live.json().await, next_expected["update"]);
        let (mut reconnected, resumed) =
            open_live(address, &task_id, &session_id, &format!("sid_v1={token}")).await;
        assert_eq!(resumed, next_expected["reconnect"]);
        state.shutdown_history();
        for client in [&mut live, &mut reconnected] {
            let (opcode, payload) = client.frame().await;
            assert_eq!(opcode, 8);
            assert_eq!(u16::from_be_bytes(payload[..2].try_into().unwrap()), 1012);
            assert_eq!(&payload[2..], b"server closing");
        }
        server.abort();
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
