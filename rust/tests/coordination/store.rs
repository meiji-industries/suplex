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
    use std::{collections::HashMap, path::Path, process::Command};

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
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('replace_project','replace_company','Replace','/tmp/replace-repo','/tmp/replace-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [rfc3339_millis(now)]).unwrap();
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
            pull_request_dependencies: vec![],
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
        assert_eq!(second.profile.as_ref().unwrap().reasoning_level, "high");
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
        let source_oracle = if std::env::var_os("SUPLEX_COORDINATOR_TS_ORACLE").is_some() {
            let snapshot = filename.with_extension("oracle.sqlite");
            database
                .connection()
                .execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])
                .unwrap();
            let output = Command::new("node")
                .args([
                    "node_modules/tsx/dist/cli.mjs",
                    "tests/support/coordinator-replacement-interop.ts",
                ])
                .arg(&snapshot)
                .arg(&task.id)
                .arg(&root.id)
                .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let _ = std::fs::remove_file(snapshot);
            Some(serde_json::from_slice::<Value>(&output.stdout).unwrap())
        } else {
            None
        };
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
        if let Some(source) = &source_oracle {
            assert_eq!(first_prompt.0, source["firstPrompt"]);
            assert_eq!(first_prompt.1, source["firstHash"]);
        }
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
        if let Some(source) = &source_oracle {
            assert_eq!(second_prompt, source["secondPrompt"]);
            assert_eq!(sha256_hex(second_prompt.as_bytes()), source["secondHash"]);
        }
        assert_eq!(
            current_worker(&database, &task.id).unwrap().unwrap().id,
            second.id.as_str()
        );
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
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('event_project','event_company','Events','/tmp/event-repo','/tmp/event-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [rfc3339_millis(now)]).unwrap();
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
            pull_request_dependencies: vec![],
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
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('rows_project','rows_company','Rows','/tmp/rows-repo','/tmp/rows-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [rfc3339_millis(now)]).unwrap();
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
            pull_request_dependencies: vec![],
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
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('note_project','note_company','Notes','/tmp/note-repo','/tmp/note-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [rfc3339_millis(now)]).unwrap();
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
            pull_request_dependencies: vec![],
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
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('project_task_test', 'company_task_test', 'Task project', '/tmp/suplex-task-project', '/tmp/suplex-task-worktrees', NULL, 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', ?1, ?1)",
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
            pull_request_dependencies: vec![],
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
                TaskLimitUsage {
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
                    TaskLimitUsage {
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
                TaskLimitUsage {
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
                TaskLimitUsage {
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
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
        let _ = std::fs::remove_dir_all(&session_directory);
    }
}

pub(crate) use super::persistence::new_turn_id;
