//! Task scheduling and sweep orchestration.

pub use super::worktree::prepare_task_worktree;
pub use crate::coordination::session_recovery::{recover_prepared_root, recover_prepared_worker};
use crate::{
    coordination::{root_session_store, session_recovery::stop_retired_sessions},
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    shared::time::{now_millis_rfc3339, rfc3339_millis},
    tasks::{control::TaskStatus, limits::reconcile_limit_pause},
};
use chrono::Utc;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
};
#[derive(Clone)]
pub struct TaskHostHandle {
    wake_tx: mpsc::UnboundedSender<String>,
    shutdown_tx: watch::Sender<bool>,
    finished_rx: watch::Receiver<bool>,
}

impl TaskHostHandle {
    pub fn wake(&self, task_id: String) {
        let _ = self.wake_tx.send(task_id);
    }

    pub async fn stop(&self) {
        let _ = self.shutdown_tx.send(true);
        let mut finished = self.finished_rx.clone();
        while !*finished.borrow() && finished.changed().await.is_ok() {}
    }
}

/// Resume every active task from durable intent. The periodic scan covers
/// starts committed before this process booted and notifications lost on crash.
pub fn spawn_task_host(database_path: PathBuf, artifact_root: PathBuf) -> TaskHostHandle {
    let (wake_tx, mut wake_rx) = mpsc::unbounded_channel::<String>();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let (finished_tx, finished_rx) = watch::channel(false);
    let handle = TaskHostHandle {
        wake_tx,
        shutdown_tx,
        finished_rx,
    };
    crate::tasks::analytics::collector::spawn(database_path.clone(), shutdown_rx.clone());
    let poller_host = handle.clone();
    crate::integrations::github_triggers::spawn_poller(
        database_path.clone(),
        move |id| poller_host.wake(id),
        shutdown_rx.clone(),
    );
    // TypeScript `refreshPullRequestPrerequisites`: GitHub is re-read every minute; the next queue sweep admits.
    let (prerequisites_path, mut prerequisites_shutdown) =
        (database_path.clone(), shutdown_rx.clone());
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tokio::select! {
                result = prerequisites_shutdown.changed() => {
                    if result.is_err() || *prerequisites_shutdown.borrow() { break; }
                },
                _ = interval.tick() => {
                    if let Err(error) = crate::tasks::pull_request_dependencies::refresh(&prerequisites_path).await {
                        eprintln!("Pull request prerequisite refresh will be retried: {error}");
                    }
                },
            }
        }
    });
    tokio::spawn(async move {
        let environment = std::env::vars().collect::<HashMap<_, _>>();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        let mut running = HashSet::new();
        let mut operations = JoinSet::<(String, Result<(), String>)>::new();
        loop {
            let candidates = tokio::select! {
                result = shutdown_rx.changed() => {
                    if result.is_err() || *shutdown_rx.borrow() { break; }
                    Vec::new()
                },
                Some(task_id) = wake_rx.recv() => vec![task_id],
                _ = interval.tick() => match scheduled_task_ids(&database_path) {
                    Ok(ids) => ids,
                    Err(error) => { eprintln!("Task scheduling will retry: {error}"); Vec::new() },
                },
                finished = operations.join_next(), if !operations.is_empty() => {
                    if let Some(Ok((task_id, result))) = finished {
                        running.remove(&task_id);
                        if let Err(error) = result { eprintln!("Task {task_id} recovery will retry: {error}"); }
                    }
                    Vec::new()
                },
            };
            for task_id in candidates {
                if running.len() >= 4 {
                    break;
                }
                if !running.insert(task_id.clone()) {
                    continue;
                }
                let database_path = database_path.clone();
                let artifact_root = artifact_root.clone();
                let environment = environment.clone();
                operations.spawn(async move {
                    let result =
                        sweep_task(&database_path, &artifact_root, &task_id, None, &environment)
                            .await
                            .map_err(|error| error.to_string());
                    (task_id, result)
                });
            }
        }
        while let Some(finished) = operations.join_next().await {
            if let Ok((task_id, Err(error))) = finished {
                eprintln!("Task {task_id} recovery will retry after restart: {error}");
            }
        }
        let _ = finished_tx.send(true);
    });
    handle
}

