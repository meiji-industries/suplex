#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::*;
    use crate::shared::time::rfc3339_millis;
    use crate::{
        http::routes::avatars::tests::{call, json_body},
        identity::auth as identity_auth,
        tasks::analytics::{AnalyticsSession, record},
    };

    #[tokio::test]
    async fn company_analytics_costs_and_timeline_read_saved_usage_for_visible_tasks() {
        let (state, filename) = auth::tests::state();
        let now = Utc::now();
        let time = rfc3339_millis(now);
        let admin = auth::tests::operator_passkey(&state, now);
        let member = state.with_database(|database| {
            let connection = database.connection();
            connection.execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('c','C','active',?1)", [&time]).unwrap();
            connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('p','c','P','/tmp/r','/tmp/w',NULL,'main','','','root','worker','{}',?1,?1)", [&time]).unwrap();
            let configuration = json!({"repository": "owner/repo", "repositoryPath": "/tmp/r", "worktreeRoot": "/tmp/w", "branch": "task/analytics", "baseBranch": "main", "baselineSha": "0123456789abcdef0123456789abcdef01234567", "startingSha": "0123456789abcdef0123456789abcdef01234567", "capturedAt": time}).to_string();
            for (id, archived) in [("active_task", None), ("archived_task", Some(time.as_str()))] {
                connection.execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_user_id,created_at,updated_at,archived_at) VALUES (?1,'c','p',?1,'',?4,?1,'h','user_development',?2,?2,?3)", rusqlite::params![id, time, archived, configuration]).unwrap();
                connection.execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,status_changed_at,created_at,updated_at) VALUES (?1,'T','local_worktree','{}','delivered','{\"profileId\":\"root\",\"model\":\"m\",\"provider\":\"codex\",\"reasoningLevel\":\"high\",\"serviceTier\":\"default\"}','{\"profileId\":\"worker\",\"model\":\"m\",\"provider\":\"codex\",\"reasoningLevel\":\"high\",\"serviceTier\":\"default\"}','standard','{}','{\"version\":1,\"reviews\":[],\"acceptedDelivery\":null,\"deliveryWait\":null,\"completion\":null}',?2,?2,?2)", rusqlite::params![id, time]).unwrap();
            }
            connection.execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,native_session_id,created_at,updated_at) VALUES ('s','active_task','root',1,1,'live','codex-a',?1,?1)", [&time]).unwrap();
            connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'Member', 'member', 'member', 'active', ?1, ?1, 1)", [&time]).unwrap();
            identity_auth::create_session(database, "member", now).unwrap()
        });
        state.with_database(|database| {
            let usage = crate::tasks::analytics::TaskUsage {
                session_id: "codex-a".into(),
                ..crate::tasks::analytics::tests::entry("msg_turn", 3.0)
            };
            record(database, "active_task", "s", &[usage], &time).unwrap();
        });
        auth::tests::require_passkeys(&state);
        let app = crate::http::router(state.clone());
        let cookie = format!("sid_v1={admin}");
        let cookie = Some(cookie.as_str());

        let (status, headers, body) =
            call(&app, "GET", "/api/companies/c/analytics", cookie, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
        let body = json_body(&body);
        let tasks = body["tasks"].as_array().unwrap();
        assert_eq!(
            tasks
                .iter()
                .map(|task| task["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["active_task", "archived_task"]
        );
        assert_eq!(
            (
                tasks[0]["sessions"].clone(),
                tasks[0]["observedSessions"].clone(),
                tasks[1]["archived"].clone()
            ),
            (json!(1), json!(1), json!(true))
        );
        assert_eq!(tasks[0]["usage"][0]["cost"], json!(3));
        let _ = AnalyticsSession {
            session_id: String::new(),
            observed_at: None,
            error_at: None,
        };

        let (_, _, body) = call(&app, "GET", "/api/companies/c/task-costs", cookie, None).await;
        assert_eq!(
            json_body(&body),
            json!({"tasks":[
                {"id":"active_task","cost":3,"unpriced":false,"subsidized":false,"partial":false},
                {"id":"archived_task","cost":null,"unpriced":false,"subsidized":false,"partial":false},
            ]})
        );

        let (status, _, body) = call(&app, "GET", "/api/companies/c/timeline", cookie, None).await;
        assert_eq!(status, StatusCode::OK);
        let body = json_body(&body);
        assert_eq!(body["unavailableSessions"], 0);
        assert_eq!(body["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(body["tasks"][0]["activity"].as_array().unwrap().len(), 1);

        let member = format!("sid_v1={member}");
        for path in ["analytics", "task-costs", "timeline"] {
            let uri = format!("/api/companies/c/{path}");
            assert_eq!(
                call(&app, "GET", &uri, Some(&member), None).await.0,
                StatusCode::NOT_FOUND,
                "{path}"
            );
            assert_eq!(
                call(&app, "GET", &uri, None, None).await.0,
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
        drop(app);
        drop(state);
        let _ = std::fs::remove_file(filename);
    }
}
