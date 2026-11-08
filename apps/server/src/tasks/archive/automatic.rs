//! Archive finished tasks after the host's configured number of days without
//! activity, so their worktrees stop using disk space.
//!
//! Each pass reads the setting and the candidates from the database, then
//! archives them one at a time through [`archive_task`]. Archive stops idle
//! sessions, removes the worktree, closes displays, and sets `archived_at`.
//! A task with uncommitted files, a busy agent, or any other failure stays as
//! it is, and a later pass tries it again.

use std::{path::Path, time::Duration};

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use tokio::sync::watch;

use crate::{
    platform::{
        database::{DatabaseResult, OpenMode, SuplexDatabase},
        environment_settings,
    },
    shared::time::rfc3339_millis,
    tasks::{
        TaskError,
        archive::operations::{ArchiveOutcome, archive_task},
        commands,
        control::TaskStatus,
        repository::TaskRecord,
    },
};

/// How often the host looks for finished tasks to archive.
pub const PERIOD: Duration = Duration::from_secs(60 * 60);
/// The most tasks one pass archives.
pub const MAX_ARCHIVES_PER_PASS: usize = 25;
/// The most candidates one pass reads. Skipped tasks do not hide others
/// until this many tasks are skipped.
const MAX_CANDIDATES_PER_PASS: i64 = 100;

/// The last activity of a task: its own or its control's latest write, or its
/// last status change. Older rows have an empty `status_changed_at`.
const LAST_ACTIVITY: &str = "MAX(t.updated_at, c.updated_at, c.status_changed_at)";

/// What one pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    pub archived: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

/// The newest last activity that a task can have and still be archived, or
/// `None` when automatic archive is off.
fn cutoff(days: i64, now: DateTime<Utc>) -> Option<String> {
    if days <= 0 {
        return None;
    }
    let age = chrono::Duration::try_days(days)?;
    // A value too large for a date never archives anything.
    now.checked_sub_signed(age).map(rfc3339_millis)
}

/// The oldest finished, unarchived tasks whose last activity is before `cutoff`.
fn candidates(database: &SuplexDatabase, cutoff: &str) -> DatabaseResult<Vec<String>> {
    let mut statement = database.connection().prepare(&format!(
        "SELECT t.id FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.status IN ('cancelled', 'delivered') AND t.archived_at IS NULL AND {LAST_ACTIVITY} < ?1 ORDER BY {LAST_ACTIVITY}, t.id LIMIT ?2"
    ))?;
    Ok(statement
        .query_map(params![cutoff, MAX_CANDIDATES_PER_PASS], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?)
}

/// Archive keeps calling this at each step, so a task that a person starts,
/// changes, or archives during the cleanup stops the automatic archive.
fn still_eligible(
    database: &SuplexDatabase,
    task: &TaskRecord,
    cutoff: &str,
) -> DatabaseResult<()> {
    let eligible = matches!(task.status, TaskStatus::Cancelled | TaskStatus::Delivered)
        && database
            .connection()
            .query_row(
                &format!(
                    "SELECT 1 FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE t.id = ?1 AND t.archived_at IS NULL AND {LAST_ACTIVITY} < ?2"
                ),
                params![task.id, cutoff],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
    if eligible {
        Ok(())
    } else {
        Err(TaskError::Failure {
            message: "The task is no longer ready for automatic archive".into(),
            status: 409,
            code: "illegal_command",
        }
        .into())
    }
}

/// One pass: read the setting, select candidates with one query, and archive
/// them in order. The pass stops early when the host shuts down.
pub async fn sweep(
    database_path: &Path,
    shutdown: &watch::Receiver<bool>,
    now: DateTime<Utc>,
) -> DatabaseResult<SweepReport> {
    let mut report = SweepReport::default();
    let (cutoff, ids) = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        let days = environment_settings::read(&database)?.auto_archive_after_days;
        let Some(cutoff) = cutoff(days, now) else {
            return Ok(report);
        };
        let ids = candidates(&database, &cutoff)?;
        (cutoff, ids)
    };
    let authority =
        |database: &SuplexDatabase, task: &TaskRecord| still_eligible(database, task, &cutoff);
    for task_id in ids {
        if *shutdown.borrow() || report.archived.len() >= MAX_ARCHIVES_PER_PASS {
            break;
        }
        // Never discard files: a dirty worktree returns the paths and stays.
        match archive_task(database_path, &authority, &task_id, false).await {
            Ok(ArchiveOutcome::Archived(task)) => {
                if let Err(error) = record_archive(database_path, &task) {
                    eprintln!("Task {task_id} automatic archive was not audited: {error}");
                }
                report.archived.push(task_id);
            }
            Ok(ArchiveOutcome::ConfirmationRequired(_)) => report.skipped.push(task_id),
            Err(error) => {
                eprintln!("Task {task_id} automatic archive will retry: {error}");
                report.failed.push(task_id);
            }
        }
    }
    Ok(report)
}

fn record_archive(database_path: &Path, task: &TaskRecord) -> DatabaseResult<()> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    commands::system_audit(&database, "task_archived", task, Utc::now())
}

