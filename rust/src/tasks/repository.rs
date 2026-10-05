//! Task intent and control persistence. Callers resolve project and provider facts before writing.

use crate::shared::time::rfc3339_millis;
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde_json::Value;
use std::path::Path;
use uuid::Uuid;

use super::TaskError;
use crate::coordination::root_session_store;
use crate::platform::{
    artifacts::{self, ArtifactInput, StoredArtifact},
    database::{DatabaseResult, SuplexDatabase},
};

use super::control::{DeliveryIntent, TaskProfile, TaskStatus};
use super::images::DecodedTaskImage;
use crate::coordination::advisor_bridge::AdvisorRole;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskCreator {
    User(String),
    Agent(String),
}

#[derive(Clone, Debug)]
pub struct PreparedTask {
    pub id: String,
    pub company_id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub configuration: Value,
    pub idempotency_key: String,
    pub request_hash: String,
    pub creator: TaskCreator,
    pub delivery_target: String,
    pub delivery_intent: DeliveryIntent,
    pub root_profile: TaskProfile,
    pub worker_profile: TaskProfile,
    pub advisor_profiles: BTreeMap<AdvisorRole, TaskProfile>,
    pub issue: Option<Value>,
    pub start_queued: bool,
    pub copied_from_task_id: Option<String>,
    pub depends_on: Vec<String>,
    /// Observed `blockedByPullRequests`, written before a queued task is admitted.
    pub pull_request_dependencies: Vec<Value>,
    /// The workflow the task runs; a non-Standard workflow is written after creation.
    pub workflow: crate::coordination::workflows::Workflow,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskRecord {
    pub id: String,
    pub company_id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub created_at: String,
}

#[derive(Debug)]
pub struct TaskEditSnapshot {
    pub task: TaskRecord,
    pub delivery_target: String,
    pub workflow: String,
    pub root_profile: TaskProfile,
    pub worker_profile: TaskProfile,
    pub advisor_profiles: BTreeMap<AdvisorRole, TaskProfile>,
    pub configuration: Value,
}

pub struct TaskDetailsWrite {
    pub title: String,
    pub description: String,
    pub delivery_target: String,
    pub workflow: String,
    pub run_project_tests: bool,
    pub visual_evidence: String,
    pub root_profile: TaskProfile,
    pub worker_profile: TaskProfile,
    pub advisor_profiles: BTreeMap<AdvisorRole, TaskProfile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWrite {
    pub task: TaskRecord,
    pub created: bool,
}

fn task(row: &Row<'_>) -> rusqlite::Result<TaskRecord> {
    Ok(TaskRecord {
        id: row.get("id")?,
        company_id: row.get("company_id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
    })
}

pub fn task_by_id(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Option<TaskRecord>> {
    Ok(database.connection().query_row(
        "SELECT t.id, t.company_id, t.project_id, t.title, t.description, c.status, t.created_at FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
        [task_id], task,
    ).optional()?)
}

pub fn new_task_id() -> String {
    format!("task_{}", Uuid::new_v4().simple())
}

pub(crate) fn existing(
    database: &SuplexDatabase,
    input: &PreparedTask,
) -> DatabaseResult<Option<TaskRecord>> {
    let row = database.connection().query_row(
        "SELECT t.id, t.company_id, t.project_id, t.title, t.description, c.status, t.created_at, t.request_hash, t.creator_user_id, t.creator_agent_id FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.company_id = ?1 AND t.idempotency_key = ?2",
        params![input.company_id, input.idempotency_key],
        |row| {
            Ok((task(row)?, row.get::<_, String>("request_hash")?, row.get::<_, Option<String>>("creator_user_id")?, row.get::<_, Option<String>>("creator_agent_id")?))
        },
    ).optional()?;
    let Some((task, hash, user_id, agent_id)) = row else {
        return Ok(None);
    };
    let same_creator = match &input.creator {
        TaskCreator::User(id) => user_id.as_deref() == Some(id),
        TaskCreator::Agent(id) => agent_id.as_deref() == Some(id),
    };
    if hash != input.request_hash || !same_creator {
        return Err(TaskError::Conflict.into());
    }
    Ok(Some(task))
}

pub(crate) fn prerequisites_complete(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<bool> {
    let waiting: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_task_dependencies d JOIN suplex_tasks t ON t.id = d.depends_on_task_id JOIN suplex_task_controls c ON c.task_id = t.id WHERE d.task_id = ?1 AND (c.status <> 'delivered' OR (c.delivery_target IN ('pull_request_draft', 'pull_request_ready', 'merged') AND COALESCE(json_extract(c.pull_request_json, '$.state'), '') <> 'merged'))) OR EXISTS(SELECT 1 FROM suplex_task_pull_request_dependencies d WHERE d.task_id = ?1 AND d.state <> 'merged')",
        [task_id], |row| row.get(0),
    )?;
    Ok(!waiting)
}

/// An open task that already works on a pull request.
#[derive(Clone, Debug, serde::Serialize)]
pub struct PullRequestOwner {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub title: String,
    pub status: String,
}

/// Find the open task other than `task_id` that owns pull request `number`.
/// `host` applies when `task_id` is not a stored task.
pub(crate) fn pull_request_owner(
    database: &SuplexDatabase,
    task_id: &str,
    host: &str,
    repository: &str,
    number: i64,
) -> DatabaseResult<Option<PullRequestOwner>> {
    Ok(database.connection().query_row(
        "WITH owner_host(kind) AS (SELECT COALESCE((SELECT json_extract(configuration_json, '$.integration.repository.kind') FROM suplex_tasks WHERE id = ?1), ?4)), known(id, name) AS (SELECT repository_id, repository_name FROM suplex_github_trigger_rules UNION SELECT repository_id, repository_name FROM suplex_github_trigger_dispatches), names(name) AS (SELECT lower(?2) UNION SELECT lower(name) FROM known WHERE (SELECT kind FROM owner_host) = 'github' AND id IN (SELECT id FROM known WHERE lower(name) = lower(?2))) SELECT t.id, t.title, c.status FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id <> ?1 AND t.archived_at IS NULL AND c.status IN ('backlog','queued','active','waiting_human') AND COALESCE(json_extract(t.configuration_json, '$.integration.repository.kind'), 'github') = (SELECT kind FROM owner_host) AND ((lower(json_extract(t.configuration_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(t.configuration_json, '$.source.kind') = 'pull_request' AND json_extract(t.configuration_json, '$.source.number') = ?3) OR (lower(json_extract(c.delivery_intent_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(c.delivery_intent_json, '$.pullRequestNumber') = ?3) OR (lower(json_extract(c.pull_request_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(c.pull_request_json, '$.number') = ?3)) ORDER BY t.created_at LIMIT 1",
        params![task_id, repository, number, host],
        |row| Ok(PullRequestOwner { task_id: row.get(0)?, title: row.get(1)?, status: row.get(2)? }),
    ).optional()?)
}

pub(crate) fn assert_pull_request_available(
    database: &SuplexDatabase,
    task_id: &str,
    repository: &str,
    number: i64,
) -> DatabaseResult<()> {
    if pull_request_owner(database, task_id, "github", repository, number)?.is_some() {
        return Err(TaskError::PullRequestOwned.into());
    }
    Ok(())
}

pub(crate) fn assert_task_pull_requests_available(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<()> {
    let raw = database.connection().query_row(
        "SELECT t.configuration_json, c.delivery_intent_json, c.pull_request_json FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
        [task_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
    ).optional()?;
    let Some((configuration, intent, pull)) = raw else {
        return Ok(());
    };
    let configuration: Value = serde_json::from_str(&configuration)?;
    let intent: Value = serde_json::from_str(&intent)?;
    let pull: Option<Value> = pull.map(|raw| serde_json::from_str(&raw)).transpose()?;
    let source = configuration.get("source");
    let repository = configuration.get("repository").and_then(Value::as_str);
    if source
        .and_then(|source| source.get("kind"))
        .and_then(Value::as_str)
        == Some("pull_request")
        && let (Some(repository), Some(number)) = (
            repository,
            source
                .and_then(|source| source.get("number"))
                .and_then(Value::as_i64),
        )
    {
        assert_pull_request_available(database, task_id, repository, number)?;
    }
    if let (Some(repository), Some(number)) = (
        intent.get("repository").and_then(Value::as_str),
        intent.get("pullRequestNumber").and_then(Value::as_i64),
    ) {
        assert_pull_request_available(database, task_id, repository, number)?;
    }
    if let Some(pull) = pull
        && let (Some(repository), Some(number)) = (
            pull.get("repository").and_then(Value::as_str),
            pull.get("number").and_then(Value::as_i64),
        )
    {
        assert_pull_request_available(database, task_id, repository, number)?;
    }
    Ok(())
}

pub(crate) fn admit_queued(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    if !prerequisites_complete(database, task_id)? {
        return Ok(false);
    }
    assert_task_pull_requests_available(database, task_id)?;
    // The project's task concurrency and the plan's running-task limit are
    // checked in this statement, so admits in one transaction cannot exceed
    // them. A task waiting on a human holds its slot.
    Ok(database.connection().execute(
        concat!("UPDATE suplex_task_controls SET status = 'active', wake_at = ?1, updated_at = ?1 WHERE task_id = ?2 AND status = 'queued' AND NOT ", crate::running_limited_sql!(), " AND EXISTS(SELECT 1 FROM suplex_tasks t LEFT JOIN suplex_projects p ON p.id = t.project_id WHERE t.id = ?2 AND t.archived_at IS NULL AND (p.task_concurrency IS NULL OR p.task_concurrency > (SELECT COUNT(*) FROM suplex_tasks s JOIN suplex_task_controls sc ON sc.task_id = s.id WHERE s.project_id = t.project_id AND s.archived_at IS NULL AND sc.status IN ('active', 'waiting_human'))))"),
        params![rfc3339_millis(now), task_id],
    )? == 1)
}

/// Put one queued task ahead of the other queued tasks without changing its status.
pub fn move_to_front(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    Ok(database.connection().execute(
        "UPDATE suplex_task_controls SET queue_priority = (SELECT COALESCE(MAX(queue_priority), 0) + 1 FROM suplex_task_controls WHERE status = 'queued'), updated_at = ?2 WHERE task_id = ?1 AND status = 'queued' AND EXISTS (SELECT 1 FROM suplex_tasks WHERE id = ?1 AND archived_at IS NULL)",
        params![task_id, rfc3339_millis(now)],
    )? == 1)
}

/// Persist the task, control, prerequisite edges, and audit as one source-owned intent.
pub fn create(
    database: &mut SuplexDatabase,
    input: &PreparedTask,
    now: DateTime<Utc>,
) -> DatabaseResult<TaskWrite> {
    create_inner(database, input, None, now, &mut Vec::new())
}

/// Keep newly written opaque files visible to the outer command, which may
/// still roll back its authorization, dependency, or audit transaction.
pub fn create_with_images(
    database: &mut SuplexDatabase,
    input: &PreparedTask,
    artifact_root: &Path,
    images: &[DecodedTaskImage],
    now: DateTime<Utc>,
    written: &mut Vec<StoredArtifact>,
) -> DatabaseResult<TaskWrite> {
    create_inner(database, input, Some((artifact_root, images)), now, written)
}

fn create_inner(
    database: &mut SuplexDatabase,
    input: &PreparedTask,
    images: Option<(&Path, &[DecodedTaskImage])>,
    now: DateTime<Utc>,
    written: &mut Vec<StoredArtifact>,
) -> DatabaseResult<TaskWrite> {
    let first_written = written.len();
    let result = database.transaction(true, |database| {
        if let Some(task) = existing(database, input)? { return Ok(TaskWrite { task, created: false }); }
        crate::billing::require(database, crate::billing::Limit::MonthlyTasks, now)?;
        let id = &input.id;
        let time = rfc3339_millis(now);
        let (creator_user_id, creator_agent_id) = match &input.creator {
            TaskCreator::User(id) => (Some(id.as_str()), None),
            TaskCreator::Agent(id) => (None, Some(id.as_str())),
        };
        database.connection().execute(
            "INSERT INTO suplex_tasks (id, company_id, project_id, title, description, configuration_json, idempotency_key, request_hash, creator_user_id, creator_agent_id, copied_from_task_id, issue_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            params![id, input.company_id, input.project_id, input.title, input.description, input.configuration.to_string(), input.idempotency_key, input.request_hash, creator_user_id, creator_agent_id, input.copied_from_task_id, input.issue.as_ref().map(Value::to_string), time],
        )?;
        if let Some((artifact_root, images)) = images {
            for image in images {
                written.push(artifacts::put_in_transaction(
                    database,
                    artifact_root,
                    &input.company_id,
                    "task-image",
                    &ArtifactInput {
                        filename: &image.filename,
                        mime_type: &image.mime_type,
                        bytes: &image.bytes,
                        task_id: id,
                    },
                    now,
                )?);
            }
        }
        let objective = if input.description.is_empty() { input.title.clone() } else { format!("{}\n\n{}", input.title, input.description) };
        database.connection().execute(
            "INSERT INTO suplex_task_controls (task_id, objective, delivery_target, delivery_intent_json, status, root_profile_json, worker_profile_json, workflow, advisor_profiles_json, workflow_state_json, status_changed_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'standard', ?8, '{\"version\":1,\"reviews\":[],\"acceptedDelivery\":null,\"deliveryWait\":null,\"completion\":null,\"toolOwner\":null}', ?9, ?9, ?9)",
            params![id, objective, input.delivery_target, serde_json::to_string(&input.delivery_intent)?, if input.start_queued { "queued" } else { "backlog" }, serde_json::to_string(&input.root_profile)?, serde_json::to_string(&input.worker_profile)?, serde_json::to_string(&input.advisor_profiles)?, time],
        )?;
        assert_task_pull_requests_available(database, id)?;
        for dependency in input.depends_on.iter().collect::<std::collections::BTreeSet<_>>() {
            let available: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_tasks WHERE id = ?1 AND company_id = ?2)",
                params![dependency, input.company_id], |row| row.get(0),
            )?;
            if !available { return Err(TaskError::internal("A dependency task is not available").into()); }
            database.connection().execute(
                "INSERT INTO suplex_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?1, ?2, ?3)",
                params![id, dependency, time],
            )?;
        }
        // The prerequisites are written first, so a queued task starts now only when every one is already complete.
        if !input.pull_request_dependencies.is_empty() {
            super::pull_request_dependencies::replace(database, id, &input.pull_request_dependencies)?;
        }
        root_session_store::observe_lifecycle(database, id)?;
        if input.start_queued && admit_queued(database, id, now)? {
            root_session_store::observe_lifecycle(database, id)?;
            root_session_store::observe_admission(database, id, "scheduler sweep", None);
        }
        let created = task_by_id(database, id)?.ok_or_else(|| TaskError::internal("Task insert did not persist"))?;
        let resulting_state = serde_json::json!({"status": created.status, "archived": false}).to_string();
        crate::identity::audit::record(database, &crate::identity::audit::AuditEvent { id: &format!("audit_{}", Uuid::new_v4().simple()), actor_user_id: creator_user_id, actor_agent_id: creator_agent_id, action: "task_created", target_user_id: None, company_id: Some(&input.company_id), metadata_json: &serde_json::json!({"taskId": id, "resultingState": resulting_state}).to_string(), created_at: &time })?;
        Ok(TaskWrite { task: created, created: true })
    });
    if result.is_err()
        && let Some((artifact_root, _)) = images
    {
        for artifact in written.drain(first_written..) {
            artifacts::remove_written(artifact_root, &artifact);
        }
    }
    result
}

pub fn edit_snapshot(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<TaskEditSnapshot>> {
    let row = database.connection().query_row(
        "SELECT t.id,t.company_id,t.project_id,t.title,t.description,c.status,t.created_at,c.delivery_target,c.workflow,c.root_profile_json,c.worker_profile_json,c.advisor_profiles_json,t.configuration_json FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
        [task_id],
        |row| Ok((
            TaskRecord { id: row.get(0)?, company_id: row.get(1)?, project_id: row.get(2)?, title: row.get(3)?, description: row.get(4)?, status: row.get(5)?, created_at: row.get(6)? },
            row.get::<_, String>(7)?, row.get::<_, String>(8)?, row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?, row.get::<_, String>(12)?,
        )),
    ).optional()?;
    row.map(
        |(task, delivery_target, workflow, root, worker, advisors, configuration)| {
            Ok(TaskEditSnapshot {
                task,
                delivery_target,
                workflow,
                root_profile: serde_json::from_str(&root)?,
                worker_profile: serde_json::from_str(&worker)?,
                advisor_profiles: serde_json::from_str(&advisors)?,
                configuration: serde_json::from_str(&configuration)?,
            })
        },
    )
    .transpose()
}

/// The service resolves every field before this guarded, atomic snapshot write.
pub fn update_details(
    database: &mut SuplexDatabase,
    task_id: &str,
    details: &TaskDetailsWrite,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        let time = rfc3339_millis(now);
        let changed = database.connection().execute(
            "UPDATE suplex_tasks SET title = ?1, description = ?2, configuration_json = json_set(configuration_json, '$.runProjectTests', json(?3), '$.visualEvidence', ?4), updated_at = ?5 WHERE id = ?6 AND archived_at IS NULL AND EXISTS (SELECT 1 FROM suplex_task_controls WHERE task_id = suplex_tasks.id AND status IN ('backlog', 'queued'))",
            params![details.title, details.description, if details.run_project_tests { "true" } else { "false" }, details.visual_evidence, time, task_id],
        )?;
        if changed != 1 { return Ok(false); }
        database.connection().execute(
            "UPDATE suplex_task_controls SET objective = (SELECT CASE WHEN description = '' THEN title ELSE title || char(10) || char(10) || description END FROM suplex_tasks WHERE id = ?1), delivery_target = ?2, workflow = ?3, root_profile_json = ?4, worker_profile_json = ?5, advisor_profiles_json = ?6, updated_at = ?7 WHERE task_id = ?1",
            params![task_id, details.delivery_target, details.workflow, serde_json::to_string(&details.root_profile)?, serde_json::to_string(&details.worker_profile)?, serde_json::to_string(&details.advisor_profiles)?, time],
        )?;
        Ok(true)
    })
}

/// The agent workflow selection a task reports after an edit names its workflow.
pub fn select_workflow(
    database: &SuplexDatabase,
    task_id: &str,
    selection: &Value,
) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.hermesSelection', json(?1)) WHERE id = ?2",
        params![selection.to_string(), task_id],
    )?;
    Ok(())
}

