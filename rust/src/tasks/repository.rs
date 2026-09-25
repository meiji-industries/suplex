//! Task intent and control persistence. Callers resolve project and provider facts before writing.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde_json::Value;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug)]
pub struct TaskConflict;

#[derive(Debug)]
pub struct PullRequestOwned;

impl std::fmt::Display for PullRequestOwned {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("A task already uses this pull request.")
    }
}

impl std::error::Error for PullRequestOwned {}

impl std::fmt::Display for TaskConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("This idempotency key belongs to a different request")
    }
}

impl std::error::Error for TaskConflict {}

use crate::platform::{
    artifacts::{self, ArtifactInput, StoredArtifact},
    database::{DatabaseResult, SuplexDatabase},
};

use super::images::DecodedTaskImage;

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
    pub delivery_intent: Value,
    pub root_profile: Value,
    pub worker_profile: Value,
    pub advisor_profiles: Value,
    pub issue: Option<Value>,
    pub start_queued: bool,
    pub copied_from_task_id: Option<String>,
    pub depends_on: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskRecord {
    pub id: String,
    pub company_id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWrite {
    pub task: TaskRecord,
    pub created: bool,
}

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
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
        return Err(Box::new(TaskConflict));
    }
    Ok(Some(task))
}

fn prerequisites_complete(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<bool> {
    let waiting: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_task_dependencies d JOIN suplex_tasks t ON t.id = d.depends_on_task_id JOIN suplex_task_controls c ON c.task_id = t.id WHERE d.task_id = ?1 AND (c.status <> 'delivered' OR (c.delivery_target = 'merged' AND COALESCE(json_extract(c.pull_request_json, '$.state'), '') <> 'merged'))) OR EXISTS(SELECT 1 FROM suplex_task_pull_request_dependencies d WHERE d.task_id = ?1 AND d.state <> 'merged')",
        [task_id], |row| row.get(0),
    )?;
    Ok(!waiting)
}

fn assert_pull_request_available(
    database: &SuplexDatabase,
    task_id: &str,
    repository: &str,
    number: i64,
) -> DatabaseResult<()> {
    let owned: bool = database.connection().query_row(
        "WITH owner_host(kind) AS (SELECT COALESCE((SELECT json_extract(configuration_json, '$.integration.repository.kind') FROM suplex_tasks WHERE id = ?1), 'github')), known(id, name) AS (SELECT repository_id, repository_name FROM suplex_github_trigger_rules UNION SELECT repository_id, repository_name FROM suplex_github_trigger_dispatches), names(name) AS (SELECT lower(?2) UNION SELECT lower(name) FROM known WHERE (SELECT kind FROM owner_host) = 'github' AND id IN (SELECT id FROM known WHERE lower(name) = lower(?2))) SELECT EXISTS(SELECT 1 FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id <> ?1 AND t.archived_at IS NULL AND c.status IN ('backlog','queued','active','waiting_human') AND COALESCE(json_extract(t.configuration_json, '$.integration.repository.kind'), 'github') = (SELECT kind FROM owner_host) AND ((lower(json_extract(t.configuration_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(t.configuration_json, '$.source.kind') = 'pull_request' AND json_extract(t.configuration_json, '$.source.number') = ?3) OR (lower(json_extract(c.delivery_intent_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(c.delivery_intent_json, '$.pullRequestNumber') = ?3) OR (lower(json_extract(c.pull_request_json, '$.repository')) IN (SELECT name FROM names) AND json_extract(c.pull_request_json, '$.number') = ?3)))",
        params![task_id, repository, number], |row| row.get(0),
    )?;
    if owned {
        return Err(Box::new(PullRequestOwned));
    }
    Ok(())
}

fn assert_task_pull_requests_available(
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
    Ok(database.connection().execute(
        "UPDATE suplex_task_controls SET status = 'active', wake_at = ?1, updated_at = ?1 WHERE task_id = ?2 AND status = 'queued' AND EXISTS(SELECT 1 FROM suplex_tasks WHERE id = ?2 AND archived_at IS NULL)",
        params![timestamp(now), task_id],
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
        let id = &input.id;
        let time = timestamp(now);
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
            params![id, objective, input.delivery_target, input.delivery_intent.to_string(), if input.start_queued { "queued" } else { "backlog" }, input.root_profile.to_string(), input.worker_profile.to_string(), input.advisor_profiles.to_string(), time],
        )?;
        assert_task_pull_requests_available(database, id)?;
        for dependency in input.depends_on.iter().collect::<std::collections::BTreeSet<_>>() {
            let available: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_tasks WHERE id = ?1 AND company_id = ?2)",
                params![dependency, input.company_id], |row| row.get(0),
            )?;
            if !available { return Err(std::io::Error::other("A dependency task is not available").into()); }
            database.connection().execute(
                "INSERT INTO suplex_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?1, ?2, ?3)",
                params![id, dependency, time],
            )?;
        }
        if input.start_queued { let _ = admit_queued(database, id, now)?; }
        let created = task_by_id(database, id)?.ok_or_else(|| std::io::Error::other("Task insert did not persist"))?;
        let resulting_state = serde_json::json!({"status": created.status, "archived": false}).to_string();
        database.connection().execute(
            "INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES (?1, ?2, ?3, 'task_created', NULL, ?4, ?5, ?6)",
            params![format!("audit_{}", Uuid::new_v4().simple()), creator_user_id, creator_agent_id, input.company_id, serde_json::json!({"taskId": id, "resultingState": resulting_state}).to_string(), time],
        )?;
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

/// Start records intent as queued; admission rechecks prerequisites in this transaction.
pub fn start(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<TaskRecord>> {
    database.transaction(true, |database| {
        let time = timestamp(now);
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
            let _ = admit_queued(database, task_id, now)?;
        }
        task_by_id(database, task_id)
    })
}
