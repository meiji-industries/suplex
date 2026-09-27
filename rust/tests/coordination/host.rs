#[cfg(test)]
mod host_tests {
    use super::*;
    use crate::runtimes::task_harness::{NativeTimeline, UsageEntry};
    use crate::shared::time::rfc3339_millis;
    use crate::tasks::host::{due_task_ids, scheduled_task_ids, sweep_task};
    use crate::tasks::limits::replace_observed_usage;
    use crate::tasks::limits::{
        estimate_unpriced_usage, observed_usage, reconcile_limit_pause, settle_usage,
    };
    use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

    use crate::{
        coordination::root_controller,
        delivery::operations,
        identity::auth,
        profiles::model_pricing::ModelPricing,
        runtimes::{codex::usage, native::UsageTokens},
        tasks::{
            commands,
            repository::{self, PreparedTask, TaskCreator},
        },
    };

    #[test]
    fn claimed_or_prompted_turns_are_never_assumed_absent() {
        let mut turn = TurnRow {
            task_id: "task_one".into(),
            prompt_text: "Work".into(),
            ..TurnRow::fixture("msg_one", "session_one", TurnStatus::PendingPrompt)
        };
        assert_eq!(dispatch_state(&turn), DispatchState::NotSubmitted);
        turn.dispatch_attempt = Some(PromptDispatchAttempt {
            server_generation: "generation".into(),
            claimed_at: "now".into(),
        });
        assert_eq!(dispatch_state(&turn), DispatchState::Ambiguous);
        turn.status = TurnStatus::Unknown;
        assert_eq!(dispatch_state(&turn), DispatchState::Ambiguous);
    }

    #[test]
    fn standard_worker_wake_matches_pinned_typescript_bytes() {
        let prompt = crate::coordination::root_prompts::worker_result_wake(
            crate::coordination::workflows::Workflow::Standard,
            "codex-one:msg-one:completed",
            &crate::coordination::root_prompts::WorkerResult {
                turn_id: "msg-one",
                state: "completed",
                text: "  Worker completed the fixture.  ",
                verification_range: None,
            },
            "implementation",
        );
        assert_eq!(
            crate::shared::hash::sha256_hex(prompt.as_bytes()),
            "0006b216cc05f1c1ec971806987c6347b055fc06ea7e566704453e26feeb2267"
        );
    }