pub fn rename(
    database: &mut SuplexDatabase,
    task_id: &str,
    title: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        let time = rfc3339_millis(now);
        let changed = database.connection().execute(
            "UPDATE suplex_tasks SET title = ?1, updated_at = ?2 WHERE id = ?3 AND archived_at IS NULL",
            params![title, time, task_id],
        )?;
        if changed != 1 { return Ok(false); }
        database.connection().execute(
            "UPDATE suplex_task_controls SET objective = (SELECT CASE WHEN description = '' THEN title ELSE title || char(10) || char(10) || description END FROM suplex_tasks WHERE id = ?1), updated_at = ?2 WHERE task_id = ?1 AND status IN ('backlog', 'queued')",
            params![task_id, time],
        )?;
        Ok(true)
    })
}

/// Call when a task may have lost its last blocker. A queued task is admitted;
/// an active task receives an earlier wake. Returns whether it was admitted.
pub(crate) fn reconcile_dependency_release(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let blocked: bool = crate::tasks::dependencies::blocked(database, task_id)?;
    if blocked {
        return Ok(false);
    }
    match admit_queued(database, task_id, now) {
        Ok(true) => return Ok(true),
        Ok(false) => {}
        Err(error) if TaskError::is_pull_request_owned(&*error) => return Ok(false),
        Err(error) => return Err(error),
    }
    database.connection().execute(
        "UPDATE suplex_task_controls SET wake_at = ?1, updated_at = ?1 WHERE task_id = ?2 AND status = 'active'",
        params![rfc3339_millis(now), task_id],
    )?;
    Ok(false)
}

