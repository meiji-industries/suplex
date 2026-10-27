#[cfg(test)]
mod agent_selection_tests {
    use super::*;
    use crate::{
        identity::auth,
        platform::database::OpenMode,
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use serde_json::json;

    struct Fixture {
        database: SuplexDatabase,
        path: std::path::PathBuf,
        task_id: String,
        now: DateTime<Utc>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn fixture() -> Fixture {
        let path = std::env::temp_dir().join(format!("suplex-selection-{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        let time = rfc3339_millis(now);
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('select_company','Select','active',?1)", [&time]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('select_project','select_company','Select','/tmp/select-repo','/tmp/select-worktrees',NULL,'main','','','root','worker',?1,?1)", [&time]).unwrap();
        for (id, role, provider) in [
            ("new-root", "root", "codex"),
            ("new-worker", "worker", "opencode"),
        ] {
            database.connection().execute("INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES (?1,?1,?2,?1,?3,'test','medium','default',?4,?4)", rusqlite::params![id, role, provider, time]).unwrap();
        }
        let prepared = PreparedTask {
            id: repository::new_task_id(), company_id: "select_company".into(), project_id: "select_project".into(),
            title: "Agent selection".into(), description: String::new(),
            configuration: json!({"repository":"owner/repo","repositoryPath":"/tmp/select-repo","worktreeRoot":"/tmp/select-worktrees","branch":"task-select","baseBranch":"main","baselineSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","startingSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","setupCommand":"","verificationCommand":"","runProjectTests":false,"visualEvidence":"off","source":null,"capturedAt":"2026-09-25T12:00:00.000Z"}),
            idempotency_key: "select-key".into(), request_hash: "select-hash".into(), creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-select","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: true, copied_from_task_id: None,
            depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        };
        let task_id = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task
            .id;
        Fixture {
            database,
            path,
            task_id,
            now,
        }
    }

    fn request(
        role: &str,
        expected_profile_id: &str,
        expected_session_id: Option<&str>,
        profile_id: &str,
        direction: &str,
        resume: bool,
        question_id: Option<&str>,
    ) -> AgentSelection {
        AgentSelection {
            role: role.into(),
            expected_profile_id: expected_profile_id.into(),
            expected_session_id: expected_session_id.map(str::to_owned),
            profile_id: profile_id.into(),
            direction: direction.into(),
            resume,
            question_id: question_id.map(str::to_owned),
        }
    }

    fn turns(fixture: &Fixture, session_id: &str) -> Vec<String> {
        let mut statement = fixture.database.connection().prepare("SELECT prompt_text FROM suplex_task_turns WHERE session_id = ?1 ORDER BY created_at, id").unwrap();
        statement
            .query_map([session_id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn first_coordinator_selection_is_atomic_idempotent_and_keeps_direction() {
        let mut f = fixture();
        let selected = request(
            "root",
            "root",
            None,
            "new-root",
            "Keep the notes.",
            false,
            None,
        );
        select_initial_root(&mut f.database, &f.task_id, &selected, "user_development", f.now).unwrap();
        let first = current_root(&f.database, &f.task_id).unwrap().unwrap();
        select_initial_root(&mut f.database, &f.task_id, &selected, "user_development", f.now).unwrap();
        assert_eq!(
            current_root(&f.database, &f.task_id).unwrap().unwrap().id,
            first.id
        );
        assert!(turns(&f, &first.id).join("\n").contains("Keep the notes."));
        let changed = request(
            "root",
            "root",
            None,
            "new-root",
            "Other direction",
            false,
            None,
        );
        assert!(select_initial_root(&mut f.database, &f.task_id, &changed, "user_development", f.now).is_err());
    }

    #[test]
    fn worker_selection_replaces_active_session_and_preserves_assignment() {
        let mut f = fixture();
        let root = reserve_root(&mut f.database, &f.task_id, f.now).unwrap();
        let old = launch_standard_worker(
            &mut f.database,
            &root,
            "Build the change",
            "Build the change",
            None,
            f.now,
        )
        .unwrap();
        let selected = request(
            "worker",
            "worker",
            Some(&old.id),
            "new-worker",
            "Keep prior checks.",
            false,
            None,
        );
        select_delegate(&mut f.database, &f.task_id, &selected, "user_development", f.now).unwrap();
        let next = current_worker(&f.database, &f.task_id).unwrap().unwrap();
        assert_ne!(next.id, old.id);
        assert_eq!(next.profile.as_ref().unwrap().provider, crate::tasks::control::HarnessKind::Opencode);
        assert!(turns(&f, &next.id).join("\n").contains("Build the change"));
        assert!(
            turns(&f, &next.id)
                .join("\n")
                .contains("Keep prior checks.")
        );
        select_delegate(&mut f.database, &f.task_id, &selected, "user_development", f.now).unwrap();
        assert_eq!(
            current_worker(&f.database, &f.task_id).unwrap().unwrap().id,
            next.id
        );
        let current: i64 = f
            .database
            .connection()
            .query_row(
                "SELECT is_current FROM suplex_task_sessions WHERE id = ?1",
                [&old.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current, 0);
    }

    #[test]
    fn active_reviewer_selection_preserves_workflow_input_and_assignment() {
        let mut f = fixture();
        f.database.connection().execute("UPDATE suplex_task_controls SET workflow = 'independent_review' WHERE task_id = ?1", [&f.task_id]).unwrap();
        let root = reserve_root(&mut f.database, &f.task_id, f.now).unwrap();
        let input = json!({"kind":"advisor","role":"reviewer","range":{"baseSha":"a","headSha":"b","files":["README.md"],"commits":["b"]},"evidenceDirectory":"/tmp/evidence","evidenceSha256":"a","verificationTurnIds":[]});
        let old = launch_advisor(
            &mut f.database,
            &root,
            "reviewer",
            "Review the change",
            &input,
            f.now,
        )
        .unwrap();
        let selected = request(
            "reviewer",
            "root",
            Some(&old.id),
            "new-root",
            "Check the changed files.",
            false,
            None,
        );
        select_delegate(&mut f.database, &f.task_id, &selected, "user_development", f.now).unwrap();
        let (id, saved_input): (String, String) = f.database.connection().query_row("SELECT id,workflow_input_json FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND advisor_role = 'reviewer' AND is_current = 1", [&f.task_id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_ne!(id, old.id);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&saved_input).unwrap(),
            input
        );
        assert!(turns(&f, &id).join("\n").contains("Review the change"));
        assert!(
            turns(&f, &id)
                .join("\n")
                .contains("Check the changed files.")
        );
        let old_current: i64 = f
            .database
            .connection()
            .query_row(
                "SELECT is_current FROM suplex_task_sessions WHERE id = ?1",
                [&old.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_current, 0);
    }

    #[test]
    fn completed_worker_selection_changes_future_profile_without_replaying_completed_work() {
        let mut f = fixture();
        let root = reserve_root(&mut f.database, &f.task_id, f.now).unwrap();
        let old = launch_standard_worker(
            &mut f.database,
            &root,
            "First assignment",
            "First assignment",
            None,
            f.now,
        )
        .unwrap();
        f.database.connection().execute("UPDATE suplex_task_turns SET status = 'completed', terminal_observation = ?1 WHERE session_id = ?2", rusqlite::params![json!({"state":"completed","text":"Done"}).to_string(), old.id]).unwrap();
        let selected = request(
            "worker",
            "worker",
            Some(&old.id),
            "new-worker",
            "Future work only.",
            false,
            None,
        );
        select_delegate(&mut f.database, &f.task_id, &selected, "user_development", f.now).unwrap();
        assert_eq!(
            current_worker(&f.database, &f.task_id).unwrap().unwrap().id,
            old.id
        );
        assert_eq!(turns(&f, &old.id).len(), 1);
        let next = launch_standard_worker(
            &mut f.database,
            &root,
            "Second assignment",
            "Second assignment",
            None,
            f.now,
        )
        .unwrap();
        assert_ne!(next.id, old.id);
        assert_eq!(next.profile.as_ref().unwrap().profile_id, "new-worker");
    }

    #[test]
    fn role_selection_cannot_resume_task_limit_or_cleanup_decisions() {
        let mut f = fixture();
        assert!(
            ask_human(
                &mut f.database,
                &f.task_id,
                "Choose a source",
                &json!([]),
                f.now
            )
            .unwrap()
        );
        let question: String = f
            .database
            .connection()
            .query_row(
                "SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?1",
                [&f.task_id],
                |row| row.get(0),
            )
            .unwrap();
        let selected = request(
            "worker",
            "worker",
            None,
            "new-worker",
            "Continue",
            true,
            Some(&question),
        );
        f.database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET limit_pause_json = ?1 WHERE task_id = ?2",
                rusqlite::params![
                    json!({"estimatedCostUsd":999,"admittedTurns":1}).to_string(),
                    f.task_id
                ],
            )
            .unwrap();
        assert!(select_delegate(&mut f.database, &f.task_id, &selected, "user_development", f.now).is_err());
        let turn_id = new_turn_id(f.now).unwrap();
        let time = rfc3339_millis(f.now);
        f.database.connection().execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,created_at,updated_at) VALUES ('cleanup-root',?1,'root',1,1,'reserved',?2,?2)", rusqlite::params![f.task_id, time]).unwrap();
        f.database.connection().execute("INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,'cleanup-root',1,'cleanup','Cleanup','pending_prompt',?3,?3)", rusqlite::params![turn_id, f.task_id, time]).unwrap();
        f.database.connection().execute("UPDATE suplex_task_controls SET limit_pause_json = NULL, recovery_turn_id = ?1 WHERE task_id = ?2", rusqlite::params![turn_id, f.task_id]).unwrap();
        assert!(select_delegate(&mut f.database, &f.task_id, &selected, "user_development", f.now).is_err());
        assert_eq!(
            current_root(&f.database, &f.task_id).unwrap().unwrap().id,
            "cleanup-root"
        );
    }

    #[test]
    fn ordinary_question_selection_keeps_question_unanswered_and_requires_exact_resume_id() {
        let mut f = fixture();
        assert!(
            ask_human(
                &mut f.database,
                &f.task_id,
                "Choose a source",
                &json!([{"label":"Main"}]),
                f.now
            )
            .unwrap()
        );
        let question: String = f
            .database
            .connection()
            .query_row(
                "SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?1",
                [&f.task_id],
                |row| row.get(0),
            )
            .unwrap();
        let selected = request(
            "root",
            "root",
            None,
            "new-root",
            "Use existing commits.",
            true,
            Some(&question),
        );
        let wrong = request(
            "root",
            "root",
            None,
            "new-root",
            "Use existing commits.",
            true,
            Some("stale"),
        );
        assert!(select_initial_root(&mut f.database, &f.task_id, &wrong, "user_development", f.now).is_err());
        select_initial_root(&mut f.database, &f.task_id, &selected, "user_development", f.now).unwrap();
        let root = current_root(&f.database, &f.task_id).unwrap().unwrap();
        assert!(
            turns(&f, &root.id)
                .join("\n")
                .contains(&format!("Question {question} remains unanswered"))
        );
        let (status, question_id): (String, Option<String>) = f
            .database
            .connection()
            .query_row(
                "SELECT status,human_question_id FROM suplex_task_controls WHERE task_id = ?1",
                [&f.task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), question_id), ("active", None));
    }
}