    #[test]
    fn interrupted_terminal_uses_native_record_generation() {
        let directory =
            std::env::temp_dir().join(format!("suplex-native-terminal-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::write(
            directory.join("dispatch-database-attempt.json"),
            serde_json::json!({
                "generation":"native-generation","turnId":"msg-one","sessionID":"codex-one",
                "pid":1,"processIdentity":{"command":"codex","executable":"/bin/codex",
                    "argv":[],"processGroup":1,"startTime":"one","ownerUid":1},
                "dispatchArguments":[],
            })
            .to_string(),
        )
        .unwrap();
        let turn = TurnRow {
            task_id: "task-one".into(),
            dispatch_attempt: Some(PromptDispatchAttempt {
                server_generation: "database-attempt".into(),
                claimed_at: "now".into(),
            }),
            ..TurnRow::fixture("msg-one", "session-one", TurnStatus::Prompted)
        };
        let observation = PromptObservation {
            state: PromptState::Interrupted,
            admission_observed: true,
            retry_allowed: false,
            reason: "dispatch_process_stopped",
            unsettled_tool_ids: Vec::new(),
            native_final_observed: false,
            process_running: false,
            execution_uncertain: false,
        };
        let terminal =
            terminal_observation(&observation, serde_json::json!({}), "", &directory, &turn)
                .unwrap();
        assert_eq!(
            serde_json::to_string(&terminal).unwrap(),
            "{\"state\":\"interrupted\",\"native\":{},\"reason\":\"dispatch_process_stopped\",\"interruptedExecution\":{\"stoppedServerGeneration\":\"native-generation\"},\"text\":\"\"}"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn project_scope_keeps_context_and_excludes_credential_references() {
        let configuration = serde_json::json!({
            "integration":{"repository":{"kind":"bitbucket","tokenEnvironment":"BB_TOKEN","usernameEnvironment":"BB_USER"},"tracker":{"kind":"jira","emailEnvironment":"JIRA_EMAIL","tokenEnvironment":"JIRA_TOKEN"}},
            "execution":{"instructions":"Follow project instructions","environment":{"PROJECT_MODE":"strict"},"mcp":[{"transport":{"type":"http","headers":{"Authorization":"MCP_TOKEN"}}}]}
        });
        let scope = project_launch_scope(
            &configuration,
            &serde_json::json!({"key":"ISSUE-1"}),
            Path::new("/tmp/suplex/data/suplex.sqlite"),
            "task_one",
        );
        assert_eq!(scope.environment["PROJECT_MODE"], "strict");
        assert_eq!(
            scope.excluded_keys,
            [
                "BB_TOKEN",
                "BB_USER",
                "JIRA_EMAIL",
                "JIRA_TOKEN",
                "MCP_TOKEN"
            ]
        );
        assert!(
            scope
                .context
                .as_deref()
                .unwrap()
                .contains("Associated issue context")
        );
        assert_eq!(
            scope.context_path.unwrap(),
            Path::new("/tmp/suplex/data/runtime/task-preparation/task_one/context.md")
        );
    }

    #[test]
    fn owner_observation_keeps_unknown_claims_and_stops_only_safe_retirements() {
        let running = ProcessOwnerObservation::Running {
            start_time: "same".into(),
        };
        assert!(claim_owner_busy(None, running.clone()));
        assert!(claim_owner_busy(Some("same"), running.clone()));
        assert!(!claim_owner_busy(Some("old"), running.clone()));
        assert!(claim_owner_busy(
            Some("old"),
            ProcessOwnerObservation::Unknown
        ));
        assert!(!claim_owner_busy(
            Some("old"),
            ProcessOwnerObservation::Absent
        ));
        assert!(!retired_owner_can_stop(Some("same"), running.clone()));
        assert!(retired_owner_can_stop(None, running.clone()));
        assert!(retired_owner_can_stop(Some("old"), running));
        assert!(!retired_owner_can_stop(
            Some("old"),
            ProcessOwnerObservation::Unknown
        ));
        assert!(retired_owner_can_stop(
            Some("old"),
            ProcessOwnerObservation::Absent
        ));
        assert_eq!(
            observe_process_owner(std::process::id()),
            ProcessOwnerObservation::Running {
                start_time: inspect_process(std::process::id()).unwrap().start_time,
            }
        );
        let mut exited = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let exited_pid = exited.id();
        exited.wait().unwrap();
        assert_eq!(
            observe_process_owner(exited_pid),
            ProcessOwnerObservation::Absent
        );
    }

    /// A queued Standard local-worktree task with Codex profiles.
    fn fixture_task() -> (PathBuf, PathBuf, String) {
        let base = std::env::temp_dir().join(format!("suplex-usage-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let database_path = base.join("suplex.sqlite");
        let now = Utc::now();
        let task_id = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
            let user = auth::development_sign_in(&mut database, now).unwrap().user;
            let time = now.to_rfc3339();
            database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('usage_company','Usage','active',?1)", [&time]).unwrap();
            database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('usage_project','usage_company','Project','/tmp/repo','/tmp/worktrees',NULL,'main','','','root_profile','worker_profile','{}',?1,?1)", [&time]).unwrap();
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "usage_company".into(),
                project_id: "usage_project".into(),
                title: "Usage task".into(),
                description: "Observe usage".into(),
                configuration: serde_json::json!({"repository":"owner/repo","branch":"task-usage","baseBranch":"main"}),
                idempotency_key: "usage-key".into(),
                request_hash: "usage-request".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-usage","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(serde_json::json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
            };
            repository::create(&mut database, &prepared, now)
                .unwrap()
                .task
                .id
        };
        (base, database_path, task_id)
    }

    #[test]
    fn scheduler_tick_admits_a_queued_task_whose_blocker_cleared() {
        let (base, database_path, task_id) = fixture_task();
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'queued', wake_at = NULL WHERE task_id = ?1",
                [&task_id],
            ).unwrap();
            database.connection().execute(
                "INSERT INTO suplex_task_pull_request_dependencies (task_id,pull_request_number,state,title,url,observed_at) VALUES (?1,7,'open','Blocker','https://github.com/owner/repo/pull/7',?2)",
                rusqlite::params![task_id, Utc::now().to_rfc3339()],
            ).unwrap();
        }
        let status = || -> String {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            database
                .connection()
                .query_row(
                    "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                    [&task_id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert!(
            !scheduled_task_ids(&database_path)
                .unwrap()
                .contains(&task_id)
        );
        assert_eq!(status(), "queued");
        // The blocker merges out of band. No user action follows.
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_pull_request_dependencies SET state = 'merged' WHERE task_id = ?1",
                [&task_id],
            ).unwrap();
        }
        assert!(
            scheduled_task_ids(&database_path)
                .unwrap()
                .contains(&task_id)
        );
        assert_eq!(status(), "active");
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn prerequisite_refresh_retries_one_failed_row_without_blocking_another() {
        use axum::{Json, Router, http::StatusCode};
        let (base, database_path, failed) = fixture_task();
        let healthy = "healthy_prerequisite";
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute_batch(&format!(
                "CREATE TEMP TABLE copied_task AS SELECT * FROM suplex_tasks WHERE id = '{failed}';
                 UPDATE copied_task SET id = '{healthy}', idempotency_key = 'healthy-key', issue_number = issue_number + 1;
                 INSERT INTO suplex_tasks SELECT * FROM copied_task;
                 CREATE TEMP TABLE copied_control AS SELECT * FROM suplex_task_controls WHERE task_id = '{failed}';
                 UPDATE copied_control SET task_id = '{healthy}';
                 INSERT INTO suplex_task_controls SELECT * FROM copied_control;
                 UPDATE suplex_task_controls SET status = 'queued', wake_at = NULL WHERE task_id IN ('{failed}', '{healthy}');
                 INSERT INTO suplex_task_pull_request_dependencies (task_id,pull_request_number,state,title,url,observed_at) VALUES
                   ('{failed}',47,'open','Failed','https://github.com/owner/repo/pull/47','2026-09-26T00:00:00Z'),
                   ('{healthy}',48,'open','Healthy','https://github.com/owner/repo/pull/48','2026-09-26T00:00:00Z');"
            )).unwrap();
        }
        let app = Router::new().fallback(|Json(request): Json<serde_json::Value>| async move {
            if request["variables"]["number"] == 47 {
                return (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"message":"offline"})));
            }
            (StatusCode::OK, Json(serde_json::json!({"data":{"repository":{"pullRequest":{
                "number":48,"url":"https://github.com/owner/repo/pull/48","state":"MERGED","isDraft":false,
                "headRefOid":"a".repeat(40),"baseRefOid":"b".repeat(40),"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN",
                "autoMergeRequest":null,"reviewDecision":null,"author":{"login":"octo","avatarUrl":"https://avatars.githubusercontent.com/octo"},
                "changedFiles":1,"additions":1,"deletions":0,"title":"Healthy","commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}
            }}}})))
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let access =
            crate::integrations::github::Access::for_api(&api, Some("test-token".into())).unwrap();
        let mut github = crate::integrations::github_delivery::Github::new(access);
        github.retry_pauses.clear();
        crate::tasks::pull_request_dependencies::refresh_with(&database_path, Some(&github))
            .await
            .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let state = |task_id: &str| -> String {
            database
                .connection()
                .query_row(
                    "SELECT state FROM suplex_task_pull_request_dependencies WHERE task_id = ?1",
                    [task_id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(state(&failed), "open");
        assert_eq!(state(healthy), "merged");
        drop(database);
        assert!(
            !scheduled_task_ids(&database_path)
                .unwrap()
                .contains(&failed)
        );
        assert!(
            scheduled_task_ids(&database_path)
                .unwrap()
                .contains(&healthy.to_owned())
        );
        server.abort();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn scheduler_tick_reports_admission_and_queue_wait() {
        let logs = crate::platform::system_events::install_for_test();
        let (base, database_path, admitted) = fixture_task();
        let waiting = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let user = auth::development_sign_in(&mut database, Utc::now())
                .unwrap()
                .user;
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "usage_company".into(),
                project_id: "usage_project".into(),
                title: "Waiting task".into(),
                description: "".into(),
                configuration: serde_json::json!({"repository":"owner/repo","branch":"task-waiting","baseBranch":"main"}),
                idempotency_key: "waiting-key".into(),
                request_hash: "waiting-request".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-waiting","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(serde_json::json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
                issue: None,
                start_queued: false,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
            };
            let waiting = repository::create(&mut database, &prepared, Utc::now())
                .unwrap()
                .task
                .id;
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'queued', wake_at = NULL WHERE task_id IN (?1, ?2)",
                [&admitted, &waiting],
            ).unwrap();
            database.connection().execute(
                "INSERT INTO suplex_task_pull_request_dependencies (task_id,pull_request_number,state,title,url,observed_at) VALUES (?1,7,'open','Blocker','https://github.com/owner/repo/pull/7',?2)",
                rusqlite::params![waiting, Utc::now().to_rfc3339()],
            ).unwrap();
            waiting
        };
        let log = logs.join("system.log");
        let before = fs::read_to_string(&log).map_or(0, |log| log.len());
        assert!(
            scheduled_task_ids(&database_path)
                .unwrap()
                .contains(&admitted)
        );
        let events = fs::read_to_string(&log).unwrap()[before..]
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|event| {
                (event["taskId"] == admitted.as_str() || event["taskId"] == waiting.as_str())
                    && (event["type"] == "task_admitted" || event["type"] == "queue_wait")
            })
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
        // TypeScript `tick` observes queue waits before it admits.
        assert_eq!(
            events,
            vec![
                serde_json::json!({"type":"queue_wait","taskId":admitted,"waits":[]}),
                serde_json::json!({"type":"queue_wait","taskId":waiting,"waits":[{"id":"pull_request:7","reason":"prerequisite_pull_request_open"}]}),
                serde_json::json!({"type":"task_admitted","taskId":admitted,"trigger":"scheduler sweep"}),
            ]
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn recovery_resumes_a_limit_pause_once_usage_is_within_limits() {
        let (base, database_path, task_id) = fixture_task();
        let control = || -> (String, Option<String>) {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            database
                .connection()
                .query_row(
                    "SELECT status,wake_at FROM suplex_task_controls WHERE task_id = ?1",
                    [&task_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap()
        };
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let pause = r#"{"kind":"task_limit","reason":"budget","limits":{"budgetUsd":1,"maxTurns":5},"usage":{"estimatedCostUsd":1,"admittedTurns":0},"proposedLimits":{"budgetUsd":20,"maxTurns":5}}"#;
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', limit_pause_json = ?1, human_question = 'Limit', human_question_id = 'limit-question', budget_usd = 1, max_turns = 5, wake_at = NULL WHERE task_id = ?2",
                rusqlite::params![pause, task_id],
            ).unwrap();
        }
        // Without complete native usage the pause stays and is observed again.
        reconcile_limit_pause(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &database_path,
            &task_id,
        )
        .await
        .unwrap();
        let (status, wake_at) = control();
        assert_eq!(status, "waiting_human");
        assert!(wake_at.is_some());
        // The budget was removed outside the pause answer. Recovery resumes.
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_controls SET budget_usd = 0 WHERE task_id = ?1",
                    [&task_id],
                )
                .unwrap();
        }
        reconcile_limit_pause(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &database_path,
            &task_id,
        )
        .await
        .unwrap();
        assert_eq!(control().0, "active");
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn linked_issue_scope_failure_asks_for_tracker_access() {
        let (base, database_path, task_id) = fixture_task();
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.integration', json(?1)), issue_json = ?2 WHERE id = ?3",
                rusqlite::params![serde_json::json!({"tracker":{"kind":"jira","site":"https://issues.example.test","project":"A","emailEnvironment":"SUPLEX_P3_MISSING_JIRA_EMAIL","tokenEnvironment":"SUPLEX_P3_MISSING_JIRA_TOKEN"}}).to_string(), serde_json::json!({"kind":"github","repository":"owner/repo","number":1}).to_string(), task_id],
            ).unwrap();
        }
        assert!(
            !crate::tasks::issue_context::prepare_for_host(
                &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
                &base,
                &task_id
            )
            .await
            .unwrap()
        );
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let control = root_session_store::task_control(&database, &task_id)
            .unwrap()
            .unwrap();
        assert_eq!(control.status, TaskStatus::WaitingHuman);
        assert!(
            control
                .human_question
                .as_deref()
                .unwrap()
                .starts_with("Suplex cannot read the linked issue.")
        );
        assert!(control.human_question_id.is_some());
        drop(database);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn native_launch_refuses_a_missing_worktree() {
        let (base, database_path, task_id) = fixture_task();
        root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        let inherited_environment = HashMap::new();
        let host = RecoveryHost {
            database_path: &database_path,
            artifact_root: &base,
            task_id: &task_id,
            executable: None,
            inherited_environment: &inherited_environment,
            usage: ObservedTaskLimitUsage {
                estimated_cost_usd: Some(0.0),
            },
        };
        let error = recover_session_blocking(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &host,
            LaunchPlan::Root,
        )
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<TaskError>(),
            Some(TaskError::Failure {
                code: "worktree_missing",
                ..
            })
        ));
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn a_failing_sweep_waits_before_retrying_and_leaves_other_tasks_due() {
        let (base, database_path, failing) = fixture_task();
        let other = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let user = auth::development_sign_in(&mut database, Utc::now())
                .unwrap()
                .user;
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "usage_company".into(),
                project_id: "usage_project".into(),
                title: "Other task".into(),
                description: "".into(),
                configuration: serde_json::json!({"repository":"owner/repo","branch":"task-other","baseBranch":"main"}),
                idempotency_key: "other-key".into(),
                request_hash: "other-request".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-other","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(serde_json::json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
                issue: None,
                start_queued: false,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
            };
            let other = repository::create(&mut database, &prepared, Utc::now())
                .unwrap()
                .task
                .id;
            // Both tasks are due now. The repository path does not exist, so
            // worktree preparation fails after the early sweep steps.
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'active', wake_at = NULL, worktree_json = NULL WHERE task_id IN (?1, ?2)",
                [&failing, &other],
            ).unwrap();
            other
        };
        assert!(
            due_task_ids(&SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap())
                .unwrap()
                .contains(&failing)
        );
        assert!(
            sweep_task(
                &database_path,
                &base.join("artifacts"),
                &failing,
                None,
                &HashMap::new()
            )
            .await
            .is_ok()
        );
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let control = root_session_store::task_control(&database, &failing)
            .unwrap()
            .unwrap();
        assert_eq!(control.status, TaskStatus::WaitingHuman);
        assert!(
            control
                .human_question
                .as_deref()
                .unwrap()
                .starts_with("Suplex could not prepare this task.")
        );
        assert!(
            control
                .human_question
                .as_deref()
                .unwrap()
                .ends_with("Resolve the problem, then answer to retry.")
        );
        assert!(control.root_session_id.is_some());
        drop(database);
        let due = due_task_ids(&SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap())
            .unwrap();
        assert!(
            !due.contains(&failing),
            "a failed sweep is due again at once"
        );
        assert!(due.contains(&other));
        fs::remove_dir_all(base).unwrap();
    }

    /// Four delivered tasks whose stops kept failing held every sweep slot, so
    /// an active task behind them was never recovered.
    #[tokio::test]
    async fn a_delivered_task_with_a_pending_stop_waits_between_sweeps() {
        let (base, database_path, delivered) = fixture_task();
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let time = Utc::now().to_rfc3339();
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'delivered', wake_at = NULL WHERE task_id = ?1",
                [&delivered],
            ).unwrap();
            database.connection().execute(
                "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,native_session_id,stop_requested_at,created_at,updated_at) VALUES ('retired',?1,'root',1,0,'stopped','codex-retired',?2,?2,?2)",
                rusqlite::params![&delivered, &time],
            ).unwrap();
            // An unreadable turn record makes the native stop fail on every sweep.
            let directory =
                crate::runtimes::native::session_directory(&database_path, "retired").unwrap();
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("turn.json"), "not a turn record").unwrap();
        }
        let due = || {
            due_task_ids(&SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap())
                .unwrap()
        };
        assert!(due().contains(&delivered));
        assert!(
            sweep_task(
                &database_path,
                &base.join("artifacts"),
                &delivered,
                None,
                &HashMap::new(),
            )
            .await
            .is_err()
        );
        let wake_at: Option<String> = SuplexDatabase::open(&database_path, OpenMode::ReadOnly)
            .unwrap()
            .connection()
            .query_row(
                "SELECT wake_at FROM suplex_task_controls WHERE task_id = ?1",
                [&delivered],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            wake_at.as_deref().is_some_and(|wake| wake > Utc::now().to_rfc3339().as_str()),
            "a swept delivered task is due again at once"
        );
        assert!(!due().contains(&delivered));
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn unidentified_execution_asks_for_command_cleanup() {
        let (base, database_path, task_id) = fixture_task();
        let root = root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        let turn_id = {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let turn = root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .remove(0);
            let attempt = PromptDispatchAttempt {
                server_generation: "lost-record".into(),
                claimed_at: now_millis_rfc3339(),
            };
            database.connection().execute(
                "UPDATE suplex_task_turns SET status = 'unknown', dispatch_attempt_json = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::to_string(&attempt).unwrap(), turn.id],
            ).unwrap();
            turn.id
        };
        // A native log exists, but no dispatch record identifies its process.
        let directory = session_reader::session_directory(&database_path, &root.id).unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            crate::runtimes::headless::turn_file(&directory, &turn_id, "jsonl"),
            "",
        )
        .unwrap();
        let observed =
            recover_prepared_root(&database_path, &base, &task_id, None, &HashMap::new())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(observed.reason, "dispatch_identity_missing");
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let (status, recovery_turn_id): (String, Option<String>) = database
            .connection()
            .query_row(
                "SELECT status,recovery_turn_id FROM suplex_task_controls WHERE task_id = ?1",
                [&task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "waiting_human");
        assert_eq!(recovery_turn_id.as_deref(), Some(turn_id.as_str()));
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn dispatch_coalesces_idle_wakes_waits_for_prerequisites_and_refreshes_status() {
        let (base, database_path, task_id) = fixture_task();
        let root = root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        let turn_status = |id: &str| -> (String, String) {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            database
                .connection()
                .query_row(
                    "SELECT status,prompt_text FROM suplex_task_turns WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap()
        };
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute_batch(&format!(
                "UPDATE suplex_task_turns SET status = 'completed' WHERE task_id = '{task_id}';
                 CREATE TEMP TABLE blocker_task AS SELECT * FROM suplex_tasks WHERE id = '{task_id}';
                 UPDATE blocker_task SET id = 'blocker', title = 'Blocker', idempotency_key = 'blocker-key', issue_number = issue_number + 1;
                 INSERT INTO suplex_tasks SELECT * FROM blocker_task;
                 CREATE TEMP TABLE blocker_control AS SELECT * FROM suplex_task_controls WHERE task_id = '{task_id}';
                 UPDATE blocker_control SET task_id = 'blocker', status = 'active';
                 INSERT INTO suplex_task_controls SELECT * FROM blocker_control;
                 INSERT INTO suplex_task_dependencies (task_id,depends_on_task_id,created_at) VALUES ('{task_id}','blocker','2026-01-01T00:00:00.000Z');"
            )).unwrap();
            for (id, prompt, created) in [
                (
                    "msg_idle",
                    root_session_store::IDLE_ROOT_PROMPT,
                    "2026-01-01T00:00:01.000Z",
                ),
                (
                    "msg_note",
                    "Human note:\nCheck the result.",
                    "2026-01-01T00:00:02.000Z",
                ),
            ] {
                database.connection().execute(
                    "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,?4,'hash',?5,'pending_prompt',?6,?6)",
                    rusqlite::params![id, task_id, root.id, root.generation, prompt, created],
                ).unwrap();
            }
        }
        // The idle wake yields to the note, and the note waits for its prerequisite.
        recover_prepared_root(&database_path, &base, &task_id, None, &HashMap::new())
            .await
            .unwrap();
        assert_eq!(turn_status("msg_idle").0, "cancelled");
        assert_eq!(
            turn_status("msg_note"),
            (
                "pending_prompt".into(),
                "Human note:\nCheck the result.".into()
            )
        );
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_controls SET status = 'delivered' WHERE task_id = 'blocker'",
                    [],
                )
                .unwrap();
        }
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        let refreshed = root_session_store::refresh_pending_root_dependency_context(
            &mut database,
            "msg_note",
            Utc::now(),
        )
        .unwrap();
        assert!(refreshed.prompt_text.starts_with(
            "Human note:\nCheck the result.\n\n[Suplex prerequisite status]\nCurrent prerequisites: blocker \"Blocker\" (delivered). "
        ));
        let again = root_session_store::refresh_pending_root_dependency_context(
            &mut database,
            "msg_note",
            Utc::now(),
        )
        .unwrap();
        assert_eq!(again.prompt_text, refreshed.prompt_text);
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn empty_native_usage_is_incomplete_and_does_not_block_dispatch() {
        let (base, database_path, task_id) = fixture_task();
        let now = Utc::now();
        let root = root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        let turn_id = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            assert!(
                root_session_store::bind_native_session(&mut database, &root, "codex-usage", now)
                    .unwrap()
            );
            let turn = root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .remove(0);
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_turns SET status = 'prompted', prompted_at = ?1 WHERE id = ?2",
                    rusqlite::params![now.to_rfc3339(), turn.id],
                )
                .unwrap();
            turn.id
        };
        let directory = session_reader::session_directory(&database_path, &root.id).unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("turn-{turn_id}.jsonl")),
            "{\"type\":\"thread.started\",\"thread_id\":\"codex-usage\"}\n",
        )
        .unwrap();
        assert!(
            !usage::observe_session(&directory, "codex-usage", None)
                .unwrap()
                .complete
        );
        let observed = observed_usage(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &database_path,
            &task_id,
            false,
        )
        .await
        .unwrap();
        assert_eq!(observed.estimated_cost_usd, None);
        assert_eq!(
            observed_usage(
                &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
                &database_path,
                &task_id,
                true
            )
            .await
            .unwrap()
            .estimated_cost_usd,
            None
        );
        fs::remove_dir_all(base).unwrap();
    }

    /// `tests/task-limits.test.ts`: the budget proposed at a budget pause.
    #[test]
    fn a_budget_suggestion_rounds_spend_plus_allowance() {
        for (spend, allowance, expected) in [
            (15.412846000000002, 15.0, 30.0),
            (18.0, 15.0, 35.0),
            (1.0, 1.0, 5.0),
            (30.0, 1.0, 35.0),
        ] {
            assert_eq!(
                crate::tasks::limits::suggested_budget(spend + allowance, spend),
                expected
            );
        }
    }

    /// TypeScript `observeObservedTaskLimitUsage` cases from
    /// `tests/root-controller-limits.test.ts`.
    #[tokio::test]
    async fn observed_usage_matches_the_typescript_limit_observer() {
        let (base, database_path, task_id) = fixture_task();
        let root = root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        let cost = |require| {
            let database_path = database_path.clone();
            let task_id = task_id.clone();
            async move {
                observed_usage(
                    &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
                    &database_path,
                    &task_id,
                    require,
                )
                .await
                .unwrap()
                .estimated_cost_usd
            }
        };
        // No session has native work yet.
        assert_eq!(cost(false).await, Some(0.0));
        assert_eq!(cost(true).await, None);
        {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            assert!(
                root_session_store::bind_native_session(
                    &mut database,
                    &root,
                    "codex-limits",
                    Utc::now()
                )
                .unwrap()
            );
            database.connection().execute(
                "UPDATE suplex_task_turns SET status = 'prompted', prompted_at = ?1 WHERE session_id = ?2",
                rusqlite::params![Utc::now().to_rfc3339(), root.id],
            ).unwrap();
        }
        let limits = |budget: f64, turns: i64| {
            SuplexDatabase::open(&database_path, OpenMode::ReadWrite)
                .unwrap()
                .connection()
                .execute(
                    "UPDATE suplex_task_controls SET budget_usd = ?1, max_turns = ?2 WHERE task_id = ?3",
                    rusqlite::params![budget, turns, task_id],
                )
                .unwrap();
        };
        // A known turn cap and a disabled budget report no cost without reading usage.
        limits(15.0, 1);
        assert_eq!(cost(false).await, None);
        limits(0.0, 40);
        assert_eq!(cost(false).await, None);

        let entry = |message: &str, cost_usd: f64, input: f64| UsageEntry {
            message_id: message.into(),
            turn_id: message.into(),
            provider: "openai",
            model: "gpt-5.6-luna".into(),
            started_at_ms: 1,
            completed_at_ms: Some(2),
            failed: false,
            tokens: UsageTokens {
                input,
                output: 0.0,
                reasoning: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
            cost_usd,
            subsidized: cost_usd > 0.0,
            summary: false,
            steps: 1.0,
            source: "message",
        };
        let settle = |usage: Vec<UsageEntry>, pricing, require| {
            settle_usage(
                &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
                &task_id,
                vec![(
                    "codex-limits".to_owned(),
                    "root".to_owned(),
                    NativeTimeline {
                        usage,
                        live_message_id: None,
                    },
                )],
                pricing,
                require,
            )
            .unwrap()
            .estimated_cost_usd
        };
        let stored = || -> Vec<serde_json::Value> {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            let mut statement = database
                .connection()
                .prepare(
                    "SELECT snapshot FROM suplex_task_usage WHERE task_id = ?1 ORDER BY message_id",
                )
                .unwrap();
            statement
                .query_map([&task_id], |row| row.get::<_, String>(0))
                .unwrap()
                .map(|snapshot| serde_json::from_str(&snapshot.unwrap()).unwrap())
                .collect()
        };
        let empty = HashMap::new();
        let catalog = HashMap::from([(
            "openai/gpt-5.6-luna".to_owned(),
            ModelPricing {
                input: 200_000.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
        )]);

        // Sessions with no usage have no cost.
        assert_eq!(settle(vec![], None, false), None);
        assert_eq!(settle(vec![], None, true), None);
        // Wholly unpriced usage without a listed price: usage is kept, cost is unknown.
        for pricing in [None, Some(&empty)] {
            assert_eq!(
                settle(vec![entry("unpriced", 0.0, 100.0)], pricing, false),
                None
            );
            let snapshots = stored();
            assert_eq!(snapshots.len(), 1);
            assert_eq!(snapshots[0]["cost"], 0.0);
            assert_eq!(snapshots[0]["tokens"]["input"], 100.0);
            assert_eq!(
                settle(vec![entry("unpriced", 0.0, 100.0)], pricing, true),
                None
            );
        }
        // A listed price estimates wholly unpriced usage.
        assert_eq!(
            settle(vec![entry("unpriced", 0.0, 100.0)], Some(&catalog), false),
            Some(20.0)
        );
        assert_eq!(stored()[0]["subsidized"], true);
        assert_eq!(
            settle(vec![entry("unpriced", 0.0, 100.0)], Some(&catalog), true),
            Some(20.0)
        );
        // Known native cost counts when other usage is unpriced, unless complete pricing is required.
        let mixed = || vec![entry("usage-15", 15.0, 0.0), entry("unpriced", 0.0, 100.0)];
        assert_eq!(settle(mixed(), Some(&empty), false), Some(15.0));
        assert_eq!(settle(mixed(), Some(&empty), true), None);
        // Native cost does not depend on the price catalog.
        assert_eq!(
            settle(vec![entry("usage-20", 20.0, 100.0)], None, true),
            Some(20.0)
        );
        // Unsettled usage counts only when complete pricing is not required.
        let mut running = entry("usage-5", 5.0, 0.0);
        running.completed_at_ms = None;
        assert_eq!(settle(vec![running.clone()], None, false), Some(5.0));
        assert_eq!(settle(vec![running], None, true), None);
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn workflow_tasks_are_observed_and_every_provider_runs_the_workflow_coordinator() {
        let (base, database_path, task_id) = fixture_task();
        let root = root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        let identity = RootIdentity {
            task_id: task_id.clone(),
            session_id: root.id.clone(),
            generation: root.generation,
        };
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET root_profile_json = json_set(root_profile_json,'$.provider','devin'), workflow = 'competing_plans' WHERE task_id = ?1",
                [&task_id],
            ).unwrap();
        }
        let observed = root_controller::observe(
            &SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap(),
            &database_path,
            &identity,
        )
        .await
        .unwrap();
        assert_eq!(observed["control"]["workflow"], "competing_plans");
        let environment = HashMap::new();
        // A Devin Coordinator of a non-Standard workflow is not skipped: it proceeds to worktree preparation.
        let error = recover_prepared_root(&database_path, &base, &task_id, None, &environment)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "The task has no worktree");
        fs::remove_dir_all(base).unwrap();
    }

    fn tagged_sleep(markers: &[(&str, &Path)]) -> std::process::Child {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new("/usr/bin/python3");
        command
            .args(["-c", "import time; time.sleep(300)"])
            .env_clear()
            .process_group(0);
        for (key, directory) in markers {
            command.env(key, crate::runtimes::process::owner_marker(directory));
        }
        command.spawn().unwrap()
    }

    fn visible(key: &str, directory: &Path, child: &std::process::Child) -> bool {
        (0..40).any(|_| {
            let found = crate::runtimes::headless::discovered_process_ids(key, directory)
                .is_ok_and(|pids| pids.contains(&child.id()));
            if !found {
                std::thread::sleep(Duration::from_millis(100));
            }
            found
        })
    }

    #[test]
    fn retired_session_cleanup_preserves_another_session_in_the_same_worktree() {
        let base = std::env::temp_dir().join(format!("suplex-retired-{}", Uuid::new_v4()));
        let worktree = base.join("worktree");
        let retired_directory = base.join("retired-session");
        let current_directory = base.join("current-session");
        fs::create_dir_all(&worktree).unwrap();
        let mut retired = tagged_sleep(&[
            ("SUPLEX_TASK_PROCESS_OWNER", &worktree),
            ("SUPLEX_SESSION_PROCESS_OWNER", &retired_directory),
        ]);
        let mut current = tagged_sleep(&[
            ("SUPLEX_TASK_PROCESS_OWNER", &worktree),
            ("SUPLEX_SESSION_PROCESS_OWNER", &current_directory),
        ]);
        let result = (|| {
            assert!(visible(
                "SUPLEX_SESSION_PROCESS_OWNER",
                &retired_directory,
                &retired
            ));
            crate::runtimes::headless::stop_session(&retired_directory, None)?;
            retired.wait()?;
            assert!(current.try_wait()?.is_none());
            io::Result::Ok(())
        })();
        let _ = retired.kill();
        let _ = retired.wait();
        let _ = current.kill();
        let _ = current.wait();
        fs::remove_dir_all(base).unwrap();
        result.unwrap();
    }

    #[test]
    fn dispatch_recovery_stops_the_old_execution_without_stopping_its_replacement() {
        let runtime = std::env::temp_dir().join(format!("suplex-execution-{}", Uuid::new_v4()));
        let launch = |generation: &str| {
            tagged_sleep(&[
                ("SUPLEX_SESSION_PROCESS_OWNER", &runtime),
                ("SUPLEX_EXECUTION_PROCESS_OWNER", &runtime.join(generation)),
            ])
        };
        let mut old = launch("old");
        let mut replacement = launch("replacement");
        let result = (|| {
            assert!(visible(
                "SUPLEX_EXECUTION_PROCESS_OWNER",
                &runtime.join("old"),
                &old
            ));
            crate::runtimes::headless::stop_execution(&runtime, "old")?;
            old.wait()?;
            assert!(replacement.try_wait()?.is_none());
            io::Result::Ok(())
        })();
        let _ = old.kill();
        let _ = old.wait();
        let _ = replacement.kill();
        let _ = replacement.wait();
        result.unwrap();
    }

    /// TypeScript `RootController.recordWorkerResult` recovers Root inline.
    /// One Rust sweep records the Worker result and dispatches the Root wake.
    #[tokio::test]
    async fn sweep_dispatches_the_root_wake_from_a_worker_result() {
        let (base, database_path, task_id) = fixture_task();
        let worktree = base.join("worktree");
        fs::create_dir(&worktree).unwrap();
        let repository = git2::Repository::init(&worktree).unwrap();
        let tree = repository
            .find_tree(repository.index().unwrap().write_tree().unwrap())
            .unwrap();
        let signature = git2::Signature::now("Suplex fixture", "fixture@example.invalid").unwrap();
        let head = repository
            .commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
            .unwrap()
            .to_string();
        let codex = base.join("codex");
        fs::write(&codex, "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"inline-thread\"}' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":0,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":0,\"reasoning_output_tokens\":0}}'\n").unwrap();
        fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
        let root = root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        let worker_turn = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
                rusqlite::params![serde_json::json!({"path":worktree,"branch":"task-usage","baseSha":head,"headSha":head,"dirty":false}).to_string(), task_id],
            ).unwrap();
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_turns SET status = 'completed' WHERE session_id = ?1",
                    [&root.id],
                )
                .unwrap();
            root_session_store::launch_standard_worker(
                &mut database,
                &root,
                "Implement the fixture",
                "Worker prompt",
                Some(&serde_json::json!({"kind":"worker","purpose":"implementation"})),
                Utc::now(),
            )
            .unwrap();
            let worker = root_session_store::current_worker(&database, &task_id)
                .unwrap()
                .unwrap();
            root_session_store::pending_turns(&database, &worker.id)
                .unwrap()
                .remove(0)
        };
        let environment = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        let launched =
            recover_prepared_worker(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(launched.admission_observed);
        let directory =
            session_reader::session_directory(&database_path, &worker_turn.session_id).unwrap();
        let exit = crate::runtimes::headless::turn_file(&directory, &worker_turn.id, "exit");
        // Poll for up to 20 s. A loaded full-suite run starts processes slowly.
        for _ in 0..400 {
            if exit.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(exit.exists());
        sweep_task(&database_path, &base, &task_id, Some(&codex), &environment)
            .await
            .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let (worker_status, wake_attempt): (String, Option<String>) = database
            .connection()
            .query_row(
                "SELECT (SELECT status FROM suplex_task_turns WHERE id = ?1), (SELECT dispatch_attempt_json FROM suplex_task_turns WHERE session_id = ?2 AND prompt_text LIKE 'Worker result %')",
                rusqlite::params![worker_turn.id, root.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(worker_status, "completed");
        assert!(wake_attempt.is_some());
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn root_dispatch_claim_survives_reopen_without_replaying_child() {
        let base = std::env::temp_dir().join(format!("suplex-root-host-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let database_path = base.join("suplex.sqlite");
        let worktree = base.join("worktree");
        fs::create_dir(&worktree).unwrap();
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head("task-one");
        let repository = git2::Repository::init_opts(&worktree, &options).unwrap();
        fs::write(worktree.join("fixture.txt"), "task fixture\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("fixture.txt")).unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Suplex fixture", "fixture@example.invalid").unwrap();
        let head = repository
            .commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
            .unwrap()
            .to_string();
        drop(tree);
        drop(repository);
        let marker = base.join("launches");
        let codex = base.join("codex");
        // The child outlives both recoveries, so the second one observes an admitted, running turn.
        fs::write(&codex, format!("#!/bin/sh\nprintf x >> '{}'\ncat >/dev/null\nsleep 0.5\nprintf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"host-thread\"}}' '{{\"type\":\"turn.completed\",\"usage\":{{\"input_tokens\":1,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":1,\"reasoning_output_tokens\":0}}}}'\n", marker.display())).unwrap();
        fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
        let now = Utc::now();
        let task_id = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
            let user = auth::development_sign_in(&mut database, now).unwrap().user;
            let time = now.to_rfc3339();
            database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('host_company','Host','active',?1)", [&time]).unwrap();
            database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('host_project','host_company','Project',?1,?2,NULL,'main','','','root_profile','worker_profile','{}',?3,?3)", rusqlite::params![worktree.to_string_lossy(), base.to_string_lossy(), time]).unwrap();
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "host_company".into(),
                project_id: "host_project".into(),
                title: "One task".into(),
                description: "Run Codex".into(),
                configuration: serde_json::json!({"repository":"owner/repo","branch":"task-one","baseBranch":"main","baselineSha":"head"}),
                idempotency_key: "host-key".into(),
                request_hash: "host-request".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-one","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(serde_json::json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
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
            database.connection().execute("UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2", rusqlite::params![serde_json::json!({"path":worktree,"branch":"task-one","baseSha":head,"headSha":head,"dirty":false}).to_string(), task.id]).unwrap();
            task.id
        };
        root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
        )
        .unwrap();
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let root = root_session_store::current_root(&database, &task_id)
                .unwrap()
                .unwrap();
            let turn = root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .remove(0);
            let attempted = PromptDispatchAttempt {
                server_generation: "crash-before-native-launch".into(),
                claimed_at: now_millis_rfc3339(),
            };
            database.connection().execute(
                "UPDATE suplex_task_turns SET status = 'unknown', dispatch_attempt_json = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::to_string(&attempted).unwrap(), turn.id],
            ).unwrap();
        }
        let environment = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        let young =
            recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(!young.retry_allowed);
        assert!(!marker.exists());
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let root = root_session_store::current_root(&database, &task_id)
                .unwrap()
                .unwrap();
            let turn = root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .remove(0);
            let attempted = PromptDispatchAttempt {
                server_generation: "crash-before-native-launch".into(),
                claimed_at: rfc3339_millis(Utc::now() - chrono::Duration::seconds(31)),
            };
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_turns SET dispatch_attempt_json = ?1 WHERE id = ?2",
                    rusqlite::params![serde_json::to_string(&attempted).unwrap(), turn.id],
                )
                .unwrap();
        }
        let fenced =
            recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(fenced.retry_allowed);
        assert!(!fenced.admission_observed);
        assert!(!marker.exists());
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            let root = root_session_store::current_root(&database, &task_id)
                .unwrap()
                .unwrap();
            let turn = root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .remove(0);
            assert_eq!(turn.status, TurnStatus::PendingPrompt);
            assert!(turn.dispatch_attempt.is_none());
        }
        let first =
            recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(first.admission_observed);
        let second =
            recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(!second.retry_allowed);
        assert!(second.admission_observed);
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let root = root_session_store::current_root(&database, &task_id)
            .unwrap()
            .unwrap();
        assert!(
            root.native_session_id
                .as_deref()
                .unwrap()
                .starts_with("codex-")
        );
        let rows = root_session_store::root_observation_rows(&database, &task_id).unwrap();
        let turn = rows
            .turns
            .iter()
            .find(|turn| turn.session_id == root.id)
            .unwrap();
        assert!(turn.dispatch_attempt.is_some());
        let directory = session_reader::session_directory(&database_path, &root.id).unwrap();
        let exit = crate::runtimes::headless::turn_file(&directory, turn.id.as_str(), "exit");
        for _ in 0..40 {
            if exit.exists() && fs::read(&marker).is_ok_and(|launches| launches == b"x") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(exit.exists());
        assert_eq!(fs::read(&marker).unwrap(), b"x");
        drop(database);
        recover_prepared_root(&database_path, &base, &task_id, Some(&codex), &environment)
            .await
            .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let rows = root_session_store::root_observation_rows(&database, &task_id).unwrap();
        assert_eq!(
            rows.turns
                .iter()
                .find(|row| row.session_id == root.id)
                .unwrap()
                .status,
            TurnStatus::Completed
        );
        assert!(
            rows.turns
                .iter()
                .find(|row| row.session_id == root.id)
                .unwrap()
                .terminal_observation
                .as_deref()
                .is_some_and(|raw| raw.contains("\"state\":\"completed\""))
        );
        let root_terminal = rows
            .turns
            .iter()
            .find(|row| row.session_id == root.id)
            .unwrap()
            .terminal_observation
            .as_deref()
            .unwrap();
        assert!(!root_terminal.contains("\"reason\""));
        assert!(!root_terminal.contains("\"interruptedExecution\""));
        drop(database);
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let native_id = root.native_session_id.as_deref().unwrap();
            database.connection().execute(
                "INSERT INTO suplex_task_usage (task_id,session_id,message_id,snapshot,observed_at) VALUES (?1,?2,'prior-native','{}',?3)",
                rusqlite::params![task_id, native_id, Utc::now().to_rfc3339()],
            ).unwrap();
            let no_usage_event = NativeTimeline::default();
            // TypeScript `replaceNativeUsage` replaces the task usage with the
            // partial observation; missing native usage never blocks dispatch.
            assert_eq!(
                replace_observed_usage(
                    &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
                    &task_id,
                    vec![(native_id.to_owned(), "root".into(), no_usage_event)],
                )
                .unwrap(),
                None
            );
            let retained: i64 = database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_task_usage WHERE task_id = ?1 AND message_id = 'prior-native'",
                [&task_id], |row| row.get(0),
            ).unwrap();
            assert_eq!(retained, 0);
        }
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        root_session_store::launch_standard_worker(
            &mut database,
            &root,
            "Implement the fixture",
            "Worker prompt",
            Some(&serde_json::json!({"kind":"worker","purpose":"implementation"})),
            Utc::now(),
        )
        .unwrap();
        let worker = root_session_store::current_worker(&database, &task_id)
            .unwrap()
            .unwrap();
        let worker_turn = root_session_store::pending_turns(&database, &worker.id)
            .unwrap()
            .remove(0);
        drop(database);
        let launched =
            recover_prepared_worker(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(launched.admission_observed);
        let worker_directory =
            session_reader::session_directory(&database_path, &worker.id).unwrap();
        let worker_exit =
            crate::runtimes::headless::turn_file(&worker_directory, &worker_turn.id, "exit");
        for _ in 0..40 {
            if worker_exit.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(worker_exit.exists());
        recover_prepared_worker(&database_path, &base, &task_id, Some(&codex), &environment)
            .await
            .unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let rows = root_session_store::root_observation_rows(&database, &task_id).unwrap();
        assert_eq!(
            rows.turns
                .iter()
                .find(|row| row.id == worker_turn.id)
                .unwrap()
                .status,
            TurnStatus::Completed
        );
        assert_eq!(
            rows.turns
                .iter()
                .find(|row| row.id == worker_turn.id)
                .unwrap()
                .native_turn_id
                .as_deref(),
            Some(worker_turn.id.as_str())
        );
        assert!(
            rows.turns
                .iter()
                .find(|row| row.id == worker_turn.id)
                .unwrap()
                .result_receipt_id
                .as_deref()
                .unwrap()
                .contains(&worker_turn.id)
        );
        assert_eq!(
            root_session_store::pending_turns(&database, &root.id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(fs::read(&marker).unwrap(), b"xx");
        drop(database);
        let replacement_id = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let request = crate::http::contracts::typed::tasks::TaskWorkerReplacementBody {
                session_id: worker.id.clone(),
                reason: "Change strategy".into(),
                handoff: Some("Finish the checks".into()),
                worker_profile_id: None,
            };
            let replacement =
                root_session_store::replace_worker(&mut database, &task_id, &request, Utc::now())
                    .unwrap();
            let id = replacement.id.as_str().to_owned();
            assert!(!root_session_store::worker_replacement_ready(&database, &id).unwrap());
            id
        };
        assert!(
            recover_prepared_worker(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(&marker).unwrap(), b"xx");
        stop_retired_sessions(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &database_path,
            &task_id,
        )
        .await
        .unwrap();
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            assert!(
                root_session_store::worker_replacement_ready(&database, &replacement_id).unwrap()
            );
        }
        let replacement_launch =
            recover_prepared_worker(&database_path, &base, &task_id, Some(&codex), &environment)
                .await
                .unwrap()
                .unwrap();
        assert!(replacement_launch.admission_observed);
        let replacement_directory =
            session_reader::session_directory(&database_path, &replacement_id).unwrap();
        let replacement_turn_id = {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            root_session_store::root_observation_rows(&database, &task_id)
                .unwrap()
                .turns
                .into_iter()
                .find(|turn| turn.session_id == replacement_id)
                .unwrap()
                .id
        };
        let replacement_exit = crate::runtimes::headless::turn_file(
            &replacement_directory,
            &replacement_turn_id,
            "exit",
        );
        for _ in 0..40 {
            if replacement_exit.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(replacement_exit.exists());
        recover_prepared_worker(&database_path, &base, &task_id, Some(&codex), &environment)
            .await
            .unwrap();
        assert_eq!(fs::read(&marker).unwrap(), b"xxx");
        let pricing = HashMap::from([(
            "openai/gpt-6-sol".into(),
            ModelPricing {
                input: 1.0,
                output: 2.0,
                cache_read: 0.5,
                cache_write: 0.5,
            },
        )]);
        let unpriced = replace_observed_usage(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
            vec![(
                root.native_session_id.clone().unwrap(),
                "root".into(),
                NativeTimeline {
                    usage: vec![UsageEntry {
                        message_id: "msg-usage".into(),
                        turn_id: "msg-usage".into(),
                        provider: "openai",
                        model: "gpt-6-sol".into(),
                        started_at_ms: 1_234_567,
                        completed_at_ms: None,
                        failed: false,
                        tokens: UsageTokens {
                            input: 1_000_000.0,
                            output: 0.0,
                            reasoning: 0.0,
                            cache_read: 0.0,
                            cache_write: 0.0,
                        },
                        cost_usd: 0.0,
                        subsidized: false,
                        summary: false,
                        steps: 1.0,
                        source: "message",
                    }],
                    live_message_id: Some("msg-usage".into()),
                },
            )],
        )
        .unwrap();
        assert_eq!(unpriced, None);
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let snapshot: String = database.connection().query_row(
            "SELECT snapshot FROM suplex_task_usage WHERE task_id = ?1 AND message_id = 'msg-usage'",
            [&task_id], |row| row.get(0),
        ).unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert!(snapshot["completedAt"].is_null());
        drop(database);
        let cost = replace_observed_usage(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &task_id,
            vec![(root.native_session_id.clone().unwrap(), "root".into(), {
                let mut timeline = NativeTimeline {
                    usage: vec![UsageEntry {
                        message_id: "msg-usage".into(),
                        turn_id: "msg-usage".into(),
                        provider: "openai",
                        model: "gpt-6-sol".into(),
                        started_at_ms: 1_234_567,
                        completed_at_ms: Some(1_234_567),
                        failed: false,
                        tokens: UsageTokens {
                            input: 1_000_000.0,
                            output: 0.0,
                            reasoning: 0.0,
                            cache_read: 0.0,
                            cache_write: 0.0,
                        },
                        cost_usd: 0.0,
                        subsidized: false,
                        summary: false,
                        steps: 1.0,
                        source: "message",
                    }],
                    live_message_id: None,
                };
                estimate_unpriced_usage(&mut timeline.usage, &pricing);
                timeline
            })],
        )
        .unwrap();
        assert_eq!(cost, Some(1.0));
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let snapshot: String = database.connection().query_row(
            "SELECT snapshot FROM suplex_task_usage WHERE task_id = ?1 AND message_id = 'msg-usage'",
            [&task_id], |row| row.get(0),
        ).unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(
            snapshot["sessionId"],
            root.native_session_id.clone().unwrap()
        );
        assert_eq!(snapshot["role"], "root");
        assert_eq!(snapshot["cost"], 1.0);
        assert_eq!(snapshot["subsidized"], true);
        drop(database);
        fs::write(
            worktree.join("uncommitted.txt"),
            "local work may be dirty\n",
        )
        .unwrap();
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        let token = root_session_store::claim_tool_owner(&mut database, &task_id, Utc::now())
            .unwrap()
            .unwrap();
        drop(database);
        let identity = RootIdentity {
            task_id: task_id.clone(),
            session_id: root.id,
            generation: root.generation,
        };
        assert!(
            operations::complete_local_work(&database_path, &identity, &token, Some("wrong-head"))
                .await
                .is_err()
        );
        let delivered =
            operations::complete_local_work(&database_path, &identity, &token, Some(&head))
                .await
                .unwrap();
        assert_eq!(
            delivered,
            serde_json::json!({"kind":"local_work_completed","headSha":head})
        );
        // A lost MCP reply cannot perform a second delivery after the durable
        // status transition; recovery reads the delivered control instead.
        assert!(
            operations::complete_local_work(&database_path, &identity, &token, Some(&head))
                .await
                .is_err()
        );
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let control = root_session_store::root_observation_rows(&database, &task_id)
            .unwrap()
            .control;
        assert_eq!(control.status, crate::tasks::control::TaskStatus::Delivered);
        assert_eq!(serde_json::json!(control)["worktree"]["dirty"], true);
        drop(database);
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_sessions SET launch_owner_pid = ?1, launch_owner_start_time = NULL WHERE id = ?2",
                rusqlite::params![i64::from(std::process::id()), identity.session_id],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_sessions SET launch_owner_pid = ?1, launch_owner_start_time = 'stale-owner' WHERE id = ?2",
                rusqlite::params![i64::from(std::process::id()), worker.id],
            ).unwrap();
        }
        assert!(
            due_task_ids(&SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap())
                .unwrap()
                .contains(&task_id)
        );
        sweep_task(&database_path, &base, &task_id, Some(&codex), &environment)
            .await
            .unwrap();
        assert!(
            !due_task_ids(&SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap())
                .unwrap()
                .contains(&task_id)
        );
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            let outstanding: i64 = database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_task_sessions WHERE task_id = ?1 AND stop_requested_at IS NOT NULL AND stopped_at IS NULL",
                [&task_id], |row| row.get(0),
            ).unwrap();
            assert_eq!(outstanding, 0);
        }
        let failing_task = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let user = auth::development_sign_in(&mut database, Utc::now())
                .unwrap()
                .user;
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "host_company".into(),
                project_id: "host_project".into(),
                title: "Failing Root".into(),
                description: "Verify the failure transition".into(),
                configuration: serde_json::json!({"repository":"owner/repo","branch":"task-two","baseBranch":"main","baselineSha":"head"}),
                idempotency_key: "failure-key".into(),
                request_hash: "failure-request".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-two","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(serde_json::json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
            };
            repository::create(&mut database, &prepared, Utc::now())
                .unwrap()
                .task
                .id
        };
        let failing_root = root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &failing_task,
        )
        .unwrap();
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        let failing_turn = root_session_store::pending_turns(&database, &failing_root.id)
            .unwrap()
            .remove(0);
        let failure = PromptObservation {
            state: PromptState::Error,
            admission_observed: true,
            retry_allowed: false,
            reason: "native_startup_failed",
            unsettled_tool_ids: vec![],
            native_final_observed: false,
            process_running: false,
            execution_uncertain: false,
        };
        assert!(
            complete_root_if_terminal(
                &mut database,
                &database_path,
                &crate::runtimes::codex::harness::CodexTaskRuntime,
                &failing_root,
                &failing_turn,
                &failure
            )
            .unwrap()
        );
        let failed = root_session_store::root_observation_rows(&database, &failing_task)
            .unwrap()
            .control;
        assert_eq!(failed.status, TaskStatus::WaitingHuman);
        assert_eq!(
            failed.human_question.as_deref().unwrap(),
            "The agent stopped the Coordinator turn (error). native_startup_failed Can you resolve the failure and continue?"
        );
        drop(database);
        let mut worktree_child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .current_dir(&worktree)
            .spawn()
            .unwrap();
        {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
                rusqlite::params![serde_json::json!({"path":worktree,"branch":"task-two","baseSha":head,"headSha":head,"dirty":false}).to_string(), failing_task],
            ).unwrap();
            database.connection().execute(
                "UPDATE suplex_task_sessions SET launch_owner_pid = ?1, launch_owner_start_time = NULL WHERE id = ?2",
                rusqlite::params![i64::from(std::process::id()), failing_root.id],
            ).unwrap();
            let actor = auth::development_sign_in(&mut database, Utc::now())
                .unwrap()
                .user;
            let cancelled = commands::cancel_user_task(
                &mut database,
                &actor.id,
                &failing_task,
                Utc::now(),
                |_| {},
            )
            .unwrap();
            assert_eq!(cancelled.status, TaskStatus::Cancelled);
            let pending: i64 = database.connection().query_row(
                "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status IN ('pending_prompt','prompted','unknown')",
                [&failing_task], |row| row.get(0),
            ).unwrap();
            assert_eq!(pending, 0);
        }
        assert!(
            due_task_ids(&SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap())
                .unwrap()
                .contains(&failing_task)
        );
        sweep_task(
            &database_path,
            &base,
            &failing_task,
            Some(&codex),
            &environment,
        )
        .await
        .unwrap();
        assert!(
            !due_task_ids(&SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap())
                .unwrap()
                .contains(&failing_task)
        );
        assert!(worktree_child.wait().unwrap().code().is_none());
        let replacement_task = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let user = auth::development_sign_in(&mut database, Utc::now())
                .unwrap()
                .user;
            database.connection().execute(
                "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('new-root-host','New Root','root','new-root-host','codex','gpt-6-sol','medium','default',?1,?1)",
                [Utc::now().to_rfc3339()],
            ).unwrap();
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "host_company".into(),
                project_id: "host_project".into(),
                title: "Replace native Root".into(),
                description: String::new(),
                configuration: serde_json::json!({"repository":"owner/repo","branch":"task-one","baseBranch":"main","baselineSha":"head"}),
                idempotency_key: "host-root-replacement".into(),
                request_hash: "host-root-replacement".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-one","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(serde_json::json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
                advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
                pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
            };
            let task = repository::create(&mut database, &prepared, Utc::now())
                .unwrap()
                .task;
            database.connection().execute("UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",rusqlite::params![serde_json::json!({"path":worktree,"branch":"task-one","baseSha":head,"headSha":head,"dirty":false}).to_string(),task.id]).unwrap();
            task.id
        };
        root_controller::prepare_root(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &replacement_task,
        )
        .unwrap();
        let old_root = {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            root_session_store::current_root(&database, &replacement_task)
                .unwrap()
                .unwrap()
        };
        let admitted = recover_prepared_root(
            &database_path,
            &base,
            &replacement_task,
            Some(&codex),
            &environment,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(admitted.admission_observed);
        let old_turn = {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            database.connection().query_row("SELECT id FROM suplex_task_turns WHERE session_id = ?1 ORDER BY rowid DESC LIMIT 1",[&old_root.id],|row|row.get::<_,String>(0)).unwrap()
        };
        let old_directory =
            session_reader::session_directory(&database_path, &old_root.id).unwrap();
        for _ in 0..40 {
            if crate::runtimes::headless::turn_file(&old_directory, &old_turn, "exit").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(crate::runtimes::headless::turn_file(&old_directory, &old_turn, "exit").exists());
        recover_prepared_root(
            &database_path,
            &base,
            &replacement_task,
            Some(&codex),
            &environment,
        )
        .await
        .unwrap();
        let next_root = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
            let rows =
                root_session_store::root_observation_rows(&database, &replacement_task).unwrap();
            let initial = crate::coordination::root_prompts::initial_coordinator_prompt(
                &rows.control,
                &rows.context,
                &rows.dependencies,
            );
            let request = crate::http::contracts::typed::tasks::TaskCoordinatorReplacementBody {
                session_id: old_root.id.clone(),
                root_profile_id: "new-root-host".into(),
                handoff: Some("Continue safely".into()),
                resume: false,
                question_id: None,
            };
            let next = root_session_store::replace_coordinator(
                &mut database,
                &replacement_task,
                &request,
                &initial,
                Utc::now(),
            )
            .unwrap();
            let id = next.id.as_str().to_owned();
            assert!(!root_session_store::worker_replacement_ready(&database, &id).unwrap());
            id
        };
        let before = fs::read(&marker).unwrap();
        assert!(
            recover_prepared_root(
                &database_path,
                &base,
                &replacement_task,
                Some(&codex),
                &environment
            )
            .await
            .unwrap()
            .is_none()
        );
        assert_eq!(fs::read(&marker).unwrap(), before);
        stop_retired_sessions(
            &mut SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap(),
            &database_path,
            &replacement_task,
        )
        .await
        .unwrap();
        {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            assert!(root_session_store::worker_replacement_ready(&database, &next_root).unwrap());
        }
        let launched = recover_prepared_root(
            &database_path,
            &base,
            &replacement_task,
            Some(&codex),
            &environment,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(launched.admission_observed);
        for _ in 0..40 {
            if fs::read(&marker).is_ok_and(|launches| launches.len() == before.len() + 1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(fs::read(&marker).unwrap().len(), before.len() + 1);
        let new_turn = {
            let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
            database.connection().query_row("SELECT id FROM suplex_task_turns WHERE session_id = ?1 ORDER BY rowid DESC LIMIT 1",[&next_root],|row|row.get::<_,String>(0)).unwrap()
        };
        let next_directory = session_reader::session_directory(&database_path, &next_root).unwrap();
        for _ in 0..40 {
            if crate::runtimes::headless::turn_file(&next_directory, &new_turn, "exit").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(crate::runtimes::headless::turn_file(&next_directory, &new_turn, "exit").exists());
        fs::remove_dir_all(base).unwrap();
    }
}
