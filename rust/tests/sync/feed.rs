#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        coordination::workflows::Workflow,
        tasks::{
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
        let listed = repository::list_active(&database, "company_media").unwrap();
        assert_eq!(listed.len(), 2);
        for row in listed {
            let full = repository::task_response(&database, &row.id)
                .unwrap()
                .unwrap();
            assert_eq!(row, TaskListItem::from(full));
        }
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
}
