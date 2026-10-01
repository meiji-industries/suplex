#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_an_admin_can_open_the_quick_shell() {
        let (state, _filename) = super::super::auth::tests::state();
        let admin = state.with_database(|database| {
            crate::identity::auth::development_sign_in(database, chrono::Utc::now()).unwrap()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::serve(
                listener,
                crate::http::router(state.clone())
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .into_future(),
        );
        let open = || {
            reqwest::Client::new()
                .get(format!("http://{address}/api/quick-shell/terminal?cols=80&rows=24"))
                .header("origin", "https://suplex.example.test:4111")
                .header("cookie", format!("sid_v1={}", admin.session_token))
                .header("connection", "upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .send()
        };
        assert_eq!(open().await.unwrap().status(), StatusCode::SWITCHING_PROTOCOLS);
        state.with_database(|database| {
            database
                .connection()
                .execute("UPDATE suplex_users SET role = 'member'", [])
                .unwrap();
        });
        assert_eq!(open().await.unwrap().status(), StatusCode::FORBIDDEN);
        server.abort();
    }
}
