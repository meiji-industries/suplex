#[cfg(test)]
mod tests {
    use serde_json::Value;
    use std::sync::Arc;

    use super::*;
    use crate::http::routes::task_pane::tests::fixture;

    fn fake_launchers() -> (Vec<Launcher>, Option<Launcher>) {
        let launcher = |id, command: &str, cwd_is_path| Launcher {
            id,
            label: "Fake",
            command: command.into(),
            args: Arc::new(|path: &str| {
                vec![
                    "-c".into(),
                    "test \"$0\" = /tmp || { echo failed >&2; exit 3; }".into(),
                    path.into(),
                ]
            }),
            cwd_is_path,
            bundle: None,
        };
        (
            vec![
                launcher("finder", "/bin/sh", false),
                launcher("terminal", "/nonexistent/suplex-terminal", true),
            ],
            Some(launcher("editor", "/bin/sh", false)),
        )
    }

    fn loopback() -> Extensions {
        let mut extensions = Extensions::new();
        extensions.insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50_000))));
        extensions
    }

    #[tokio::test]
    async fn worktree_routes_require_a_direct_loopback_peer_and_the_configured_host() {
        let fixture = fixture();
        let address = fixture.serve().await;
        let client = reqwest::Client::new();
        let apps = format!(
            "http://{address}/api/tasks/{}/worktree/apps",
            fixture.task_id
        );
        let open = format!(
            "http://{address}/api/tasks/{}/worktree/open",
            fixture.task_id
        );
        let get = |host: &'static str| {
            client
                .get(&apps)
                .header("host", host)
                .header("cookie", &fixture.cookie)
        };
        let missing = get("127.0.0.1:4113").send().await.unwrap();
        assert_eq!(missing.status(), 404);
        assert_eq!(
            missing.json::<Value>().await.unwrap(),
            json!({"error":"Worktree not found"})
        );
        let worktree = json!({"path":"/tmp","branch":"task"}).to_string();
        fixture.execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
            &[&worktree, &fixture.task_id],
        );
        let local: Value = get("127.0.0.1:4113")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(local["apps"].is_array());
        let remote: Value = get("suplex.tailnet.ts.net:4113")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(remote, json!({"error":"Remote access requires HTTPS"}));
        let forwarded: Value = get("127.0.0.1:4113")
            .header("x-forwarded-for", "127.0.0.1")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(forwarded, json!({"error":"Remote access requires HTTPS"}));
        let post = |host: &'static str, body: Value| {
            client
                .post(&open)
                .header("host", host)
                .header("origin", "http://127.0.0.1:4113")
                .header("cookie", &fixture.cookie)
                .json(&body)
                .send()
        };
        let remote = post("suplex.tailnet.ts.net:4113", json!({"app":"finder"}))
            .await
            .unwrap();
        assert_eq!(remote.status(), 403);
        assert_eq!(
            remote.json::<Value>().await.unwrap(),
            json!({"error":"Remote access requires HTTPS"})
        );
        let invalid = post("127.0.0.1:4113", json!({"app":"not-an-app"}))
            .await
            .unwrap();
        assert_eq!(invalid.status(), 400);
        assert_eq!(
            invalid.json::<Value>().await.unwrap()["findings"][0]["field"],
            ".app"
        );
        crate::http::routes::auth::tests::require_passkeys(&fixture.state);
        let anonymous = client
            .get(&apps)
            .header("host", "suplex.tailnet.ts.net:4113")
            .header("x-forwarded-host", "suplex.example.test:4111")
            .header("x-forwarded-proto", "https")
            .send()
            .await
            .unwrap();
        assert_eq!(anonymous.status(), 401);
        let _ = std::fs::remove_dir_all(&fixture.root);
    }

    #[tokio::test]
    async fn opening_runs_the_resolved_launcher_and_audits_only_successful_launches() {
        let fixture = fixture();
        let worktree = json!({"path":"/tmp","branch":"task"}).to_string();
        fixture.execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
            &[&worktree, &fixture.task_id],
        );
        let mut headers = HeaderMap::new();
        headers.insert(crate::http::session::REQUEST_CLASS_HEADER, "local".parse().unwrap());
        headers.insert("host", "127.0.0.1:4113".parse().unwrap());
        headers.insert("origin", "http://127.0.0.1:4113".parse().unwrap());
        headers.insert("cookie", fixture.cookie.parse().unwrap());
        headers.insert("content-type", "application/json".parse().unwrap());
        let open = |app: &str, extensions: Extensions| {
            open_with(
                fixture.state.clone(),
                fixture.task_id.clone(),
                headers.clone(),
                extensions,
                Bytes::from(json!({"app": app}).to_string()),
                fake_launchers,
            )
        };
        async fn body(response: Response) -> Value {
            serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 4096)
                    .await
                    .unwrap(),
            )
            .unwrap()
        }
        let audits = || {
            fixture.state.with_database(|database| {
                database
                    .connection()
                    .query_row(
                        "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'worktree_opened'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap()
            })
        };
        assert_eq!(open("ghostty", loopback()).await.status(), 501);
        assert_eq!(body(open("terminal", loopback()).await).await["ok"], false);
        assert_eq!(audits(), 0);
        assert_eq!(open("editor", Extensions::new()).await.status(), 403);
        assert_eq!(
            body(open("editor", loopback()).await).await,
            json!({"ok": true})
        );
        assert_eq!(audits(), 1);
        let _ = std::fs::remove_dir_all(&fixture.root);
    }
}
