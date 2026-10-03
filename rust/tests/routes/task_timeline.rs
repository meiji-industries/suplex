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

    task_path!(task_timeline);
    use crate::http::session;
    use crate::{
        platform::database::OpenMode,
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use axum::{body::to_bytes, http::HeaderValue};
    use chrono::Utc;

    #[tokio::test]
    async fn saved_timeline_obeys_live_company_membership_and_session_scope() {
        let root =
            std::env::temp_dir().join(format!("suplex-timeline-route-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut database =
            SuplexDatabase::open(&root.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = crate::http::routes::auth::tests::verified_sign_in(&mut database, now).unwrap();
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('timeline_company','Timeline','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('timeline_project','timeline_company','Timeline','/tmp/repo','/tmp/worktrees',NULL,'main','','','root_profile','worker_profile','{}',?1,?1)", [&stamp]).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "timeline_company".into(), project_id: "timeline_project".into(),
            title: "Saved timing".into(), description: "Read-only".into(),
            configuration: json!({"branch":"timeline-branch","baseBranch":"main"}),
            idempotency_key: "timeline-route".into(), request_hash: "timeline-hash".into(),
            creator: TaskCreator::User(admin.user.id), delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"timeline-branch","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: false,
            copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        }, now).unwrap().task;
        database.connection().execute("INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES ('timeline_member','Member','user_v1_timeline_member','member','active',?1,?1,1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_memberships (user_id,company_id,created_at) VALUES ('timeline_member','timeline_company',?1)", [&stamp]).unwrap();
        let token = crate::http::routes::auth::tests::verified_session(&database, "timeline_member", now).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "https://suplex.example.test:4113".into(),
                tailscale_exposure: "serve".into(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(crate::http::session::VERIFIED_HTTPS_HEADER, "1".parse().unwrap());
        headers.insert("host", HeaderValue::from_static("untrusted.invalid"));
        assert_eq!(
            task_timeline(State(state.clone()), Path(task.id.clone()), headers.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={token}")).unwrap(),
        );
        let accepted =
            task_timeline(State(state.clone()), Path(task.id.clone()), headers.clone()).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(accepted.headers()[CACHE_CONTROL], "private, no-store");
        let bytes = to_bytes(accepted.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body,
            json!({"tasks":[{"id":task.id,"projectId":"timeline_project","issueKey":null,"title":"Saved timing","activity":[]}],"unavailableSessions":0})
        );
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "DELETE FROM suplex_memberships WHERE user_id = 'timeline_member'",
                    [],
                )
                .unwrap()
        });
        assert_eq!(
            task_timeline(State(state.clone()), Path(task.id), headers)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
