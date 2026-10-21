#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use chrono::TimeZone;
    use serde_json::{Value, json};

    use crate::{
        http::routes::avatars::tests::{call, json_body},
        shared::time::rfc3339_millis,
        tasks::analytics::{TaskUsage, Tokens},
    };

    #[test]
    fn accepts_dst_length_weeks_and_rejects_invalid_ranges() {
        assert!(parse_range(Some("weekStartsAt=2026-03-02T05%3A00%3A00Z&weekEndsAt=2026-03-09T04%3A00%3A00Z")).is_ok());
        assert!(parse_range(Some("weekStartsAt=2026-10-26T04%3A00%3A00Z&weekEndsAt=2026-11-02T05%3A00%3A00Z")).is_ok());
        assert!(parse_range(Some("weekStartsAt=bad&weekEndsAt=2026-11-02T05%3A00%3A00Z")).is_err());
        assert!(parse_range(Some("weekStartsAt=2026-11-02T05%3A00%3A00Z&weekEndsAt=2026-10-26T04%3A00%3A00Z")).is_err());
        assert!(parse_range(Some("weekStartsAt=2026-03-02T05%3A00%3A00Z&weekEndsAt=2026-03-09T04%3A00%3A00Z&extra=x")).is_err());
    }

    #[tokio::test]
    async fn aggregate_uses_live_company_scope_weekly_state_questions_and_usage_coverage() {
        let (state, filename) = auth::tests::state();
        let start = Utc.with_ymd_and_hms(2026, 9, 21, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 9, 28, 0, 0, 0).unwrap();
        let prior = rfc3339_millis(start - Duration::days(8));
        let current = rfc3339_millis(start + Duration::days(1));
        let boundary = "2026-09-21T08:00:00+08:00";
        let admin = auth::tests::operator_account(&state, Utc::now());
        let member = state.with_database(|database| {
            let connection = database.connection();
            for index in 1..=3 {
                connection.execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES (?1,?2,'active',?3)", rusqlite::params![format!("today_c{index}"), format!("Client {index}"), prior]).unwrap();
                connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,NULL,'main','','','root','worker',?6,?6)", rusqlite::params![format!("today_p{index}"), format!("today_c{index}"), format!("Project {index}"), format!("/tmp/today-r{index}"), format!("/tmp/today-w{index}"), prior]).unwrap();
            }
            connection.execute("INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES ('today_member','Today member','today-member','member','active',?1,?1,1)", [&prior]).unwrap();
            for company in ["today_c1", "today_c2"] {
                connection.execute("INSERT INTO suplex_memberships (user_id,company_id,created_at) VALUES ('today_member',?1,?2)", rusqlite::params![company, prior]).unwrap();
            }
            crate::http::routes::auth::tests::verified_session(database, "today_member", Utc::now()).unwrap()
        });
        state.with_database(|database| {
            let connection = database.connection();
            let insert_task = |id: &str, company: &str, project: &str, status: &str, changed: &str, archived: Option<&str>, question: Option<(&str, &str, Option<&str>, Option<&str>)>| {
                connection.execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_user_id,created_at,updated_at,archived_at) VALUES (?1,?2,?3,?1,'','{}',?1,?1,'user_development',?4,?4,?5)", rusqlite::params![id, company, project, changed, archived]).unwrap();
                let (text, question_id, limit, recovery) = question.map_or((None, None, None, None), |(text, id, limit, recovery)| (Some(text), Some(id), limit, recovery));
                if let Some(turn_id) = recovery {
                    let session_id = format!("session-{id}");
                    connection.execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,created_at,updated_at,profile_json) VALUES (?1,?2,'root',1,1,'stopped',?3,?3,'{}')", rusqlite::params![session_id, id, changed]).unwrap();
                    connection.execute("INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,1,'hash','prompt','completed',?4,?4)", rusqlite::params![turn_id, id, session_id, changed]).unwrap();
                }
                connection.execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,human_question,human_question_id,human_question_options_json,limit_pause_json,recovery_turn_id,status_changed_at,created_at,updated_at) VALUES (?1,'T','local_worktree','{}',?2,'{}','{}','standard','{}','{}',?3,?4,'[]',?5,?6,?7,?7,?7)", rusqlite::params![id, status, text, question_id, limit, recovery, changed]).unwrap();
            };
            insert_task("question_plain", "today_c1", "today_p1", "waiting_human", &current, None, Some(("Choose?", "q1", None, None)));
            insert_task("question_cleanup", "today_c2", "today_p2", "waiting_human", &current, None, Some(("Stop commands?", "q2", None, Some("turn-2"))));
            let pause = json!({"kind":"task_limit","reason":"budget","limits":{"budgetUsd":15,"maxTurns":40},"usage":{"estimatedCostUsd":15,"admittedTurns":3},"proposedLimits":{"budgetUsd":25,"maxTurns":40}}).to_string();
            insert_task("question_limit", "today_c3", "today_p3", "waiting_human", &current, None, Some(("Raise limit?", "q3", Some(&pause), None)));
            insert_task("active_known", "today_c1", "today_p1", "active", &current, None, None);
            insert_task("active_unobserved", "today_c3", "today_p3", "active", &current, None, None);
            insert_task("archived_shipped", "today_c2", "today_p2", "delivered", boundary, Some(&current), None);
            insert_task("end_boundary", "today_c2", "today_p2", "delivered", &rfc3339_millis(end), None, None);
            insert_task("prior_delivery", "today_c1", "today_p1", "delivered", &prior, None, None);
            connection.execute("UPDATE suplex_tasks SET title='edited without transition' WHERE id='archived_shipped'", []).unwrap();
            let unchanged: String = connection.query_row("SELECT status_changed_at FROM suplex_task_controls WHERE task_id='archived_shipped'", [], |row| row.get(0)).unwrap();
            assert_eq!(unchanged, boundary);
            connection.execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,native_session_id,created_at,updated_at) VALUES ('current_known','active_known','root',1,1,'live','codex-known',?1,?1)", [&current]).unwrap();
            connection.execute("INSERT INTO suplex_task_analytics_sessions (session_id,task_id,observed_at) VALUES ('current_known','active_known',?1)", [&current]).unwrap();
            connection.execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,native_session_id,created_at,updated_at) VALUES ('current_missing','active_unobserved','root',1,1,'live','codex-current',?1,?1)", [&current]).unwrap();
            connection.execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,native_session_id,created_at,updated_at) VALUES ('old_error','prior_delivery','root',1,1,'stopped','codex-old',?1,?1)", [&prior]).unwrap();
            connection.execute("INSERT INTO suplex_task_analytics_sessions (session_id,task_id,error_at) VALUES ('old_error','prior_delivery',?1)", [&prior]).unwrap();
            let usage = |message: &str, cost: f64, tokens: f64, subsidized: bool| TaskUsage { session_id: format!("session-{message}"), message_id: message.into(), turn_id: message.into(), role: "root".into(), provider: "codex".into(), model: "fixture".into(), started_at: (start + Duration::days(1)).timestamp_millis() as f64, completed_at: Some((start + Duration::days(1)).timestamp_millis() as f64 + 100.0), failed: false, summary: false, steps: 1.0, cost, subsidized, tokens: Tokens { input: tokens, ..Tokens::default() }, source: "fixture".into(), generation_ms: None, first_response_ms: None };
            for (task, entry) in [("active_known", usage("known", 2.0, 10.0, false)), ("question_cleanup", usage("unpriced", 0.0, 10.0, false))] {
                connection.execute("INSERT INTO suplex_task_usage (task_id,session_id,message_id,snapshot,observed_at) VALUES (?1,?2,?3,?4,?5)", rusqlite::params![task, entry.session_id, entry.message_id, crate::tasks::analytics::js(&entry), current]).unwrap();
            }
        });
        auth::tests::require_remote_login(&state);
        let app = crate::http::router(state.clone());
        let path = "/api/today?weekStartsAt=2026-09-21T00%3A00%3A00Z&weekEndsAt=2026-09-28T00%3A00%3A00Z";
        assert_eq!(call(&app, "GET", path, None, None).await.0, StatusCode::UNAUTHORIZED);
        let cookie = format!("sid_v1={admin}");
        let (status, _, body) = call(&app, "GET", path, Some(&cookie), None).await;
        assert_eq!(status, StatusCode::OK);
        let body = json_body(&body);
        assert_eq!(body["needsYou"].as_array().unwrap().len(), 3);
        assert_eq!(body["inProgress"].as_array().unwrap().len(), 2);
        assert_eq!(body["shippedThisWeek"].as_array().unwrap().iter().map(|task| task["taskId"].as_str().unwrap()).collect::<Vec<_>>(), ["archived_shipped"]);
        let questions = body["needsYou"].as_array().unwrap();
        let question = |id: &str| questions.iter().find(|task| task["taskId"] == id).unwrap();
        assert_eq!(question("question_plain")["humanQuestion"]["kind"], "question");
        assert_eq!(question("question_cleanup")["humanQuestion"]["requiresCommandCleanup"], true);
        assert_eq!(question("question_limit")["humanQuestion"]["kind"], "task_limit");
        let spend = body["spendByCompany"].as_array().unwrap();
        let company = |id: &str| spend.iter().find(|row| row["companyId"] == id).unwrap();
        assert_eq!((company("today_c1")["knownCostUsd"].clone(), company("today_c1")["partial"].clone()), (json!(2.0), json!(false)));
        assert_eq!((company("today_c2")["knownCostUsd"].clone(), company("today_c2")["partial"].clone()), (Value::Null, json!(true)));
        assert_eq!((company("today_c3")["knownCostUsd"].clone(), company("today_c3")["partial"].clone()), (Value::Null, json!(true)));
        assert_eq!(["today_c1", "today_c2", "today_c3"].map(|id| company(id)["totalTokens"].clone()), [json!(10), json!(10), json!(0)]);
        let member_cookie = format!("sid_v1={member}");
        let member_body = json_body(&call(&app, "GET", path, Some(&member_cookie), None).await.2);
        assert_eq!(member_body["companies"].as_array().unwrap().len(), 2);
        state.with_database(|database| database.connection().execute("DELETE FROM suplex_memberships WHERE user_id='today_member' AND company_id='today_c2'", []).unwrap());
        let member_body = json_body(&call(&app, "GET", path, Some(&member_cookie), None).await.2);
        assert_eq!(member_body["companies"].as_array().unwrap().iter().map(|company| company["id"].as_str().unwrap()).collect::<Vec<_>>(), ["today_c1"]);
        drop(app); drop(state); let _ = std::fs::remove_file(filename);
    }
}
