#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::session;
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
