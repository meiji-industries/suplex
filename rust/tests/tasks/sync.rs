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

    /// The published list as JSON, when `ready` accepts it.
    fn wait(
        receiver: &watch::Receiver<Option<TaskList>>,
        ready: impl Fn(&[Value]) -> bool,
    ) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let published = serde_json::to_value(receiver.borrow().as_deref()).unwrap();
            if let Some(tasks) = published.as_array()
                && ready(tasks)
            {
                return tasks.clone();
            }
            assert!(
                Instant::now() < deadline,
                "the feed did not publish the expected list: {published}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
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
        let feed = TaskFeed::new(path.clone());
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

    #[test]
    fn feed_stops_without_subscribers_and_starts_again() {
        let (directory, path, _database, first) = fixture();
        let feed = TaskFeed::new(path);
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
        let feed = TaskFeed::new(missing);
        let receiver = feed.subscribe("company_media");
        let deadline = Instant::now() + Duration::from_secs(5);
        while receiver.has_changed().is_ok() {
            assert!(Instant::now() < deadline, "the feed kept a channel it cannot serve");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(receiver.borrow().is_none());
    }
}