/// Observe an active or waiting task again in 15 seconds (30 during a delivery
/// wait), and a finished task with a pending session stop in 15 seconds
/// without touching its user-visible `updated_at`.
pub(crate) fn schedule_next_sweep(
    database: &SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let time = |seconds| rfc3339_millis(now + chrono::Duration::seconds(seconds));
    database.connection().execute(
        "UPDATE suplex_task_controls SET wake_at = CASE WHEN json_extract(workflow_state_json,'$.deliveryWait') IS NULL THEN ?1 ELSE ?2 END,updated_at = ?3 WHERE task_id = ?4 AND status IN ('active','waiting_human')",
        params![time(15), time(30), time(0), task_id],
    )?;
    database.connection().execute(
        "UPDATE suplex_task_controls SET wake_at = ?1 WHERE task_id = ?2 AND status NOT IN ('active','waiting_human') AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = ?2 AND s.stopped_at IS NULL AND (s.stop_requested_at IS NOT NULL OR suplex_task_controls.status = 'delivered'))",
        params![time(15), task_id],
    )?;
    database.connection().execute(
        "UPDATE suplex_task_controls SET wake_at = ?1 WHERE task_id = ?2 AND status IN ('cancelled','delivered') AND EXISTS (SELECT 1 FROM suplex_tasks t WHERE t.id = ?2 AND t.archived_at IS NULL) AND NOT EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = ?2 AND s.stopped_at IS NULL AND (s.stop_requested_at IS NOT NULL OR suplex_task_controls.status = 'delivered'))",
        params![time(300), task_id],
    )?;
    Ok(())
}

