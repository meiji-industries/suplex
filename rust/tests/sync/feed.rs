#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        coordination::workflows::Workflow,
        http::contracts::task_reads::TaskAgentStatus,
        tasks::{
            analytics::{TaskUsage, tests::entry},
            artifacts::tests::fixture,
            repository::{PreparedTask, TaskCreator},
        },
    };
    use chrono::Utc;
    use serde_json::{Value, json};
    use std::{fs, time::Instant};
    use uuid::Uuid;

    /// A second task in the fixture company.
    pub(crate) fn add_task(
        database: &mut SuplexDatabase,
        title: &str,
        depends_on: Vec<String>,
    ) -> String {
        let now = Utc::now();
        let profile = json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
        repository::create(
            database,
            &PreparedTask {
                id: repository::new_task_id(),
                company_id: "company_media".into(),
                project_id: "project_media".into(),
                title: title.into(),
                description: String::new(),
                configuration: json!({
                    "repository":"owner/repo",
                    "repositoryPath":"/tmp/repo",
                    "worktreeRoot":"/tmp/worktrees",
                    "branch":"task-second",
                    "baseBranch":"main",
                    "baselineSha":"head",
                    "startingSha":"head",
                    "visualEvidence":"off",
                    "source":null,
                    "capturedAt":now.to_rfc3339()
                }),
                idempotency_key: Uuid::new_v4().to_string(),
                request_hash: "second-hash".into(),
                creator: TaskCreator::User("user_development".into()),
                delivery_target: "merged".into(),
                delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-second","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
                root_profile: serde_json::from_value(profile.clone()).unwrap(),
                worker_profile: serde_json::from_value(profile).unwrap(),
                advisor_profiles: serde_json::from_value(json!({})).unwrap(),
                issue: None,
                start_queued: false,
                copied_from_task_id: None,
                depends_on,
                pull_request_dependencies: vec![],
                workflow: Workflow::Standard,
            },
            now,
        )
        .unwrap()
        .task
        .id
    }

    /// A live Coordinator session of the task with one prompted turn.
    pub(crate) fn add_turn(database: &SuplexDatabase, task_id: &str) {
        let now = Utc::now().to_rfc3339();
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,created_at,updated_at) VALUES (?1 || '-root',?1,'root',1,1,'live',?2,?2)",
            [task_id, &now],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,prompted_at,updated_at) VALUES (?1 || '-turn',?1,?1 || '-root',1,'hash','Start','prompted',?2,?2,?2)",
            [task_id, &now],
        ).unwrap();
    }

    fn wait_until(what: &str, ready: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready() {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The published watch values, when `ready` accepts them.
    pub(crate) fn wait_watched(
        receiver: &watch::Receiver<Option<Watched>>,
        ready: impl Fn(&Watched) -> bool,
    ) -> Watched {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(watched) = receiver.borrow().clone()
                && ready(&watched)
            {
                return watched;
            }
            assert!(
                Instant::now() < deadline,
                "the feed did not publish the expected watch values"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn value<T: serde::Serialize>(value: &Option<Arc<T>>) -> Value {
        serde_json::to_value(value.as_deref()).unwrap()
    }

    /// The published lists, when `ready` accepts them.
    fn wait_lists(
        receiver: &watch::Receiver<Option<Published>>,
        ready: impl Fn(&CompanyLists) -> bool,
    ) -> Published {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(lists) = receiver.borrow().clone()
                && ready(&lists)
            {
                return lists;
            }
            assert!(
                Instant::now() < deadline,
                "the feed did not publish the expected lists"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn json<T: serde::Serialize>(list: &[T]) -> Vec<Value> {
        list.iter()
            .map(|item| serde_json::to_value(item).unwrap())
            .collect()
    }

    /// The published tasks as JSON, when `ready` accepts them.
    fn wait(
        receiver: &watch::Receiver<Option<Published>>,
        ready: impl Fn(&[Value]) -> bool,
    ) -> Vec<Value> {
        json(&wait_lists(receiver, |lists| ready(&json(&lists.tasks))).tasks)
    }

    #[test]
    fn diff_reports_new_changed_and_removed_tasks() {
        let (directory, _, mut database, first) = fixture();
        let one = repository::list_active(&database, "company_media").unwrap();
        assert_eq!(diff(&one, &one), (vec![], vec![]));
        assert_eq!(diff(&[], &one), (one.clone(), vec![]));
        assert_eq!(diff(&one, &[]), (vec![], vec![first.clone()]));

        database
            .connection()
            .execute("UPDATE suplex_tasks SET title = 'Renamed' WHERE id = ?1", [&first])
            .unwrap();
        let second = add_task(&mut database, "Second", vec![]);
        let two = repository::list_active(&database, "company_media").unwrap();
        let (changed, removed) = diff(&one, &two);
        assert_eq!(changed, two);
        assert!(removed.is_empty());
        let (changed, removed) = diff(&two, &one);
        assert_eq!(changed, one);
        assert_eq!(removed, vec![second]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn list_row_equals_the_list_fields_of_the_full_response() {
        let (directory, _, mut database, first) = fixture();
        let second = add_task(&mut database, "Second", vec![first.clone()]);
        let connection = database.connection();
        connection
            .execute("UPDATE suplex_companies SET issue_code = 'MED' WHERE id = 'company_media'", [])
            .unwrap();
        connection
            .execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Which branch?', human_question_id = 'question_1', pull_request_json = ?1 WHERE task_id = ?2",
                rusqlite::params![
                    json!({"repository":"owner/repo","number":7,"url":"https://example.test/pull/7","headSha":"head","state":"open","mergedAt":null}).to_string(),
                    first
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO suplex_task_pull_request_dependencies (task_id, pull_request_number, state, title, url, observed_at) VALUES (?1, 9, 'open', 'Prerequisite', 'https://example.test/pull/9', ?2)",
                rusqlite::params![second, Utc::now().to_rfc3339()],
            )
            .unwrap();
        connection
            .execute("UPDATE suplex_task_controls SET status = 'queued' WHERE task_id = ?1", [&second])
            .unwrap();
        connection
            .execute("UPDATE suplex_projects SET task_concurrency = 1 WHERE id = 'project_media'", [])
            .unwrap();
        let listed = repository::list_active(&database, "company_media").unwrap();
        assert_eq!(listed.len(), 2);
        let queued = serde_json::to_value(listed.iter().find(|row| row.id == second).unwrap()).unwrap();
        assert_eq!(queued["queue"]["projectConcurrencyLimited"], true);
        assert_eq!(queued["queue"]["waitingOn"].as_array().unwrap().len(), 2);
        for row in listed {
            let full = repository::task_response(&database, &row.id)
                .unwrap()
                .unwrap();
            assert_eq!(row, TaskListItem::from(full));
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn list_and_full_response_include_the_first_native_execution_timestamp() {
        let (directory, _, database, task_id) = fixture();
        let before = serde_json::to_value(repository::list_active(&database, "company_media").unwrap()).unwrap();
        assert!(before[0].get("startedAt").is_none());
        for (message, millis) in [("later", 1_791_239_460_000.0), ("first", 1_791_239_400_000.0)] {
            let mut usage = entry(message, 0.0);
            usage.started_at = millis;
            database.connection().execute(
                "INSERT INTO suplex_task_usage (session_id,message_id,task_id,snapshot,observed_at) VALUES ('timing',?1,?2,?3,?4)",
                rusqlite::params![message, task_id, serde_json::to_string(&usage).unwrap(), Utc::now().to_rfc3339()],
            ).unwrap();
        }
        let rows = repository::list_active(&database, "company_media").unwrap();
        let full = repository::task_response(&database, &task_id).unwrap().unwrap();
        assert_eq!(rows[0], TaskListItem::from(full));
        let row = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(row["startedAt"], "2026-10-05T22:30:00.000Z");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn feed_publishes_writes_from_other_connections() {
        let (directory, path, mut database, first) = fixture();
        let feed = CompanyFeed::new(path.clone(), Arc::default());
        let receiver = feed.subscribe("company_media");
        wait(&receiver, |tasks| tasks[0]["title"] == "Media task");

        // The fixture connection is not the feed's connection.
        let rename = |title: &str| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_tasks SET title = ?1 WHERE id = ?2",
                    [title, first.as_str()],
                )
                .unwrap();
        };
        rename("Renamed");
        wait(&receiver, |tasks| tasks[0]["title"] == "Renamed");
        rename("Media task");
        wait(&receiver, |tasks| tasks[0]["title"] == "Media task");

        let second = add_task(&mut database, "Second", vec![first.clone()]);
        wait(&receiver, |tasks| tasks.len() == 2);

        // A raw connection stands in for another process, such as `suplex mcp root`.
        let other = rusqlite::Connection::open(&path).unwrap();
        other.busy_timeout(Duration::from_secs(5)).unwrap();
        other
            .execute("UPDATE suplex_tasks SET title = 'Prerequisite' WHERE id = ?1", [&first])
            .unwrap();
        let usage = entry("first-timing", 0.0);
        other.execute(
            "INSERT INTO suplex_task_usage (session_id,message_id,task_id,snapshot,observed_at) VALUES ('timing','first-timing',?1,?2,?3)",
            rusqlite::params![first, serde_json::to_string(&usage).unwrap(), Utc::now().to_rfc3339()],
        ).unwrap();
        wait(&receiver, |tasks| tasks.iter().any(|task| task["id"] == first && task["startedAt"] == "1970-01-01T00:00:00.100Z"));
        // The title of a prerequisite is part of the task that waits on it.
        wait(&receiver, |tasks| {
            tasks
                .iter()
                .any(|task| task["id"] == second && task["blockedBy"][0]["title"] == "Prerequisite")
        });
        other
            .execute(
                "UPDATE suplex_tasks SET archived_at = ?1 WHERE id = ?2",
                [Utc::now().to_rfc3339(), second],
            )
            .unwrap();
        let tasks = wait(&receiver, |tasks| tasks.len() == 1);
        assert_eq!(tasks[0]["id"], first);
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn feed_publishes_moves_run_liveness_and_project_changes() {
        let (directory, path, database, _) = fixture();
        let terminals = Arc::<HostTerminals>::default();
        let feed = CompanyFeed::new(path, terminals.clone());
        let receiver = feed.subscribe("company_media");
        let first = wait_lists(&receiver, |_| true);
        assert!(first.moves.is_empty());
        // The pushed projects are the list that `GET /api/companies/{id}/projects` returns.
        let listed = || {
            let projects = projects::list(&database, "user_development", Some("company_media"));
            json(&projects.unwrap().iter().map(projects::response_project).collect::<Vec<_>>())
        };
        assert_eq!(json(&first.projects), listed());
        assert_eq!(first.projects.len(), 1);

        let now = Utc::now().to_rfc3339();
        let connection = database.connection();
        connection.execute(
            "INSERT INTO suplex_moves (id, company_id, project_id, name, prompt, runner, profile_id, confirm, workflow, delivery_target, run_project_tests, visual_evidence, created_by_user_id, created_at, updated_at) VALUES ('move_one', 'company_media', 'project_media', 'Say hello', 'echo hello', 'script', NULL, 0, 'standard', 'pull_request_ready', 1, 'off', 'user_development', ?1, ?1)",
            [&now],
        ).unwrap();
        let with_move = wait_lists(&receiver, |lists| lists.moves.len() == 1);
        assert_eq!(json(&with_move.moves)[0]["name"], "Say hello");
        // A list that did not change keeps its allocation, so a socket skips it.
        assert!(Arc::ptr_eq(&with_move.tasks, &first.tasks));
        assert!(Arc::ptr_eq(&with_move.projects, &first.projects));

        connection.execute(
            "INSERT INTO suplex_move_runs (id, move_id, company_id, project_id, move_name, runner, prompt, inputs_json, excluded_pull_requests_json, outcomes_json, started_by_user_id, started_at, idempotency_key) VALUES ('run_one', 'move_one', 'company_media', 'project_media', 'Say hello', 'script', 'echo hello', '{}', '[]', '[]', 'user_development', ?1, 'run-one-key')",
            [&now],
        ).unwrap();
        let live = |lists: &CompanyLists| {
            lists.moves[0].last_run.as_ref().map(|run| run.live)
        };
        wait_lists(&receiver, |lists| live(lists) == Some(false));

        // The terminal registry is in memory. No commit reports these two changes.
        let terminal = moves::shell::terminal_id("run_one");
        let viewer = terminals
            .open(
                &terminal,
                crate::terminals::host::Spec::mirror("task", "sleep 30", std::env::temp_dir()),
                80,
                24,
            )
            .unwrap();
        wait_lists(&receiver, |lists| live(lists) == Some(true));
        terminals.close(&terminal);
        let ended = wait_lists(&receiver, |lists| live(lists) == Some(false));
        drop(viewer);

        connection
            .execute("UPDATE suplex_projects SET name = 'Renamed' WHERE id = 'project_media'", [])
            .unwrap();
        let renamed = wait_lists(&receiver, |lists| !Arc::ptr_eq(&lists.projects, &ended.projects));
        assert_eq!(json(&renamed.projects)[0]["name"], "Renamed");
        assert_eq!(json(&renamed.projects), listed());
        assert!(Arc::ptr_eq(&renamed.moves, &ended.moves));
        assert!(Arc::ptr_eq(&renamed.tasks, &first.tasks));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn feed_stops_without_subscribers_and_starts_again() {
        let (directory, path, _database, first) = fixture();
        let feed = CompanyFeed::new(path, Arc::default());
        let receiver = feed.subscribe("company_media");
        wait(&receiver, |tasks| tasks.len() == 1);
        drop(receiver);
        let deadline = Instant::now() + Duration::from_secs(5);
        while feed.subscriptions.lock().unwrap().running {
            assert!(Instant::now() < deadline, "the feed thread did not stop");
            std::thread::sleep(Duration::from_millis(10));
        }
        let receiver = feed.subscribe("company_media");
        assert_eq!(wait(&receiver, |tasks| tasks.len() == 1)[0]["id"], first);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_watch_outside_a_runtime_observes_on_the_runtime_the_feed_was_created_on() {
        let (directory, path, _database, task_id) = fixture();
        // No runtime anywhere: the watch starts without an observer and does not panic.
        let unobserved = CompanyFeed::new(path.clone(), Arc::default());
        let receiver = unobserved.watch(vec![task_id.clone()], None);
        assert!(unobserved.subscriptions.lock().unwrap().observer.is_none());
        drop(receiver);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let feed = {
            let _entered = runtime.enter();
            CompanyFeed::new(path, Arc::default())
        };
        // This thread has no runtime; the observer runs on the feed's runtime.
        let receiver = feed.watch(vec![task_id.clone()], None);
        let watched = wait_watched(&receiver, |_| true);
        assert_eq!(watched.agents.len(), 1);
        assert_eq!(watched.agents[0].task_id, task_id);
        drop(receiver);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn feed_closes_the_channel_when_it_cannot_read_the_database() {
        let missing = std::env::temp_dir()
            .join(format!("suplex-sync-missing-{}", Uuid::new_v4()))
            .join("suplex.sqlite");
        let feed = CompanyFeed::new(missing, Arc::default());
        let receiver = feed.subscribe("company_media");
        let deadline = Instant::now() + Duration::from_secs(5);
        while receiver.has_changed().is_ok() {
            assert!(Instant::now() < deadline, "the feed kept a channel it cannot serve");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(receiver.borrow().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn watch_publishes_each_value_then_pushes_a_turn_committed_by_another_process() {
        let (directory, path, database, task_id) = fixture();
        add_turn(&database, &task_id);
        let feed = CompanyFeed::new(path.clone(), Arc::default());
        let receiver = feed.watch(vec![task_id.clone()], Some(task_id.clone()));
        // The first value carries every value: the stored ones and the native ones.
        let first = wait_watched(&receiver, |_| true);
        let rows = root_session_store::root_observation_rows(&database, &task_id).unwrap();
        let saved = timeline::read_saved(&database, &task_id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&*first.agents[0]).unwrap(),
            serde_json::to_value(task_agents::agents(
                &task_agents::saved_task(&database, &task_id).unwrap(),
                &path,
                false
            )
            .await
            .unwrap())
            .unwrap()
        );
        assert_eq!(first.agents[0].agents[0].status, TaskAgentStatus::Queued);
        assert_eq!(
            value(&first.open.task),
            serde_json::to_value(repository::task_response(&database, &task_id).unwrap()).unwrap()
        );
        assert_eq!(
            value(&first.open.activity),
            serde_json::to_value(task_reads::activity_document(&database, &rows, &task_id, None).unwrap()).unwrap()
        );
        assert_eq!(
            value(&first.open.execution),
            serde_json::to_value(task_reads::execution_document(&rows, &path).await.unwrap()).unwrap()
        );
        assert_eq!(
            value(&first.open.timeline),
            serde_json::to_value(timeline::observe(&path, saved).await.unwrap()).unwrap()
        );

        // A turn change leaves the task list as it is, so only the watch reports it.
        let other = rusqlite::Connection::open(&path).unwrap();
        other.busy_timeout(Duration::from_secs(5)).unwrap();
        let committed = Instant::now();
        other
            .execute(
                "UPDATE suplex_task_turns SET status = 'completed', terminal_observation = 'Done' WHERE task_id = ?1",
                [&task_id],
            )
            .unwrap();
        let done = wait_watched(&receiver, |watched| {
            watched.open.activity.as_ref().is_some_and(|activity| {
                activity.turns[0].result.as_deref() == Some("Done")
            })
        });
        let elapsed = committed.elapsed();
        assert!(elapsed < Duration::from_millis(500), "pushed after {elapsed:?}");
        assert!(Arc::ptr_eq(&done.agents[0], &first.agents[0]));
        assert!(same(&done.open.execution, &first.open.execution));
        assert!(same(&done.open.timeline, &first.open.timeline));

        // The agents have no commit signal of their own; the runtime pass reads them.
        other
            .execute(
                "UPDATE suplex_task_sessions SET lifecycle = 'stopped', stopped_at = '2026-01-01T00:00:00.000Z' WHERE task_id = ?1",
                [&task_id],
            )
            .unwrap();
        let stopped = wait_watched(&receiver, |watched| {
            watched.agents[0].agents[0].status == TaskAgentStatus::Stopped
        });
        assert_eq!(
            stopped.agents[0].agents[0].status_changed_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        let preparation =
            crate::tasks::preparation::task_preparation_directory(&path, &task_id).unwrap();
        fs::create_dir_all(&preparation).unwrap();
        fs::write(preparation.join("setup.log"), "setup failed").unwrap();
        fs::write(
            preparation.join("setup-result.json"),
            r#"{"state":"failed","exitStatus":"7"}"#,
        )
        .unwrap();
        let setup_changed = wait_watched(&receiver, |watched| {
            watched.open.activity.as_ref().is_some_and(|activity| {
                activity.setup.state == crate::tasks::preparation::SetupState::Failed
            })
        });
        assert_eq!(
            setup_changed
                .open
                .activity
                .as_ref()
                .unwrap()
                .setup
                .exit_status
                .as_deref(),
            Some("7")
        );
        let setup_changed = wait_watched(&receiver, |watched| {
            watched.agents[0].setup.state == crate::tasks::preparation::SetupState::Failed
        });
        assert_eq!(
            setup_changed.agents[0].setup.exit_status.as_deref(),
            Some("7")
        );
        fs::remove_dir_all(preparation).unwrap();
        wait_watched(&receiver, |watched| {
            watched.open.activity.as_ref().is_some_and(|activity| {
                activity.setup.state == crate::tasks::preparation::SetupState::None
            })
        });

        drop(receiver);
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_watch_replaces_the_old_one_and_a_dropped_watch_stops_observation() {
        let (directory, path, mut database, first) = fixture();
        let second = add_task(&mut database, "Second", vec![]);
        let feed = CompanyFeed::new(path, Arc::default());
        let company = feed.subscribe("company_media");
        let old = feed.watch(vec![first.clone()], Some(first.clone()));
        wait_watched(&old, |_| true);
        // A socket drops its previous watch when the client watches other tasks.
        let new = feed.watch(vec![], Some(second.clone()));
        drop(old);
        let watched = wait_watched(&new, |_| true);
        assert!(watched.agents.is_empty());
        let observed = || {
            let subscriptions = feed.subscriptions.lock().unwrap();
            subscriptions.tasks.keys().cloned().collect::<Vec<_>>()
        };
        wait_until("the feed kept observing the old task", || observed() == [second.clone()]);
        // A second watch of the same task reads nothing again.
        let again = feed.watch(vec![], Some(second.clone()));
        let shared = wait_watched(&again, |_| true);
        assert!(same(&shared.open.activity, &watched.open.activity));
        drop((new, again));
        wait_until("the feed kept a closed watch", || {
            let subscriptions = feed.subscriptions.lock().unwrap();
            subscriptions.watchers.is_empty()
                && subscriptions.tasks.is_empty()
                && subscriptions.observer.is_none()
        });
        drop(company);
        wait_until("the feed thread did not stop", || {
            !feed.subscriptions.lock().unwrap().running
        });
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn costs_are_read_again_only_after_the_stored_usage_changed() {
        let (directory, path, mut database, task_id) = fixture();
        let feed = CompanyFeed::new(path, Arc::default());
        let receiver = feed.subscribe("company_media");
        let costs = |database: &SuplexDatabase| {
            let analytics =
                analytics::analytics(database, "user_development", "company_media", Utc::now())
                    .unwrap();
            serde_json::to_value(analytics::task_costs(&analytics).unwrap().tasks).unwrap()
        };
        let first = wait_lists(&receiver, |lists| lists.costs.is_some());
        assert_eq!(value(&first.costs), costs(&database));
        let usage = usage_state(&database, "company_media").unwrap();

        // The collector writes the same usage again with a new time.
        let at = |seconds: u32| format!("2026-01-01T00:00:{seconds:02}.000Z");
        analytics::record(&mut database, &task_id, "root", &[entry("one", 3.0)], &at(1)).unwrap();
        let recorded = usage_state(&database, "company_media").unwrap();
        assert_ne!(recorded, usage);
        analytics::record(&mut database, &task_id, "root", &[entry("one", 3.0)], &at(2)).unwrap();
        assert_eq!(usage_state(&database, "company_media").unwrap(), recorded);
        let priced = wait_lists(&receiver, |lists| {
            lists.costs.as_ref().is_some_and(|costs| costs[0].cost == Some(3.0))
        });
        assert_eq!(value(&priced.costs), costs(&database));

        // A commit outside the usage keeps the costs.
        database
            .connection()
            .execute("UPDATE suplex_tasks SET title = 'Renamed' WHERE id = ?1", [&task_id])
            .unwrap();
        let renamed = wait_lists(&receiver, |lists| json(&lists.tasks)[0]["title"] == "Renamed");
        assert!(same(&renamed.costs, &priced.costs));
        assert_eq!(renamed.usage, Some(recorded));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_pending_costs_read_does_not_delay_a_task_push() {
        let (directory, path, database, task_id) = fixture();
        let feed = CompanyFeed::new(path.clone(), Arc::default());
        // A costs read that does not end: the tail starts no other one.
        feed.subscriptions
            .lock()
            .unwrap()
            .costing
            .insert("company_media".into(), 0);
        let receiver = feed.subscribe("company_media");
        wait_lists(&receiver, |_| true);
        let committed = Instant::now();
        database
            .connection()
            .execute("UPDATE suplex_tasks SET title = 'Renamed' WHERE id = ?1", [&task_id])
            .unwrap();
        let renamed = wait_lists(&receiver, |lists| json(&lists.tasks)[0]["title"] == "Renamed");
        let elapsed = committed.elapsed();
        assert!(elapsed < Duration::from_millis(500), "pushed after {elapsed:?}");
        assert!(renamed.costs.is_none());

        // The tail gave the running read the newest usage. The read publishes
        // the costs of that usage when it ends.
        let usage = usage_state(&database, "company_media").unwrap();
        assert_eq!(feed.subscriptions.lock().unwrap().costing["company_media"], usage);
        read_costs(&path, &feed.subscriptions, "company_media");
        let priced = receiver.borrow().clone().unwrap();
        let analytics =
            analytics::analytics(&database, "user_development", "company_media", Utc::now()).unwrap();
        assert_eq!(
            value(&priced.costs),
            serde_json::to_value(analytics::task_costs(&analytics).unwrap().tasks).unwrap()
        );
        assert_eq!(priced.usage, Some(usage));
        assert!(Arc::ptr_eq(&priced.tasks, &renamed.tasks));
        assert!(feed.subscriptions.lock().unwrap().costing.is_empty());
        drop(receiver);
        fs::remove_dir_all(directory).unwrap();
    }

    /// One feed refresh for a company of 500, 2,000, and 5,000 active tasks,
    /// each with a Coordinator session and 10 usage records. Run with
    /// `cargo test --lib -- --ignored --nocapture refresh_time_at_scale`.
    #[test]
    #[ignore = "measurement"]
    fn refresh_time_at_scale() {
        for count in [500, 2_000, 5_000] {
            let (directory, path, mut database, first) = fixture();
            // Copies of the fixture task; creating tasks stops at the free plan's limit.
            let seeded = [
                ("id", "'task_seed_' || i"),
                ("task_id", "'task_seed_' || i"),
                ("idempotency_key", "'task_seed_' || i"),
                ("issue_number", "issue_number + i"),
            ];
            for (table, key) in [("suplex_tasks", "id"), ("suplex_task_controls", "task_id")] {
                let mut statement = database
                    .connection()
                    .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                    .unwrap();
                let columns = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .unwrap()
                    .map(|column| {
                        let column = column.unwrap();
                        seeded
                            .iter()
                            .find(|(name, _)| *name == column)
                            .map_or(column, |(_, value)| (*value).to_owned())
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                database.connection().execute(
                    &format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2) INSERT INTO {table} SELECT {columns} FROM {table}, n WHERE {key} = ?1"),
                    rusqlite::params![first, count - 1],
                ).unwrap();
            }
            let ids = std::iter::once(first)
                .chain((1..count).map(|index| format!("task_seed_{index}")))
                .collect::<Vec<_>>();
            for id in &ids {
                add_turn(&database, id);
                database.connection().execute(
                    "UPDATE suplex_task_sessions SET native_session_id = 'codex-' || task_id WHERE task_id = ?1",
                    [id],
                ).unwrap();
                let usage = (0..10)
                    .map(|index| TaskUsage {
                        session_id: format!("codex-{id}"),
                        ..entry(&format!("{id}-{index}"), 0.01)
                    })
                    .collect::<Vec<_>>();
                analytics::record(&mut database, id, &format!("{id}-root"), &usage, "2026-01-01T00:00:00.000Z").unwrap();
            }
            let terminals = HostTerminals::default();
            let subscriptions = Arc::new(Mutex::new(Subscriptions::default()));
            {
                let mut subscriptions = subscriptions.lock().unwrap();
                subscriptions
                    .companies
                    .insert("company_media".into(), watch::channel(None).0);
                // Stands for a running costs read, so a refresh starts none.
                subscriptions.costing.insert("company_media".into(), 0);
            }
            let time = |run: &mut dyn FnMut()| {
                let mut runs = (0..5)
                    .map(|_| {
                        let started = Instant::now();
                        run();
                        started.elapsed()
                    })
                    .collect::<Vec<_>>();
                runs.sort();
                runs[2]
            };
            let list = time(&mut || {
                repository::list_active(&database, "company_media").unwrap();
            });
            let probe = time(&mut || {
                usage_state(&database, "company_media").unwrap();
            });
            let costs = time(&mut || {
                let value =
                    analytics::company_analytics(&database, "company_media", Utc::now()).unwrap();
                analytics::task_costs(&value).unwrap();
            });
            // The tail's work for any commit. The costs read runs on its own thread.
            let refresh = time(&mut || {
                publish(&database, &path, &terminals, &subscriptions, "company_media").unwrap();
            });
            println!(
                "{count} tasks: refresh {refresh:?} (list_active {list:?}, usage probe {probe:?}); costs read on its own thread {costs:?}"
            );
            drop(database);
            fs::remove_dir_all(directory).unwrap();
        }
    }
}