/// TypeScript `TaskHost.tick`: the queue sweep admits every ready queued
/// task on each tick, starting with the immediate first tick at startup.
pub(crate) fn scheduled_task_ids(database_path: &Path) -> DatabaseResult<Vec<String>> {
    {
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        // A diagnostic read never changes queue admission.
        let queued = database
            .connection()
            .prepare("SELECT task_id FROM suplex_task_controls WHERE status = 'queued'")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap_or_default();
        for task_id in queued {
            root_session_store::observe_queue_wait(&mut database, &task_id);
        }
        root_session_store::admit_queued(&mut database, Utc::now())?;
    }
    due_task_ids(database_path)
}

pub(crate) fn due_task_ids(database_path: &Path) -> DatabaseResult<Vec<String>> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let mut statement = database.connection().prepare(
        "SELECT c.task_id FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE (t.archived_at IS NULL AND c.status IN ('active','waiting_human') AND (c.wake_at IS NULL OR c.wake_at <= ?1)) OR (c.status = 'delivered' AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = c.task_id AND s.stopped_at IS NULL)) OR EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = c.task_id AND s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL) ORDER BY COALESCE(c.wake_at,c.created_at)",
    )?;
    Ok(statement
        .query_map([now_millis_rfc3339()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// TypeScript `recoverOne`: whatever the sweep did, and even when it failed,
/// an active or waiting task is observed again in 15 seconds (30 during a
/// delivery wait), so a failing task cannot starve the others.
pub async fn sweep_task(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<()> {
    let swept = sweep_task_once(
        database_path,
        artifact_root,
        task_id,
        executable,
        inherited_environment,
    )
    .await;
    let database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let now = Utc::now();
    let time = |seconds| rfc3339_millis(now + chrono::Duration::seconds(seconds));
    database.connection().execute(
        "UPDATE suplex_task_controls SET wake_at = CASE WHEN json_extract(workflow_state_json,'$.deliveryWait') IS NULL THEN ?1 ELSE ?2 END,updated_at = ?3 WHERE task_id = ?4 AND status IN ('active','waiting_human')",
        rusqlite::params![time(15), time(30), time(0), task_id],
    )?;
    swept
}

async fn sweep_task_once(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<()> {
    {
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        root_session_store::retire_delivered_sessions(&mut database, task_id, Utc::now())?;
    }
    stop_retired_sessions(database_path, task_id).await?;
    reconcile_limit_pause(database_path, task_id).await?;
    crate::delivery::operations::host_observation(database_path, artifact_root, task_id).await;
    let (active, needs_worktree) = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        let rows = root_session_store::root_observation_rows(&database, task_id)?;
        (
            rows.control.status == TaskStatus::Active,
            rows.control.worktree.is_none(),
        )
    };
    if !active {
        return Ok(());
    }
    {
        let prepared = async {
            if needs_worktree {
                let prepared = prepare_task_worktree(database_path, task_id).await?;
                let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
                root_session_store::set_worktree(&mut database, task_id, &prepared, Utc::now())?;
            }
            if !super::issue_context::prepare_for_host(database_path, artifact_root, task_id)
                .await?
            {
                return Ok(false);
            }
            crate::tasks::preparation::prepare_before_native_work(database_path, task_id).await?;
            crate::coordination::root_controller::prepare_root(database_path, task_id)?;
            Ok::<_, Box<dyn std::error::Error>>(true)
        }
        .await;
        match prepared {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(error) => {
                crate::coordination::root_controller::prepare_root(database_path, task_id)?;
                let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
                root_session_store::ask_human(
                    &mut database,
                    task_id,
                    &format!(
                        "Suplex could not prepare this task. {error}. Resolve the problem, then answer to retry."
                    ),
                    &serde_json::json!([]),
                    Utc::now(),
                )?;
                return Ok(());
            }
        }
    }
    recover_prepared_worker(
        database_path,
        artifact_root,
        task_id,
        executable,
        inherited_environment,
    )
    .await?;
    recover_prepared_root(
        database_path,
        artifact_root,
        task_id,
        executable,
        inherited_environment,
    )
    .await?;
    {
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        let rows = root_session_store::root_observation_rows(&database, task_id)?;
        let prompt = root_session_store::with_current_dependency_status(
            root_session_store::IDLE_ROOT_PROMPT,
            &rows.dependencies,
        );
        root_session_store::wake_idle_root(&mut database, task_id, &prompt, Utc::now())?;
    }
    Ok(())
}