pub(crate) fn terminal_displays_ready(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<bool> {
    let (status, pending): (TaskStatus, bool) = database.connection().query_row(
        "SELECT status, EXISTS(SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = ?1 AND s.stopped_at IS NULL AND (s.stop_requested_at IS NOT NULL OR suplex_task_controls.status = 'delivered')) FROM suplex_task_controls WHERE task_id = ?1",
        [task_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(matches!(status, TaskStatus::Cancelled | TaskStatus::Delivered) && !pending)
}

/// Return a queued task to the manual backlog. A manual backlog task is a no-op.
pub fn disarm(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let changed = database.transaction(true, |database| {
        let status: Option<String> = database.connection().query_row(
            "SELECT status FROM suplex_task_controls WHERE task_id = ?1", [task_id], |row| row.get(0),
        ).optional()?;
        match status.as_deref() {
            Some("backlog") => Ok(Some(false)),
            Some("queued") => {
                database.connection().execute(
                    "UPDATE suplex_task_controls SET status = 'backlog', queue_priority = 0, updated_at = ?1 WHERE task_id = ?2 AND status = 'queued'",
                    params![rfc3339_millis(now), task_id],
                )?;
                Ok(Some(true))
            }
            _ => Ok(None),
        }
    })?;
    if changed == Some(true) {
        root_session_store::observe_lifecycle(database, task_id)?;
    }
    Ok(changed.is_some())
}

/// Admit a queued task now. The user overrides incomplete prerequisites and the
/// project task concurrency; the plan's running-task limit and another task
/// that owns the same pull request still reject.
pub fn force_start(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<TaskRecord>> {
    database.transaction(true, |database| {
        assert_task_pull_requests_available(database, task_id)?;
        crate::billing::require(database, crate::billing::Limit::RunningTasks, now)?;
        let admitted = database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'active', wake_at = ?1, updated_at = ?1 WHERE task_id = ?2 AND status = 'queued' AND EXISTS(SELECT 1 FROM suplex_tasks WHERE id = ?2 AND archived_at IS NULL)",
            params![rfc3339_millis(now), task_id],
        )? == 1;
        if !admitted {
            return Ok(None);
        }
        root_session_store::observe_lifecycle(database, task_id)?;
        root_session_store::observe_admission(database, task_id, "force start", None);
        task_by_id(database, task_id)
    })
}

/// Start records intent as queued; admission rechecks prerequisites in this transaction.
pub fn start(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<TaskRecord>> {
    database.transaction(true, |database| {
        let time = rfc3339_millis(now);
        let active = database.connection().execute(
            "UPDATE suplex_task_controls SET wake_at = ?1, updated_at = ?1 WHERE task_id = ?2 AND status = 'active'",
            params![time, task_id],
        )? == 1;
        if !active {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'queued', updated_at = ?1 WHERE task_id = ?2 AND status = 'backlog' AND EXISTS(SELECT 1 FROM suplex_tasks WHERE id = ?2 AND archived_at IS NULL)",
                params![time, task_id],
            )?;
            let queued: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?1 AND c.status = 'queued' AND t.archived_at IS NULL)",
                [task_id], |row| row.get(0),
            )?;
            if !queued { return Ok(None); }
            let admitted = admit_queued(database, task_id, now)?;
            root_session_store::observe_lifecycle(database, task_id)?;
            if admitted {
                root_session_store::observe_admission(database, task_id, "start request", None);
            } else {
                root_session_store::observe_queue_wait(database, task_id);
            }
        } else {
            root_session_store::observe_lifecycle(database, task_id)?;
        }
        task_by_id(database, task_id)
    })
}

/// The `dependencies` and `pr_dependencies` columns of a task row `t`.
macro_rules! task_dependencies_sql {
    () => {
        r#"(SELECT json_group_array(json_array(id, title, status, delivery_target, archived_at, pull_state)) FROM (
        SELECT dep.id, dep.title, control.status, control.delivery_target, dep.archived_at, json_extract(control.pull_request_json, '$.state') AS pull_state
        FROM suplex_task_dependencies d JOIN suplex_tasks dep ON dep.id = d.depends_on_task_id JOIN suplex_task_controls control ON control.task_id = dep.id WHERE d.task_id = t.id ORDER BY dep.id
    )) AS dependencies,
    (SELECT json_group_array(json_array(pull_request_number, state, title, url, observed_at)) FROM (
        SELECT pull_request_number, state, title, url, observed_at FROM suplex_task_pull_request_dependencies WHERE task_id = t.id ORDER BY pull_request_number
    )) AS pr_dependencies"#
    };
}

