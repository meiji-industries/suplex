#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::http::routes::auth;

    fn subscription(endpoint: &str) -> Subscription {
        Subscription { endpoint: endpoint.into(), p256dh: "p".into(), auth: "a".into() }
    }

    fn endpoints(due: &Due) -> Vec<&str> {
        due.recipients.iter().map(|recipient| recipient.endpoint.as_str()).collect()
    }

    #[test]
    fn claims_each_waiting_episode_once_for_creator_and_admins() {
        let (state, filename) = auth::tests::state();
        let now = Utc::now();
        let time = rfc3339_millis(now - Duration::days(1));
        state.with_database(|database| {
            let connection = database.connection();
            connection.execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('push_c','Push','active',?1)", [&time]).unwrap();
            connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('push_p','push_c','Push','/tmp/push-r','/tmp/push-w',NULL,'main','','','root','worker',?1,?1)", [&time]).unwrap();
            for (id, role) in [("push_creator", "member"), ("push_member", "member"), ("push_former", "member"), ("push_admin", "admin")] {
                connection.execute("INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES (?1,?1,?1,?2,'active',?3,?3,1)", params![id, role, time]).unwrap();
                save_subscription(database, id, &subscription(&format!("https://web.push.apple.com/{id}")), now).unwrap();
            }
            for id in ["push_creator", "push_member"] {
                connection.execute("INSERT INTO suplex_memberships (user_id,company_id,created_at) VALUES (?1,'push_c',?2)", params![id, time]).unwrap();
            }
            connection.execute("INSERT INTO suplex_agents (id,name,avatar_seed,created_at,updated_at) VALUES ('push_agent','Agent','seed',?1,?1)", [&time]).unwrap();
            let insert = |id: &str, user: Option<&str>, agent: Option<&str>, status: &str, archived: Option<&str>| {
                connection.execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_user_id,creator_agent_id,created_at,updated_at,archived_at) VALUES (?1,'push_c','push_p',?1,'','{}',?1,?1,?2,?3,?4,?4,?5)", params![id, user, agent, time, archived]).unwrap();
                connection.execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,human_question_options_json,human_question,human_question_id,status_changed_at,created_at,updated_at) VALUES (?1,'T','local_worktree','{}',?2,'{}','{}','standard','{}','{}','[]',?4,?5,?3,?3,?3)", params![id, status, time, (status == "waiting_human").then_some("Old?"), (status == "waiting_human").then_some("q0")]).unwrap();
            };
            insert("push_task", Some("push_creator"), None, "active", None);
            insert("push_former_task", Some("push_former"), None, "active", None);
            insert("push_agent_task", None, Some("push_agent"), "active", None);
            insert("push_archived", Some("push_creator"), None, "active", Some(&time));
            insert("push_old", Some("push_creator"), None, "waiting_human", None);
            for id in ["push_task", "push_former_task", "push_agent_task", "push_archived"] {
                connection.execute("UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Approve?', human_question_id = 'q' WHERE task_id = ?1", [id]).unwrap();
            }
        });
        let since = now - Duration::minutes(10);
        let due = state.with_database(|database| claim_due(database, since, Utc::now())).unwrap();
        let task = |id: &str| due.iter().find(|due| due.task_id == id);
        assert_eq!(due.len(), 3);
        assert_eq!(endpoints(task("push_task").unwrap()), ["https://web.push.apple.com/push_admin", "https://web.push.apple.com/push_creator"]);
        assert_eq!(endpoints(task("push_former_task").unwrap()), ["https://web.push.apple.com/push_admin"]);
        assert_eq!(endpoints(task("push_agent_task").unwrap()), ["https://web.push.apple.com/push_admin"]);
        assert_eq!(task("push_task").unwrap().company_id, "push_c");
        assert!(task("push_archived").is_none() && task("push_old").is_none());
        assert!(state.with_database(|database| claim_due(database, since, Utc::now())).unwrap().is_empty());
        let old_claimed: i64 = state.with_database(|database| database.connection().query_row("SELECT COUNT(*) FROM suplex_web_push_sent WHERE task_id = 'push_old'", [], |row| row.get(0))).unwrap();
        assert_eq!(old_claimed, 0);

        state.with_database(|database| {
            let connection = database.connection();
            connection.execute("UPDATE suplex_task_controls SET status = 'active', human_question = NULL, human_question_id = NULL WHERE task_id = 'push_task'", [])?;
            connection.execute("UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Again?', human_question_id = 'q2' WHERE task_id = 'push_task'", [])?;
            connection.execute("UPDATE suplex_task_controls SET status_changed_at = ?1 WHERE task_id = 'push_task'", [rfc3339_millis(Utc::now() + Duration::seconds(1))])
        }).unwrap();
        let again = state.with_database(|database| claim_due(database, since, Utc::now())).unwrap();
        assert_eq!(again.iter().map(|due| due.task_id.as_str()).collect::<Vec<_>>(), ["push_task"]);
        drop(state);
        let _ = std::fs::remove_file(filename);
    }

    #[test]
    fn key_is_stable_and_an_endpoint_moves_to_the_latest_user() {
        let (state, filename) = auth::tests::state();
        let now = Utc::now();
        let time = rfc3339_millis(now);
        let (first, second) = state.with_database(|database| Ok::<_, Box<dyn std::error::Error + Send + Sync>>((vapid_key(database)?.to_base64url(), vapid_key(database)?.to_base64url()))).unwrap();
        assert_eq!(first, second);
        let owners = state.with_database(|database| {
            for id in ["push_one", "push_two"] {
                database.connection().execute("INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES (?1,?1,?1,'member','active',?2,?2,1)", params![id, time])?;
            }
            save_subscription(database, "push_one", &subscription("https://fcm.googleapis.com/fcm/send/x"), now)?;
            save_subscription(database, "push_two", &subscription("https://fcm.googleapis.com/fcm/send/x"), now)?;
            delete_subscription(database, "push_one", "https://fcm.googleapis.com/fcm/send/x")?;
            let mut statement = database.connection().prepare("SELECT user_id FROM suplex_web_push_subscriptions")?;
            let owners = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(owners)
        }).unwrap();
        assert_eq!(owners, ["push_two"]);
        drop(state);
        let _ = std::fs::remove_file(filename);
    }
}
