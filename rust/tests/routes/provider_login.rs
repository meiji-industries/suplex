#[cfg(test)]
mod tests {
    use std::time::Duration;

    use reqwest::Method;
    use serde_json::Value;

    use super::*;
    use crate::{
        http::routes::task_pane::tests::{
            client::{Frame, connect},
            fixture,
        },
        integrations::herdr_bridge::tests::fake_terminal,
        profiles::provider_login::tests::login_herdr,
    };

    #[tokio::test]
    async fn provider_login_and_instance_routes_create_reuse_and_close_sign_in_panes() {
        let mut fixture = fixture();
        fixture.state.herdr = login_herdr().0;
        let address = fixture.serve().await;
        let client = reqwest::Client::new();
        let request = |method: Method, path: &str| {
            client
                .request(method, format!("http://{address}{path}"))
                .header("host", "127.0.0.1:4113")
                .header("origin", "http://127.0.0.1:4113")
                .header("cookie", &fixture.cookie)
        };
        let status = |response: reqwest::Response| response.status().as_u16();
        let started = request(Method::POST, "/api/admin/providers/devin/login")
            .send()
            .await
            .unwrap();
        assert_eq!(started.status(), 200);
        assert_eq!(started.headers()["cache-control"], "private, no-store");
        assert_eq!(
            started.json::<Value>().await.unwrap(),
            json!({"paneId":"pane-login-1"})
        );
        let reused: Value = request(Method::POST, "/api/admin/providers/devin/login")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reused["paneId"], "pane-login-1");
        assert_eq!(
            status(
                request(Method::POST, "/api/admin/providers/openai/login")
                    .send()
                    .await
                    .unwrap()
            ),
            400
        );
        let refused = request(Method::POST, "/api/admin/provider-instances")
            .json(&json!({"provider":"opencode","label":"No"}))
            .send()
            .await
            .unwrap();
        assert_eq!(status(refused), 422);
        let created = request(Method::POST, "/api/admin/provider-instances")
            .json(&json!({"provider":"claude-code","label":" Work "}))
            .send()
            .await
            .unwrap();
        assert_eq!(created.status(), 201);
        let instance: Value = created.json().await.unwrap();
        assert_eq!(instance["label"], "Work");
        assert!(std::path::Path::new(instance["homeDirectory"].as_str().unwrap()).is_dir());
        let id = instance["id"].as_str().unwrap();
        let login: Value = request(
            Method::POST,
            &format!("/api/admin/provider-instances/{id}/login"),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        assert_eq!(login["paneId"], "pane-login-2");
        assert_eq!(
            status(
                request(
                    Method::POST,
                    "/api/admin/provider-instances/instance_missing/login"
                )
                .send()
                .await
                .unwrap()
            ),
            404
        );
        let listed: Value = request(Method::GET, "/api/admin/provider-instances")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed["instances"][0]["id"], id);
        assert!(listed["instances"][0]["readiness"]["status"].is_string());
        assert!(listed["instances"][0]["connection"]["status"].is_string());
        assert_eq!(
            status(
                request(Method::DELETE, "/api/admin/provider-login/pane-login-1")
                    .send()
                    .await
                    .unwrap()
            ),
            404
        );
        assert_eq!(
            status(
                request(Method::DELETE, "/api/admin/provider-login/pane-login-2")
                    .send()
                    .await
                    .unwrap()
            ),
            204
        );
        assert_eq!(
            status(
                request(
                    Method::DELETE,
                    &format!("/api/admin/provider-instances/{id}")
                )
                .send()
                .await
                .unwrap()
            ),
            204
        );
        assert_eq!(
            status(
                request(
                    Method::DELETE,
                    &format!("/api/admin/provider-instances/{id}")
                )
                .send()
                .await
                .unwrap()
            ),
            404
        );
        fixture.execute("UPDATE suplex_users SET role = 'member'", &[]);
        assert_eq!(
            status(
                request(Method::POST, "/api/admin/providers/devin/login")
                    .send()
                    .await
                    .unwrap()
            ),
            403
        );
        assert_eq!(
            status(
                request(Method::GET, "/api/admin/provider-instances")
                    .send()
                    .await
                    .unwrap()
            ),
            403
        );
        let _ = std::fs::remove_dir_all(&fixture.root);
    }

    #[tokio::test]
    async fn the_sign_in_terminal_is_admin_only_and_bridges_control_input() {
        let mut fixture = fixture();
        let frame = r#"{"type":"terminal.frame","seq":1,"full":true,"width":80,"height":24,"bytes":"aGk="}"#;
        let script = fake_terminal(&fixture.root.join("herdr"), &[frame]);
        let (mut herdr, _) = login_herdr();
        herdr.binary = script.to_string_lossy().into_owned();
        fixture.state.herdr = herdr;
        let session = fixture
            .state
            .provider_logins
            .start(
                &fixture.state.herdr,
                "provider:codex",
                "codex",
                "codex login",
                "/",
            )
            .unwrap();
        let address = fixture.serve().await;
        let path = format!(
            "/api/admin/provider-login/{}/terminal?cols=100&rows=30",
            session.pane_id
        );
        let cookie = ("cookie", fixture.cookie.as_str());
        let (_, mut unknown) = connect(
            address,
            "/api/admin/provider-login/pane-unknown/terminal",
            &[cookie],
        )
        .await;
        assert_eq!(unknown.next().await, Frame::Close(4404, "not found".into()));
        let (_, mut foreign) = connect(
            address,
            &path,
            &[cookie, ("origin", "https://evil.example")],
        )
        .await;
        assert_eq!(foreign.next().await, Frame::Close(4403, "origin".into()));
        let (_, mut terminal) = connect(address, &path, &[cookie]).await;
        let Frame::Text(opened) = terminal.next().await else {
            panic!("open message")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&opened).unwrap(),
            json!({"type":"open","paneId":"pane-login-1","readOnly":false,"cols":100,"rows":30})
        );
        assert_eq!(
            terminal.next().await,
            Frame::Text(r#"{"type":"size","cols":80,"rows":24}"#.into())
        );
        assert_eq!(terminal.next().await, Frame::Binary(b"hi".to_vec()));
        terminal.send(2, b"yes\n").await;
        let stdin = fixture.root.join("herdr/stdin");
        for _ in 0..100 {
            if std::fs::read_to_string(&stdin).is_ok_and(|text| !text.is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            std::fs::read_to_string(&stdin).unwrap(),
            "{\"type\":\"terminal.input\",\"bytes\":\"eWVzCg==\"}\n"
        );
        assert!(
            fixture
                .state
                .provider_logins
                .close(&fixture.state.herdr, &session.pane_id)
        );
        assert_eq!(
            terminal.next().await,
            Frame::Close(4404, "pane closed".into())
        );
        fixture.execute("UPDATE suplex_users SET role = 'member'", &[]);
        let (_, mut member) = connect(address, &path, &[cookie]).await;
        assert_eq!(member.next().await, Frame::Close(4403, "access".into()));
        let _ = std::fs::remove_dir_all(&fixture.root);
    }
}
