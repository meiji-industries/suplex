//! Archive a task only after native sessions and its live Git worktree are safe.
//! Saved pane and worktree display fields do not decide whether cleanup may run.

use crate::shared::time::now_millis_rfc3339;
use crate::tasks::TaskError;
use crate::tasks::control::TaskStatus;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use rusqlite::params;
use serde_json::Value;

use crate::{
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

fn failure(message: &str, status_code: u16) -> Box<dyn std::error::Error> {
    failure_code(message, status_code, "task_failure")
}

fn failure_code(message: &str, status_code: u16, code: &'static str) -> Box<dyn std::error::Error> {
    TaskError::Failure {
        message: message.to_owned(),
        status: status_code,
        code,
    }
    .into()
}

fn cleanup_error(error: Box<dyn std::error::Error>) -> Box<dyn std::error::Error> {
    if matches!(error.downcast_ref(), Some(TaskError::Failure { .. })) {
        error
    } else {
        failure(&error.to_string(), 409)
    }
}

fn required_path(configuration: &Value, field: &str) -> DatabaseResult<PathBuf> {
    let value = configuration[field]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| TaskError::internal(format!("Task {field} is missing")))?;
    Ok(PathBuf::from(value))
}

/// Live authority over one task: a board user's company access or a paired agent's grant.
pub type Authority<'a> = &'a (dyn Fn(&SuplexDatabase, &TaskRecord) -> DatabaseResult<()> + Sync);

fn user_authority(
    actor_user_id: &str,
) -> impl Fn(&SuplexDatabase, &TaskRecord) -> DatabaseResult<()> + Sync + '_ {
    move |database, task| {
        companies::require_company_access(database, actor_user_id, &task.company_id).map(|_| ())
    }
}

fn task_scope(
    database: &SuplexDatabase,
    authority: Authority<'_>,
    task_id: &str,
) -> DatabaseResult<(TaskRecord, Value)> {
    let task =
        repository::task_by_id(database, task_id)?.ok_or_else(|| failure("Not found", 404))?;
    authority(database, &task)?;
    let configuration: String = database.connection().query_row(
        "SELECT configuration_json FROM suplex_tasks WHERE id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    Ok((task, serde_json::from_str(&configuration)?))
}

fn reauthorize(
    database_path: &Path,
    authority: Authority<'_>,
    task_id: &str,
) -> DatabaseResult<()> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    task_scope(&database, authority, task_id)?;
    Ok(())
}

/// One idle native session that archive stops after its displays are prepared.
struct IdleSession {
    harness: &'static dyn TaskHarness,
    directory: PathBuf,
    native_session_id: Option<String>,
}

