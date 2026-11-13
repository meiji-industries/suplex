#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::validation::test_path;
    use axum::{extract::Path, http::StatusCode};
    use serde_json::json;

    // The handlers validate the task id in an extractor; these adapters run
    // that validation for direct calls.
    macro_rules! task_path {
        ($($name:ident),*) => {$(
            async fn $name(state: State<AppState>, Path(id): Path<String>, headers: HeaderMap) -> Response {
                match test_path(json!({"taskId": id})) {
                    Ok(path) => super::$name(state, path, headers).await,
                    Err(response) => *response,
                }
            }
        )*};
    }

    task_path!(activity, execution, diff_summary, diff, setup_log);
    use crate::http::session;
    use crate::{
        platform::database::{OpenMode, SuplexDatabase},
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use axum::{body::to_bytes, http::HeaderValue};
    use chrono::Utc;
    use std::{fs, process::Command};
    use crate::integrations::github_delivery::failure;

    fn git(args: &[&str], cwd: &std::path::Path) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[tokio::test]
    async fn task_detail_reads_follow_live_scope_and_saved_native_intent() {
        let root = std::env::temp_dir().join(format!("suplex-ui-reads-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let database_path = root.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = crate::http::routes::auth::tests::verified_sign_in(&mut database, now).unwrap();
        let stamp = now.to_rfc3339();
        database.connection().execute(
            "INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('read_company','Read','active',?1)",
            [&stamp],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('read_project','read_company','Read','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker',?1,?1)",
            [&stamp],
        ).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "read_company".into(), project_id: "read_project".into(),
            title: "Read the native task".into(), description: "Inspect activity".into(),
            configuration: json!({"branch":"task-reads","baseBranch":"main"}),
            idempotency_key: "reads-1".into(), request_hash: "reads-hash".into(),
            creator: TaskCreator::User(admin.user.id.clone()), delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-reads","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(json!({"profileId":"profile_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        }, now).unwrap().task;
        let root_session = root_session_store::reserve_root(&mut database, &task.id, now).unwrap();
        root_session_store::ensure_initial_prompt(&mut database, &root_session, "Inspect", now)
            .unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "https://suplex.example.test:4113".into(),
                tailscale_exposure: "serve".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            crate::http::session::VERIFIED_HTTPS_HEADER,
            "1".parse().unwrap(),
        );
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4113"));
        assert_eq!(
            activity(State(state.clone()), Path("".into()), headers.clone())
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            activity(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let empty_diff = diff(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(empty_diff.status(), StatusCode::OK);
        assert_eq!(empty_diff.headers()[CACHE_CONTROL], "private, no-store");
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(empty_diff.into_body(), usize::MAX).await.unwrap()
            )
            .unwrap(),
            json!({"available":false,"patch":"","truncated":false})
        );
        let preparation =
            crate::tasks::preparation::task_preparation_directory(&database_path, &task.id)
                .unwrap();
        fs::create_dir_all(&preparation).unwrap();
        fs::write(preparation.join("setup.log"), "setup error output").unwrap();
        fs::write(
            preparation.join("setup-result.json"),
            r#"{"state":"failed","exitStatus":"7"}"#,
        )
        .unwrap();
        let setup_response =
            setup_log(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(setup_response.status(), StatusCode::OK);
        let setup_document: Value = serde_json::from_slice(
            &to_bytes(setup_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(setup_document["output"], "setup error output");
        assert_eq!(setup_document["setup"]["exitStatus"], "7");
        let activity_response =
            activity(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(activity_response.status(), StatusCode::OK);
        assert_eq!(
            activity_response.headers()[CACHE_CONTROL],
            "private, no-store"
        );
        let body = to_bytes(activity_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let document: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            document["setup"],
            json!({"state":"failed","exitStatus":"7"})
        );
        let agents = state.with_database(|database| {
            super::super::task_agents::saved_task(database, &task.id).unwrap()
        });
        assert_eq!(
            super::super::task_agents::agents(&agents, &database_path, false)
                .await
                .unwrap()
                .setup
                .state,
            crate::tasks::preparation::SetupState::Failed
        );
        assert_eq!(document["sessions"][0]["id"], root_session.id);
        assert_eq!(document["sessions"][0]["profileId"], "profile_root");
        assert_eq!(document["sessions"][0]["harness"], "codex");
        assert_eq!(document["sessions"][0]["nativeSessionId"], Value::Null);
        assert_eq!(document["turns"][0]["prompt"], "Inspect");
        assert_eq!(document["shellPaneId"], Value::Null);
        for (provider, pane) in [
            ("opencode", None),
            ("claude-code", Some("stale-claude")),
            ("codex", None),
            ("devin", Some("stale-devin")),
        ] {
            state.with_database(|database| {
                database.connection().execute("UPDATE suplex_task_sessions SET profile_json=json_set((SELECT root_profile_json FROM suplex_task_controls WHERE task_id=suplex_task_sessions.task_id),'$.provider',?1),pane_id=?2 WHERE id=?3", rusqlite::params![provider,pane,root_session.id]).unwrap();
                database.connection().execute("UPDATE suplex_task_controls SET root_profile_json=json_set(root_profile_json,'$.provider','opencode') WHERE task_id=?1", [&task.id]).unwrap();
            });
            let response =
                activity(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
            let value: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(value["sessions"][0]["harness"], provider);
            assert_eq!(value["sessions"][0]["paneId"], json!(pane));
        }
        state.with_database(|database| {
            database.connection().execute("UPDATE suplex_task_turns SET status='completed',prompted_at='2026-09-21T10:00:00.000Z',completed_at='2026-09-21T10:05:23.000Z' WHERE task_id=?1", [&task.id]).unwrap();
            database.connection().execute("INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) SELECT 'pending-turn',task_id,session_id,generation,'pending','Pending','pending_prompt',created_at,updated_at FROM suplex_task_turns WHERE task_id=?1 LIMIT 1", [&task.id]).unwrap();
        });
        let response = activity(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        let turns = value["turns"].as_array().unwrap();
        let completed = turns
            .iter()
            .find(|turn| turn["id"] != "pending-turn")
            .unwrap();
        let pending = turns
            .iter()
            .find(|turn| turn["id"] == "pending-turn")
            .unwrap();
        assert_eq!(completed["promptedAt"], "2026-09-21T10:00:00.000Z");
        assert_eq!(completed["completedAt"], "2026-09-21T10:05:23.000Z");
        assert_eq!(pending["promptedAt"], Value::Null);
        assert_eq!(pending["completedAt"], Value::Null);

        let execution_response =
            execution(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(execution_response.status(), StatusCode::OK);
        let body = to_bytes(execution_response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"sessions":[]})
        );
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_sessions SET native_session_id='ses_missing' WHERE id=?1",
                    [&root_session.id],
                )
                .unwrap();
        });
        let saved_intent = || {
            state.with_database(|database| {
            let connection = database.connection();
            let controls: String = connection.query_row("SELECT status || ':' || updated_at FROM suplex_task_controls WHERE task_id=?1", [&task.id], |row| row.get(0)).unwrap();
            let turns: i64 = connection.query_row("SELECT count(*) FROM suplex_task_turns WHERE task_id=?1", [&task.id], |row| row.get(0)).unwrap();
            (controls, turns)
        })
        };
        let before = saved_intent();
        let response =
            execution(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let unavailable: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(unavailable["sessions"][0]["available"], false);
        assert_eq!(unavailable["sessions"][0]["plan"], Value::Null);
        assert_eq!(unavailable["sessions"][0]["tools"], json!([]));
        assert_eq!(saved_intent(), before);
        let diff_response =
            diff_summary(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(diff_response.status(), StatusCode::OK);
        let body = to_bytes(diff_response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"available":false,"files":0})
        );
        let bare = root.join("origin.git");
        let local = root.join("repository");
        let publisher = root.join("publisher");
        git(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ],
            &root,
        );
        git(
            &[
                "init",
                "--quiet",
                "--initial-branch=main",
                local.to_str().unwrap(),
            ],
            &root,
        );
        git(&["config", "user.name", "Probe"], &local);
        git(&["config", "user.email", "probe@example.invalid"], &local);
        fs::write(local.join("README.md"), "Before\n").unwrap();
        git(&["add", "README.md"], &local);
        git(&["commit", "--quiet", "-m", "Base"], &local);
        let base = git(&["rev-parse", "HEAD"], &local);
        git(&["remote", "add", "origin", bare.to_str().unwrap()], &local);
        git(&["push", "--quiet", "origin", "main"], &local);
        git(&["checkout", "--quiet", "-b", "task-change"], &local);
        fs::write(local.join("task.txt"), "Task change\n").unwrap();
        git(&["add", "task.txt"], &local);
        git(&["commit", "--quiet", "-m", "Task"], &local);
        fs::write(local.join("README.md"), "Staged\n").unwrap();
        git(&["add", "README.md"], &local);
        fs::write(local.join("README.md"), "Staged\nUnstaged\n").unwrap();
        fs::write(local.join("NEW.md"), "Untracked\n").unwrap();
        git(
            &[
                "clone",
                "--quiet",
                bare.to_str().unwrap(),
                publisher.to_str().unwrap(),
            ],
            &root,
        );
        git(&["config", "user.name", "Publisher"], &publisher);
        git(
            &["config", "user.email", "publisher@example.invalid"],
            &publisher,
        );
        fs::write(publisher.join("published.txt"), "Published base\n").unwrap();
        git(&["add", "published.txt"], &publisher);
        git(&["commit", "--quiet", "-m", "Published"], &publisher);
        git(&["push", "--quiet", "origin", "main"], &publisher);
        let published = git(&["rev-parse", "HEAD"], &publisher);
        let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", api.local_addr().unwrap());
        let published_for_api = published.clone();
        let api_task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let Ok((mut socket, _)) = api.accept().await else {
                    break;
                };
                let mut request = [0_u8; 8192];
                let bytes = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..bytes]);
                let body = if request.starts_with("GET /repos/acme/demo/branches/main ") {
                    format!("{{\"commit\":{{\"sha\":\"{published_for_api}\"}}}}")
                } else {
                    "{\"message\":\"Not Found\"}".to_owned()
                };
                let status = if request.starts_with("GET /repos/acme/demo/branches/main ") {
                    "200 OK"
                } else {
                    "404 Not Found"
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let access = || Access::for_api(&api_url, None).unwrap();
        assert!(
            git2::Repository::open(&local)
                .unwrap()
                .find_commit(git2::Oid::from_str(&published).unwrap())
                .is_err()
        );
        let rewrite = format!("url.file://{}.insteadOf", bare.display());
        git(
            &[
                "config",
                "--local",
                &rewrite,
                "https://github.com/acme/demo.git",
            ],
            &local,
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json,'$.repository','acme/demo','$.baseBranch','main','$.baselineSha',?1) WHERE id = ?2",
                rusqlite::params!["0".repeat(40), task.id],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
                rusqlite::params![json!({"path":local,"branch":"saved-branch","baseSha":"f".repeat(40),"headSha":"f".repeat(40),"dirty":false}).to_string(), task.id],
            ).unwrap();
        });
        let summary = diff_summary_with_access(
            state.clone(),
            task.id.clone(),
            headers.clone(),
            Some(access()),
        )
        .await;
        assert_eq!(summary.status(), StatusCode::OK);
        let body = to_bytes(summary.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"available":true,"files":2})
        );
        assert!(
            git2::Repository::open(&local)
                .unwrap()
                .find_commit(git2::Oid::from_str(&published).unwrap())
                .is_ok()
        );
        git(&["update-ref", "refs/remotes/origin/main", &base], &local);
        git(&["add", "NEW.md"], &local);
        let summary = diff_summary_with_access(
            state.clone(),
            task.id.clone(),
            headers.clone(),
            Some(access()),
        )
        .await;
        assert_eq!(summary.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(summary.into_body(), usize::MAX).await.unwrap()
            )
            .unwrap(),
            json!({"available":true,"files":3})
        );
        let wrong = root.join("unrelated.git");
        git(
            &["init", "--quiet", "--bare", wrong.to_str().unwrap()],
            &root,
        );
        git(
            &["remote", "set-url", "origin", wrong.to_str().unwrap()],
            &local,
        );
        git(&["update-ref", "-d", "refs/remotes/origin/main"], &local);
        assert!(
            git2::Repository::open(&local)
                .unwrap()
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
        let summary = diff_summary_with_access(
            state.clone(),
            task.id.clone(),
            headers.clone(),
            Some(access()),
        )
        .await;
        assert_eq!(summary.status(), StatusCode::OK);
        let summary_body = to_bytes(summary.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&summary_body).unwrap(),
            json!({"available":true,"files":3})
        );
        fs::write(
            local.join("README.md"),
            format!("password=fixture\n{}", "Large diff é\n".repeat(2000)),
        )
        .unwrap();
        fs::write(local.join("UNTRACKED.md"), "Not in the patch\n").unwrap();
        git(&["config", "diff.context", "5"], &local);
        let patch_response = read_diff(
            state.clone(),
            task.id.clone(),
            headers.clone(),
            Some(access()),
            DiffKind::Patch,
        )
        .await;
        assert_eq!(patch_response.status(), StatusCode::OK);
        assert_eq!(patch_response.headers()[CACHE_CONTROL], "private, no-store");
        let patch_body = to_bytes(patch_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let patch: Value = serde_json::from_slice(&patch_body).unwrap();
        assert_eq!(patch["available"], true);
        assert_eq!(patch["truncated"], false);
        assert!(patch["patch"].as_str().unwrap().len() > 8192);
        assert!(patch["patch"].as_str().unwrap().contains("[REDACTED]"));
        assert!(!patch["patch"].as_str().unwrap().contains("UNTRACKED.md"));
        let merge_base = git(&["merge-base", &published, "HEAD"], &local);
        let source = Command::new("git")
            .args([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                &merge_base,
                "--",
            ])
            .current_dir(&local)
            .output()
            .unwrap();
        assert!(source.status.success());
        let expected_patch =
            crate::platform::redaction::command_output(&String::from_utf8(source.stdout).unwrap());
        let expected_body =
            serde_json::to_vec(&json!({"available":true,"patch":expected_patch,"truncated":false}))
                .unwrap();
        if patch_body.as_ref() != expected_body.as_slice() {
            let offset = patch_body
                .iter()
                .zip(&expected_body)
                .position(|(left, right)| left != right)
                .unwrap_or(patch_body.len().min(expected_body.len()));
            panic!(
                "raw diff response differs at byte {offset}: actual {} bytes, expected {} bytes; actual {:?}, expected {:?}",
                patch_body.len(),
                expected_body.len(),
                &patch_body[offset.saturating_sub(80)..patch_body.len().min(offset + 160)],
                &expected_body[offset.saturating_sub(80)..expected_body.len().min(offset + 160)]
            );
        }
        assert_eq!(
            summary_body.as_ref(),
            include_bytes!("../../../../tests/parity/task-diff-native/summary.json")
        );
        git(&["restore", "--staged", "--worktree", "README.md"], &local);
        git(&["mv", "README.md", "MOVED.md"], &local);
        git(&["config", "diff.renames", "false"], &local);
        let source_files = git(
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--name-only",
                &base,
                "--",
            ],
            &local,
        )
        .lines()
        .count();
        assert_eq!(source_files, 4);
        let summary = diff_summary_with_access(
            state.clone(),
            task.id.clone(),
            headers.clone(),
            Some(access()),
        )
        .await;
        assert_eq!(summary.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(summary.into_body(), usize::MAX).await.unwrap()
            )
            .unwrap(),
            json!({"available":true,"files":source_files})
        );
        for rename_setting in ["false", "true"] {
            git(&["config", "diff.renames", rename_setting], &local);
            let source = Command::new("git")
                .args([
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    &base,
                    "--",
                ])
                .current_dir(&local)
                .output()
                .unwrap();
            assert!(source.status.success());
            let expected_patch = crate::platform::redaction::command_output(
                &String::from_utf8(source.stdout).unwrap(),
            );
            let response = read_diff(
                state.clone(),
                task.id.clone(),
                headers.clone(),
                Some(access()),
                DiffKind::Patch,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                serde_json::from_slice::<Value>(
                    &to_bytes(response.into_body(), usize::MAX).await.unwrap()
                )
                .unwrap(),
                json!({"available":true,"patch":expected_patch,"truncated":false}),
                "diff.renames={rename_setting}",
            );
        }
        fs::write(local.join("MOVED.md"), "No final newline").unwrap();
        fs::write(local.join("task.txt"), b"\0binary payload\n").unwrap();
        let mode = fs::metadata(local.join("task.txt")).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            local.join("task.txt"),
            fs::Permissions::from_mode(mode.mode() | 0o111),
        )
        .unwrap();
        let source = Command::new("git")
            .args([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                &base,
                "--",
            ])
            .current_dir(&local)
            .output()
            .unwrap();
        assert!(source.status.success());
        let response = read_diff(
            state.clone(),
            task.id.clone(),
            headers.clone(),
            Some(access()),
            DiffKind::Patch,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(response.into_body(), usize::MAX).await.unwrap()
            )
            .unwrap(),
            json!({"available":true,"patch":crate::platform::redaction::command_output(&String::from_utf8(source.stdout).unwrap()),"truncated":false}),
            "binary, mode, and no-final-newline patch",
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json,'$.baseBranch','missing') WHERE id = ?1",
                [&task.id],
            ).unwrap();
        });
        let missing_base = diff_summary_with_access(
            state.clone(),
            task.id.clone(),
            headers.clone(),
            Some(access()),
        )
        .await;
        assert_eq!(missing_base.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &to_bytes(missing_base.into_body(), usize::MAX).await.unwrap()
            )
            .unwrap(),
            json!({"available":false,"files":0})
        );
        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json,'$.baseBranch','main') WHERE id = ?1",
                [&task.id],
            ).unwrap();
        });
        let member_hash = crate::shared::hash::sha256_hex(b"read_member_token");
        state.with_database(|database| {
            let connection = database.connection();
            connection.execute(
                "INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES ('read_member','Member','user_v1_read_member','member','active',?1,?1,1)",
                [&stamp],
            ).unwrap();
            connection.execute(
                "INSERT INTO suplex_memberships (user_id,company_id,created_at) VALUES ('read_member','read_company',?1)",
                [&stamp],
            ).unwrap();
            connection.execute(
                "INSERT INTO suplex_sessions (id,token_hash,user_id,expires_at,created_at,token_version) VALUES ('read_member_session',?1,'read_member',?2,?3,1)",
                rusqlite::params![member_hash, (now + chrono::Duration::days(1)).to_rfc3339(), stamp],
            ).unwrap();
            connection.execute(
                "UPDATE suplex_task_sessions SET pane_id = 'stale-pane' WHERE id = ?1",
                [&root_session.id],
            ).unwrap();
        });
        state.with_database(|db| {
            db.connection().execute("INSERT INTO suplex_account_users (user_id, account_id, email) VALUES ('read_member', 'test_verified_account', 'read_member@example.com')", []).unwrap();
            db.connection().execute("INSERT INTO suplex_account_sessions (token_hash, account_id) VALUES (?1, 'test_verified_account')", [crate::shared::hash::sha256_hex("read_member_token")]).unwrap();
        });
        headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=read_member_token"),
        );
        assert_eq!(
            activity(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        state.with_database(|database| {
            database.connection().execute(
                "DELETE FROM suplex_memberships WHERE user_id = 'read_member' AND company_id = 'read_company'",
                [],
            ).unwrap();
        });
        assert_eq!(
            activity(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            diff_summary(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            diff(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            execution(State(state.clone()), Path(task.id), headers)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        api_task.abort();
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn diff_summary_is_unavailable_when_git_or_github_cannot_report_it() {
        let logs = crate::platform::system_events::install_for_test();
        let root = std::env::temp_dir().join(format!("suplex-diff-unobservable-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mut database =
            SuplexDatabase::open(&root.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = crate::http::routes::auth::tests::verified_sign_in(&mut database, now).unwrap();
        let stamp = now.to_rfc3339();
        database.connection().execute(
            "INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('diff_company','Diff','active',?1)",
            [&stamp],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('diff_project','diff_company','Diff','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker',?1,?1)",
            [&stamp],
        ).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "diff_company".into(), project_id: "diff_project".into(),
            title: "Observe the diff".into(), description: "Count changed files".into(),
            configuration: json!({"branch":"task-diff","baseBranch":"main","repository":"acme/demo"}),
            idempotency_key: "diff-1".into(), request_hash: "diff-hash".into(),
            creator: TaskCreator::User(admin.user.id.clone()), delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"acme/demo","headBranch":"task-diff","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(json!({"profileId":"profile_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        }, now).unwrap().task;
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "https://suplex.example.test:4113".into(),
                tailscale_exposure: "serve".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            crate::http::session::VERIFIED_HTTPS_HEADER,
            "1".parse().unwrap(),
        );
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4113"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );

        // The published repository. Its main branch is the authority for the base.
        let source = root.join("source");
        git(&["init", "--quiet", "--initial-branch=main", source.to_str().unwrap()], &root);
        git(&["config", "user.name", "Probe"], &source);
        git(&["config", "user.email", "probe@example.invalid"], &source);
        fs::write(source.join("README.md"), "Base\n").unwrap();
        git(&["add", "README.md"], &source);
        git(&["commit", "--quiet", "-m", "Base"], &source);
        let published = git(&["rev-parse", "HEAD"], &source);
        let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", api.local_addr().unwrap());
        let published_for_api = published.clone();
        let api_task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let Ok((mut socket, _)) = api.accept().await else {
                    break;
                };
                let mut request = [0_u8; 8192];
                let bytes = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..bytes]);
                let (status, body) = if request.starts_with("GET /repos/acme/demo/branches/main ") {
                    ("200 OK", format!("{{\"commit\":{{\"sha\":\"{published_for_api}\"}}}}"))
                } else {
                    ("404 Not Found", "{\"message\":\"Not Found\"}".to_owned())
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let set_worktree = |path: &std::path::Path, base_branch: &str| {
            state.with_database(|database| {
                database.connection().execute(
                    "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json,'$.baseBranch',?1) WHERE id = ?2",
                    rusqlite::params![base_branch, task.id],
                ).unwrap();
                database.connection().execute(
                    "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
                    rusqlite::params![json!({"path":path,"branch":"task-diff","baseSha":"f".repeat(40),"headSha":"f".repeat(40),"dirty":false}).to_string(), task.id],
                ).unwrap();
            });
        };
        let read = |kind: DiffKind| {
            read_diff(
                state.clone(),
                task.id.clone(),
                headers.clone(),
                Some(Access::for_api(&api_url, None).unwrap()),
                kind,
            )
        };
        async fn body(response: Response) -> (StatusCode, Value) {
            let status = response.status();
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap())
        }
        let unavailable = (StatusCode::OK, json!({"available":false,"files":0}));

        // An observable worktree reports its changed files.
        let worktree = root.join("worktree");
        git(&["clone", "--quiet", source.to_str().unwrap(), worktree.to_str().unwrap()], &root);
        fs::write(worktree.join("README.md"), "Changed\n").unwrap();
        set_worktree(&worktree, "main");
        assert_eq!(
            body(read(DiffKind::Summary).await).await,
            (StatusCode::OK, json!({"available":true,"files":1}))
        );

        // GitHub cannot read the configured base branch.
        set_worktree(&worktree, "renamed-base");
        let response = read(DiffKind::Summary).await;
        assert_eq!(response.headers()[CACHE_CONTROL], "private, no-store");
        assert_eq!(body(response).await, unavailable);
        // The patch response is unchanged.
        assert_eq!(
            read(DiffKind::Patch).await.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );

        // The saved worktree directory no longer exists.
        set_worktree(&root.join("removed-worktree"), "main");
        assert_eq!(body(read(DiffKind::Summary).await).await, unavailable);

        // The saved worktree path is not a Git repository.
        let plain = root.join("plain");
        fs::create_dir(&plain).unwrap();
        set_worktree(&plain, "main");
        assert_eq!(body(read(DiffKind::Summary).await).await, unavailable);

        // The published commit is absent and the repository has no origin to fetch it from.
        let no_origin = root.join("no-origin");
        git(&["init", "--quiet", "--initial-branch=main", no_origin.to_str().unwrap()], &root);
        set_worktree(&no_origin, "main");
        assert_eq!(body(read(DiffKind::Summary).await).await, unavailable);

        // HEAD is unborn although the published commit is present.
        let unborn = root.join("unborn");
        git(&["init", "--quiet", "--initial-branch=main", unborn.to_str().unwrap()], &root);
        git(&["fetch", "--quiet", source.to_str().unwrap(), "main"], &unborn);
        set_worktree(&unborn, "main");
        assert_eq!(body(read(DiffKind::Summary).await).await, unavailable);

        // The worktree history shares no merge base with the published commit.
        let unrelated = root.join("unrelated");
        git(&["init", "--quiet", "--initial-branch=main", unrelated.to_str().unwrap()], &root);
        git(&["config", "user.name", "Probe"], &unrelated);
        git(&["config", "user.email", "probe@example.invalid"], &unrelated);
        fs::write(unrelated.join("OTHER.md"), "Other\n").unwrap();
        git(&["add", "OTHER.md"], &unrelated);
        git(&["commit", "--quiet", "-m", "Other"], &unrelated);
        git(&["fetch", "--quiet", source.to_str().unwrap(), "main"], &unrelated);
        set_worktree(&unrelated, "main");
        assert_eq!(body(read(DiffKind::Summary).await).await, unavailable);

        // The reason is in the host log, not in the response.
        let logged = fs::read_dir(&logs)
            .unwrap()
            .filter_map(|entry| fs::read_to_string(entry.unwrap().path()).ok())
            .collect::<String>();
        let reasons = logged
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|event| event["type"] == "task_diff" && event["taskId"] == task.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(reasons.len(), 6, "{reasons:?}");
        assert!(reasons.iter().all(|event| event["state"] == "unavailable"
            && !event["reason"].as_str().unwrap().is_empty()));

        // Authorization still applies, and an unknown task keeps its status.
        assert_eq!(
            diff_summary(State(state.clone()), Path(repository::new_task_id()), headers.clone())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        headers.remove("cookie");
        assert_eq!(
            diff_summary(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        api_task.abort();
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    /// A fake GitHub API that answers every request with one reply.
    async fn fake_github(status: &'static str, body: Value) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", api.local_addr().unwrap());
        let body = body.to_string();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = api.accept().await else {
                    break;
                };
                // Read the whole request before the reply closes the connection.
                let mut request = Vec::new();
                let mut chunk = [0_u8; 8192];
                loop {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    request.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&request);
                    let complete = text.find("\r\n\r\n").is_some_and(|end| {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        request.len() >= end + 4 + length
                    });
                    if read == 0 || complete {
                        break;
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (url, task)
    }

    #[tokio::test]
    async fn checks_are_unavailable_when_github_cannot_report_them() {
        let logs = crate::platform::system_events::install_for_test();
        let root = std::env::temp_dir().join(format!("suplex-checks-unobservable-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mut database =
            SuplexDatabase::open(&root.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = crate::http::routes::auth::tests::verified_sign_in(&mut database, now).unwrap();
        let stamp = now.to_rfc3339();
        database.connection().execute(
            "INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('checks_company','Checks','active',?1)",
            [&stamp],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('checks_project','checks_company','Checks','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker',?1,?1)",
            [&stamp],
        ).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "checks_company".into(), project_id: "checks_project".into(),
            title: "Observe the checks".into(), description: "Read check runs".into(),
            configuration: json!({"branch":"task-checks","baseBranch":"main","repository":"acme/demo"}),
            idempotency_key: "checks-1".into(), request_hash: "checks-hash".into(),
            creator: TaskCreator::User(admin.user.id.clone()), delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"acme/demo","headBranch":"task-checks","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(json!({"profileId":"profile_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        }, now).unwrap().task;
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "https://suplex.example.test:4113".into(),
                tailscale_exposure: "serve".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            crate::http::session::VERIFIED_HTTPS_HEADER,
            "1".parse().unwrap(),
        );
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4113"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let github = |url: &str| {
            let mut github = Github::new(Access::for_api(url, None).unwrap());
            github.retry_pauses.clear();
            github
        };
        async fn body(response: Response) -> (StatusCode, Value) {
            let status = response.status();
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap())
        }
        let unavailable = (StatusCode::OK, json!({"available":false,"runs":[]}));
        let (failing_url, failing_api) = fake_github(
            "502 Bad Gateway",
            json!({"message":"Server Error"}),
        )
        .await;
        let (observed_url, observed_api) = fake_github("200 OK", json!({"data":{"repository":{"pullRequest":{
            "number": 7, "url": "https://github.com/acme/demo/pull/7", "state": "OPEN", "isDraft": false,
            "headRefOid": "a".repeat(40), "baseRefOid": "b".repeat(40), "mergeable": null,
            "autoMergeRequest": null, "reviewDecision": null, "author": {"login": "octo"},
            "changedFiles": 1, "additions": 1, "deletions": 0,
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": [
                {"name": "unit", "status": "COMPLETED", "conclusion": "SUCCESS", "completedAt": "2026-09-02T00:00:00Z"}
            ]}}}}]}
        }}}}))
        .await;

        // A task without a pull request has no checks.
        let response = checks_with_github(
            state.clone(),
            task.id.clone(),
            headers.clone(),
            Some(Err(failure("authentication-required", "unused"))),
        )
        .await;
        assert_eq!(response.headers()[CACHE_CONTROL], "private, no-store");
        assert_eq!(body(response).await, unavailable);

        state.with_database(|database| {
            database.connection().execute(
                "UPDATE suplex_task_controls SET pull_request_json = ?1 WHERE task_id = ?2",
                rusqlite::params![json!({"repository":"acme/demo","number":7,"url":"https://github.com/acme/demo/pull/7","headSha":"a".repeat(40),"state":"open","mergedAt":null}).to_string(), task.id],
            ).unwrap();
        });
        let read = |github: Option<GithubResult<Github>>| {
            checks_with_github(state.clone(), task.id.clone(), headers.clone(), github)
        };

        // GitHub reports the pull request and its checks.
        let (status, observed) = body(read(Some(Ok(github(&observed_url)))).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(observed["available"], true);
        assert_eq!(observed["pullRequestState"], "ready");
        assert_eq!(observed["runs"].as_array().unwrap().len(), 1);
        assert_eq!(observed["runs"][0]["name"], "unit");
        assert_eq!(observed["runs"][0]["status"], "successful");
        assert_eq!(observed["mergeBlocks"], json!([]));

        // GitHub blocks the merge for a branch rule: the view names it.
        let (blocked, blocked_api, _) =
            crate::integrations::github_delivery::tests::counted_fake_api(
                vec![
                    ("/repos/acme/demo/branches/main/protection", 200, json!({"required_signatures": {"enabled": true}})),
                    ("/repos/acme/demo/rules/branches/main", 200, json!([])),
                    ("/repos/acme/demo/pulls/7/commits?per_page=100&page=1", 200, json!([{"sha": format!("abc1234{}", "0".repeat(33)), "commit": {"verification": {"verified": false, "reason": "unsigned"}}}])),
                ],
                vec![("reviewRequests", json!({"data":{"repository":{"pullRequest":{
                    "number": 7, "url": "https://github.com/acme/demo/pull/7", "state": "OPEN", "isDraft": false,
                    "headRefOid": "a".repeat(40), "baseRefOid": "b".repeat(40), "baseRefName": "main",
                    "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED",
                    "autoMergeRequest": null, "reviewDecision": null, "author": {"login": "octo"},
                    "changedFiles": 1, "additions": 1, "deletions": 0,
                    "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": [
                        {"name": "unit", "status": "COMPLETED", "conclusion": "SUCCESS", "completedAt": "2026-09-02T00:00:00Z"}
                    ]}}}}]}
                }}}}))],
            )
            .await;
        let (_, observed) = body(read(Some(Ok(blocked))).await).await;
        assert_eq!(
            observed["mergeBlocks"],
            json!(["Branch `main` requires signed commits and 1 commit is unsigned (abc1234)."])
        );
        blocked_api.abort();

        // The GitHub credential cannot be loaded.
        let response = read(Some(Err(failure(
            "authentication-required",
            "GitHub CLI authentication is unavailable: not logged in",
        ))))
        .await;
        assert_eq!(response.headers()[CACHE_CONTROL], "private, no-store");
        assert_eq!(body(response).await, unavailable);

        // GitHub fails to observe the pull request.
        let response = read(Some(Ok(github(&failing_url)))).await;
        assert_eq!(response.headers()[CACHE_CONTROL], "private, no-store");
        assert_eq!(body(response).await, unavailable);

        // GitHub cannot be reached.
        assert_eq!(
            body(read(Some(Ok(github("http://127.0.0.1:1")))).await).await,
            unavailable
        );

        // The reason is in the host log, not in the response.
        let logged = fs::read_dir(&logs)
            .unwrap()
            .filter_map(|entry| fs::read_to_string(entry.unwrap().path()).ok())
            .collect::<String>();
        let reasons = logged
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|event| event["type"] == "task_checks" && event["taskId"] == task.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(reasons.len(), 3, "{reasons:?}");
        assert!(reasons.iter().all(|event| event["state"] == "unavailable"
            && !event["reason"].as_str().unwrap().is_empty()));
        assert!(reasons[0]["reason"].as_str().unwrap().contains("not logged in"));

        // Authorization still applies while GitHub cannot be observed.
        let failing = || Some(Err(failure("authentication-required", "unavailable")));
        assert_eq!(
            checks_with_github(state.clone(), repository::new_task_id(), headers.clone(), failing())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        let outsider_hash = crate::shared::hash::sha256_hex(b"checks_outsider_token");
        state.with_database(|database| {
            let connection = database.connection();
            connection.execute(
                "INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES ('checks_outsider','Outsider','user_v1_checks_outsider','member','active',?1,?1,1)",
                [&stamp],
            ).unwrap();
            connection.execute(
                "INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('checks_other','Other','active',?1)",
                [&stamp],
            ).unwrap();
            connection.execute(
                "INSERT INTO suplex_memberships (user_id,company_id,created_at) VALUES ('checks_outsider','checks_other',?1)",
                [&stamp],
            ).unwrap();
            connection.execute(
                "INSERT INTO suplex_sessions (id,token_hash,user_id,expires_at,created_at,token_version) VALUES ('checks_outsider_session',?1,'checks_outsider',?2,?3,1)",
                rusqlite::params![outsider_hash, (now + chrono::Duration::days(1)).to_rfc3339(), stamp],
            ).unwrap();
            connection.execute("INSERT INTO suplex_account_users (user_id, account_id, email) VALUES ('checks_outsider', 'test_verified_account', 'checks_outsider@example.com')", []).unwrap();
            connection.execute("INSERT INTO suplex_account_sessions (token_hash, account_id) VALUES (?1, 'test_verified_account')", [&outsider_hash]).unwrap();
        });
        let mut outsider = headers.clone();
        outsider.insert("cookie", HeaderValue::from_static("sid_v1=checks_outsider_token"));
        // Another company's task is not found, as for any unreadable task.
        assert_eq!(
            checks_with_github(state.clone(), task.id.clone(), outsider, failing())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        headers.remove("cookie");
        assert_eq!(
            checks_with_github(state.clone(), task.id.clone(), headers.clone(), failing())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        failing_api.abort();
        observed_api.abort();
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn frozen_typescript_task_detail_responses_remain_compatible() {
        let root = std::env::temp_dir().join(format!("suplex-ui-parity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database_path = root.join("suplex.sqlite");
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/parity/task-detail-database.sqlite"
            ),
            &database_path,
        )
        .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let (task_id, session_id, user_id): (String, String, String) = database.connection().query_row(
            "SELECT s.task_id, s.id, t.creator_user_id FROM suplex_task_sessions s JOIN suplex_tasks t ON t.id = s.task_id LIMIT 1",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        let runtime = crate::runtimes::task_harness::task_session_runtime_directory(
            &database_path,
            &session_id,
        )
        .unwrap();
        fs::create_dir_all(&runtime).unwrap();
        fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/parity/task-detail-runtime/turn-msg_ui_read.jsonl"
            ),
            runtime.join("turn-msg_ui_read.jsonl"),
        )
        .unwrap();
        let token =
            crate::http::routes::auth::tests::verified_session(&database, &user_id, Utc::now())
                .unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "http://127.0.0.1:4111".into(),
                tailscale_exposure: "none".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            crate::http::session::VERIFIED_HTTPS_HEADER,
            "1".parse().unwrap(),
        );
        headers.insert("host", HeaderValue::from_static("127.0.0.1:4111"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={token}")).unwrap(),
        );
        let fixture = include_str!("../../../../tests/parity/task-detail-read.json")
            .replace("$SESSION", &session_id);
        let expected: Value = serde_json::from_str(&fixture).unwrap();
        for case in expected.as_array().unwrap() {
            let response = match case["path"].as_str().unwrap() {
                "activity" => {
                    activity(State(state.clone()), Path(task_id.clone()), headers.clone()).await
                }
                "execution" => {
                    execution(State(state.clone()), Path(task_id.clone()), headers.clone()).await
                }
                "diff/summary" => {
                    diff_summary(State(state.clone()), Path(task_id.clone()), headers.clone()).await
                }
                path => panic!("Unexpected frozen route: {path}"),
            };
            assert_eq!(
                response.status().as_u16(),
                case["status"].as_u64().unwrap() as u16
            );
            assert_eq!(
                response
                    .headers()
                    .get(CACHE_CONTROL)
                    .and_then(|value| value.to_str().ok()),
                case["cacheControl"].as_str()
            );
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                case["body"],
                "{}",
                case["path"]
            );
        }
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delegation_turns_expose_their_worker_assignment() {
        let planned = json!({"kind":"worker","version":2,"mode":"planned","purpose":"implementation","range":null,"plan":"Add the field","acceptanceCriteria":["Field shows"],"instruction":"Build it","advisorReport":null,"candidateReports":null});
        assert_eq!(
            worker_assignment(Some(&planned)),
            Some(TaskWorkerAssignment {
                mode: WorkerAssignmentMode::Planned,
                purpose: WorkerAssignmentPurpose::Implementation,
                plan: Some("Add the field".into()),
                acceptance_criteria: vec!["Field shows".into()],
                instruction: "Build it".into(),
            })
        );
        let direct = json!({"kind":"worker","mode":"direct","purpose":"verification","plan":null,"acceptanceCriteria":[],"instruction":"Run checks"});
        let direct = worker_assignment(Some(&direct)).unwrap();
        assert_eq!(direct.mode, WorkerAssignmentMode::Direct);
        assert_eq!(direct.purpose, WorkerAssignmentPurpose::Verification);
        assert_eq!(direct.plan, None);
        // Continuation, Advisor, and legacy turns carry no Worker assignment.
        assert_eq!(worker_assignment(None), None);
        assert_eq!(worker_assignment(Some(&Value::Null)), None);
        assert_eq!(
            worker_assignment(Some(&json!({"kind":"advisor","role":"rater"}))),
            None
        );
        assert_eq!(
            worker_assignment(Some(&json!({"kind":"worker","plan":"Old"}))),
            None
        );
    }

    #[test]
    fn legacy_standard_delegations_read_the_saved_worker_prompt() {
        let text = crate::coordination::root_prompts::compose_worker_assignment(
            &crate::coordination::root_prompts::WorkerAssignmentText {
                mode: "planned",
                purpose: "implementation",
                plan: Some("## Steps\n\nAcceptance criteria:\n1. Not a criterion"),
                acceptance_criteria: &["First\nline two".into(), "Second".into()],
                instruction: "Build it",
                visual_evidence: "off",
                verification_range: None,
                advisor_report: None,
            },
        )
        .unwrap();
        let prompt =
            crate::coordination::root_prompts::worker_prompt("planned", "implementation", &text)
                .unwrap();
        assert_eq!(
            legacy_worker_assignment(&prompt),
            Some(TaskWorkerAssignment {
                mode: WorkerAssignmentMode::Planned,
                purpose: WorkerAssignmentPurpose::Implementation,
                plan: Some("## Steps\n\nAcceptance criteria:\n1. Not a criterion".into()),
                acceptance_criteria: vec!["First\nline two".into(), "Second".into()],
                instruction: "Build it".into(),
            })
        );
        assert_eq!(legacy_worker_assignment("Continue with the fix."), None);
    }
}
