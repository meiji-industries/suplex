//! Archive a task, or send it back to the backlog, only after native sessions
//! and its live Git worktree are safe.
//! Saved pane and worktree display fields do not decide whether cleanup may run.

use crate::shared::time::{now_millis_rfc3339, rfc3339_millis};
use crate::tasks::TaskError;
use crate::tasks::control::TaskStatus;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use crate::tasks::response::TaskConfiguration;
use rusqlite::params;

use crate::{
    coordination::{root_session_store, session_recovery},
    identity::companies,
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    runtimes::{
        native as session_reader,
        process::inspect_process,
        task_harness::{ReaderSession, TaskHarness},
        task_harness_registry,
    },
    tasks::{
        archive::displays,
        commands,
        repository::{self, TaskRecord},
        worktree::{self, TaskWorktreeIntent, WorktreeCleanup},
    },
};

static ARCHIVES_IN_PROGRESS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct ArchiveGuard(String);

impl ArchiveGuard {
    fn acquire(task_id: &str) -> DatabaseResult<Self> {
        let mut active = ARCHIVES_IN_PROGRESS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(|_| TaskError::internal("Archive state is unavailable"))?;
        if !active.insert(task_id.to_owned()) {
            return Err(failure("Archive cleanup is in progress", 409));
        }
        Ok(Self(task_id.to_owned()))
    }
}

impl Drop for ArchiveGuard {
    fn drop(&mut self) {
        if let Some(active) = ARCHIVES_IN_PROGRESS.get()
            && let Ok(mut active) = active.lock()
        {
            active.remove(&self.0);
        }
    }
}

pub fn in_progress(task_id: &str) -> bool {
    ARCHIVES_IN_PROGRESS
        .get()
        .and_then(|active| active.lock().ok().map(|active| active.contains(task_id)))
        .unwrap_or(false)
}

fn failure(message: &str, status_code: u16) -> Box<dyn std::error::Error + Send + Sync> {
    failure_code(message, status_code, "task_failure")
}

fn failure_code(
    message: &str,
    status_code: u16,
    code: &'static str,
) -> Box<dyn std::error::Error + Send + Sync> {
    TaskError::Failure {
        message: message.to_owned(),
        status: status_code,
        code,
    }
    .into()
}

fn cleanup_error(
    error: Box<dyn std::error::Error + Send + Sync>,
) -> Box<dyn std::error::Error + Send + Sync> {
    if matches!(error.downcast_ref(), Some(TaskError::Failure { .. })) {
        error
    } else {
        failure(&error.to_string(), 409)
    }
}

/// Live authority over one task: a board user's company access or a paired agent's grant.
pub type Authority<'a> = &'a (dyn Fn(&SuplexDatabase, &TaskRecord) -> DatabaseResult<()> + Sync);

fn user_authority(
    actor_user_id: &str,
) -> impl Fn(&SuplexDatabase, &TaskRecord) -> DatabaseResult<()> + Sync + '_ {
    move |database, task| {
        companies::require_company_edit(database, actor_user_id, &task.company_id).map(|_| ())
    }
}

fn task_scope(
    database: &SuplexDatabase,
    authority: Authority<'_>,
    task_id: &str,
) -> DatabaseResult<(TaskRecord, TaskConfiguration)> {
    let task =
        repository::task_by_id(database, task_id)?.ok_or_else(|| failure("Not found", 404))?;
    authority(database, &task)?;
    let configuration: String = database.connection().query_row(
        "SELECT configuration_json FROM suplex_tasks WHERE id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    Ok((
        task,
        serde_json::from_str::<TaskConfiguration>(&configuration)?,
    ))
}

fn reauthorize(
    database: &SuplexDatabase,
    authority: Authority<'_>,
    task_id: &str,
) -> DatabaseResult<()> {
    task_scope(database, authority, task_id)?;
    Ok(())
}

/// One idle native session that archive stops after its displays are prepared.
struct IdleSession {
    harness: &'static dyn TaskHarness,
    directory: PathBuf,
    native_session_id: Option<String>,
}