/// TypeScript `stopIdleArchiveSessions`: every native reader confirms its
/// session is idle before anything stops.
fn archive_sessions_idle(
    database: &SuplexDatabase,
    database_path: &Path,
    task_id: &str,
) -> DatabaseResult<Vec<IdleSession>> {
    let mut statement = database.connection().prepare(
        "SELECT id, launch_owner_pid, launch_owner_start_time, native_session_id, json_extract(profile_json, '$.instanceHomeDirectory') FROM suplex_task_sessions WHERE task_id = ?1",
    )?;
    let sessions = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<u32>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
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
        let busy = harness.busy(&ReaderSession {
            database_path,
            session_id: &session_id,
            native_session_id: native_session_id.as_deref().unwrap_or_default(),
            instance_home_directory: instance_home.as_deref().map(Path::new),
        })?;
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
    unarchive_task(database, &user_authority(actor_user_id), task_id)
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

/// Synchronous archive operation for a detached blocking caller. The database
/// is never held locked while native processes or Git are inspected.
pub fn archive_local_task(
    database_path: &Path,
    actor_user_id: &str,
    task_id: &str,
    confirm_discard_dirty: bool,
) -> DatabaseResult<ArchiveOutcome> {
    archive_task(
        database_path,
        &user_authority(actor_user_id),
        task_id,
        confirm_discard_dirty,
    )
}

pub fn archive_task(
    database_path: &Path,
    authority: Authority<'_>,
    task_id: &str,
    confirm_discard_dirty: bool,
) -> DatabaseResult<ArchiveOutcome> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let (task, configuration) = task_scope(&database, authority, task_id)?;
    if in_progress(task_id) {
        return Err(failure("Archive cleanup is in progress", 409));
    }
    if !task.status.archivable() {
        return Err(failure("Cancel the task before archiving it", 409));
    }
    let _guard = ArchiveGuard::acquire(task_id)?;
    let idle = archive_sessions_idle(&database, database_path, task_id).map_err(cleanup_error)?;
    let displays = displays::prepare_task_displays(&database, task_id).map_err(cleanup_error)?;
    drop(database);
    // An idle OpenCode server still runs until its harness stops it.
    for session in &idle {
        session
            .harness
            .stop(&session.directory, session.native_session_id.as_deref())
            .map_err(|error| cleanup_error(error.into()))?;
    }
    reauthorize(database_path, authority, task_id)?;

    let intent = TaskWorktreeIntent {
        task_id: task_id.to_owned(),
        repository_path: required_path(&configuration, "repositoryPath")?,
        worktree_root: required_path(&configuration, "worktreeRoot")?,
        branch: configuration["branch"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        starting_sha: configuration["startingSha"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    };
    let cleanup = worktree::remove_local_task_worktree(&intent, confirm_discard_dirty, || {
        reauthorize(database_path, authority, task_id)
    })
    .map_err(cleanup_error)?;
    if let WorktreeCleanup::ConfirmationRequired { dirty_file_paths } = cleanup {
        return Ok(ArchiveOutcome::ConfirmationRequired(dirty_file_paths));
    }
    reauthorize(database_path, authority, task_id)?;
    displays.close().map_err(cleanup_error)?;
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::time::rfc3339_millis;
    use crate::{
        identity::auth,
        runtimes::headless::{HeadlessTurnRecord, RecordedProcessIdentity},
        tasks::repository::{PreparedTask, TaskCreator},
    };
    use git2::{Repository, Signature};
    use serde_json::json;
    use std::fs;

    #[test]
    fn archive_uses_live_native_and_git_facts_then_commits_once() {
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
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('archive_project','archive_company','Project',?1,?2,NULL,'main','','','root_profile','worker_profile','{}',?3,?3)", params![repository_path.to_string_lossy(),worktree_root.to_string_lossy(),time]).unwrap();
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
            configuration: json!({"repositoryPath":repository_path,"worktreeRoot":worktree_root,"branch":"task-archive","startingSha":sha}),
            idempotency_key: "archive-key".into(), request_hash: "archive-hash".into(), creator: TaskCreator::User(user.id.clone()),
            delivery_target: "pull_request_draft".into(), delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(), root_profile: serde_json::from_value(json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(), worker_profile: serde_json::from_value(json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(), advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: false, copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![],
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
        assert!(archive_local_task(&database_path, &user.id, &task_id, false).is_err());
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
        assert!(archive_local_task(&database_path, &user.id, &task_id, false).is_err());
        assert!(worktree.path.exists());
        fs::remove_file(directory.join("turn.json")).unwrap();
        // Every provider is ported, so no native session is an unsupported one anymore.
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("UPDATE suplex_task_sessions SET native_session_id = NULL WHERE id = 'archive_session'", []).unwrap();
        drop(database);
        fs::write(worktree.path.join("draft.txt"), "keep\n").unwrap();
        match archive_local_task(&database_path, &user.id, &task_id, false).unwrap() {
            ArchiveOutcome::ConfirmationRequired(paths) => assert_eq!(paths, ["draft.txt"]),
            ArchiveOutcome::Archived(_) => panic!("dirty worktree needs confirmation"),
        }
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
        database.connection().execute("UPDATE suplex_task_controls SET delivery_target = 'pull_request_draft' WHERE task_id = ?1", [&task_id]).unwrap();
        drop(database);
        match archive_local_task(&database_path, &user.id, &task_id, false).unwrap() {
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
        match archive_local_task(&database_path, &user.id, &task_id, false).unwrap() {
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
        match archive_local_task(&database_path, &user.id, &task_id, false).unwrap() {
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
        let result = archive_local_task(&database_path, &user.id, &task_id, true);
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
}
