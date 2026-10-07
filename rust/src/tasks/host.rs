//! Task scheduling and sweep orchestration.

pub use super::worktree::prepare_task_worktree;
pub use crate::coordination::session_recovery::{recover_prepared_root, recover_prepared_worker};
use crate::{
    coordination::{root_session_store, session_recovery::stop_retired_sessions},
    integrations::herdr::Herdr,
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    shared::time::now_millis_rfc3339,
    tasks::{
        TaskError,
        archive::displays::{close_task_displays, task_display_sessions},
        control::TaskStatus,
        limits::reconcile_limit_pause,
    },
    terminals::host::HostTerminals,
};
use chrono::Utc;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
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
    /// A handle that only records wakes, for route tests.
    #[cfg(test)]
    pub fn recording() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (wake_tx, wake_rx) = mpsc::unbounded_channel();
        let (shutdown_tx, _) = watch::channel(false);
        let (_, finished_rx) = watch::channel(true);
        let handle = Self {
            wake_tx,
            shutdown_tx,
            finished_rx,
        };
        (handle, wake_rx)
    }
}

/// Resume every active task from durable intent. The periodic scan covers
/// starts committed before this process booted and notifications lost on crash.
pub fn spawn_task_host(
    database_path: PathBuf,
    artifact_root: PathBuf,
    host_terminals: Arc<HostTerminals>,
) -> TaskHostHandle {
    let (wake_tx, mut wake_rx) = mpsc::unbounded_channel::<String>();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let (finished_tx, finished_rx) = watch::channel(false);
    let handle = TaskHostHandle {
        wake_tx,
        shutdown_tx,
        finished_rx,
    };
    crate::tasks::analytics::collector::spawn(database_path.clone(), shutdown_rx.clone());
    crate::web_push::spawn(database_path.clone(), shutdown_rx.clone());
    let poller_host = handle.clone();
    crate::integrations::github_triggers::spawn_poller(
        database_path.clone(),
        move |id| poller_host.wake(id),
        shutdown_rx.clone(),
    );
    // TypeScript `refreshPullRequestPrerequisites`: GitHub is re-read every minute; the next queue sweep admits.
    let prerequisites_path = database_path.clone();
    tokio::spawn(poll_periodically(
        Duration::from_secs(60),
        shutdown_rx.clone(),
        "Pull request prerequisite",
        move || {
            let path = prerequisites_path.clone();
            async move { crate::tasks::pull_request_dependencies::refresh(&path).await }
        },
    ));
    let completed_path = database_path.clone();
    tokio::spawn(poll_periodically(
        Duration::from_secs(60),
        shutdown_rx.clone(),
        "Delivered pull request",
        move || {
            let path = completed_path.clone();
            async move { crate::delivery::completed_pull_requests::refresh(&path, None).await }
        },
    ));
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
                _ = interval.tick() => match scheduled_task_ids(&database_path, &host_terminals) {
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

/// Host terminals close with their task: all of them on archive, and the
/// ones no browser shows once the task has finished or the experiment is off.
fn close_retired_terminals(database: &SuplexDatabase, host_terminals: &HostTerminals) {
    if !crate::terminals::host_enabled(database) {
        host_terminals.close_idle();
    }
    for task_id in host_terminals.task_ids() {
        if super::repository::archived_or_gone(database, &task_id).unwrap_or(false) {
            host_terminals.close_task(&task_id, false);
        } else if super::repository::terminal_displays_ready(database, &task_id).unwrap_or(false) {
            host_terminals.close_task(&task_id, true);
        }
    }
}

pub(crate) async fn poll_periodically<F, Fut>(
    period: Duration,
    mut shutdown: watch::Receiver<bool>,
    subject: &'static str,
    mut refresh: F,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = DatabaseResult<()>>,
{
    let mut interval = tokio::time::interval(period);
    // A slow provider or a suspended host must not replay missed refreshes.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            result = shutdown.changed() => {
                if result.is_err() || *shutdown.borrow() { break; }
            },
            _ = interval.tick() => {
                if let Err(error) = refresh().await
                    && !crate::integrations::github_delivery::is_rate_limited(error.as_ref()) {
                    eprintln!("{subject} refresh will be retried: {error}");
                }
            },
        }
    }
}

