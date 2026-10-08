#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::control::{
        TaskCoordinatorReplacementBody, TaskLimitDecision, TaskWorkerReplacementBody,
    };
    use crate::{
        identity::auth,
        platform::database::OpenMode,
        runtimes::headless::{self, DispatchInput},
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use std::{collections::HashMap, path::Path};

    fn normalize_generated_ids(prompt: &str) -> String {
        let ids = regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|msg_[A-Za-z0-9]+|task_[A-Za-z0-9]+").unwrap();
        let mut seen = HashMap::<String, String>::new();
        ids.replace_all(prompt, |captures: &regex::Captures<'_>| {
            let value = captures.get(0).unwrap().as_str();
            let next = seen.len() + 1;
            seen.entry(value.to_owned())
                .or_insert_with(|| format!("<ID_{next}>"))
                .clone()
        })
        .into_owned()
    }

    #[test]
    fn worker_and_coordinator_replacement_preserve_handoffs_and_native_readiness() {
        let filename =
            std::env::temp_dir().join(format!("suplex_replace_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('replace_company','Replace','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('replace_project','replace_company','Replace','/tmp/replace-repo','/tmp/replace-worktrees',NULL,'main','','','root','worker',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "replace_company".into(),
            project_id: "replace_project".into(),
            title: "Replace Worker".into(),
            description: String::new(),
            configuration: serde_json::json!({"repository":"owner/repo","repositoryPath":"/tmp/replace-repo","worktreeRoot":"/tmp/replace-worktrees","branch":"task-replace","baseBranch":"main","baselineSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","startingSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","setupCommand":"","verificationCommand":"","runProjectTests":false,"visualEvidence":"off","source":null,"capturedAt":"2026-09-25T12:00:00.000Z"}),
            idempotency_key: "replace-key".into(),
            request_hash: "replace-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-replace","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        };
        let task = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task;
        let root = reserve_root(&mut database, &task.id, now).unwrap();
        let old = launch_standard_worker(
            &mut database,
            &root,
            "Assignment: build",
            "Worker assignment: build",
            None,
            now,
        )
        .unwrap();
        let old_id = old.id.as_str().to_owned();
        let delegate_profile = delegate_profile(&database, &task.id, None).unwrap();
        database.connection().execute(
            "UPDATE suplex_task_sessions SET is_current = 0, updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?1",
            [&old_id],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,profile_json,delegate_slot,created_at,updated_at) VALUES ('newer-worker',?1,'worker',2,1,'live',?2,'delegate','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
            params![task.id, delegate_profile],
        ).unwrap();
        assert_eq!(
            compatible_delegate(&database, &task.id, &delegate_profile, None)
                .unwrap()
                .as_deref(),
            Some("newer-worker")
        );
        database.connection().execute("UPDATE suplex_task_sessions SET stop_requested_at = created_at WHERE id = 'newer-worker'", []).unwrap();
        assert!(
            compatible_delegate(&database, &task.id, &delegate_profile, None).is_err(),
            "an older session cannot bypass cleanup of the newest conversation"
        );
        database
            .connection()
            .execute(
                "DELETE FROM suplex_task_sessions WHERE id = 'newer-worker'",
                [],
            )
            .unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET is_current = 1 WHERE id = ?1",
                [&old_id],
            )
            .unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET native_session_id = 'codex-old' WHERE id = ?1",
                [&old_id],
            )
            .unwrap();
        database.connection().execute("UPDATE suplex_task_turns SET status = 'completed',terminal_observation = ?1 WHERE session_id = ?2", params![r#"{"state":"completed","text":"Made a partial change."}"#, old_id]).unwrap();
        let request = TaskWorkerReplacementBody {
            session_id: old_id.clone(),
            reason: "Change strategy".into(),
            handoff: Some("Finish the test".into()),
            worker_profile_id: None,
        };
        let next = replace_worker(&mut database, &task.id, &request, now).unwrap();
        assert_ne!(next.id, old_id);
        assert_eq!(next.native_session_id, None);
        assert_eq!(next.profile, old.profile);
        let next_id = next.id.as_str();
        assert!(!worker_replacement_ready(&database, next_id).unwrap());
        let saved: (String, String, String) = database.connection().query_row(
            "SELECT prompt_text,prompt_hash,assignment_hash FROM suplex_task_turns WHERE session_id = ?1", [next_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert!(saved.0.starts_with("Worker assignment: build\n\nFresh Worker handoff:\nReason for replacement: Change strategy"));
        assert!(saved.0.contains("Latest Worker result (verify its claims against source and command evidence):\nMade a partial change."));
        assert_eq!(saved.1, sha256_hex(saved.0.as_bytes()));
        assert_eq!(saved.1, saved.2);
        assert_eq!(
            replace_worker(&mut database, &task.id, &request, now)
                .unwrap()
                .id,
            next.id
        );
        drop(database);
        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        assert_eq!(
            current_worker(&database, &task.id).unwrap().unwrap().id,
            next_id
        );
        assert!(!worker_replacement_ready(&database, next_id).unwrap());
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET stopped_at = ?1 WHERE id = ?2",
                params![rfc3339_millis(now), old_id],
            )
            .unwrap();
        assert!(worker_replacement_ready(&database, next_id).unwrap());
        database.connection().execute(
            "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('alternate-worker','Alternate','worker','alternate','codex','gpt-6-sol','high','default',?1,?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let second = replace_worker(
            &mut database,
            &task.id,
            &TaskWorkerReplacementBody {
                session_id: next_id.into(),
                reason: "Try another approach".into(),
                handoff: None,
                worker_profile_id: Some("alternate-worker".into()),
            },
            now,
        )
        .unwrap();
        assert_eq!(
            second.profile.as_ref().unwrap().profile_id,
            "alternate-worker"
        );
        assert_eq!(second.profile.as_ref().unwrap().reasoning_level, crate::tasks::control::ReasoningLevel::High);
        assert_eq!(next.profile, old.profile);
        let latest: String = database
            .connection()
            .query_row(
                "SELECT prompt_text FROM suplex_task_turns WHERE session_id = ?1",
                [second.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(latest.matches("Fresh Worker handoff:").count(), 1);
        database.connection().execute(
            "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('alternate-root','Alternate Root','root','alternate-root','codex','gpt-6-sol','medium','default',?1,?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let rows = root_observation_rows(&database, &task.id).unwrap();
        let initial = root_prompts::initial_coordinator_prompt(
            &rows.control,
            &rows.context,
            &rows.dependencies,
        );
        ensure_initial_prompt(&mut database, &root, &initial, now).unwrap();
        for prompt in [
            "Human note:\nKeep the release notes intact.".to_owned(),
            r#"{"question":"Which branch?","answer":"Maintenance"}"#.to_owned(),
            r#"{"question":"More budget?","decision":{"kind":"add_budget","amount":9.0}}"#
                .to_owned(),
        ] {
            database.connection().execute(
                "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'completed',?7,?7)",
                params![new_turn_id(now).unwrap(),task.id,root.id,root.generation,sha256_hex(prompt.as_bytes()),prompt,rfc3339_millis(now)],
            ).unwrap();
        }
        for text in ["Checked the branch", "Compared the failed provider"] {
            let prompt = "Continue the task";
            database.connection().execute(
                "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,terminal_observation,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'completed',?7,?8,?8)",
                params![new_turn_id(now).unwrap(),task.id,root.id,root.generation,sha256_hex(prompt.as_bytes()),prompt,js_json::stringify(&serde_json::json!({"state":"completed","text":text})),rfc3339_millis(now)],
            ).unwrap();
        }
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human',human_question = 'Resolve provider failure?',human_question_id = 'question-current',human_question_options_json = '[]' WHERE task_id = ?1",
            [&task.id],
        ).unwrap();
        let source: Value = serde_json::from_str(include_str!(
            "../../../../tests/parity/coordinator-replacement-native/expected.json"
        ))
        .unwrap();
        for (prompt, hash) in [("firstPrompt", "firstHash"), ("secondPrompt", "secondHash")] {
            assert_eq!(
                sha256_hex(source[prompt].as_str().unwrap().as_bytes()),
                source[hash]
            );
        }
        let coordinator_request = TaskCoordinatorReplacementBody {
            session_id: root.id.clone(),
            root_profile_id: "alternate-root".into(),
            handoff: Some("Check the failed provider.".into()),
            resume: true,
            question_id: Some("question-current".into()),
        };
        let first =
            replace_coordinator(&mut database, &task.id, &coordinator_request, &initial, now)
                .unwrap();
        let first_id = first.id.as_str().to_owned();
        assert_ne!(first_id, root.id);
        assert_eq!(first.profile.as_ref().unwrap().profile_id, "alternate-root");
        assert_eq!(first.native_session_id, None);
        let retained_profile: String = database
            .connection()
            .query_row(
                "SELECT profile_json FROM suplex_task_sessions WHERE id = ?1",
                [&root.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&retained_profile).unwrap()["profileId"],
            "root"
        );
        assert!(!worker_replacement_ready(&database, &first_id).unwrap());
        assert_eq!(
            replace_coordinator(&mut database, &task.id, &coordinator_request, &initial, now)
                .unwrap()
                .id,
            first_id
        );
        let first_prompt: (String, String) = database
            .connection()
            .query_row(
                "SELECT prompt_text,prompt_hash FROM suplex_task_turns WHERE session_id = ?1",
                [&first_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(first_prompt.0.contains("Keep the release notes intact."));
        assert!(
            first_prompt
                .0
                .contains("Accepted human task limit decision")
        );
        assert!(first_prompt.0.contains("\"amount\":9}"));
        assert!(
            first_prompt
                .0
                .contains("Checked the branch\n\nCoordinator turn")
        );
        assert!(
            first_prompt
                .0
                .contains("Question question-current:\nResolve provider failure?")
        );
        assert!(
            first_prompt
                .0
                .contains("Additional direction from the user:\nCheck the failed provider.")
        );
        assert_eq!(first_prompt.1, sha256_hex(first_prompt.0.as_bytes()));
        assert_eq!(
            normalize_generated_ids(&first_prompt.0),
            normalize_generated_ids(source["firstPrompt"].as_str().unwrap())
        );
        assert_eq!(first_prompt.1, sha256_hex(first_prompt.0.as_bytes()));
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET stopped_at = ?1 WHERE id = ?2",
                params![rfc3339_millis(now), root.id],
            )
            .unwrap();
        assert!(worker_replacement_ready(&database, &first_id).unwrap());
        let second_root = replace_coordinator(
            &mut database,
            &task.id,
            &TaskCoordinatorReplacementBody {
                session_id: first_id.clone(),
                root_profile_id: "alternate-root".into(),
                handoff: None,
                resume: false,
                question_id: None,
            },
            &initial,
            now,
        )
        .unwrap();
        // A retry that also names a question without resuming is the same intent.
        assert_eq!(
            replace_coordinator(
                &mut database,
                &task.id,
                &TaskCoordinatorReplacementBody {
                    session_id: first_id.clone(),
                    root_profile_id: "alternate-root".into(),
                    handoff: None,
                    resume: false,
                    question_id: Some("question-current".into()),
                },
                &initial,
                now,
            )
            .unwrap()
            .id,
            second_root.id
        );
        let second_prompt: String = database
            .connection()
            .query_row(
                "SELECT prompt_text FROM suplex_task_turns WHERE session_id = ?1",
                [second_root.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(second_prompt.contains(
            "Earlier additional directions from the user, in order:\nCheck the failed provider."
        ));
        assert!(second_prompt.contains("The task is active. Reassess these questions"));
        assert_eq!(
            normalize_generated_ids(&second_prompt),
            normalize_generated_ids(source["secondPrompt"].as_str().unwrap())
        );
        let second_hash: String = database
            .connection()
            .query_row(
                "SELECT prompt_hash FROM suplex_task_turns WHERE session_id = ?1",
                [second_root.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(second_hash, sha256_hex(second_prompt.as_bytes()));
        assert_eq!(
            current_worker(&database, &task.id).unwrap().unwrap().id,
            second.id.as_str()
        );
        database.connection().execute(
            "INSERT INTO suplex_provider_instances (id,provider,label,home_directory,created_at,updated_at) VALUES ('client','claude-code','Client','/dedicated/client',?1,?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,provider_instance_id,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('client-worker','Client','worker','client','claude-code','client','sonnet','high','default',?1,?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let policy =
            serde_json::json!({"allowedProviders":["claude-code"],"allowedInstanceIds":["client"]})
                .to_string();
        database.connection().execute(
            "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.providerPolicy', json(?1)) WHERE id = ?2",
            params![policy, task.id],
        ).unwrap();
        let denied = replace_worker(
            &mut database,
            &task.id,
            &TaskWorkerReplacementBody {
                session_id: second.id.clone(),
                reason: "Try disallowed login".into(),
                handoff: None,
                worker_profile_id: Some("alternate-worker".into()),
            },
            now,
        );
        assert!(
            denied
                .unwrap_err()
                .to_string()
                .contains("allowed by this project")
        );
        let dedicated = replace_worker(
            &mut database,
            &task.id,
            &TaskWorkerReplacementBody {
                session_id: second.id.clone(),
                reason: "Use client login".into(),
                handoff: None,
                worker_profile_id: Some("client-worker".into()),
            },
            now,
        )
        .unwrap();
        assert_eq!(
            dedicated.profile.as_ref().unwrap().provider_instance_id,
            Some(Some("client".into()))
        );
        assert_eq!(
            dedicated.profile.as_ref().unwrap().instance_home_directory,
            Some(Some("/dedicated/client".into()))
        );
        let inherited = replace_worker(
            &mut database,
            &task.id,
            &TaskWorkerReplacementBody {
                session_id: dedicated.id.clone(),
                reason: "Fresh native session".into(),
                handoff: None,
                worker_profile_id: None,
            },
            now,
        )
        .unwrap();
        assert_eq!(inherited.profile, dedicated.profile);
        database.connection().execute(
            "UPDATE suplex_task_sessions SET stopped_at = ?1,lifecycle = 'stopped' WHERE id = ?2",
            params![rfc3339_millis(now), inherited.id],
        ).unwrap();
        let inspect_again = replace_worker(
            &mut database,
            &task.id,
            &TaskWorkerReplacementBody {
                session_id: inherited.id.clone(),
                reason: "Fresh native inspection".into(),
                handoff: None,
                worker_profile_id: None,
            },
            now,
        )
        .unwrap();
        assert!(!worker_replacement_ready(&database, &inspect_again.id).unwrap());
        let retired: (Option<String>, Option<String>) = database
            .connection()
            .query_row(
                "SELECT stop_requested_at,stopped_at FROM suplex_task_sessions WHERE id = ?1",
                [&inherited.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(retired.0.is_some());
        assert!(retired.1.is_none());
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn lifecycle_events_follow_start_queue_wait_and_prerequisite_release() {
        let filename =
            std::env::temp_dir().join(format!("suplex_events_{}.sqlite", Uuid::new_v4()));
        let logs = crate::platform::system_events::install_for_test();
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('event_company','Events','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('event_project','event_company','Events','/tmp/event-repo','/tmp/event-worktrees',NULL,'main','','','root','worker',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let first = PreparedTask {
            id: repository::new_task_id(),
            company_id: "event_company".into(),
            project_id: "event_project".into(),
            title: "First".into(),
            description: "".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-first","baseBranch":"main","baselineSha":"head"}),
            idempotency_key: "event-first".into(),
            request_hash: "event-first-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-first","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        };
        let a = repository::create(&mut database, &first, now)
            .unwrap()
            .task
            .id;
        let second = PreparedTask {
            id: repository::new_task_id(),
            idempotency_key: "event-second".into(),
            request_hash: "event-second-hash".into(),
            start_queued: false,
            depends_on: vec![a.clone()],
            pull_request_dependencies: vec![],
            ..first.clone()
        };
        let b = repository::create(&mut database, &second, now)
            .unwrap()
            .task
            .id;
        repository::start(&mut database, &b, now).unwrap();
        assert_eq!(
            mark_delivered(&mut database, &a, now).unwrap(),
            vec![b.clone()]
        );
        let events = std::fs::read_to_string(logs.join("system.log"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|event| event["taskId"] == a.as_str() || event["taskId"] == b.as_str())
            .map(|mut event| {
                let fields = event.as_object_mut().unwrap();
                for key in [
                    "schemaVersion",
                    "time",
                    "eventId",
                    "bootId",
                    "sequence",
                    "pid",
                    "bootElapsedMs",
                ] {
                    assert!(fields.remove(key).is_some());
                }
                event
            })
            .collect::<Vec<_>>();
        assert_eq!(
            events,
            vec![
                json!({"type":"task_status","taskId":a,"status":"queued"}),
                json!({"type":"task_status","taskId":a,"status":"active","previousStatus":"queued"}),
                json!({"type":"task_admitted","taskId":a,"trigger":"scheduler sweep"}),
                json!({"type":"task_status","taskId":b,"status":"backlog"}),
                json!({"type":"task_status","taskId":b,"status":"queued","previousStatus":"backlog"}),
                json!({"type":"queue_wait","taskId":b,"waits":[{"id":a,"reason":"prerequisite_running"}]}),
                json!({"type":"task_status","taskId":a,"status":"delivered","previousStatus":"active"}),
                json!({"type":"task_status","taskId":b,"status":"active","previousStatus":"queued"}),
                json!({"type":"task_admitted","taskId":b,"trigger":"prerequisite completion","prerequisiteTaskId":a}),
            ]
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    /// A pull request target prerequisite completes when its pull request merges.
    #[test]
    fn pull_request_target_prerequisites_release_dependents_when_the_pull_request_merges() {
        let filename =
            std::env::temp_dir().join(format!("suplex_merge_wait_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        crate::billing::tests::grant_pro(&database);
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('merge_company','Merge','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('merge_project','merge_company','Merge','/tmp/merge-repo','/tmp/merge-worktrees',NULL,'main','','','root','worker',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let waits = |database: &SuplexDatabase, id: &str| {
            let response = crate::tasks::response::get(database, id).unwrap().unwrap();
            serde_json::to_value(&response).unwrap()["queue"]["waitingOn"]
                .as_array()
                .unwrap()
                .iter()
                .map(|wait| {
                    (
                        wait["id"].as_str().unwrap().to_owned(),
                        wait["reason"].as_str().unwrap().to_owned(),
                        wait["summary"].as_str().unwrap().to_owned(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let status = |database: &SuplexDatabase, id: &str| -> String {
            database
                .connection()
                .query_row(
                    "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let observe = |database: &SuplexDatabase, id: &str, state: Option<&str>| {
            let pull = state.map(|state| format!(r#"{{"repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","headSha":"head","state":"{state}","mergedAt":null}}"#));
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_controls SET pull_request_json = ?1 WHERE task_id = ?2",
                    params![pull, id],
                )
                .unwrap();
        };
        for (index, target) in [
            "pull_request_draft",
            "pull_request_ready",
            "merged",
            "remote_branch",
            "local_worktree",
        ]
        .into_iter()
        .enumerate()
        {
            let first = PreparedTask {
                id: repository::new_task_id(),
                company_id: "merge_company".into(),
                project_id: "merge_project".into(),
                title: "First".into(),
                description: "".into(),
                configuration: serde_json::json!({"repository":"owner/repo","repositoryPath":"/tmp/merge-repo","worktreeRoot":"/tmp/merge-worktrees","branch":format!("task-first-{index}"),"baseBranch":"main","baselineSha":"head","startingSha":"head","source":null,"capturedAt":"2026-09-25T12:00:00.000Z"}),
                idempotency_key: format!("merge-first-{index}"),
                request_hash: format!("merge-first-hash-{index}"),
                creator: TaskCreator::User(user.id.clone()),
                delivery_target: target.into(),
                delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":format!("task-first-{index}"),"baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![],
                workflow: crate::coordination::workflows::Workflow::Standard,
            };
            let a = repository::create(&mut database, &first, now)
                .unwrap()
                .task
                .id;
            let b = repository::create(
                &mut database,
                &PreparedTask {
                    id: repository::new_task_id(),
                    idempotency_key: format!("merge-second-{index}"),
                    request_hash: format!("merge-second-hash-{index}"),
                    delivery_target: "local_worktree".into(),
                    depends_on: vec![a.clone()],
                    ..first.clone()
                },
                now,
            )
            .unwrap()
            .task
            .id;
            // An active dependent keeps its turns while the pull request is open.
            let active = repository::create(
                &mut database,
                &PreparedTask {
                    id: repository::new_task_id(),
                    idempotency_key: format!("merge-active-{index}"),
                    request_hash: format!("merge-active-hash-{index}"),
                    delivery_target: "local_worktree".into(),
                    depends_on: vec![],
                    ..first.clone()
                },
                now,
            )
            .unwrap()
            .task
            .id;
            database.connection().execute(
                "INSERT INTO suplex_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?1, ?2, ?3)",
                params![active, a, rfc3339_millis(now)],
            ).unwrap();
            observe(&database, &a, Some("open"));
            let released = mark_delivered(&mut database, &a, now).unwrap();
            assert!(!crate::tasks::dependencies::blocked(&database, &active).unwrap());
            // Admission and the queue projection agree for every observed pull request state.
            let backlog = repository::create(
                &mut database,
                &PreparedTask {
                    id: repository::new_task_id(),
                    idempotency_key: format!("merge-backlog-{index}"),
                    request_hash: format!("merge-backlog-hash-{index}"),
                    delivery_target: "local_worktree".into(),
                    start_queued: false,
                    depends_on: vec![a.clone()],
                    ..first.clone()
                },
                now,
            )
            .unwrap()
            .task
            .id;
            for state in [None, Some("open"), Some("closed"), Some("merged")] {
                observe(&database, &a, state);
                assert_eq!(
                    repository::prerequisites_complete(&database, &backlog).unwrap(),
                    waits(&database, &backlog).is_empty(),
                    "{target} {state:?}"
                );
            }
            observe(&database, &a, Some("open"));
            if matches!(target, "remote_branch" | "local_worktree") {
                assert_eq!(released, vec![b.clone()], "{target}");
                assert!(waits(&database, &b).is_empty());
                continue;
            }
            assert!(released.is_empty(), "{target}");
            assert_eq!(status(&database, &b), "queued");
            let open = waits(&database, &b);
            assert_eq!(open.len(), 1);
            assert_eq!(open[0].0, a);
            if target == "merged" {
                assert_eq!(open[0].1, "prerequisite_merge_unobserved");
            } else {
                assert_eq!(open[0].1, "prerequisite_pull_request_open");
                assert_eq!(
                    open[0].2,
                    "First is delivered, and its pull request is open. This task starts when its pull request merges."
                );
                observe(&database, &a, Some("closed"));
                assert!(admit_queued(&mut database, now).unwrap().is_empty());
                let closed = waits(&database, &b);
                assert_eq!(closed[0].1, "prerequisite_pull_request_closed");
                assert_eq!(
                    closed[0].2,
                    "First is delivered, but its pull request is closed without merging. Reopen and merge it, or remove First from Blocked by."
                );
            }
            observe(&database, &a, None);
            assert!(admit_queued(&mut database, now).unwrap().is_empty());
            let unobserved = waits(&database, &b);
            assert_eq!(unobserved[0].1, "prerequisite_merge_unobserved");
            assert!(unobserved[0].2.contains("Suplex checks GitHub again"));
            observe(&database, &a, Some("merged"));
            assert_eq!(admit_queued(&mut database, now).unwrap(), vec![b.clone()]);
            assert_eq!(status(&database, &b), "active");
            assert!(waits(&database, &b).is_empty());
        }
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    /// The typed rows keep the JSON of the json_object projection they replaced.
    #[test]
    fn typed_rows_serialize_like_the_persisted_json_projection() {
        let filename = std::env::temp_dir().join(format!("suplex_rows_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('rows_company','Rows','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('rows_project','rows_company','Rows','/tmp/rows-repo','/tmp/rows-worktrees',NULL,'main','','','root','worker',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let profile = serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default","providerInstanceId":null,"instanceHomeDirectory":"/home/rows"});
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "rows_company".into(),
            project_id: "rows_project".into(),
            title: "Rows".into(),
            description: "Keep \"quotes\" and é".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-rows","baseBranch":"main","baselineSha":"head","runProjectTests":false,"visualEvidence":"off"}),
            idempotency_key: "rows-key".into(),
            request_hash: "rows-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "pull_request_draft".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-rows","baseBranch":"main","baselineSha":"head","pullRequestNumber":7})).unwrap(),
            root_profile: serde_json::from_value(profile.clone()).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({"reviewer":profile})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        };
        let task = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task;
        let root = reserve_root(&mut database, &task.id, now).unwrap();
        let worker = launch_standard_worker(
            &mut database,
            &root,
            "Assignment",
            "Worker assignment",
            Some(&serde_json::json!({"kind":"worker","mode":"direct"})),
            now,
        )
        .unwrap();
        replace_worker(
            &mut database,
            &task.id,
            &TaskWorkerReplacementBody {
                session_id: worker.id,
                reason: "Retry".into(),
                handoff: None,
                worker_profile_id: None,
            },
            now,
        )
        .unwrap();
        database.connection().execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1, pull_request_json = ?2, limit_pause_json = '{\"kind\":\"task_limit\"}', workflow_state_json = ?3 WHERE task_id = ?4",
            params![
                r#"{"path":"/tmp/rows","branch":"task-rows","baseSha":"base","headSha":"head","dirty":false}"#,
                r#"{"repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","headSha":"head","state":"open","mergedAt":null}"#,
                r#"{"version":1,"reviews":[{"sessionId":"s","turnId":"t","role":"reviewer","range":{"baseSha":"b","headSha":"h","files":["a"],"commits":["h"],"patchDigest":"d"},"result":{"role":"reviewer","approved":true},"invalidReason":null,"recordedAt":"now"}],"acceptedDelivery":null,"deliveryWait":{"headSha":"h","fingerprint":"f","since":"now","reason":"checks"},"completion":null,"toolOwner":{"token":"x","pid":7,"processStartTime":"start"},"followUp":true}"#,
                task.id,
            ],
        ).unwrap();
        database.connection().execute(
            "UPDATE suplex_task_turns SET dispatch_attempt_json = '{\"serverGeneration\":\"g\",\"claimedAt\":\"now\"}' WHERE session_id = ?1",
            [&root.id],
        ).unwrap();
        let projected = |sql: &str| -> Vec<String> {
            let mut statement = database.connection().prepare(sql).unwrap();
            statement
                .query_map([&task.id], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<String>>>()
                .unwrap()
        };
        let rows = root_observation_rows(&database, &task.id).unwrap();
        assert_eq!(
            vec![serde_json::to_string(&rows.control).unwrap()],
            projected(
                r#"SELECT json_object(
                'taskId',task_id,'objective',objective,'deliveryTarget',delivery_target,
                'deliveryIntent',json(delivery_intent_json),'status',status,'wakeAt',wake_at,
                'humanQuestion',human_question,
                'humanQuestionOptions',json(COALESCE(human_question_options_json,'[]')),
                'humanQuestionId',human_question_id,'recoveryTurnId',recovery_turn_id,
                'limitPause',json(limit_pause_json),'worktree',json(worktree_json),
                'pullRequest',json(pull_request_json),'rootSessionId',root_session_id,
                'workerSessionId',worker_session_id,'shellPaneId',shell_pane_id,
                'rootProfile',json(root_profile_json),'workerProfile',json(worker_profile_json),
                'workflow',workflow,'advisorProfiles',json(advisor_profiles_json),
                'workflowState',json(workflow_state_json))
                FROM suplex_task_controls WHERE task_id = ?1"#
            )
        );
        let sessions = projected(
            r#"SELECT json_object(
            'profile',json(profile_json),
            'replacement',CASE WHEN replaces_session_id IS NULL THEN NULL ELSE json_object(
                'sessionId',replaces_session_id,'reason',replacement_reason,'handoff',replacement_handoff) END,
            'id',id,'taskId',task_id,'kind',kind,'generation',generation,
            'current',json(CASE is_current WHEN 1 THEN 'true' ELSE 'false' END),
            'paneId',pane_id,'nativeSessionId',native_session_id,'lifecycle',lifecycle,
            'assignmentHash',assignment_hash,'launchOwner',launch_owner,
            'launchOwnerPid',launch_owner_pid,'launchOwnerStartTime',launch_owner_start_time,
            'stopRequestedAt',stop_requested_at,'stoppedAt',stopped_at,
            'advisorRole',advisor_role,'delegateSlot',delegate_slot,
            'workflowInput',json(workflow_input_json))
            FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY created_at,id"#,
        );
        assert_eq!(sessions.len(), 3);
        assert_eq!(
            rows.sessions
                .iter()
                .map(|session| serde_json::to_string(session).unwrap())
                .collect::<Vec<_>>(),
            sessions
        );
        let turns = projected(
            r#"SELECT json_object(
            'id',id,'taskId',task_id,'sessionId',session_id,'generation',generation,
            'assignmentHash',assignment_hash,'promptHash',prompt_hash,'promptText',prompt_text,
            'status',status,'promptedAt',prompted_at,'completedAt',completed_at,
            'resultReceiptId',result_receipt_id,'terminalObservation',terminal_observation,
            'nativeTurnId',native_turn_id,'dispatchAttempt',json(dispatch_attempt_json),
            'workflowInput',json(workflow_input_json))
            FROM suplex_task_turns WHERE task_id = ?1 ORDER BY created_at,id"#,
        );
        assert_eq!(
            rows.turns
                .iter()
                .map(|turn| serde_json::to_string(turn).unwrap())
                .collect::<Vec<_>>(),
            turns
        );
        drop(database);
        let _ = std::fs::remove_file(filename);
    }

    #[test]
    fn human_note_reuses_root_and_resumes_delivered_intent_without_replay() {
        let filename = std::env::temp_dir().join(format!("suplex_note_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('note_company','Notes','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('note_project','note_company','Notes','/tmp/note-repo','/tmp/note-worktrees',NULL,'main','','','root','worker',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "note_company".into(),
            project_id: "note_project".into(),
            title: "Note task".into(),
            description: "".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-note","baseBranch":"main","baselineSha":"head","runProjectTests":false,"visualEvidence":"off"}),
            idempotency_key: "note-key".into(),
            request_hash: "note-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-note","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        };
        let task = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task;
        let note = send_note(&mut database, &task.id, " \u{feff}First  ", now).unwrap();
        assert_eq!(note.prompt_text, "Human note:\nFirst");
        let (root_id, note_hash): (String, String) = database
            .connection()
            .query_row(
                "SELECT session_id,prompt_hash FROM suplex_task_turns WHERE id = ?1",
                [&note.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            note_hash,
            "a3d575167f0d45878ed9616d0c2a95a2c62b01365bfc7e5be52dc38a33e118d9"
        );
        assert_eq!(pending_turns(&database, &root_id).unwrap().len(), 2);
        database.connection().execute(
            "UPDATE suplex_task_sessions SET native_session_id = 'codex-retained' WHERE id = ?1",
            [&root_id],
        ).unwrap();
        drop(database);
        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        assert_eq!(pending_turns(&database, &root_id).unwrap().len(), 2);
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'delivered',workflow_state_json = json_set(workflow_state_json,'$.acceptedDelivery',json(?1),'$.completion',json(?2)) WHERE task_id = ?3",
            params![r#"{"baseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","files":["file.txt"],"commits":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]}"#, r#"{"kind":"workflow","reviewedHead":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pullRequestNumber":1597,"observedAt":"2026-09-25T12:00:00.000Z"}"#, task.id],
        ).unwrap();
        database.connection().execute("UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'stopped',stop_requested_at = ?1,stopped_at = ?1 WHERE id = ?2", params![rfc3339_millis(now), root_id]).unwrap();
        let resumed = send_note(&mut database, &task.id, " Follow up ", now).unwrap();
        assert_eq!(resumed.session_id, root_id);
        assert_eq!(
            resumed.prompt_text,
            "{\"question\":\"The user has resumed this delivered task. Handle the follow-up below before completing delivery again. Preserve existing work and inspect current GitHub state. Earlier delivery is history, not completion of this request. For failing checks, read the logs, reproduce and repair the failure, verify locally, push, and observe checks on the current head. Keep the delivery target unchanged. Request delivery explicitly only when the follow-up is satisfied.\",\"answer\":\"Follow up\"}"
        );
        let resumed_hash: String = database
            .connection()
            .query_row(
                "SELECT prompt_hash FROM suplex_task_turns WHERE id = ?1",
                [&resumed.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            resumed_hash,
            "6b9a237b2658b9659363286f8a54845684e413b60d9e3decf4d3006beb066b8b"
        );
        let rows = root_observation_rows(&database, &task.id).unwrap();
        assert_eq!(
            rows.control.status,
            crate::tasks::control::TaskStatus::Active
        );
        assert_eq!(
            serde_json::json!(rows.control.workflow_state)["followUp"],
            true
        );
        assert_eq!(
            serde_json::json!(rows.control.workflow_state)["deliveryHistory"][0]["acceptedDelivery"]
                ["headSha"],
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert_eq!(rows.root.as_ref().unwrap().id, root_id);
        assert_eq!(
            rows.root.as_ref().unwrap().native_session_id.as_deref(),
            Some("codex-retained")
        );
        assert_eq!(pending_turns(&database, &root_id).unwrap().len(), 3);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn committed_claim_survives_reopen_and_budget_pause_never_dispatches() {
        let filename =
            std::env::temp_dir().join(format!("suplex_task_store_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let message_id = new_turn_id(now).unwrap();
        assert_eq!(message_id.len(), 30);
        assert!(message_id.starts_with("msg_0d86fca"));
        assert!(
            message_id[16..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric())
        );
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_task_test', 'Task test', 'active', ?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, created_at, updated_at) VALUES ('project_task_test', 'company_task_test', 'Task project', '/tmp/suplex-task-project', '/tmp/suplex-task-worktrees', NULL, 'main', '', '', 'profile_native_root', 'profile_native_worker', ?1, ?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "company_task_test".into(),
            project_id: "project_task_test".into(),
            title: "One task".into(),
            description: "Run Codex".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-one","baseBranch":"main","baselineSha":"head"}),
            idempotency_key: "task-key".into(),
            request_hash: "same-request".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-one","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(serde_json::json!({"profileId":"profile_native_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"profile_native_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        };
        let created = repository::create(&mut database, &prepared, now).unwrap();
        assert!(created.created);
        assert_eq!(created.task.status, TaskStatus::Active);
        let repeated = repository::create(&mut database, &prepared, now).unwrap();
        assert!(!repeated.created);
        assert_eq!(created.task.id, repeated.task.id);
        let blocked_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Dependent task".into(),
            idempotency_key: "dependent-key".into(),
            request_hash: "dependent-request".into(),
            depends_on: vec![created.task.id.clone()],
            pull_request_dependencies: vec![],
            ..prepared.clone()
        };
        let blocked = repository::create(&mut database, &blocked_input, now).unwrap();
        assert_eq!(blocked.task.status, TaskStatus::Queued);
        let backlog_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Manual task".into(),
            idempotency_key: "manual-key".into(),
            request_hash: "manual-request".into(),
            start_queued: false,
            ..prepared.clone()
        };
        let backlog = repository::create(&mut database, &backlog_input, now).unwrap();
        assert_eq!(backlog.task.status, TaskStatus::Backlog);
        assert_eq!(
            repository::start(&mut database, &backlog.task.id, now)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Active
        );
        let pull_request_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Pull request task".into(),
            idempotency_key: "pull-request-key".into(),
            request_hash: "pull-request-request".into(),
            configuration: serde_json::json!({"repository":"owner/repo","source":{"kind":"pull_request","number":42}}),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task","baseBranch":"main","baselineSha":"head","pullRequestNumber":42})).unwrap(),
            start_queued: false,
            ..prepared.clone()
        };
        let pull_request = repository::create(&mut database, &pull_request_input, now).unwrap();
        assert!(pull_request.created);
        let conflicting_pull_request = PreparedTask {
            id: repository::new_task_id(),
            idempotency_key: "another-pull-request-key".into(),
            request_hash: "another-pull-request-request".into(),
            ..pull_request_input
        };
        assert!(repository::create(&mut database, &conflicting_pull_request, now).is_err());
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'delivered' WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        assert_eq!(
            repository::start(&mut database, &blocked.task.id, now)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Active
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        let root = reserve_root(&mut database, &created.task.id, now).unwrap();
        assert!(Uuid::parse_str(&root.id).is_ok());
        let observed = root_observation_rows(&database, &created.task.id).unwrap();
        assert_eq!(
            observed.control.status,
            crate::tasks::control::TaskStatus::Active
        );
        assert_eq!(serde_json::json!(observed.control)["workflow"], "standard");
        assert_eq!(observed.context["configuration"]["branch"], "task-one");
        assert_eq!(observed.root.as_ref().unwrap().id, root.id);
        assert!(observed.worker.is_none());
        assert!(observed.workers.is_empty());
        assert!(observed.turns.is_empty());
        assert_current_root(&database, &created.task.id, &root.id, root.generation).unwrap();
        assert!(
            assert_current_root(&database, &created.task.id, &root.id, root.generation + 1)
                .is_err()
        );
        let tool_token = claim_tool_owner(&mut database, &created.task.id, now)
            .unwrap()
            .unwrap();
        assert!(
            claim_tool_owner(&mut database, &created.task.id, now)
                .unwrap()
                .is_none()
        );
        assert_tool_owner(&database, &created.task.id, &tool_token).unwrap();
        release_tool_owner(&mut database, &created.task.id, "wrong-token").unwrap();
        assert_tool_owner(&database, &created.task.id, &tool_token).unwrap();
        release_tool_owner(&mut database, &created.task.id, &tool_token).unwrap();
        assert!(assert_tool_owner(&database, &created.task.id, &tool_token).is_err());
        let worker = launch_standard_worker(
            &mut database,
            &root,
            "Implement",
            "Worker assignment: Implement",
            None,
            now,
        )
        .unwrap();
        assert_eq!(worker.kind, crate::tasks::control::SessionKind::Worker);
        assert!(
            root_observation_rows(&database, &created.task.id)
                .unwrap()
                .turns[0]
                .id
                .starts_with("msg_")
        );
        assert!(
            launch_standard_worker(
                &mut database,
                &root,
                "Duplicate",
                "Worker assignment: Duplicate",
                None,
                now,
            )
            .is_err()
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_turns SET status = 'completed' WHERE session_id = ?1",
                [worker.id.as_str()],
            )
            .unwrap();
        let next_worker = launch_standard_worker(
            &mut database,
            &root,
            "Verify",
            "Worker assignment: Verify",
            None,
            now,
        )
        .unwrap();
        assert_eq!(next_worker.id, worker.id);
        assert_eq!(next_worker.generation, 2);
        let turn = ensure_initial_prompt(&mut database, &root, "Begin", now)
            .unwrap()
            .unwrap();
        assert!(turn.id.starts_with("msg_"));
        assert!(
            claim_session_operation(&mut database, &root, "owner-one", 123, "process-start", now)
                .unwrap()
        );
        let session_directory = filename.with_extension("session");
        std::fs::create_dir_all(&session_directory).unwrap();
        let args = vec!["-c".to_owned(), "sleep 1; cat >/dev/null".to_owned()];
        let environment = HashMap::new();
        let dispatch_input = || DispatchInput {
            directory: &session_directory,
            worktree: session_directory.parent().unwrap(),
            session_id: &root.id,
            turn_id: &turn.id,
            executable: Path::new("/bin/sh"),
            args: &args,
            prompt: "Begin",
            environment: &environment,
        };
        let native = headless::dispatch(dispatch_input(), |generation| {
            claim_prompt(
                &mut database,
                &turn,
                "owner-one",
                generation,
                ObservedTaskLimitUsage {
                    estimated_cost_usd: None,
                },
                now,
            )
        })
        .unwrap();
        assert!(
            headless::dispatch(dispatch_input(), |generation| {
                claim_prompt(
                    &mut database,
                    &turn,
                    "owner-one",
                    generation,
                    ObservedTaskLimitUsage {
                        estimated_cost_usd: None,
                    },
                    now,
                )
            })
            .is_err()
        );
        drop(database);

        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        let recovered = headless::read_record(&session_directory.join("turn.json"))
            .unwrap()
            .unwrap();
        assert_eq!(recovered.generation, native.generation);
        assert_eq!(recovered.turn_id, turn.id);
        let exit_file = headless::turn_file(&session_directory, &turn.id, "exit");
        for _ in 0..30 {
            if exit_file.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert_eq!(std::fs::read_to_string(&exit_file).unwrap().trim(), "0");
        let pending = pending_turns(&database, &root.id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].status, TurnStatus::Unknown);
        assert_eq!(
            pending[0]
                .dispatch_attempt
                .as_ref()
                .unwrap()
                .server_generation,
            native.generation
        );
        assert!(mark_prompted(&mut database, &pending[0], Some("native-turn"), now).unwrap());
        let second_id = Uuid::new_v4().to_string();
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'hash', 'Continue', 'pending_prompt', ?5, ?5)",
            params![second_id, created.task.id, root.id, root.generation, rfc3339_millis(now)],
        ).unwrap();
        let second = pending_turns(&database, &root.id)
            .unwrap()
            .into_iter()
            .find(|turn| turn.id == second_id)
            .unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'backlog' WHERE task_id = ?1",
                [&backlog.task.id],
            )
            .unwrap();
        database.connection().execute(
            "INSERT INTO suplex_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?1, ?2, ?3)",
            params![created.task.id, backlog.task.id, rfc3339_millis(now)],
        ).unwrap();
        assert!(
            !claim_prompt(
                &mut database,
                &second,
                "owner-one",
                "dependency-regressed",
                ObservedTaskLimitUsage {
                    estimated_cost_usd: None
                },
                now,
            )
            .unwrap()
        );
        let still_active: String = database
            .connection()
            .query_row(
                "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                [&created.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_active, "active");
        database.connection().execute(
            "DELETE FROM suplex_task_dependencies WHERE task_id = ?1 AND depends_on_task_id = ?2",
            params![created.task.id, backlog.task.id],
        ).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET budget_usd = 1 WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        assert!(
            !claim_prompt(
                &mut database,
                &second,
                "owner-one",
                "runtime-generation-three",
                ObservedTaskLimitUsage {
                    estimated_cost_usd: Some(1.0)
                },
                now
            )
            .unwrap()
        );
        let status: String = database
            .connection()
            .query_row(
                "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                [&created.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "waiting_human");
        let attempt: Option<String> = database
            .connection()
            .query_row(
                "SELECT dispatch_attempt_json FROM suplex_task_turns WHERE id = ?1",
                [&second_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(attempt.is_none());
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'active', human_question = NULL, human_question_id = NULL, limit_pause_json = NULL WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        let result = StandardWorkerResult {
            task_id: &created.task.id,
            session_id: worker.id.as_str(),
            generation: next_worker.generation,
            receipt_id: "native:worker:completed",
            observation: "{\"state\":\"completed\"}",
            native_turn_id: Some("native-turn"),
            wake_prompt: "Review the Worker result",
            review: None,
        };
        let wake = record_standard_worker_result_and_wake(&mut database, &result, now)
            .unwrap()
            .unwrap();
        assert_eq!(wake.prompt_text, "Review the Worker result");
        assert!(
            record_standard_worker_result_and_wake(&mut database, &result, now)
                .unwrap()
                .is_none()
        );
        assert!(
            complete_root_turn(
                &mut database,
                &turn.id,
                "{\"state\":\"completed\"}",
                Some("Continue from native state"),
                now
            )
            .unwrap()
        );
        assert!(!complete_root_turn(&mut database, &turn.id, "{}", None, now).unwrap());
        assert!(
            pending_turns(&database, &root.id)
                .unwrap()
                .iter()
                .any(|candidate| candidate.prompt_text == "Continue from native state")
        );
        let waiting_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Release after local delivery".into(),
            idempotency_key: "delivery-dependent-key".into(),
            request_hash: "delivery-dependent-request".into(),
            depends_on: vec![created.task.id.clone()],
            pull_request_dependencies: vec![],
            ..prepared.clone()
        };
        let waiting = repository::create(&mut database, &waiting_input, now).unwrap();
        assert_eq!(waiting.task.status, TaskStatus::Queued);
        set_worktree(
            &mut database,
            &created.task.id,
            &serde_json::from_value(serde_json::json!({
                "path":"/tmp/task-one","branch":"task-one","baseSha":"base",
                "headSha":"head","dirty":true,
            }))
            .unwrap(),
            now,
        )
        .unwrap();
        assert_eq!(
            mark_delivered(&mut database, &created.task.id, now).unwrap(),
            vec![waiting.task.id.clone()]
        );
        assert_eq!(
            repository::task_by_id(&database, &waiting.task.id)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Active
        );
        // As in TypeScript, the released dependent is woken by its committed
        // wake_at; the host's scheduled scan admits it without a notification.
        let due: bool = database
            .connection()
            .query_row(
                "SELECT wake_at <= ?1 FROM suplex_task_controls WHERE task_id = ?2",
                params![rfc3339_millis(now), waiting.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(due);
        assert!(
            mark_delivered(&mut database, &created.task.id, now)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            root_observation_rows(&database, &created.task.id)
                .unwrap()
                .control
                .status,
            crate::tasks::control::TaskStatus::Delivered
        );
        let answer_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Human answer".into(),
            idempotency_key: "answer-key".into(),
            request_hash: "answer-request".into(),
            ..prepared.clone()
        };
        let answer_task = repository::create(&mut database, &answer_input, now)
            .unwrap()
            .task;
        let answer_root = reserve_root(&mut database, &answer_task.id, now).unwrap();
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Use main?', human_question_id = 'question-normal' WHERE task_id = ?1",
            [&answer_task.id],
        ).unwrap();
        assert!(
            answer_human(
                &mut database,
                &answer_task.id,
                "stale",
                "Proceed",
                false,
                None,
                now
            )
            .is_err()
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET lifecycle = 'cancelled' WHERE id = ?1",
                [&answer_root.id],
            )
            .unwrap();
        assert!(
            answer_human(
                &mut database,
                &answer_task.id,
                "question-normal",
                "Proceed",
                false,
                None,
                now
            )
            .is_err()
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET lifecycle = 'reserved' WHERE id = ?1",
                [&answer_root.id],
            )
            .unwrap();
        answer_human(
            &mut database,
            &answer_task.id,
            "question-normal",
            "  Proceed 🌍  ",
            false,
            None,
            now,
        )
        .unwrap();
        let first_answer: (String, String) = database.connection().query_row(
            "SELECT prompt_text,prompt_hash FROM suplex_task_turns WHERE task_id = ?1 ORDER BY rowid DESC LIMIT 1",
            [&answer_task.id], |row| Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(
            first_answer.0,
            "{\"question\":\"Use main?\",\"answer\":\"Proceed 🌍\"}"
        );
        assert_eq!(
            first_answer.1,
            "348686453066142f49a913b2c8803025cc80ee4fbabcc7dd4914317df08b3181"
        );
        assert!(
            answer_human(
                &mut database,
                &answer_task.id,
                "question-normal",
                "Again",
                false,
                None,
                now
            )
            .is_err()
        );
        let interrupted = launch_standard_worker(
            &mut database,
            &answer_root,
            "Implement",
            "Worker assignment: Implement",
            None,
            now,
        )
        .unwrap();
        let worker_turn_id: String = database.connection().query_row(
            "SELECT id FROM suplex_task_turns WHERE session_id = ?1 ORDER BY rowid DESC LIMIT 1",
            [interrupted.id.as_str()], |row| row.get(0),
        ).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_turns SET status = 'prompted' WHERE id = ?1",
                [&worker_turn_id],
            )
            .unwrap();
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Commands interrupted?', human_question_id = 'question-worker', recovery_turn_id = ?1 WHERE task_id = ?2",
            params![worker_turn_id, answer_task.id],
        ).unwrap();
        assert!(
            answer_human(
                &mut database,
                &answer_task.id,
                "question-worker",
                "I stopped commands.",
                false,
                None,
                now
            )
            .is_err()
        );
        answer_human(
            &mut database,
            &answer_task.id,
            "question-worker",
            "I stopped commands.",
            true,
            None,
            now,
        )
        .unwrap();
        let recovered: (String, String, String) = database.connection().query_row(
            "SELECT status,result_receipt_id,terminal_observation FROM suplex_task_turns WHERE id = ?1",
            [&worker_turn_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(recovered.0, "completed");
        assert_eq!(recovered.1, "cleanup:question-worker");
        assert_eq!(
            recovered.2,
            format!(
                "{{\"state\":\"interrupted\",\"reason\":\"operator_confirmed_commands_stopped\",\"questionId\":\"question-worker\",\"answer\":\"I stopped commands.\",\"turnId\":\"{worker_turn_id}\"}}"
            )
        );
        let answer_turns = pending_turns(&database, &answer_root.id).unwrap();
        assert!(answer_turns.iter().any(|turn| {
            turn.prompt_text
                .starts_with("Worker result receipt cleanup:question-worker.")
        }));
        let last_answer: (String, String) = database.connection().query_row(
            "SELECT prompt_text,prompt_hash FROM suplex_task_turns WHERE task_id = ?1 ORDER BY rowid DESC LIMIT 1",
            [&answer_task.id], |row| Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(
            last_answer.0,
            "{\"question\":\"Commands interrupted?\",\"answer\":\"I stopped commands.\"}"
        );
        assert_eq!(
            last_answer.1,
            "02c119667a01036370d700c8a8600a2e588b12556bb4c5b27eece15ad330a9b3"
        );
        assert_eq!(
            repository::task_by_id(&database, &answer_task.id)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Active
        );
        let pause = serde_json::json!({
            "kind":"task_limit", "reason":"budget",
            "limits":{"budgetUsd":15,"maxTurns":40},
            "usage":{"estimatedCostUsd":15,"admittedTurns":3},
            "proposedLimits":{"budgetUsd":25,"maxTurns":40}
        });
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Limit?', human_question_id = 'limit-add', limit_pause_json = ?1 WHERE task_id = ?2",
            params![pause.to_string(), answer_task.id],
        ).unwrap();
        answer_task_limit(
            &mut database,
            &answer_task.id,
            "limit-add",
            &TaskLimitDecision::AddAllowance,
            now,
        )
        .unwrap();
        let added: (String, String, f64, i64) = database.connection().query_row(
            "SELECT t.prompt_text,t.prompt_hash,c.budget_usd,c.max_turns FROM suplex_task_turns t JOIN suplex_task_controls c ON c.task_id = t.task_id WHERE t.task_id = ?1 ORDER BY t.rowid DESC LIMIT 1",
            [&answer_task.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        assert_eq!(
            added.0,
            "{\"question\":\"Limit?\",\"decision\":{\"kind\":\"add_allowance\"}}"
        );
        assert_eq!(
            added.1,
            "d683387a6c26a52e950010d766bcd7195c6b8324c699b32a20993b71ffef84ff"
        );
        assert_eq!((added.2, added.3), (25.0, 40));
        assert!(
            answer_task_limit(
                &mut database,
                &answer_task.id,
                "limit-add",
                &TaskLimitDecision::AddAllowance,
                now
            )
            .is_err()
        );
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Limit again?', human_question_id = 'limit-change', limit_pause_json = ?1 WHERE task_id = ?2",
            params![pause.to_string(), answer_task.id],
        ).unwrap();
        answer_task_limit(
            &mut database,
            &answer_task.id,
            "limit-change",
            &TaskLimitDecision::ChangeLimits {
                limits: crate::tasks::control::TaskLimits {
                    budget_usd: 30.0,
                    max_turns: 60,
                },
            },
            now,
        )
        .unwrap();
        let changed: (String, String, f64, i64) = database.connection().query_row(
            "SELECT t.prompt_text,t.prompt_hash,c.budget_usd,c.max_turns FROM suplex_task_turns t JOIN suplex_task_controls c ON c.task_id = t.task_id WHERE t.task_id = ?1 ORDER BY t.rowid DESC LIMIT 1",
            [&answer_task.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        assert_eq!(
            changed.0,
            "{\"question\":\"Limit again?\",\"decision\":{\"kind\":\"change_limits\",\"limits\":{\"budgetUsd\":30,\"maxTurns\":60}}}"
        );
        assert_eq!(
            changed.1,
            "01bccddaaae04b2b221a6ae690313c8054b2d22cddfd8bbcca7ef3a6ac5a5578"
        );
        assert_eq!((changed.2, changed.3), (30.0, 60));
        let cancelled_worker = launch_standard_worker(
            &mut database,
            &answer_root,
            "Finish remaining work",
            "Worker assignment: Finish remaining work",
            None,
            now,
        )
        .unwrap();
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Cancel?', human_question_id = 'limit-cancel', limit_pause_json = ?1 WHERE task_id = ?2",
            params![pause.to_string(), answer_task.id],
        ).unwrap();
        answer_task_limit(
            &mut database,
            &answer_task.id,
            "limit-cancel",
            &TaskLimitDecision::CancelTask,
            now,
        )
        .unwrap();
        assert_eq!(
            repository::task_by_id(&database, &answer_task.id)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Cancelled
        );
        let outstanding: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status IN ('pending_prompt','prompted','unknown')",
            [&answer_task.id], |row| row.get(0),
        ).unwrap();
        assert_eq!(outstanding, 0);
        let late_result = StandardWorkerResult {
            task_id: &answer_task.id,
            session_id: &cancelled_worker.id,
            generation: cancelled_worker.generation,
            receipt_id: "native:late-worker:completed",
            observation: "{\"state\":\"completed\"}",
            native_turn_id: Some("late-native-turn"),
            wake_prompt: "Review a cancelled Worker result",
            review: None,
        };
        assert!(record_standard_worker_result_and_wake(&mut database, &late_result, now).is_err());
        let late_wakes: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompt_text = ?2",
                params![answer_task.id, late_result.wake_prompt],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(late_wakes, 0);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
        let _ = std::fs::remove_dir_all(&session_directory);
    }

    /// A project's task concurrency counts active and waiting tasks, admits the
    /// oldest queued task when a slot frees, and leaves other projects alone.
    #[test]
    fn project_task_concurrency_admits_oldest_queued_task_per_free_slot() {
        let filename =
            std::env::temp_dir().join(format!("suplex_concurrency_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('limit_company','Limit','active',?1)", [rfc3339_millis(now)]).unwrap();
        for project in ["limited_project", "open_project"] {
            database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES (?1,'limit_company',?1,'/tmp/' || ?1,'/tmp/' || ?1 || '-worktrees',NULL,'main','','','root','worker',?2,?2)", params![project, rfc3339_millis(now)]).unwrap();
        }
        let profile = serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"});
        let create = |database: &mut SuplexDatabase, project: &str, key: &str| {
            repository::create(database, &PreparedTask {
                id: repository::new_task_id(),
                company_id: "limit_company".into(),
                project_id: project.into(),
                title: key.into(),
                description: String::new(),
                configuration: serde_json::json!({"repository":"owner/repo","repositoryPath":"/tmp/repo","worktreeRoot":"/tmp/worktrees","branch":key,"baseBranch":"main","baselineSha":"head","startingSha":"head","setupCommand":"","verificationCommand":"","capturedAt":rfc3339_millis(now),"runProjectTests":false,"visualEvidence":"off"}),
                idempotency_key: key.into(),
                request_hash: key.into(),
                creator: TaskCreator::User(user.id.clone()),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":key,"baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(profile.clone()).unwrap(),
                worker_profile: serde_json::from_value(profile.clone()).unwrap(),
                advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![],
                workflow: crate::coordination::workflows::Workflow::Standard,
            }, now).unwrap().task.id
        };
        // Without a limit, every queued task starts.
        let unlimited = [create(&mut database, "limited_project", "unlimited-a"), create(&mut database, "limited_project", "unlimited-b")];
        let open = create(&mut database, "open_project", "open-a");
        let status = |database: &SuplexDatabase, id: &str| -> String {
            database.connection().query_row("SELECT status FROM suplex_task_controls WHERE task_id = ?1", [id], |row| row.get(0)).unwrap()
        };
        for id in unlimited.iter().chain([&open]) {
            assert_eq!(status(&database, id), "active");
        }
        database.connection().execute("UPDATE suplex_task_controls SET status = 'delivered' WHERE task_id IN (?1, ?2)", params![unlimited[0], unlimited[1]]).unwrap();
        database.connection().execute("UPDATE suplex_projects SET task_concurrency = 1 WHERE id = 'limited_project'", []).unwrap();

        let capacity_wait = |database: &SuplexDatabase, id: &str| {
            serde_json::to_value(repository::task_response(database, id).unwrap().unwrap()).unwrap()["queue"]["projectConcurrencyLimited"].as_bool().unwrap()
        };
        let running = create(&mut database, "limited_project", "running");
        let newer = create(&mut database, "limited_project", "newer");
        let older = create(&mut database, "limited_project", "older");
        let other = create(&mut database, "open_project", "open-b");
        assert_eq!(status(&database, &running), "active");
        assert_eq!(status(&database, &newer), "queued");
        assert_eq!(status(&database, &older), "queued");
        assert!(capacity_wait(&database, &newer));
        assert!(!capacity_wait(&database, &running));
        assert!(!capacity_wait(&database, &other));
        // Another project still starts while this one is full.
        assert_eq!(status(&database, &other), "active");
        // Queue time orders the queue, not creation time.
        database.connection().execute("UPDATE suplex_task_controls SET status_changed_at = '2026-09-25T11:00:00.000Z' WHERE task_id = ?1", [&older]).unwrap();
        database.connection().execute("UPDATE suplex_task_controls SET status_changed_at = '2026-09-25T11:30:00.000Z' WHERE task_id = ?1", [&newer]).unwrap();
        assert!(admit_queued(&mut database, now).unwrap().is_empty());

        // A task waiting on a human holds its slot.
        database.connection().execute("UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Continue?', human_question_id = 'question_limit' WHERE task_id = ?1", [&running]).unwrap();
        assert!(admit_queued(&mut database, now).unwrap().is_empty());
        assert_eq!(status(&database, &older), "queued");
        assert!(capacity_wait(&database, &older));

        database.connection().execute("UPDATE suplex_task_controls SET status = 'delivered', human_question = NULL, human_question_id = NULL WHERE task_id = ?1", [&running]).unwrap();
        assert!(!capacity_wait(&database, &older));
        assert_eq!(admit_queued(&mut database, now).unwrap(), vec![older.clone()]);
        assert_eq!(status(&database, &newer), "queued");

        // An archived task does not hold a slot.
        database.connection().execute("UPDATE suplex_tasks SET archived_at = ?1 WHERE id = ?2", params![rfc3339_millis(now), older]).unwrap();
        assert!(!capacity_wait(&database, &newer));
        assert_eq!(admit_queued(&mut database, now).unwrap(), vec![newer.clone()]);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