const TASK_RESPONSE_SELECT: &str = concat!(
    r#"SELECT t.id AS id, t.company_id AS company_id, t.project_id AS project_id, t.issue_json, t.issue_number, cpy.issue_code, t.title, t.description, c.status AS status, c.queue_priority, c.delivery_target AS delivery_target, c.root_profile_json, c.worker_profile_json, c.workflow, c.advisor_profiles_json, c.workflow_state_json, t.configuration_json, c.worktree_json, c.pull_request_json, c.human_question, c.human_question_id, c.limit_pause_json, c.human_question_options_json, c.recovery_turn_id, c.wake_at, t.created_at, CASE WHEN julianday(t.updated_at) >= julianday(COALESCE(c.updated_at, t.updated_at)) THEN t.updated_at ELSE c.updated_at END AS updated_at, c.status_changed_at, t.archived_at, c.budget_usd, c.max_turns,
    EXISTS(SELECT 1 FROM suplex_projects p WHERE p.id = t.project_id AND p.task_concurrency IS NOT NULL AND p.task_concurrency <= (SELECT COUNT(*) FROM suplex_tasks s JOIN suplex_task_controls sc ON sc.task_id = s.id WHERE s.project_id = t.project_id AND s.archived_at IS NULL AND sc.status IN ('active', 'waiting_human'))) AS project_concurrency_limited,
    "#,
    crate::running_limited_sql!(),
    r#" AS plan_concurrency_limited,
    COALESCE((SELECT default_budget_usd FROM suplex_environment_settings WHERE id = 'host'), 15.0) AS default_budget,
    COALESCE((SELECT default_max_turns FROM suplex_environment_settings WHERE id = 'host'), 40) AS default_turns,
    (SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = t.id AND prompted_at IS NOT NULL) AS admitted_turns,
    "#,
    task_dependencies_sql!(),
    r#",
    (SELECT json_group_array(json_object('artifactId', id, 'filename', filename, 'mimeType', mime_type, 'byteSize', byte_size)) FROM (
        SELECT id, filename, mime_type, byte_size FROM suplex_artifacts WHERE task_id = t.id AND company_id = t.company_id AND kind = 'task-image' ORDER BY created_at, id
    )) AS images,
    (SELECT json_group_array(json_object('artifactId', id, 'filename', filename, 'mimeType', mime_type, 'byteSize', byte_size)) FROM (
        SELECT id, filename, mime_type, byte_size FROM suplex_artifacts WHERE task_id = t.id AND company_id = t.company_id AND kind LIKE 'delivery-%' ORDER BY created_at, id
    )) AS artifacts
 FROM suplex_tasks t JOIN suplex_companies cpy ON cpy.id = t.company_id JOIN suplex_task_controls c ON c.task_id = t.id"#
);