/// Run a pass when the host starts and then every [`PERIOD`] until shutdown.
pub fn spawn(database_path: std::path::PathBuf, shutdown: watch::Receiver<bool>) {
    let observed = shutdown.clone();
    tokio::spawn(crate::tasks::host::poll_periodically(
        PERIOD,
        shutdown,
        "Automatic archive",
        move || {
            let path = database_path.clone();
            let shutdown = observed.clone();
            async move { sweep(&path, &shutdown, Utc::now()).await.map(|_| ()) }
        },
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth,
        tasks::{
            repository::{self, PreparedTask, TaskCreator},
            worktree::{self, TaskWorktreeIntent},
        },
    };
    use git2::{Repository, Signature};
    use serde_json::json;
    use std::{fs, path::PathBuf};

    const OLD: &str = "2026-01-01T00:00:00.000Z";

    struct Fixture {
        base: PathBuf,
        repository_path: PathBuf,
        worktree_root: PathBuf,
        sha: String,
        database_path: PathBuf,
        user_id: String,
    }

    fn fixture() -> Fixture {
        let base =
            std::env::temp_dir().join(format!("suplex-auto-archive-{}", uuid::Uuid::new_v4()));
        let repository_path = base.join("repository");
        let worktree_root = base.join("worktrees");
        fs::create_dir_all(&repository_path).unwrap();
        let repository = Repository::init(&repository_path).unwrap();
        fs::write(
            repository_path.join("README.md"),
            "automatic archive fixture\n",
        )
        .unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("Suplex", "suplex@example.invalid").unwrap();
        let sha = repository
            .commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
            .unwrap()
            .to_string();
        let database_path = base.join("suplex.sqlite");
        let now = Utc::now();
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        let time = rfc3339_millis(now);
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('auto_company','Automatic','active',?1)", [&time]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('auto_project','auto_company','Project',?1,?2,NULL,'main','','','root_profile','worker_profile',?3,?3)", params![repository_path.to_string_lossy(),worktree_root.to_string_lossy(),time]).unwrap();
        Fixture {
            base,
            repository_path,
            worktree_root,
            sha,
            database_path,
            user_id: user.id,
        }
    }

    impl Fixture {
        /// A task with `status`, last active at `activity`, with a worktree when `worktree`.
        fn task(
            &self,
            name: &str,
            status: &str,
            activity: Option<&str>,
            worktree: bool,
        ) -> (String, PathBuf) {
            let mut database =
                SuplexDatabase::open(&self.database_path, OpenMode::ReadWrite).unwrap();
            let profile = json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
            let id = repository::new_task_id();
            let branch = format!("task-{name}");
            repository::create(
                &mut database,
                &PreparedTask {
                    id: id.clone(),
                    company_id: "auto_company".into(),
                    project_id: "auto_project".into(),
                    title: format!("Automatic archive {name}"),
                    description: "".into(),
                    configuration: json!({"repository":"owner/repo","baseBranch":"main","baselineSha":self.sha,"capturedAt":OLD,"repositoryPath":self.repository_path,"worktreeRoot":self.worktree_root,"branch":branch,"startingSha":self.sha}),
                    idempotency_key: format!("auto-key-{name}"),
                    request_hash: format!("auto-hash-{name}"),
                    creator: TaskCreator::User(self.user_id.clone()),
                    delivery_target: "pull_request_draft".into(),
                    delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":branch,"baseBranch":"main","baselineSha":self.sha,"pullRequestNumber":null})).unwrap(),
                    root_profile: serde_json::from_value(profile.clone()).unwrap(),
                    worker_profile: serde_json::from_value(profile).unwrap(),
                    advisor_profiles: serde_json::from_value(json!({})).unwrap(),
                    issue: None,
                    start_queued: false,
                    copied_from_task_id: None,
                    depends_on: vec![],
                    pull_request_dependencies: vec![],
                    workflow: crate::coordination::workflows::Workflow::Standard,
                },
                Utc::now(),
            )
            .unwrap();
            let path = if worktree {
                worktree::prepare_local_task_worktree(
                    &TaskWorktreeIntent {
                        task_id: id.clone(),
                        repository_path: self.repository_path.clone(),
                        worktree_root: self.worktree_root.clone(),
                        branch,
                        starting_sha: self.sha.clone(),
                    },
                    None,
                )
                .unwrap()
                .path
            } else {
                self.worktree_root.join(&id)
            };
            let connection = database.connection();
            connection
                .execute(
                    "UPDATE suplex_task_controls SET status = ?1, human_question = CASE WHEN ?1 = 'waiting_human' THEN 'Continue?' END, human_question_id = CASE WHEN ?1 = 'waiting_human' THEN 'question' END WHERE task_id = ?2",
                    params![status, id],
                )
                .unwrap();
            if let Some(activity) = activity {
                connection.execute("UPDATE suplex_task_controls SET updated_at = ?1, status_changed_at = ?1 WHERE task_id = ?2", params![activity, id]).unwrap();
                connection
                    .execute(
                        "UPDATE suplex_tasks SET updated_at = ?1 WHERE id = ?2",
                        params![activity, id],
                    )
                    .unwrap();
            }
            (id, path)
        }

        fn set_days(&self, days: i64) {
            let mut database =
                SuplexDatabase::open(&self.database_path, OpenMode::ReadWrite).unwrap();
            let current = environment_settings::read(&database).unwrap();
            environment_settings::update(
                &mut database,
                environment_settings::EnvironmentSettings {
                    auto_archive_after_days: days,
                    ..current
                },
            )
            .unwrap();
        }

        fn archived_at(&self, id: &str) -> Option<String> {
            let database = SuplexDatabase::open(&self.database_path, OpenMode::ReadOnly).unwrap();
            database
                .connection()
                .query_row(
                    "SELECT archived_at FROM suplex_tasks WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        }

        async fn sweep(&self) -> SweepReport {
            let (_shutdown_tx, shutdown) = watch::channel(false);
            sweep(&self.database_path, &shutdown, Utc::now())
                .await
                .unwrap()
        }
    }

    #[test]
    fn zero_or_out_of_range_days_select_nothing() {
        let now = Utc::now();
        assert_eq!(cutoff(0, now), None);
        assert_eq!(cutoff(-3, now), None);
        assert_eq!(cutoff(i64::MAX, now), None);
        assert_eq!(
            cutoff(30, now),
            Some(rfc3339_millis(now - chrono::Duration::days(30)))
        );
    }

    #[tokio::test]
    async fn sweep_archives_only_old_finished_tasks_and_keeps_dirty_files() {
        let fixture = fixture();
        // Oldest first: the failing and dirty candidates come before the others.
        let (broken, _) = fixture.task(
            "broken",
            "delivered",
            Some("2025-12-01T00:00:00.000Z"),
            false,
        );
        let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.repositoryPath', '') WHERE id = ?1", [&broken]).unwrap();
        drop(database);
        let (dirty, dirty_path) =
            fixture.task("dirty", "cancelled", Some("2025-12-02T00:00:00.000Z"), true);
        fs::write(dirty_path.join("draft.txt"), "keep\n").unwrap();
        let (delivered, delivered_path) = fixture.task("delivered", "delivered", Some(OLD), true);
        let (cancelled, _) = fixture.task(
            "cancelled",
            "cancelled",
            Some("2026-01-02T00:00:00.000Z"),
            false,
        );
        let (recent, recent_path) = fixture.task("recent", "delivered", None, true);
        let mut unfinished = Vec::new();
        for status in ["backlog", "queued", "active", "waiting_human"] {
            unfinished.push(fixture.task(status, status, Some(OLD), true));
        }
        let (archived, _) = fixture.task("archived", "cancelled", Some(OLD), false);
        let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_tasks SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![OLD, archived],
            )
            .unwrap();
        drop(database);

        // 0 turns automatic archive off.
        fixture.set_days(0);
        assert_eq!(fixture.sweep().await, SweepReport::default());
        assert!(fixture.archived_at(&delivered).is_none());
        assert!(delivered_path.exists());

        fixture.set_days(30);
        let report = fixture.sweep().await;
        assert_eq!(report.failed, [broken.as_str()]);
        assert_eq!(report.skipped, [dirty.as_str()]);
        assert_eq!(report.archived, [delivered.clone(), cancelled.clone()]);
        assert!(fixture.archived_at(&delivered).is_some());
        assert!(fixture.archived_at(&cancelled).is_some());
        assert!(!delivered_path.exists());
        // The branch stays after the worktree is removed.
        let source = Repository::open(&fixture.repository_path).unwrap();
        assert!(
            source
                .find_branch("task-delivered", git2::BranchType::Local)
                .is_ok()
        );
        drop(source);
        // A skipped dirty task keeps its worktree and its files.
        assert!(fixture.archived_at(&dirty).is_none());
        assert_eq!(
            fs::read_to_string(dirty_path.join("draft.txt")).unwrap(),
            "keep\n"
        );
        assert!(fixture.archived_at(&broken).is_none());
        assert!(fixture.archived_at(&recent).is_none());
        assert!(recent_path.exists());
        for (id, path) in &unfinished {
            assert!(fixture.archived_at(id).is_none());
            assert!(path.exists());
        }
        assert_eq!(fixture.archived_at(&archived).as_deref(), Some(OLD));

        // Each automatic archive has the audit of a manual one, sent by Suplex.
        let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadOnly).unwrap();
        let (count, actors): (i64, i64) = database.connection().query_row(
            "SELECT COUNT(*), COUNT(actor_user_id) + COUNT(actor_agent_id) FROM suplex_audit_events WHERE action = 'task_archived'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!((count, actors), (2, 0));
        let actions = crate::http::routes::task_reads::task_actions(&database, &delivered).unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].actor_name, "Suplex");
        assert_eq!(
            actions[0].action,
            crate::http::contracts::task_reads::TaskActivityActionKind::Archived
        );
        drop(database);

        // A later pass retries the skipped task once its files are committed or gone.
        fs::remove_file(dirty_path.join("draft.txt")).unwrap();
        let report = fixture.sweep().await;
        assert_eq!(report.archived, [dirty.as_str()]);
        assert_eq!(report.failed, [broken]);
        assert!(!dirty_path.exists());
        // Archived tasks are not selected again.
        let report = fixture.sweep().await;
        assert!(report.archived.is_empty());
        fs::remove_dir_all(fixture.base).unwrap();
    }

    #[tokio::test]
    async fn a_task_that_changes_during_the_pass_is_not_archived() {
        let fixture = fixture();
        let (task, path) = fixture.task("reopened", "delivered", Some(OLD), true);
        let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadOnly).unwrap();
        let record = repository::task_by_id(&database, &task).unwrap().unwrap();
        let cutoff = cutoff(30, Utc::now()).unwrap();
        assert!(still_eligible(&database, &record, &cutoff).is_ok());
        drop(database);
        // A person moves the task back to the backlog after the selection.
        let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'backlog' WHERE task_id = ?1",
                [&task],
            )
            .unwrap();
        let record = repository::task_by_id(&database, &task).unwrap().unwrap();
        assert!(still_eligible(&database, &record, &cutoff).is_err());
        // New activity on a finished task restarts its count of days.
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'delivered' WHERE task_id = ?1",
                [&task],
            )
            .unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_tasks SET updated_at = ?1 WHERE id = ?2",
                params![rfc3339_millis(Utc::now()), task],
            )
            .unwrap();
        let record = repository::task_by_id(&database, &task).unwrap().unwrap();
        assert!(still_eligible(&database, &record, &cutoff).is_err());
        drop(database);
        assert_eq!(fixture.sweep().await, SweepReport::default());
        assert!(path.exists());
        fs::remove_dir_all(fixture.base).unwrap();
    }

    #[tokio::test]
    async fn a_task_with_an_active_session_operation_is_retried_later() {
        let fixture = fixture();
        let (busy, path) = fixture.task("busy", "delivered", Some(OLD), true);
        let (other, _) = fixture.task(
            "other",
            "cancelled",
            Some("2026-01-02T00:00:00.000Z"),
            false,
        );
        let owner = crate::runtimes::process::inspect_process(std::process::id()).unwrap();
        let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,created_at,updated_at,launch_owner_pid,launch_owner_start_time) VALUES ('busy_session',?1,'root',1,1,'reserved',?2,?2,?3,?4)", params![busy, OLD, owner.pid, owner.start_time]).unwrap();
        drop(database);
        let report = fixture.sweep().await;
        assert_eq!(report.failed, [busy.as_str()]);
        assert_eq!(report.archived, [other]);
        assert!(fixture.archived_at(&busy).is_none());
        assert!(path.exists());
        // The operation stops; the next pass archives the task.
        let database = SuplexDatabase::open(&fixture.database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("UPDATE suplex_task_sessions SET launch_owner_pid = NULL, launch_owner_start_time = NULL", []).unwrap();
        drop(database);
        assert_eq!(fixture.sweep().await.archived, [busy.as_str()]);
        assert!(!path.exists());
        fs::remove_dir_all(fixture.base).unwrap();
    }

    #[tokio::test]
    async fn a_pass_stops_when_the_host_shuts_down() {
        let fixture = fixture();
        let (task, _) = fixture.task("shutdown", "cancelled", Some(OLD), false);
        let (_shutdown_tx, shutdown) = watch::channel(true);
        let report = sweep(&fixture.database_path, &shutdown, Utc::now())
            .await
            .unwrap();
        assert_eq!(report, SweepReport::default());
        assert!(fixture.archived_at(&task).is_none());
        fs::remove_dir_all(fixture.base).unwrap();
    }
}