/// A task session: id, launch owner process id and start time, native id, and instance home.
type ArchiveSession = (
    String,
    Option<u32>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn archive_sessions(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Vec<ArchiveSession>> {
    let mut statement = database.connection().prepare(
        "SELECT id, launch_owner_pid, launch_owner_start_time, native_session_id, json_extract(profile_json, '$.instanceHomeDirectory') FROM suplex_task_sessions WHERE task_id = ?1",
    )?;
    Ok(statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<u32>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// TypeScript `stopIdleArchiveSessions`: every native reader confirms its
/// session is idle before anything stops.
async fn archive_sessions_idle(
    sessions: Vec<ArchiveSession>,
    database_path: &Path,
) -> DatabaseResult<Vec<IdleSession>> {
    let mut idle = Vec::new();
    for (session_id, owner_pid, owner_start_time, native_session_id, instance_home) in sessions {
        if let (Some(pid), Some(start_time)) = (owner_pid, owner_start_time)
            && inspect_process(pid)
                .as_ref()
                .is_some_and(|owner| owner.start_time == start_time)
        {
            return Err(failure(
                "A task session operation is still active. Retry after it stops.",
                409,
            ));
        }
        let directory = session_reader::session_directory(database_path, &session_id)?;
        // TypeScript `nativeSessionReader`: a session without a native identity belongs to OpenCode.
        let harness = task_harness_registry::for_session(native_session_id.as_deref())
            .ok_or_else(|| TaskError::internal("No native reader for this session"))?;
        let busy = harness
            .busy(&ReaderSession {
                database_path,
                session_id: &session_id,
                native_session_id: native_session_id.as_deref().unwrap_or_default(),
                instance_home_directory: instance_home.as_deref().map(Path::new),
            })
            .await?;
        if busy {
            return Err(failure(
                "An agent is still active. Retry after it stops.",
                409,
            ));
        }
        idle.push(IdleSession {
            harness,
            directory,
            native_session_id,
        });
    }
    Ok(idle)
}

#[derive(Debug)]
pub enum ArchiveOutcome {
    Archived(TaskRecord),
    ConfirmationRequired(Vec<String>),
}

/// Reopen an authorized task, checking current pull-request ownership for
/// statuses that can resume work.
pub fn unarchive_local_task(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
) -> DatabaseResult<TaskRecord> {
    let task = unarchive_task(database, &user_authority(actor_user_id), task_id)?;
    commands::audit(
        database,
        actor_user_id,
        "task_unarchived",
        &task,
        chrono::Utc::now(),
    )?;
    Ok(task)
}

pub fn unarchive_task(
    database: &mut SuplexDatabase,
    authority: Authority<'_>,
    task_id: &str,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let (task, _) = task_scope(database, authority, task_id)?;
        if in_progress(task_id) {
            return Err(failure("Archive cleanup is in progress", 409));
        }
        if matches!(
            task.status,
            TaskStatus::Backlog
                | TaskStatus::Queued
                | TaskStatus::Active
                | TaskStatus::WaitingHuman
        ) {
            repository::assert_task_pull_requests_available(database, task_id)?;
        }
        let now = now_millis_rfc3339();
        database.connection().execute(
            "UPDATE suplex_tasks SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, task_id],
        )?;
        repository::task_by_id(database, task_id)?.ok_or_else(|| failure("Not found", 404))
    })
}

/// Archive operation for a detached caller. The database is never held locked
/// while native processes or Git are inspected.
pub async fn archive_local_task(
    database_path: &Path,
    actor_user_id: &str,
    task_id: &str,
    confirm_discard_dirty: bool,
) -> DatabaseResult<ArchiveOutcome> {
    let outcome = archive_task(
        database_path,
        &user_authority(actor_user_id),
        task_id,
        confirm_discard_dirty,
    )
    .await?;
    if let ArchiveOutcome::Archived(task) = &outcome {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        commands::audit(
            &database,
            actor_user_id,
            "task_archived",
            task,
            chrono::Utc::now(),
        )?;
    }
    Ok(outcome)
}

pub async fn archive_task(
    database_path: &Path,
    authority: Authority<'_>,
    task_id: &str,
    confirm_discard_dirty: bool,
) -> DatabaseResult<ArchiveOutcome> {
    // No transaction stays open while native processes or Git are inspected.
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let (task, configuration) = task_scope(&database, authority, task_id)?;
    if in_progress(task_id) {
        return Err(failure("Archive cleanup is in progress", 409));
    }
    if !task.status.archivable() {
        return Err(failure("Cancel the task before archiving it", 409));
    }
    let _guard = ArchiveGuard::acquire(task_id)?;
    if let Some(dirty_file_paths) = release_task_resources(
        &mut database,
        database_path,
        authority,
        task_id,
        &configuration,
        confirm_discard_dirty,
    )
    .await?
    {
        return Ok(ArchiveOutcome::ConfirmationRequired(dirty_file_paths));
    }
    database.transaction(true, |database| {
        let (current, _) = task_scope(database, authority, task_id)?;
        if !current.status.archivable() {
            return Err(failure_code("The task changed while its worktree was removed", 409, "illegal_command"));
        }
        let now = now_millis_rfc3339();
        database.connection().execute(
            "UPDATE suplex_task_controls SET worktree_json = NULL WHERE task_id = ?1",
            [task_id],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'backlog', updated_at = ?1 WHERE task_id = ?2 AND status = 'queued'",
            params![now, task_id],
        )?;
        database.connection().execute(
            "UPDATE suplex_tasks SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, task_id],
        )?;
        let archived = repository::task_by_id(database, task_id)?
            .ok_or_else(|| failure("Not found", 404))?;
        Ok(ArchiveOutcome::Archived(archived))
    })
}

/// Stop the task's idle native sessions, remove its live Git worktree, and close
/// its displays. Returns the dirty files that need confirmation; the worktree
/// and its files stay when they do. Archive and backlog share this cleanup.
async fn release_task_resources(
    database: &mut SuplexDatabase,
    database_path: &Path,
    authority: Authority<'_>,
    task_id: &str,
    configuration: &TaskConfiguration,
    confirm_discard_dirty: bool,
) -> DatabaseResult<Option<Vec<String>>> {
    let sessions = archive_sessions(database, task_id).map_err(cleanup_error)?;
    let idle = archive_sessions_idle(sessions, database_path)
        .await
        .map_err(cleanup_error)?;
    let displays = displays::prepare_task_displays(database, task_id).map_err(cleanup_error)?;
    // An idle OpenCode server still runs until its harness stops it.
    for session in &idle {
        session
            .harness
            .stop(&session.directory, session.native_session_id.as_deref())
            .await
            .map_err(|error| cleanup_error(error.into()))?;
    }
    reauthorize(database, authority, task_id)?;

    if configuration.repository_path.is_empty() {
        return Err(TaskError::internal("Task repositoryPath is missing").into());
    }
    if configuration.worktree_root.is_empty() {
        return Err(TaskError::internal("Task worktreeRoot is missing").into());
    }
    let intent = TaskWorktreeIntent {
        task_id: task_id.to_owned(),
        repository_path: PathBuf::from(&configuration.repository_path),
        worktree_root: PathBuf::from(&configuration.worktree_root),
        branch: configuration.branch.clone(),
        starting_sha: configuration.starting_sha.clone(),
    };
    let database = &*database;
    let cleanup = worktree::remove_local_task_worktree(&intent, confirm_discard_dirty, || {
        reauthorize(database, authority, task_id)
    })
    .map_err(cleanup_error)?;
    if let WorktreeCleanup::ConfirmationRequired { dirty_file_paths } = cleanup {
        return Ok(Some(dirty_file_paths));
    }
    reauthorize(database, authority, task_id)?;
    displays.close().map_err(cleanup_error)?;
    Ok(None)
}

#[derive(Debug)]
pub enum BacklogOutcome {
    Returned(TaskRecord),
    ConfirmationRequired(Vec<String>),
}

/// Send a task back to the top of the backlog as fresh work. Active work is
/// cancelled first; the old branch and its commits stay as archived work in
/// progress, and the task gets a new branch name. Turns, usage, and audit stay.
pub async fn backlog_local_task(
    database_path: &Path,
    actor_user_id: &str,
    task_id: &str,
    confirm_discard_dirty: bool,
) -> DatabaseResult<BacklogOutcome> {
    let authority = user_authority(actor_user_id);
    let authority: Authority<'_> = &authority;
    // No transaction stays open while native processes or Git are inspected.
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let (task, _) = task_scope(&database, authority, task_id)?;
    if in_progress(task_id) {
        return Err(failure("Archive cleanup is in progress", 409));
    }
    if task.status == TaskStatus::Backlog && !archived(&database, task_id)? {
        return Ok(BacklogOutcome::Returned(task));
    }
    let _guard = ArchiveGuard::acquire(task_id)?;
    if matches!(task.status, TaskStatus::Active | TaskStatus::WaitingHuman) {
        // The cleanup below stops the retired sessions; the host sweep stops any it leaves.
        commands::cancel_user_task(
            &mut database,
            actor_user_id,
            task_id,
            chrono::Utc::now(),
            |_| {},
        )?;
    }
    session_recovery::stop_retired_sessions(&mut database, database_path, task_id)
        .await
        .map_err(cleanup_error)?;
    let (_, configuration) = task_scope(&database, authority, task_id)?;
    if let Some(dirty_file_paths) = release_task_resources(
        &mut database,
        database_path,
        authority,
        task_id,
        &configuration,
        confirm_discard_dirty,
    )
    .await?
    {
        return Ok(BacklogOutcome::ConfirmationRequired(dirty_file_paths));
    }
    let branch = fresh_branch_name(&task, &configuration);
    let now = chrono::Utc::now();
    let returned = database.transaction(true, |database| {
        let (current, _) = task_scope(database, authority, task_id)?;
        if matches!(current.status, TaskStatus::Active | TaskStatus::WaitingHuman) {
            return Err(failure_code(
                "The task changed while its worktree was removed",
                409,
                "illegal_command",
            ));
        }
        root_session_store::return_to_backlog(database, task_id, now)?;
        let time = rfc3339_millis(now);
        let (configuration, intent): (String, String) = database.connection().query_row(
            "SELECT t.configuration_json, c.delivery_intent_json FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut configuration: serde_json::Value = serde_json::from_str(&configuration)?;
        let mut intent: serde_json::Value = serde_json::from_str(&intent)?;
        if configuration.get("localBranch").is_some_and(|value| !value.is_null()) {
            // A pinned branch or pull request source keeps its published branch.
            configuration["localBranch"] = branch.clone().into();
        } else {
            configuration["branch"] = branch.clone().into();
            intent["headBranch"] = branch.clone().into();
            intent["pullRequestNumber"] = serde_json::Value::Null;
        }
        database.connection().execute(
            "UPDATE suplex_task_controls SET delivery_intent_json = ?1 WHERE task_id = ?2",
            params![intent.to_string(), task_id],
        )?;
        database.connection().execute(
            "UPDATE suplex_tasks SET configuration_json = ?1, archived_at = NULL, updated_at = ?2 WHERE id = ?3",
            params![configuration.to_string(), time, task_id],
        )?;
        repository::assert_task_pull_requests_available(database, task_id)?;
        repository::task_by_id(database, task_id)?.ok_or_else(|| failure("Not found", 404))
    })?;
    commands::audit(
        &database,
        actor_user_id,
        "task_sent_to_backlog",
        &returned,
        now,
    )?;
    Ok(BacklogOutcome::Returned(returned))
}

fn archived(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<bool> {
    Ok(database.connection().query_row(
        "SELECT archived_at IS NOT NULL FROM suplex_tasks WHERE id = ?1",
        [task_id],
        |row| row.get(0),
    )?)
}

/// A new task branch name, so the next start never reuses the old branch and
/// its commits. Live Git decides whether a candidate name is already taken.
fn fresh_branch_name(task: &TaskRecord, configuration: &TaskConfiguration) -> String {
    let base = commands::task_branch_name(&task.title, &task.id);
    let repository = git2::Repository::open(&configuration.repository_path).ok();
    let mut candidate = String::new();
    for _ in 0..8 {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        candidate = format!("{base}-{}", &suffix[..4]);
        let taken = repository.as_ref().is_some_and(|repository| {
            repository
                .find_branch(&candidate, git2::BranchType::Local)
                .is_ok()
        });
        if !taken {
            break;
        }
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::time::rfc3339_millis;
    use crate::{
        coordination::root_session_store,
        identity::auth,
        runtimes::headless::{HeadlessTurnRecord, RecordedProcessIdentity},
        tasks::repository::{PreparedTask, TaskCreator},
    };
    use git2::{Repository, Signature};
    use serde_json::json;
    use std::fs;

    #[tokio::test]
    async fn archive_uses_live_native_and_git_facts_then_commits_once() {
        let base = std::env::temp_dir().join(format!("suplex-archive-{}", uuid::Uuid::new_v4()));
        let repository_path = base.join("repository");
        let worktree_root = base.join("worktrees");
        fs::create_dir_all(&repository_path).unwrap();
        let repository = Repository::init(&repository_path).unwrap();
        fs::write(repository_path.join("README.md"), "archive fixture\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("Suplex", "suplex@example.invalid").unwrap();
        let sha = repository
            .commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
            .unwrap()
            .to_string();
        drop(tree);
        drop(repository);
        let database_path = base.join("suplex.sqlite");
        let now = chrono::Utc::now();
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        let time = rfc3339_millis(now);
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('archive_company','Archive','active',?1)", [&time]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('archive_project','archive_company','Project',?1,?2,NULL,'main','','','root_profile','worker_profile',?3,?3)", params![repository_path.to_string_lossy(),worktree_root.to_string_lossy(),time]).unwrap();
        let task_id = repository::new_task_id();
        let intent = TaskWorktreeIntent {
            task_id: task_id.clone(),
            repository_path: repository_path.clone(),
            worktree_root: worktree_root.clone(),
            branch: "task-archive".into(),
            starting_sha: sha.clone(),
        };
        let worktree = worktree::prepare_local_task_worktree(&intent, None).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: task_id.clone(), company_id: "archive_company".into(), project_id: "archive_project".into(),
            title: "Archive task".into(), description: "".into(),
            configuration: json!({"repository":"owner/repo","baseBranch":"main","baselineSha":sha,"capturedAt":time,"repositoryPath":repository_path,"worktreeRoot":worktree_root,"branch":"task-archive","startingSha":sha}),
            idempotency_key: "archive-key".into(), request_hash: "archive-hash".into(), creator: TaskCreator::User(user.id.clone()),
            delivery_target: "pull_request_draft".into(), delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(), root_profile: serde_json::from_value(json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(), worker_profile: serde_json::from_value(json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(), advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: false, copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        }, now).unwrap().task;
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
                params![
                    json!({"path":"/stale/display/path","branch":"stale"}).to_string(),
                    task_id
                ],
            )
            .unwrap();
        database.connection().execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,created_at,updated_at) VALUES ('archive_session',?1,'root',1,1,'reserved',?2,?2)", params![task_id,time]).unwrap();
        let owner = inspect_process(std::process::id()).unwrap();
        database.connection().execute("UPDATE suplex_task_sessions SET launch_owner_pid = ?1,launch_owner_start_time = ?2 WHERE id = 'archive_session'", params![owner.pid,owner.start_time]).unwrap();
        drop(database);
        assert!(
            archive_local_task(&database_path, &user.id, &task_id, false)
                .await
                .is_err()
        );
        assert!(worktree.path.exists());
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("UPDATE suplex_task_sessions SET launch_owner_pid = NULL,launch_owner_start_time = NULL,native_session_id = 'codex-native',profile_json = '{\"provider\":\"opencode\"}' WHERE id = 'archive_session'", []).unwrap();
        drop(database);
        let directory =
            session_reader::session_directory(&database_path, "archive_session").unwrap();
        fs::create_dir_all(&directory).unwrap();
        let native = HeadlessTurnRecord {
            generation: "native-generation".into(),
            turn_id: "native-turn".into(),
            session_id: "codex-native".into(),
            pid: owner.pid,
            process_identity: RecordedProcessIdentity {
                command: owner.command,
                executable: owner.executable,
                argv: owner.argv,
                process_group: owner.process_group,
                start_time: owner.start_time,
                owner_uid: owner.owner_uid.unwrap(),
            },
            dispatch_arguments: vec![],
        };
        fs::write(
            directory.join("turn.json"),
            serde_json::to_vec(&native).unwrap(),
        )
        .unwrap();
        assert!(
            archive_local_task(&database_path, &user.id, &task_id, false)
                .await
                .is_err()
        );
        assert!(worktree.path.exists());
        fs::remove_file(directory.join("turn.json")).unwrap();
        // Every provider is ported, so no native session is an unsupported one anymore.
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("UPDATE suplex_task_sessions SET native_session_id = NULL WHERE id = 'archive_session'", []).unwrap();
        drop(database);
        fs::write(worktree.path.join("draft.txt"), "keep\n").unwrap();
        match archive_local_task(&database_path, &user.id, &task_id, false)
            .await
            .unwrap()
        {
            ArchiveOutcome::ConfirmationRequired(paths) => assert_eq!(paths, ["draft.txt"]),
            ArchiveOutcome::Archived(_) => panic!("dirty worktree needs confirmation"),
        }
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("UPDATE suplex_task_controls SET delivery_target = 'pull_request_draft' WHERE task_id = ?1", [&task_id]).unwrap();
        drop(database);
        match archive_local_task(&database_path, &user.id, &task_id, false)
            .await
            .unwrap()
        {
            ArchiveOutcome::ConfirmationRequired(paths) => assert_eq!(paths, ["draft.txt"]),
            ArchiveOutcome::Archived(_) => panic!("dirty pull-request task needs confirmation"),
        }
        // An idle OpenCode server of a session without a native identity is stopped by its harness.
        // A detached server, like a real one: init reaps it once it stops.
        let spawned = {
            use std::os::unix::process::CommandExt;
            std::process::Command::new("/bin/sh")
                .args(["-c", "/bin/sleep 30 >/dev/null 2>&1 & echo $!"])
                .process_group(0)
                .output()
                .unwrap()
        };
        let server: u32 = String::from_utf8(spawned.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let identity = inspect_process(server).unwrap();
        let status = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", status.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for stream in status.incoming() {
                let mut stream = stream.unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}");
            }
        });
        let reference = json!({
            "pid": server, "baseUrl": base_url, "password": "p".repeat(32),
            "directory": worktree.path, "executable": identity.executable,
            "generation": uuid::Uuid::new_v4().to_string(), "configHash": "a".repeat(64),
            "processIdentity": {"command": identity.command, "executable": identity.executable, "argv": identity.argv,
                "processGroup": identity.process_group, "startTime": identity.start_time, "ownerUid": identity.owner_uid.unwrap()},
        });
        fs::write(directory.join("server.json"), reference.to_string()).unwrap();
        match archive_local_task(&database_path, &user.id, &task_id, false)
            .await
            .unwrap()
        {
            ArchiveOutcome::ConfirmationRequired(paths) => assert_eq!(paths, ["draft.txt"]),
            ArchiveOutcome::Archived(_) => panic!("dirty worktree needs confirmation"),
        }
        assert!(
            (0..50).any(|_| {
                let exited = !crate::runtimes::opencode::server::process_alive(server);
                if !exited {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                exited
            }),
            "archive stopped the idle OpenCode server"
        );
        fs::remove_file(directory.join("server.json")).unwrap();
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("UPDATE suplex_task_sessions SET launch_owner_pid = ?1,launch_owner_start_time = 'stale-start',native_session_id = 'codex-native' WHERE id = 'archive_session'", [owner.pid]).unwrap();
        drop(database);
        match archive_local_task(&database_path, &user.id, &task_id, false)
            .await
            .unwrap()
        {
            ArchiveOutcome::ConfirmationRequired(paths) => assert_eq!(paths, ["draft.txt"]),
            ArchiveOutcome::Archived(_) => panic!("dirty worktree needs confirmation"),
        }
        assert!(worktree.path.exists());
        #[cfg(target_os = "macos")]
        let mut native_without_record = std::process::Command::new("/bin/sleep")
            .arg("30")
            .current_dir(&worktree.path)
            .env(
                "SUPLEX_TASK_PROCESS_OWNER",
                crate::runtimes::process::owner_marker(&worktree.path),
            )
            .spawn()
            .unwrap();
        #[cfg(target_os = "macos")]
        std::thread::sleep(std::time::Duration::from_millis(150));
        let result = archive_local_task(&database_path, &user.id, &task_id, true).await;
        #[cfg(target_os = "macos")]
        if result.is_err() {
            let _ = native_without_record.kill();
        }
        match result.unwrap() {
            ArchiveOutcome::Archived(archived) => assert_eq!(archived.id, task.id),
            ArchiveOutcome::ConfirmationRequired(_) => panic!("confirmed cleanup must archive"),
        }
        #[cfg(target_os = "macos")]
        assert!(native_without_record.wait().unwrap().code().is_none());
        assert!(!worktree.path.exists());
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let (archived, worktree): (bool, Option<String>) = database.connection().query_row("SELECT t.archived_at IS NOT NULL,c.worktree_json FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1", [&task_id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert!(archived);
        assert!(worktree.is_none());
        drop(database);
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        assert_eq!(
            unarchive_local_task(&mut database, &user.id, &task_id)
                .unwrap()
                .id,
            task_id
        );
        let reopened: bool = database
            .connection()
            .query_row(
                "SELECT archived_at IS NULL FROM suplex_tasks WHERE id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(reopened);
        drop(database);
        fs::remove_dir_all(base).unwrap();
    }

    /// A Git repository with one commit, and a database with one project for it.
    fn backlog_fixture(name: &str) -> (PathBuf, PathBuf, PathBuf, String, PathBuf, String) {
        let base = std::env::temp_dir().join(format!("suplex-{name}-{}", uuid::Uuid::new_v4()));
        let repository_path = base.join("repository");
        let worktree_root = base.join("worktrees");
        fs::create_dir_all(&repository_path).unwrap();
        let repository = Repository::init(&repository_path).unwrap();
        fs::write(repository_path.join("README.md"), "backlog fixture\n").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = Signature::now("Suplex", "suplex@example.invalid").unwrap();
        let sha = repository
            .commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
            .unwrap()
            .to_string();
        let database_path = base.join("suplex.sqlite");
        let now = chrono::Utc::now();
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        let time = rfc3339_millis(now);
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('backlog_company','Backlog','active',?1)", [&time]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,created_at,updated_at) VALUES ('backlog_project','backlog_company','Project',?1,?2,NULL,'main','','','root_profile','worker_profile',?3,?3)", params![repository_path.to_string_lossy(),worktree_root.to_string_lossy(),time]).unwrap();
        (
            base,
            repository_path,
            worktree_root,
            sha,
            database_path,
            user.id,
        )
    }

    fn create_backlog_task(
        database_path: &Path,
        user_id: &str,
        configuration: serde_json::Value,
        delivery_intent: serde_json::Value,
    ) -> TaskRecord {
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite).unwrap();
        let profile = json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"});
        repository::create(
            &mut database,
            &PreparedTask {
                id: repository::new_task_id(),
                company_id: "backlog_company".into(),
                project_id: "backlog_project".into(),
                title: "Start the backlog work".into(),
                description: "".into(),
                configuration,
                idempotency_key: "backlog-key".into(),
                request_hash: "backlog-hash".into(),
                creator: TaskCreator::User(user_id.into()),
                delivery_target: "pull_request_draft".into(),
                delivery_intent: serde_json::from_value(delivery_intent).unwrap(),
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
            chrono::Utc::now(),
        )
        .unwrap()
        .task
    }

    fn audit_count(database_path: &Path, action: &str) -> i64 {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly).unwrap();
        database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action = ?1",
                [action],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn backlog_resets_active_work_and_the_next_start_is_fresh() {
        let (base, repository_path, worktree_root, sha, database_path, user_id) =
            backlog_fixture("backlog-active");
        let configuration = json!({"repository":"owner/repo","baseBranch":"main","baselineSha":sha,"capturedAt":"2026-10-29T00:00:00.000Z","repositoryPath":repository_path,"worktreeRoot":worktree_root,"branch":"task-backlog","startingSha":sha});
        let task = create_backlog_task(
            &database_path,
            &user_id,
            configuration,
            json!({"repository":"owner/repo","headBranch":"task-backlog","baseBranch":"main","baselineSha":sha,"pullRequestNumber":3}),
        );
        let now = chrono::Utc::now();
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        repository::start(&mut database, &task.id, now)
            .unwrap()
            .unwrap();
        let root = root_session_store::reserve_root(&mut database, &task.id, now).unwrap();
        assert_eq!(root.generation, 1);
        root_session_store::ensure_initial_prompt(&mut database, &root, "Start", now)
            .unwrap()
            .unwrap();
        let intent = TaskWorktreeIntent {
            task_id: task.id.clone(),
            repository_path: repository_path.clone(),
            worktree_root: worktree_root.clone(),
            branch: "task-backlog".into(),
            starting_sha: sha.clone(),
        };
        let worktree = worktree::prepare_local_task_worktree(&intent, None).unwrap();
        // The saved worktree is a stale observation; live Git decides the cleanup.
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2",
                params![
                    json!({"path":"/stale/display/path","branch":"stale"}).to_string(),
                    task.id
                ],
            )
            .unwrap();
        drop(database);
        // Work in progress: one commit on the old branch and one dirty file.
        let checkout = Repository::open(&worktree.path).unwrap();
        fs::write(worktree.path.join("progress.txt"), "old work\n").unwrap();
        let mut index = checkout.index().unwrap();
        index.add_path(Path::new("progress.txt")).unwrap();
        index.write().unwrap();
        let tree = checkout.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = checkout.head().unwrap().peel_to_commit().unwrap();
        let signature = Signature::now("Suplex", "suplex@example.invalid").unwrap();
        let old_commit = checkout
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "Old work",
                &tree,
                &[&parent],
            )
            .unwrap();
        drop(tree);
        drop(parent);
        drop(checkout);
        fs::write(worktree.path.join("draft.txt"), "keep\n").unwrap();

        match backlog_local_task(&database_path, &user_id, &task.id, false)
            .await
            .unwrap()
        {
            BacklogOutcome::ConfirmationRequired(paths) => assert_eq!(paths, ["draft.txt"]),
            BacklogOutcome::Returned(_) => panic!("dirty worktree needs confirmation"),
        }
        assert!(worktree.path.join("draft.txt").exists());
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        assert_eq!(
            repository::task_by_id(&database, &task.id)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Cancelled
        );
        drop(database);
        assert_eq!(audit_count(&database_path, "task_cancelled"), 1);

        // A retry from Cancelled continues the same operation.
        let returned = match backlog_local_task(&database_path, &user_id, &task.id, true)
            .await
            .unwrap()
        {
            BacklogOutcome::Returned(returned) => returned,
            BacklogOutcome::ConfirmationRequired(_) => panic!("confirmed cleanup must return"),
        };
        assert_eq!(returned.status, TaskStatus::Backlog);
        assert!(!worktree.path.exists());
        assert_eq!(audit_count(&database_path, "task_sent_to_backlog"), 1);
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let (archived, cleared, state, priority): (bool, bool, String, i64) = database.connection().query_row(
            "SELECT t.archived_at IS NOT NULL, c.worktree_json IS NULL AND c.pull_request_json IS NULL AND c.root_session_id IS NULL AND c.worker_session_id IS NULL, c.workflow_state_json, c.queue_priority FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [&task.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert!(!archived);
        assert!(cleared);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&state).unwrap(),
            serde_json::to_value(crate::coordination::workflows::WorkflowState::default()).unwrap()
        );
        assert_eq!(priority, 0);
        let current: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_sessions WHERE task_id = ?1 AND (is_current = 1 OR stopped_at IS NULL)",
            [&task.id], |row| row.get(0),
        ).unwrap();
        assert_eq!(current, 0);
        let turns: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status = 'cancelled'",
            [&task.id], |row| row.get(0),
        ).unwrap();
        assert_eq!(turns, 1);
        let (branch, head_branch, pull_request_number): (String, String, Option<i64>) = database.connection().query_row(
            "SELECT json_extract(t.configuration_json, '$.branch'), json_extract(c.delivery_intent_json, '$.headBranch'), json_extract(c.delivery_intent_json, '$.pullRequestNumber') FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [&task.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert!(branch.starts_with(&format!(
            "{}-",
            commands::task_branch_name(&task.title, &task.id)
        )));
        assert_eq!(head_branch, branch);
        assert_eq!(pull_request_number, None);
        drop(database);
        // The old branch keeps its commits as archived work in progress.
        let source = Repository::open(&repository_path).unwrap();
        assert_eq!(
            source
                .find_branch("task-backlog", git2::BranchType::Local)
                .unwrap()
                .get()
                .target()
                .unwrap(),
            old_commit
        );
        drop(source);

        // A backlog task that is not archived is a no-op.
        match backlog_local_task(&database_path, &user_id, &task.id, false)
            .await
            .unwrap()
        {
            BacklogOutcome::Returned(again) => assert_eq!(again.status, TaskStatus::Backlog),
            BacklogOutcome::ConfirmationRequired(_) => panic!("no-op needs no confirmation"),
        }
        assert_eq!(audit_count(&database_path, "task_sent_to_backlog"), 1);

        // The next start reserves a new Coordinator generation and a fresh worktree.
        let mut database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        commands::start_user_task(
            &mut database,
            &user_id,
            &task.id,
            chrono::Utc::now(),
            |_| {},
        )
        .unwrap();
        let root =
            root_session_store::reserve_root(&mut database, &task.id, chrono::Utc::now()).unwrap();
        assert_eq!(root.generation, 2);
        let fresh = worktree::prepare_local_task_worktree(
            &TaskWorktreeIntent {
                branch: branch.clone(),
                ..intent
            },
            None,
        )
        .unwrap();
        assert_eq!(fresh.head_sha, sha);
        assert!(!fresh.path.join("progress.txt").exists());
        drop(database);
        fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn backlog_reopens_an_archived_pinned_task_with_a_new_local_branch() {
        let (base, repository_path, worktree_root, sha, database_path, user_id) =
            backlog_fixture("backlog-archived");
        let configuration = json!({"repository":"owner/repo","baseBranch":"main","baselineSha":sha,"capturedAt":"2026-10-29T00:00:00.000Z","repositoryPath":repository_path,"worktreeRoot":worktree_root,"branch":"published","localBranch":"task-local","startingSha":sha,"source":{"kind":"branch","branch":"published"}});
        let task = create_backlog_task(
            &database_path,
            &user_id,
            configuration,
            json!({"repository":"owner/repo","headBranch":"published","baseBranch":"main","baselineSha":sha,"pullRequestNumber":null}),
        );
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'cancelled' WHERE task_id = ?1",
                [&task.id],
            )
            .unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_tasks SET archived_at = '2026-10-01T00:00:00.000Z' WHERE id = ?1",
                [&task.id],
            )
            .unwrap();
        drop(database);
        // The worktree is already gone; the saved observation is missing too.
        match backlog_local_task(&database_path, &user_id, &task.id, false)
            .await
            .unwrap()
        {
            BacklogOutcome::Returned(returned) => assert_eq!(returned.status, TaskStatus::Backlog),
            BacklogOutcome::ConfirmationRequired(_) => panic!("no worktree to confirm"),
        }
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadOnly).unwrap();
        let (archived, branch, local_branch, head_branch): (bool, String, String, String) = database.connection().query_row(
            "SELECT t.archived_at IS NOT NULL, json_extract(t.configuration_json, '$.branch'), json_extract(t.configuration_json, '$.localBranch'), json_extract(c.delivery_intent_json, '$.headBranch') FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [&task.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert!(!archived);
        assert_eq!(
            (branch.as_str(), head_branch.as_str()),
            ("published", "published")
        );
        assert_ne!(local_branch, "task-local");
        assert!(local_branch.starts_with(&commands::task_branch_name(&task.title, &task.id)));
        drop(database);
        fs::remove_dir_all(base).unwrap();
    }
}
