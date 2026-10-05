#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        http::routes::task_history::tests::{LiveClient, connect},
        platform::database::SuplexDatabase,
        tasks::{artifacts::tests::fixture, repository},
    };
    use serde_json::json;
    use std::{fs, net::SocketAddr};

    async fn serve(database: SuplexDatabase) -> (AppState, SocketAddr, tokio::task::JoinHandle<()>) {
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
        let router = crate::http::router(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (state, address, server)
    }

    async fn close_code(client: &mut LiveClient) -> u16 {
        let (opcode, payload) = client.frame().await;
        assert_eq!(opcode, 8);
        u16::from_be_bytes(payload[..2].try_into().unwrap())
    }

    const SYNC: &str = "/api/companies/company_media/sync";

    #[tokio::test]
    async fn socket_sends_the_list_then_changes_from_another_connection() {
        let (directory, path, database, task_id) = fixture();
        let (state, address, server) = serve(database).await;
        let origin = format!("http://{address}");
        let (status, mut client) = connect(address, SYNC, &origin, "").await;
        assert_eq!(status, "HTTP/1.1 101");

        // The snapshot is the list that `GET /api/companies/{id}/tasks` returns.
        let listed = state
            .with_database(|database| {
                repository::list_visible(database, "user_development", Some("company_media"), false)
            })
            .unwrap();
        assert_eq!(
            client.json().await,
            json!({"type": "snapshot", "tasks": listed})
        );

        // A raw connection stands in for another process.
        let other = rusqlite::Connection::open(&path).unwrap();
        other.busy_timeout(Duration::from_secs(5)).unwrap();
        other
            .execute("UPDATE suplex_tasks SET title = 'Renamed' WHERE id = ?1", [&task_id])
            .unwrap();
        let changes = client.json().await;
        assert_eq!(changes["type"], "changes");
        assert_eq!(changes["tasks"][0]["id"], task_id);
        assert_eq!(changes["tasks"][0]["title"], "Renamed");
        assert_eq!(changes["removedTaskIds"], json!([]));

        other
            .execute(
                "UPDATE suplex_tasks SET archived_at = ?1 WHERE id = ?2",
                [Utc::now().to_rfc3339(), task_id.clone()],
            )
            .unwrap();
        assert_eq!(
            client.json().await,
            json!({"type": "changes", "tasks": [], "removedTaskIds": [task_id]})
        );

        // A socket that connects later starts from the current list.
        let (_, mut late) = connect(address, SYNC, &origin, "").await;
        assert_eq!(late.json().await, json!({"type": "snapshot", "tasks": []}));
        late.send_text("hello").await;
        assert_eq!(close_code(&mut late).await, 1008);

        state.shutdown_history();
        assert_eq!(close_code(&mut client).await, 1012);
        server.abort();
        drop(state);
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn socket_refuses_a_foreign_origin_and_an_unknown_company() {
        let (directory, _, database, _) = fixture();
        let (state, address, server) = serve(database).await;
        let (status, mut foreign) = connect(address, SYNC, "https://attacker.example", "").await;
        assert_eq!(status, "HTTP/1.1 101");
        assert_eq!(close_code(&mut foreign).await, 4403);
        let (status, _) = connect(
            address,
            "/api/companies/company_missing/sync",
            &format!("http://{address}"),
            "",
        )
        .await;
        assert_eq!(status, "HTTP/1.1 404");
        server.abort();
        drop(state);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn socket_access_ends_with_the_session_or_the_membership() {
        let (directory, _, database, _) = fixture();
        let now = Utc::now();
        let connection = database.connection();
        connection.execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'Member', 'user_v1_member', 'member', 'active', ?1, ?1, 1)",
            [now.to_rfc3339()],
        ).unwrap();
        let join = "INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES ('member', 'company_media', ?1)";
        connection.execute(join, [now.to_rfc3339()]).unwrap();
        let token =
            crate::http::routes::auth::tests::verified_session(&database, "member", now).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "http://127.0.0.1:4111".into(),
                tailscale_exposure: "none".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(session::VERIFIED_HTTPS_HEADER, "1".parse().unwrap());
        headers.insert("cookie", format!("sid_v1={token}").parse().unwrap());
        let allowed = || still_allowed(&state, &headers, "member", "company_media");
        assert!(allowed());
        assert!(!still_allowed(&state, &headers, "user_development", "company_media"));

        state
            .with_database(|database| {
                database
                    .connection()
                    .execute("DELETE FROM suplex_memberships WHERE user_id = 'member'", [])
            })
            .unwrap();
        assert!(!allowed());
        state
            .with_database(|database| database.connection().execute(join, [now.to_rfc3339()]))
            .unwrap();
        assert!(allowed());

        state
            .with_database(|database| crate::identity::auth::sign_out(database, &token, now))
            .unwrap();
        assert!(!allowed());
        drop(state);
        fs::remove_dir_all(directory).unwrap();
    }
}
