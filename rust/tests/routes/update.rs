#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::routes::auth::tests::state;

    async fn serve(state: AppState) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = crate::http::router(state);
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        (address, server)
    }

    #[tokio::test]
    async fn update_reports_the_current_build_and_restart_needs_an_administrator() {
        let (state, filename) = state();
        crate::http::routes::auth::tests::require_remote_login(&state);
        let (address, server) = serve(state.clone()).await;
        let client = reqwest::Client::new();
        let get = |path: &str, host: Option<&str>| {
            let request = client.get(format!("http://{address}{path}"));
            match host {
                Some(host) => request.header("host", host),
                None => request
                    .header("host", "suplex.example.test:4111")
                    .header("x-forwarded-host", "suplex.example.test:4111")
                    .header("x-forwarded-proto", "https"),
            }
        };
        assert_eq!(get("/api/update", None).send().await.unwrap().status(), 401);
        let response = get("/api/update?check=1", Some("127.0.0.1:4111"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["status"], json!({"kind":"current"}));
        assert_eq!(body["canRestart"], false);
        assert_eq!(body["instanceId"], INSTANCE_ID.as_str());
        assert_eq!(
            get("/api/update?check=2", Some("127.0.0.1:4111"))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        assert_eq!(
            get("/api/update?other=1", Some("127.0.0.1:4111"))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        let restart = |cookie: &str| {
            client
                .post(format!("http://{address}/api/update/restart"))
                .header("host", "127.0.0.1:4111")
                .header("origin", "http://127.0.0.1:4111")
                .header("cookie", cookie.to_owned())
        };
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_users SET role = 'member'", [])
                .unwrap()
        });
        let member = restart(&cookie).send().await.unwrap();
        assert_eq!(member.status(), 403);
        assert_eq!(
            member.json::<Value>().await.unwrap(),
            json!({"error":"Administrator access necessary"})
        );
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_users SET role = 'admin'", [])
                .unwrap()
        });
        let admin = restart(&cookie).send().await.unwrap();
        assert_eq!(admin.status(), 503);
        assert_eq!(
            admin.json::<Value>().await.unwrap(),
            json!({"error":"Suplex update control is not available."})
        );
        server.abort();
        let _ = std::fs::remove_file(filename);
    }

    #[tokio::test]
    async fn client_lifecycle_reports_are_bounded_and_authenticated() {
        let logs = system_events::install_for_test();
        let (state, filename) = state();
        crate::http::routes::auth::tests::require_remote_login(&state);
        let (address, server) = serve(state).await;
        let client = reqwest::Client::new();
        let tab = uuid::Uuid::new_v4().to_string();
        let body = json!({"state":"startup","tabId":tab,"documentId":"22222222-2222-4222-8222-222222222222","clientTime":"2026-09-22T12:00:00.000Z","visible":true,"online":true});
        let post = |body: &Value, host: Option<&str>| {
            let request = client
                .post(format!("http://{address}/api/system/client-lifecycle"))
                .header("x-suplex-tab-id", tab.clone())
                .json(body);
            match host {
                Some(host) => request.header("host", host),
                None => request
                    .header("host", "suplex.example.test:4111")
                    .header("x-forwarded-host", "suplex.example.test:4111")
                    .header("x-forwarded-proto", "https"),
            }
        };
        assert_eq!(post(&body, None).send().await.unwrap().status(), 401);
        let mut extra = body.clone();
        extra["url"] = json!("https://private.example/secret");
        assert_eq!(
            post(&extra, Some("127.0.0.1:4111"))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        assert_eq!(
            post(&body, Some("127.0.0.1:4111"))
                .send()
                .await
                .unwrap()
                .status(),
            204
        );
        let log = std::fs::read_to_string(logs.join("system.log")).unwrap();
        let record: Value = log
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|record| record["tabId"] == tab.as_str())
            .unwrap();
        assert_eq!(record["type"], "client_lifecycle");
        assert_eq!(record["source"], "http");
        assert_eq!(record["clientId"], tab.as_str());
        server.abort();
        let _ = std::fs::remove_file(filename);
    }
}