pub fn task_response(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<super::response::TaskResponse>> {
    let mut statement = database
        .connection()
        .prepare(&format!("{TASK_RESPONSE_SELECT} WHERE t.id = ?1"))?;
    let mut rows = statement.query([task_id])?;
    rows.next()?.map(super::response::from_row).transpose()
}

/// Only the columns of `TaskListItem`. The full select spends most of its time
/// on columns a list drops.
const TASK_LIST_SELECT: &str = concat!(
    r#"SELECT t.id AS id, t.company_id AS company_id, t.project_id AS project_id, t.issue_number, cpy.issue_code, t.title, c.status AS status, c.queue_priority, json_extract(t.configuration_json, '$.repository') AS repository, json_extract(t.configuration_json, '$.branch') AS branch, c.pull_request_json, CASE WHEN c.human_question_id IS NOT NULL THEN c.human_question END AS question_text, t.created_at, CASE WHEN julianday(t.updated_at) >= julianday(COALESCE(c.updated_at, t.updated_at)) THEN t.updated_at ELSE c.updated_at END AS updated_at, c.status_changed_at, t.archived_at,
    "#,
    task_dependencies_sql!(),
    r#"
 FROM suplex_tasks t JOIN suplex_companies cpy ON cpy.id = t.company_id JOIN suplex_task_controls c ON c.task_id = t.id"#
);
const TASK_LIST_ORDER: &str = "ORDER BY julianday(CASE WHEN julianday(t.updated_at) >= julianday(c.updated_at) THEN t.updated_at ELSE c.updated_at END) DESC, t.id";

fn list_items(mut rows: rusqlite::Rows<'_>) -> DatabaseResult<Vec<super::response::TaskListItem>> {
    let mut tasks = Vec::new();
    while let Some(row) = rows.next()? {
        tasks.push(super::response::list_item_from_row(row)?);
    }
    Ok(tasks)
}

pub fn list_visible(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: Option<&str>,
    archived: bool,
) -> DatabaseResult<Vec<super::response::TaskListItem>> {
    let visible = crate::identity::companies::list_visible_companies(database, user_id)?;
    if company_id.is_some_and(|id| !visible.iter().any(|company| company.id == id)) {
        return Err(TaskError::not_found().into());
    }
    let companies = serde_json::to_string(
        &visible
            .iter()
            .map(|company| &company.id)
            .collect::<Vec<_>>(),
    )?;
    let mut statement = database.connection().prepare(&format!("{TASK_LIST_SELECT} WHERE (t.archived_at IS NOT NULL) = ?1 AND t.company_id IN (SELECT value FROM json_each(?2)) AND (?3 IS NULL OR t.company_id = ?3) {TASK_LIST_ORDER}"))?;
    list_items(statement.query(params![archived, companies, company_id])?)
}

/// One company's active task list, for the sync feed. The caller authorizes.
pub(crate) fn list_active(
    database: &SuplexDatabase,
    company_id: &str,
) -> DatabaseResult<Vec<super::response::TaskListItem>> {
    let mut statement = database.connection().prepare(&format!(
        "{TASK_LIST_SELECT} WHERE t.archived_at IS NULL AND t.company_id = ?1 {TASK_LIST_ORDER}"
    ))?;
    list_items(statement.query([company_id])?)
}

/// The authorized task's company and its current worktree path.
pub(crate) fn task_worktree(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> Result<(String, Option<String>), Box<dyn std::error::Error>> {
    let company_id = super::authorize_task(database, user_id, task_id)?;
    let path = database
        .connection()
        .query_row(
            "SELECT json_extract(worktree_json, '$.path') FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok((company_id, path))
}

pub(crate) fn bound_pane(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
    role: &str,
) -> DatabaseResult<Option<String>> {
    super::authorize_task(database, user_id, task_id)?;
    let pane = if role == "shell" {
        database
            .connection()
            .query_row(
                "SELECT shell_pane_id FROM suplex_task_controls WHERE task_id = ?1",
                [task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
    } else {
        database
                .connection()
                .query_row(
                    "SELECT pane_id FROM suplex_task_sessions WHERE task_id = ?1 AND kind = ?2 AND is_current = 1 ORDER BY created_at, id LIMIT 1",
                    params![task_id, role],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
    };
    Ok(pane.flatten())
}

/// The authorized task's current session of `kind`.
pub(crate) fn current_session(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
    kind: &str,
) -> DatabaseResult<Option<String>> {
    super::authorize_task(database, user_id, task_id)?;
    Ok(database
        .connection()
        .query_row(
            "SELECT id FROM suplex_task_sessions WHERE task_id = ?1 AND kind = ?2 AND is_current = 1 ORDER BY created_at, id LIMIT 1",
            params![task_id, kind],
            |row| row.get(0),
        )
        .optional()?)
}

/// Whether the task is archived. A deleted task counts as archived.
pub(crate) fn archived_or_gone(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<bool> {
    let archived: Option<bool> = database
        .connection()
        .query_row(
            "SELECT archived_at IS NOT NULL FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(archived.is_none_or(|archived| archived))
}

type ShellPaneContext = (Option<String>, Vec<Option<String>>, Option<String>);

pub(crate) fn shell_pane_context(
    database: &SuplexDatabase,
    user_id: &str,
    task_id: &str,
) -> DatabaseResult<ShellPaneContext> {
    let (_, worktree) = task_worktree(database, user_id, task_id)?;
    let shell = database.connection().query_row(
        "SELECT shell_pane_id FROM suplex_task_controls WHERE task_id = ?1",
        [task_id],
        |row| row.get::<_, Option<String>>(0),
    )?;
    let mut statement = database.connection().prepare(
        "SELECT pane_id FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY created_at, id",
    )?;
    let excluded = statement
        .query_map([task_id], |row| row.get::<_, Option<String>>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((shell, excluded, worktree))
}

pub(crate) fn save_shell_pane(
    database: &SuplexDatabase,
    task_id: &str,
    pane_id: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_task_controls SET shell_pane_id = ?1, updated_at = ?2 WHERE task_id = ?3",
        params![pane_id, crate::shared::time::now_millis_rfc3339(), task_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod list_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn list_snapshots_keep_scope_dependencies_and_archive_filtering() {
        let fixture = crate::http::routes::task_pane::tests::fixture();
        fixture.state.with_database(|database| {
            let tasks = list_visible(database, "user_development", Some("pane_company"), false).unwrap();
            assert_eq!(tasks.len(), 1);
            let task = serde_json::to_value(&tasks[0]).unwrap();
            assert_eq!(task["id"], fixture.task_id);
            assert_eq!(task["title"], "Terminal");
            assert!(task.get("description").is_none());
            assert!(task.get("workflowState").is_none());
            assert_eq!(task["dependsOn"], json!([]));
            assert!(task["configuration"]["repository"].is_string());
            assert!(list_visible(database, "user_development", Some("missing"), false).is_err());
            database.connection().execute("INSERT INTO suplex_task_pull_request_dependencies (task_id, pull_request_number, state, title, url, observed_at) VALUES (?1, 17, 'open', 'Prerequisite', 'https://example.test/pr/17', '2026-09-25T00:00:00.000Z')", [&fixture.task_id]).unwrap();
            let tasks = list_visible(database, "user_development", None, false).unwrap();
            let task = serde_json::to_value(&tasks[0]).unwrap();
            assert_eq!(task["blockedBy"][0]["number"], 17);
            assert_eq!(task["blockedBy"][0]["title"], "Prerequisite");
            database.connection().execute("UPDATE suplex_tasks SET archived_at = '2026-09-25T00:00:00.000Z' WHERE id = ?1", [&fixture.task_id]).unwrap();
            assert!(list_visible(database, "user_development", None, false).unwrap().is_empty());
            assert_eq!(list_visible(database, "user_development", None, true).unwrap().len(), 1);
        });
        let _ = std::fs::remove_dir_all(&fixture.root);
    }
}
