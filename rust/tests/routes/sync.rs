#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        http::routes::task_history::tests::{LiveClient, connect},
        platform::database::SuplexDatabase,
        sync::tests::{add_task, add_turn, wait_watched},
        tasks::{artifacts::tests::fixture, repository},
    };
    use serde_json::{Value, json};
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
        loop {
            let (opcode, payload) = client.frame().await;
            if opcode == 8 {
                return u16::from_be_bytes(payload[..2].try_into().unwrap());
            }
            assert_eq!(opcode, 1);
            assert_eq!(serde_json::from_slice::<Value>(&payload).unwrap()["type"], "changes");
        }
    }

    const SYNC: &str = "/api/companies/company_media/sync";

    /// The body of an HTTP read, as the browser reads it.
    async fn rest(address: SocketAddr, path: &str) -> Value {
        let response = reqwest::get(format!("http://{address}{path}")).await.unwrap();
        assert_eq!(response.status(), 200, "{path}");
        response.json().await.unwrap()
    }

    /// The next frame of `kind`. Company list changes can arrive in between.
    async fn next_of(client: &mut LiveClient, kind: &str) -> Value {
        loop {
            let frame = client.json().await;
            if frame["type"] == kind {
                return frame;
            }
            assert_eq!(frame["type"], "changes", "{frame}");
        }
    }

    fn watch(agent_task_ids: &[&str], open_task_id: Option<&str>) -> String {
        json!({"type": "watch", "agentTaskIds": agent_task_ids, "openTaskId": open_task_id})
            .to_string()
    }

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
        // The projects are the list of `GET /api/companies/{id}/projects`.
        let projects = rest(address, "/api/companies/company_media/projects").await;
        let snapshot = client.json().await;
        assert_eq!(snapshot["type"], "snapshot");
        assert_eq!(snapshot["tasks"], json!(listed));
        assert_eq!(snapshot["moves"], json!([]));
        assert_eq!(snapshot["projects"], projects["projects"]);
        // The costs are the tasks of `GET /api/companies/{id}/task-costs`. They
        // come with the snapshot or, when their read ends later, in the next frame.
        let costs = rest(address, "/api/companies/company_media/task-costs").await;
        let priced = match snapshot.get("costs") {
            Some(_) => snapshot,
            None => client.json().await,
        };
        assert_eq!(priced["costs"], costs["tasks"]);

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
        assert!(changes.get("projects").is_none());
        assert!(changes.get("moves").is_none());

        // A project change carries every project. A move change carries every move.
        other
            .execute("UPDATE suplex_projects SET name = 'Renamed' WHERE id = 'project_media'", [])
            .unwrap();
        let renamed = client.json().await;
        assert_eq!(renamed["projects"][0]["name"], "Renamed");
        assert_eq!(
            renamed,
            json!({"type": "changes", "tasks": [], "removedTaskIds": [], "projects": rest(address, "/api/companies/company_media/projects").await["projects"]})
        );
        other.execute(
            "INSERT INTO suplex_moves (id, company_id, project_id, name, prompt, runner, profile_id, confirm, workflow, delivery_target, run_project_tests, visual_evidence, created_by_user_id, created_at, updated_at) VALUES ('move_one', 'company_media', 'project_media', 'Say hello', 'echo hello', 'script', NULL, 0, 'standard', 'pull_request_ready', 1, 'off', 'user_development', ?1, ?1)",
            [Utc::now().to_rfc3339()],
        ).unwrap();
        let moved = client.json().await;
        assert_eq!(moved["moves"][0]["name"], "Say hello");
        assert_eq!(moved["tasks"], json!([]));
        // The pushed moves are the list that `GET /api/companies/{id}/moves` returns.
        let moves = state
            .with_database(|database| crate::moves::list(database, "user_development", "company_media"))
            .unwrap();
        assert_eq!(moved["moves"], serde_json::to_value(&moves.moves).unwrap());

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
        let snapshot = late.json().await;
        assert_eq!(snapshot["tasks"], json!([]));
        assert_eq!(snapshot["moves"], moved["moves"]);
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

    #[test]
    fn a_watch_serves_an_archived_open_task_of_the_company() {
        let (directory, _, mut database, task_id) = fixture();
        let foreign = add_task(&mut database, "Foreign", vec![]);
        let stamp = Utc::now().to_rfc3339();
        let connection = database.connection();
        connection.execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_other','Other','active',?1)", [&stamp]).unwrap();
        connection
            .execute("UPDATE suplex_tasks SET company_id = 'company_other' WHERE id = ?1", [&foreign])
            .unwrap();
        connection
            .execute("UPDATE suplex_tasks SET archived_at = ?1 WHERE id = ?2", [&stamp, &task_id])
            .unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "http://127.0.0.1:4111".into(),
                tailscale_exposure: "none".into(),
            },
        );
        let start = |id: &str| {
            start_watch(&state, "user_development", "company_media", vec![id.into()], Some(id.into()))
        };
        assert!(start(&foreign).is_none());
        assert!(start("task_missing").is_none());
        // The archived task is the open task. Its agents stay out of the watch.
        let watching = start(&task_id).unwrap();
        assert_eq!(watching.open_task_id.as_deref(), Some(task_id.as_str()));
        assert!(!watching.agents);
        let served = wait_watched(&watching.receiver, |watched| watched.open.task.is_some());
        let expected = state
            .with_database(|database| repository::task_response(database, &task_id))
            .unwrap();
        assert_eq!(
            serde_json::to_value(served.open.task.as_deref()).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        assert_eq!(serde_json::to_value(served.open.task.as_deref()).unwrap()["archivedAt"], stamp);
        assert!(served.open.activity.is_some() && served.open.execution.is_some());
        drop((watching, state));
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn socket_pushes_the_watched_tasks_as_their_http_reads_show_them() {
        let (directory, path, mut database, task_id) = fixture();
        add_turn(&database, &task_id);
        let second = add_task(&mut database, "Second", vec![]);
        let foreign = add_task(&mut database, "Foreign", vec![]);
        let stamp = Utc::now().to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_other','Other','active',?1)", [&stamp]).unwrap();
        database
            .connection()
            .execute("UPDATE suplex_tasks SET company_id = 'company_other' WHERE id = ?1", [&foreign])
            .unwrap();
        let (state, address, server) = serve(database).await;
        let (_, mut client) = connect(address, SYNC, &format!("http://{address}"), "").await;
        assert_eq!(client.json().await["type"], "snapshot");

        // Ids of another company and missing ids are left out.
        client
            .send_text(&watch(&[&task_id, &foreign, "task_missing"], Some(&task_id)))
            .await;
        let agents = next_of(&mut client, "agents").await;
        let batch = rest(
            address,
            &format!("/api/companies/company_media/task-agents?taskId={task_id}"),
        )
        .await;
        assert_eq!(agents, json!({"type": "agents", "tasks": batch["tasks"]}));
        let open = next_of(&mut client, "openTask").await;
        assert_eq!(open["taskId"], task_id);
        let base = format!("/api/tasks/{task_id}");
        assert_eq!(open["task"], rest(address, &base).await);
        for value in ["activity", "execution", "timeline"] {
            assert_eq!(open[value], rest(address, &format!("{base}/{value}")).await, "{value}");
        }

        // Another process changes only a turn: the task list stays the same.
        let other = rusqlite::Connection::open(&path).unwrap();
        other.busy_timeout(Duration::from_secs(5)).unwrap();
        other
            .execute(
                "UPDATE suplex_task_turns SET status = 'completed', terminal_observation = 'Done' WHERE task_id = ?1",
                [&task_id],
            )
            .unwrap();
        let pushed = client.json().await;
        assert_eq!(pushed["type"], "openTask");
        assert_eq!(pushed["activity"]["turns"][0]["result"], "Done");
        assert_eq!(pushed["activity"], rest(address, &format!("{base}/activity")).await);
        assert!(pushed.get("execution").is_none() && pushed.get("timeline").is_none());

        // A foreign open task is ignored, and the new watch ends the old one.
        client.send_text(&watch(&[], Some(&foreign))).await;
        client.send_text(&watch(&[], Some(&second))).await;
        assert_eq!(next_of(&mut client, "openTask").await["taskId"], second);
        other
            .execute("UPDATE suplex_task_turns SET terminal_observation = 'Again' WHERE task_id = ?1", [&task_id])
            .unwrap();
        other
            .execute("UPDATE suplex_tasks SET title = 'Second renamed' WHERE id = ?1", [&second])
            .unwrap();
        let renamed = next_of(&mut client, "openTask").await;
        assert_eq!(renamed["taskId"], second);
        assert_eq!(renamed["task"]["title"], "Second renamed");

        client.send_text(r#"{"type":"watch","agentTaskIds":"not a list"}"#).await;
        assert_eq!(close_code(&mut client).await, 1008);
        server.abort();
        drop(state);
        fs::remove_dir_all(directory).unwrap();
    }
}