/// TypeScript `TaskHost.tick`: the queue sweep admits every ready queued
/// task on each tick, starting with the immediate first tick at startup.
/// Each tick also closes the host terminals of finished tasks.
pub(crate) fn scheduled_task_ids(
    database_path: &Path,
    host_terminals: &HostTerminals,
) -> DatabaseResult<Vec<String>> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    close_retired_terminals(&database, host_terminals);
    {
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
    due_task_ids(&database)
}

pub(crate) fn due_task_ids(database: &SuplexDatabase) -> DatabaseResult<Vec<String>> {
    let mut statement = database.connection().prepare(
        "SELECT c.task_id FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE (t.archived_at IS NULL AND c.status IN ('active','waiting_human') AND (c.wake_at IS NULL OR c.wake_at <= ?1)) OR ((c.wake_at IS NULL OR c.wake_at <= ?1) AND ((c.status = 'delivered' AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = c.task_id AND s.stopped_at IS NULL)) OR EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = c.task_id AND s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL))) OR (t.archived_at IS NULL AND c.status IN ('cancelled','delivered') AND (c.wake_at IS NULL OR c.wake_at <= ?1)) ORDER BY COALESCE(c.wake_at,c.created_at)",
    )?;
    Ok(statement
        .query_map([now_millis_rfc3339()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// TypeScript `recoverOne`: whatever the sweep did, and even when it failed,
/// an active or waiting task is observed again in 15 seconds (30 during a
/// delivery wait), so a failing task cannot starve the others. A finished
/// task with a pending session stop also waits 15 seconds; its `updated_at`
/// stays, because task lists and analytics read it as a user-visible change.
pub async fn sweep_task(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<()> {
    sweep_task_with_herdr(
        database_path,
        artifact_root,
        task_id,
        executable,
        inherited_environment,
        &Herdr::default(),
    )
    .await
}

pub(crate) async fn sweep_task_with_herdr(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
    herdr: &Herdr,
) -> DatabaseResult<()> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let swept = sweep_task_once(
        &mut database,
        database_path,
        artifact_root,
        task_id,
        executable,
        inherited_environment,
        herdr,
    )
    .await;
    super::repository::schedule_next_sweep(&database, task_id, Utc::now())?;
    swept
}

async fn sweep_task_once(
    database: &mut SuplexDatabase,
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
    herdr: &Herdr,
) -> DatabaseResult<()> {
    {
        root_session_store::retire_delivered_sessions(database, task_id, Utc::now())?;
    }
    stop_retired_sessions(database, database_path, task_id).await?;
    if super::repository::terminal_displays_ready(database, task_id)? {
        let sessions = task_display_sessions(database, task_id)?;
        let herdr = herdr.clone();
        tokio::task::spawn_blocking(move || {
            close_task_displays(&herdr, &sessions).map_err(|error| error.to_string())
        })
        .await?
        .map_err(TaskError::internal)?;
    }
    reconcile_limit_pause(database, database_path, task_id).await?;
    crate::delivery::operations::host_observation(database_path, artifact_root, task_id).await;
    let media_database_path = database_path.to_owned();
    let media_artifact_root = artifact_root.to_owned();
    let media_task_id = task_id.to_owned();
    let media = tokio::task::spawn_blocking(move || {
        let mut database = SuplexDatabase::open(&media_database_path, OpenMode::ReadWrite)
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(super::artifacts::collect_generated_media(
            &mut database,
            &media_database_path,
            &media_artifact_root,
            &media_task_id,
        ))
    })
    .await;
    match media {
        Ok(Ok(media)) => {
            for diagnostic in media.diagnostics {
                eprintln!("Task {task_id} artifact collection will retry: {diagnostic}");
            }
        }
        Ok(Err(error)) => {
            eprintln!("Task {task_id} artifact collection will retry: {error}");
        }
        Err(error) => {
            eprintln!("Task {task_id} artifact collection will retry: {error}");
        }
    }
    let (active, needs_worktree) = {
        let rows = root_session_store::root_observation_rows(database, task_id)?;
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
                if !require_open_source_pull_request(database, task_id).await? {
                    return Ok(false);
                }
                let prepared = prepare_task_worktree(database_path, task_id).await?;
                root_session_store::set_worktree(database, task_id, &prepared, Utc::now())?;
            }
            if !super::issue_context::prepare_for_host(database, artifact_root, task_id).await? {
                return Ok(false);
            }
            crate::tasks::preparation::prepare_before_native_work(database_path, task_id).await?;
            crate::coordination::root_controller::prepare_root(database, task_id)?;
            Ok::<_, Box<dyn std::error::Error>>(true)
        }
        .await;
        match prepared {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(error) => {
                crate::coordination::root_controller::prepare_root(database, task_id)?;
                root_session_store::ask_human(
                    database,
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
        let rows = root_session_store::root_observation_rows(database, task_id)?;
        let prompt = root_session_store::with_current_dependency_status(
            root_session_store::IDLE_ROOT_PROMPT,
            &rows.dependencies,
        );
        root_session_store::wake_idle_root(database, task_id, &prompt, Utc::now())?;
    }
    Ok(())
}

/// A task sourced from a pull request needs that pull request still open
/// before Suplex builds a worktree for it. GitHub is read directly. A pull
/// request someone merged while the task waited is delivered work, so the
/// task completes as an external merge and `false` stops preparation.
async fn require_open_source_pull_request(
    database: &mut SuplexDatabase,
    task_id: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let Some((repository, number)) = source_pull_request(database, task_id)? else {
        return Ok(true);
    };
    let pull = crate::integrations::github_delivery::Github::load()
        .await?
        .get_pull_request(&repository, number)
        .await?;
    settle_source_pull_request(database, task_id, number, &pull.state)
}

pub(crate) fn settle_source_pull_request(
    database: &mut SuplexDatabase,
    task_id: &str,
    number: u64,
    state: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    use crate::coordination::workflows::{Completion, CompletionKind};
    match state {
        "open" => Ok(true),
        "merged" => {
            let mut workflow = root_session_store::workflow_state(database, task_id)?;
            workflow.completion = Some(Completion {
                kind: CompletionKind::ExternalMerge,
                reviewed_head: None,
                pull_request_number: Some(number),
                observed_at: crate::shared::time::now_millis_rfc3339(),
            });
            root_session_store::write_workflow_state(database, task_id, &workflow, Utc::now())?;
            root_session_store::mark_delivered(database, task_id, Utc::now())?;
            Ok(false)
        }
        _ => Err(format!(
            "Pull request #{number} is {state}. Cancel or archive this task, or create a new task from the current work"
        )
        .into()),
    }
}

fn source_pull_request(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<(String, u64)>> {
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let source = &rows.context["configuration"]["source"];
    Ok(match (source["kind"].as_str(), source["number"].as_u64()) {
        (Some("pull_request"), Some(number)) => {
            Some((rows.control.delivery_intent.repository.clone(), number))
        }
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    include!("../../tests/tasks/host_artifacts.rs");

    #[tokio::test]
    async fn delivered_pull_refresh_starts_immediately_retries_and_stops_with_host() {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let attempts = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(poll_periodically(
            Duration::from_millis(25),
            shutdown_rx,
            "Delivered pull request",
            move || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;
                observed_tx.send(attempt).unwrap();
                async move {
                    if attempt == 1 {
                        Err(std::io::Error::other("provider offline").into())
                    } else {
                        Ok(())
                    }
                }
            },
        ));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), observed_rx.recv())
                .await
                .unwrap(),
            Some(1)
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), observed_rx.recv())
                .await
                .unwrap(),
            Some(2)
        );
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn prerequisite_refresh_never_overlaps_a_slow_observation() {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut first = Some(release_rx);
        let active = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(poll_periodically(
            Duration::from_millis(20),
            shutdown_rx,
            "Pull request prerequisite",
            move || {
                let first = first.take();
                let active = active.clone();
                let entered = entered_tx.clone();
                async move {
                    assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                    entered.send(()).unwrap();
                    if let Some(first) = first {
                        first.await.unwrap();
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                }
            },
        ));
        tokio::time::timeout(Duration::from_secs(5), entered_rx.recv())
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(entered_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), entered_rx.recv())
            .await
            .unwrap()
            .unwrap();
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }
}
