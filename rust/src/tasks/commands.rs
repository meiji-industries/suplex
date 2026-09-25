//! User task commands keep authorization, intent, audit, and wake admission together.

use std::{error::Error, fmt, path::Path};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    coordination::root_session_store,
    http::contracts::typed::{
        projects::ProjectProviderPolicy,
        task_answers::{AnswerBody, LimitDecisionBody, TaskLimitDecision},
        tasks::{
            TaskCreateBody, TaskDetailsBody, TaskNoteBody, TaskRenameBody,
            TaskWorkerReplacementBody,
        },
    },
    identity::companies,
    platform::{
        artifacts,
        database::{DatabaseResult, SuplexDatabase},
    },
    projects::service::{self, Project},
};

use super::archive::operations as archive;
use super::images::DecodedTaskImage;
use super::repository::{self, PreparedTask, TaskCreator, TaskDetailsWrite, TaskRecord, TaskWrite};

#[derive(Debug)]
pub struct TaskFailure {
    pub public_message: String,
    pub status_code: u16,
    pub code: &'static str,
}

impl TaskFailure {
    fn new(public_message: impl Into<String>, status_code: u16) -> Self {
        Self {
            public_message: public_message.into(),
            status_code,
            code: "task_failure",
        }
    }
}

impl fmt::Display for TaskFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.public_message)
    }
}

impl Error for TaskFailure {}

fn project_signature(project: &Project) -> Value {
    json!({
        "repository": project.repository,
        "repositoryPath": project.repository_path,
        "worktreeRoot": project.worktree_root,
        "baseBranch": project.base_branch,
        "setupCommand": project.setup_command,
        "verificationCommand": project.verification_command,
        "providerPolicy": project.provider_policy,
        "integration": project.integration,
        "execution": project.execution,
    })
}

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Hash the parsed request in the same field order as TaskInputSchema. Standard
/// requests without advisors retain the pre-workflow idempotency hash shape.
pub fn task_request_hash(input: &TaskCreateBody, creator_user_id: &str) -> DatabaseResult<String> {
    let request = serde_json::to_value(input)?;
    let source = request.as_object().ok_or("task request is not an object")?;
    let workflow = source.get("workflow").cloned().unwrap_or(Value::Null);
    let advisors = source
        .get("advisorProfileIds")
        .cloned()
        .unwrap_or(Value::Null);
    let depends_on = source.get("dependsOn").cloned().unwrap_or(Value::Null);
    let pull_requests = source
        .get("blockedByPullRequests")
        .cloned()
        .unwrap_or(Value::Null);
    let mut fields = Map::new();
    for (name, value) in source {
        if ![
            "workflow",
            "advisorProfileIds",
            "dependsOn",
            "blockedByPullRequests",
        ]
        .contains(&name.as_str())
        {
            fields.insert(name.clone(), value.clone());
        }
    }
    let mut dependencies = depends_on.as_array().cloned().unwrap_or_default();
    dependencies.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
    dependencies.dedup();
    if !dependencies.is_empty() {
        fields.insert("dependsOn".to_owned(), Value::Array(dependencies));
    }
    let mut numbers = pull_requests
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("number").and_then(Value::as_u64))
        .collect::<Vec<_>>();
    numbers.sort_unstable();
    numbers.dedup();
    if !numbers.is_empty() {
        fields.insert(
            "blockedByPullRequests".to_owned(),
            Value::Array(
                numbers
                    .into_iter()
                    .map(|number| json!({"number": number}))
                    .collect(),
            ),
        );
    }
    let mut selected = Map::new();
    for key in ["reviewer", "planner_a", "planner_b", "rater"] {
        if let Some(value) = advisors.get(key).filter(|value| !value.is_null()) {
            selected.insert(key.to_owned(), value.clone());
        }
    }
    if workflow.as_str() != Some("standard") || !selected.is_empty() {
        fields.insert("workflow".to_owned(), workflow);
        fields.insert("advisorProfileIds".to_owned(), Value::Object(selected));
    }
    let payload =
        json!({"input": Value::Object(fields), "creator": {"kind": "user", "id": creator_user_id}});
    let digest = Sha256::digest(crate::shared::js_json::stringify(&payload).as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Check the idempotency key before an external Git fetch. A retry is answered
/// from the committed task and does not depend on a fresh repository snapshot.
pub fn existing_user_task(
    database: &SuplexDatabase,
    company_id: &str,
    key: &str,
    request_hash: &str,
    user_id: &str,
) -> DatabaseResult<Option<TaskRecord>> {
    let row = database.connection().query_row(
        "SELECT t.id, t.request_hash, t.creator_user_id FROM suplex_tasks t WHERE t.company_id = ?1 AND t.idempotency_key = ?2",
        params![company_id, key],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
    ).optional()?;
    let Some((task_id, hash, creator)) = row else {
        return Ok(None);
    };
    if hash != request_hash || creator.as_deref() != Some(user_id) {
        return Err(Box::new(TaskFailure::new(
            "This idempotency key belongs to a different request",
            409,
        )));
    }
    repository::task_by_id(database, &task_id)
}

pub(crate) fn allowed_profile(policy: Option<&ProjectProviderPolicy>, value: &Value) -> bool {
    let Some(policy) = policy else {
        return true;
    };
    if let Some(instance) = value
        .get("providerInstanceId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        policy.allowed_instance_ids.iter().any(|id| id == instance)
    } else {
        value
            .get("provider")
            .and_then(Value::as_str)
            .is_some_and(|provider| {
                policy
                    .allowed_providers
                    .iter()
                    .any(|allowed| allowed == provider)
            })
    }
}

pub(crate) fn read_profile(
    database: &SuplexDatabase,
    id: &str,
    role: &str,
) -> DatabaseResult<Option<Value>> {
    let profile = database.connection().query_row(
            "SELECT p.id, p.provider, p.model, p.reasoning_level, p.service_tier, p.provider_instance_id, i.home_directory FROM suplex_profiles p LEFT JOIN suplex_provider_instances i ON i.id = p.provider_instance_id WHERE p.id = ?1 AND p.role = ?2 AND p.archived_at IS NULL",
            params![id, role],
            |row| Ok(json!({"profileId": row.get::<_, String>(0)?, "provider": row.get::<_, String>(1)?, "model": row.get::<_, String>(2)?, "reasoningLevel": row.get::<_, String>(3)?, "serviceTier": row.get::<_, String>(4)?, "providerInstanceId": row.get::<_, Option<String>>(5)?, "instanceHomeDirectory": row.get::<_, Option<String>>(6)?})),
        ).optional()?;
    Ok(profile)
}

fn selected_profile(
    database: &SuplexDatabase,
    project: &Project,
    selected: Option<&str>,
    default_id: &str,
    role: &str,
) -> DatabaseResult<Value> {
    let id = selected.unwrap_or(default_id);
    let profile = read_profile(database, id, role)?.ok_or_else(|| {
        Box::new(TaskFailure::new(
            "The selected agent profile does not exist",
            422,
        )) as Box<dyn Error>
    })?;
    if allowed_profile(project.provider_policy.as_ref(), &profile) {
        return Ok(profile);
    }
    if selected.is_some() {
        return Err(Box::new(TaskFailure::new(
            "Select agents with providers and logins allowed by this project",
            422,
        )));
    }
    let mut statement = database.connection().prepare(
        "SELECT id FROM suplex_profiles WHERE role = ?1 AND archived_at IS NULL ORDER BY created_at, id",
    )?;
    let ids = statement
        .query_map([role], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        if let Some(candidate) = read_profile(database, &id, role)?
            && allowed_profile(project.provider_policy.as_ref(), &candidate)
        {
            return Ok(candidate);
        }
    }
    Err(Box::new(TaskFailure::new(
        "Create an agent with a provider and login allowed by this project",
        422,
    )))
}

fn task_branch_name(title: &str, task_id: &str) -> String {
    const FIX: &[&str] = &[
        "fix",
        "fixes",
        "fixed",
        "bug",
        "bugs",
        "bugfix",
        "hotfix",
        "broken",
        "crash",
        "crashes",
        "repair",
        "regression",
    ];
    const CHORE: &[&str] = &[
        "chore",
        "bump",
        "upgrade",
        "cleanup",
        "refactor",
        "rename",
        "remove",
        "deps",
        "dependency",
        "dependencies",
        "docs",
        "documentation",
        "ci",
        "lint",
    ];
    const STOP: &[&str] = &[
        "a", "an", "the", "to", "for", "of", "in", "on", "and", "with", "we", "i", "use", "using",
        "instead", "should", "is", "are", "be",
    ];
    let words = title
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let kind = if words.iter().any(|word| FIX.contains(&word.as_str())) {
        "fix"
    } else if words.iter().any(|word| CHORE.contains(&word.as_str())) {
        "chore"
    } else {
        "feature"
    };
    let skip = words.first().is_some_and(|word| {
        FIX.contains(&word.as_str())
            || CHORE.contains(&word.as_str())
            || ["feat", "feature"].contains(&word.as_str())
    });
    let slug = words
        .iter()
        .skip(usize::from(skip))
        .filter(|word| !STOP.contains(&word.as_str()))
        .take(4)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() { "task" } else { &slug };
    format!(
        "{kind}/{slug}-{}",
        &task_id[task_id.len().saturating_sub(6)..]
    )
}

pub struct LocalProfiles {
    root: Value,
    worker: Value,
}

/// Profile selection precedes the Git fetch in the TypeScript create flow.
pub fn select_local_profiles(
    database: &SuplexDatabase,
    project: &Project,
    input: &TaskCreateBody,
) -> DatabaseResult<LocalProfiles> {
    let root = selected_profile(
        database,
        project,
        input.root_profile_id.as_deref(),
        &project.root_profile_id,
        "root",
    )?;
    let worker = selected_profile(
        database,
        project,
        input.worker_profile_id.as_deref(),
        &project.worker_profile_id,
        "worker",
    )?;
    Ok(LocalProfiles { root, worker })
}

/// Prepare a Standard task from a fresh Git base commit. The caller owns the
/// external fetch and passes the profiles selected before it.
pub fn prepare_local_user_task(
    company_id: &str,
    actor_user_id: &str,
    project: &Project,
    input: &TaskCreateBody,
    profiles: LocalProfiles,
    base_sha: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<PreparedTask> {
    let repository = project.repository.as_deref().ok_or_else(|| {
        Box::new(TaskFailure::new(
            "Configure the project repository before creating a task",
            422,
        )) as Box<dyn Error>
    })?;
    let id = repository::new_task_id();
    let branch = task_branch_name(&input.title, &id);
    let mut configuration = Map::new();
    if let Some(policy) = &project.provider_policy {
        configuration.insert("providerPolicy".into(), serde_json::to_value(policy)?);
    }
    if let Some(integration) = &project.integration {
        configuration.insert("integration".into(), serde_json::to_value(integration)?);
    }
    if let Some(execution) = &project.execution {
        configuration.insert("execution".into(), serde_json::to_value(execution)?);
    }
    for (key, value) in [
        ("repository", json!(repository)),
        ("repositoryPath", json!(project.repository_path)),
        ("worktreeRoot", json!(project.worktree_root)),
        ("branch", json!(branch)),
        ("baseBranch", json!(project.base_branch)),
        ("baselineSha", json!(base_sha)),
        ("startingSha", json!(base_sha)),
        ("setupCommand", json!(project.setup_command)),
        ("verificationCommand", json!(project.verification_command)),
        ("runProjectTests", json!(input.run_project_tests)),
        ("visualEvidence", json!(input.visual_evidence)),
        ("source", Value::Null),
        ("capturedAt", json!(timestamp(now))),
    ] {
        configuration.insert(key.to_owned(), value);
    }
    Ok(PreparedTask {
        id,
        company_id: company_id.to_owned(),
        project_id: project.id.clone(),
        title: input.title.clone(),
        description: input.description.clone(),
        configuration: Value::Object(configuration),
        idempotency_key: input.idempotency_key.clone(),
        request_hash: task_request_hash(input, actor_user_id)?,
        creator: TaskCreator::User(actor_user_id.to_owned()),
        delivery_target: input.delivery_target.clone(),
        delivery_intent: json!({"repository": repository, "headBranch": branch, "baseBranch": project.base_branch, "baselineSha": base_sha, "pullRequestNumber": null}),
        root_profile: profiles.root,
        worker_profile: profiles.worker,
        advisor_profiles: json!({}),
        issue: None,
        start_queued: input.start_immediately,
        copied_from_task_id: None,
        depends_on: input.depends_on.clone(),
    })
}

fn audit(
    database: &SuplexDatabase,
    actor_user_id: &str,
    action: &str,
    task: &TaskRecord,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let archived: bool = database.connection().query_row(
        "SELECT archived_at IS NOT NULL FROM suplex_tasks WHERE id = ?1",
        [&task.id],
        |row| row.get(0),
    )?;
    let resulting_state = json!({"status": task.status, "archived": archived}).to_string();
    database.connection().execute(
        "INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES (?1, ?2, NULL, ?3, NULL, ?4, ?5, ?6)",
        params![format!("audit_{}", Uuid::new_v4().simple()), actor_user_id, action, task.company_id, json!({"taskId": task.id, "resultingState": resulting_state}).to_string(), timestamp(now)],
    )?;
    Ok(())
}

/// The project was read before live Git capture; compare its material fields again at the write.
pub fn create_user_task(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    expected_project: &Project,
    prepared: &PreparedTask,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskWrite> {
    create_user_task_inner(
        database,
        actor_user_id,
        expected_project,
        prepared,
        None,
        now,
        wake,
    )
}

pub fn create_user_task_with_images(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    expected_project: &Project,
    prepared: &PreparedTask,
    files: ImageFiles<'_>,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskWrite> {
    create_user_task_inner(
        database,
        actor_user_id,
        expected_project,
        prepared,
        Some((files.root, files.images)),
        now,
        wake,
    )
}

pub struct ImageFiles<'a> {
    pub root: &'a Path,
    pub images: &'a [DecodedTaskImage],
}

fn create_user_task_inner(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    expected_project: &Project,
    prepared: &PreparedTask,
    images: Option<(&Path, &[DecodedTaskImage])>,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskWrite> {
    let mut written = Vec::new();
    let result = database.transaction(true, |database| {
        let company =
            companies::require_company_access(database, actor_user_id, &prepared.company_id)?;
        if company.status != "active" {
            return Err(Box::new(TaskFailure::new("The company is not active", 409)));
        }
        if prepared.creator != TaskCreator::User(actor_user_id.to_owned()) {
            return Err(Box::new(TaskFailure::new("Not found", 404)));
        }
        if let Some(task) = repository::existing(database, prepared)? {
            if task.status == "active" {
                let id = task.id.clone();
                database.after_commit(move || wake(id));
            }
            return Ok(TaskWrite {
                task,
                created: false,
            });
        }
        let current_project = service::get(database, actor_user_id, &prepared.project_id)?;
        if current_project.company_id != prepared.company_id {
            return Err(Box::new(TaskFailure::new("Not found", 404)));
        }
        if project_signature(&current_project) != project_signature(expected_project) {
            return Err(Box::new(TaskFailure::new(
                "Project configuration changed",
                409,
            )));
        }
        let result = match images {
            Some((artifact_root, images)) => repository::create_with_images(
                database,
                prepared,
                artifact_root,
                images,
                now,
                &mut written,
            )?,
            None => repository::create(database, prepared, now)?,
        };
        if result.task.status == "active" {
            let id = result.task.id.clone();
            database.after_commit(move || wake(id));
        }
        Ok(result)
    });
    if result.is_err()
        && let Some((artifact_root, _)) = images
    {
        for artifact in &written {
            artifacts::remove_written(artifact_root, artifact);
        }
    }
    result
}

/// Start is params-only at HTTP; this command rechecks the live user's task scope.
pub fn start_user_task(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let scope = database
            .connection()
            .query_row(
                "SELECT company_id, archived_at FROM suplex_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        companies::require_company_access(database, actor_user_id, &scope.0)?;
        if archive::in_progress(task_id) {
            return Err(Box::new(TaskFailure::new(
                "Archive cleanup is in progress",
                409,
            )));
        }
        if scope.1.is_some() {
            return Err(Box::new(TaskFailure::new(
                "This task cannot be started",
                409,
            )));
        }
        let task = repository::start(database, task_id, now)?.ok_or_else(|| {
            Box::new(TaskFailure::new("This task cannot be started", 409)) as Box<dyn Error>
        })?;
        audit(database, actor_user_id, "task_started", &task, now)?;
        if task.status == "active" {
            let id = task.id.clone();
            database.after_commit(move || wake(id));
        }
        Ok(task)
    })
}

/// Cancel intent before waking the host. A disconnected HTTP waiter cannot
/// undo the committed stop request or cause the native session to replay.
pub fn cancel_user_task(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        if task.status == "delivered" {
            return Err(Box::new(TaskFailure::new(
                "Delivered tasks cannot be cancelled",
                409,
            )));
        }
        if !root_session_store::cancel_task(database, task_id, now)? {
            return Err(Box::new(TaskFailure::new(
                "This task cannot be cancelled",
                409,
            )));
        }
        let cancelled = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        audit(database, actor_user_id, "task_cancelled", &cancelled, now)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(cancelled)
    })
}

/// Send a human note to an active Root, or resume the retained Root of a
/// delivered task. The targeted host wake follows the durable prompt commit.
pub fn send_user_note(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    request: &TaskNoteBody,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        let (archived, workflow): (bool, String) = database.connection().query_row(
            "SELECT t.archived_at IS NOT NULL,c.workflow FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if archived || !matches!(task.status.as_str(), "active" | "delivered") {
            return Err(Box::new(TaskFailure::new(
                "Start the task or answer its current decision before you send a message.",
                409,
            )));
        }
        if workflow != "standard" {
            return Err(Box::new(TaskFailure {
                public_message: "experimental_not_ported".into(),
                status_code: 501,
                code: "experimental_not_ported",
            }));
        }
        root_session_store::send_note(database, task_id, &request.note, now)?;
        let updated = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(updated)
    })
}

/// Answer the current question and wake only after the durable answer commit.
pub fn answer_user_task(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    answer: &AnswerBody,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        let (archived, question, limit_pause, recovery_turn): (bool, Option<String>, bool, bool) = database
            .connection()
            .query_row(
                "SELECT t.archived_at IS NOT NULL,c.human_question_id,c.limit_pause_json IS NOT NULL,c.recovery_turn_id IS NOT NULL FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        if archived
            || question.as_deref() != Some(answer.question_id.as_str())
            || answer.answer.trim().is_empty()
        {
            return Err(Box::new(TaskFailure::new(
                "The question changed. Read the current question before answering",
                409,
            )));
        }
        if limit_pause {
            return Err(Box::new(TaskFailure::new(
                "Select a task limit action before you continue",
                409,
            )));
        }
        if recovery_turn && !answer.confirm_commands_stopped.unwrap_or(false) {
            return Err(Box::new(TaskFailure::new(
                "Confirm that the commands have stopped before you continue",
                409,
            )));
        }
        root_session_store::answer_human(
            database,
            task_id,
            &answer.question_id,
            &answer.answer,
            answer.confirm_commands_stopped.unwrap_or(false),
            now,
        )?;
        let answered = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        audit(database, actor_user_id, "task_answered", &answered, now)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(answered)
    })
}

/// User replacement authorizes the task, persists the fresh Worker, then
/// wakes the host after commit. The outgoing native execution is stopped by
/// normal host recovery before the replacement can be admitted.
pub fn replace_user_worker(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    request: &TaskWorkerReplacementBody,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        root_session_store::replace_worker(database, task_id, request, now).map_err(|error| {
            let message = error.to_string();
            if message.starts_with("experimental_not_ported:") {
                Box::new(TaskFailure {
                    public_message: "This task workflow is not implemented in the Rust engine"
                        .into(),
                    status_code: 501,
                    code: "experimental_not_ported",
                }) as Box<dyn Error>
            } else {
                Box::new(TaskFailure::new(message, 409)) as Box<dyn Error>
            }
        })?;
        let task = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(task)
    })
}

/// Apply an authenticated limit decision, audit the resulting state, then wake.
pub fn answer_user_task_limit(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    answer: &LimitDecisionBody,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        let (archived, status, question, has_limit_pause): (bool, String, Option<String>, bool) = database
            .connection()
            .query_row(
                "SELECT t.archived_at IS NOT NULL,c.status,c.human_question_id,c.limit_pause_json IS NOT NULL FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        if archived
            || status != "waiting_human"
            || question.as_deref() != Some(answer.question_id.as_str())
            || !has_limit_pause
        {
            return Err(Box::new(TaskFailure::new(
                "The question changed. Read the current question before answering",
                409,
            )));
        }
        root_session_store::answer_task_limit(
            database,
            task_id,
            &answer.question_id,
            &answer.limit_decision,
            now,
        )?;
        let answered = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        let action = if matches!(answer.limit_decision, TaskLimitDecision::CancelTask) {
            "task_cancelled"
        } else {
            "task_answered"
        };
        audit(database, actor_user_id, action, &answered, now)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(answered)
    })
}

fn edit_profile(
    database: &SuplexDatabase,
    id: &str,
    current: &Value,
    role: &str,
) -> DatabaseResult<Value> {
    if current.get("profileId").and_then(Value::as_str) == Some(id) {
        return Ok(current.clone());
    }
    read_profile(database, id, role)?.ok_or_else(|| {
        Box::new(TaskFailure::new(
            "The selected agent profile does not exist",
            422,
        )) as Box<dyn Error>
    })
}

/// The UI edit resolves a full settings snapshot against the stored task.
pub fn update_user_task_details(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    input: &TaskDetailsBody,
    now: DateTime<Utc>,
) -> DatabaseResult<TaskRecord> {
    if input.title.is_none()
        && input.description.is_none()
        && input.root_profile_id.is_none()
        && input.worker_profile_id.is_none()
        && input.delivery_target.is_none()
        && input.run_project_tests.is_none()
        && input.visual_evidence.is_none()
        && input.workflow.is_none()
        && input.advisor_profile_ids.is_none()
    {
        // The HTTP schema accepts {}, but the TypeScript service refinement throws.
        return Err(std::io::Error::other("Internal server error").into());
    }
    database.transaction(true, |database| {
        let scope = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        companies::require_company_access(database, actor_user_id, &scope.company_id)?;
        let current = repository::edit_snapshot(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        let workflow = input.workflow.as_deref().unwrap_or(&current.workflow);
        if workflow == "standard" {
            if let Some(advisors) = &input.advisor_profile_ids {
                let names = [
                    (advisors.reviewer.as_ref(), "Reviewer"),
                    (advisors.planner_a.as_ref(), "Plan A"),
                    (advisors.planner_b.as_ref(), "Plan B"),
                    (advisors.rater.as_ref(), "Rater"),
                ]
                .into_iter()
                .filter_map(|(value, label)| value.map(|_| label))
                .collect::<Vec<_>>();
                if !names.is_empty() {
                    return Err(Box::new(TaskFailure::new(
                        format!("The Standard workflow has no {} Advisor", names.join(", ")),
                        422,
                    )));
                }
            }
        } else {
            return Err(Box::new(TaskFailure {
                public_message: "Experimental Rust backend has not ported this route".into(),
                status_code: 501,
                code: "experimental_not_ported",
            }));
        }
        let root_id = input
            .root_profile_id
            .as_deref()
            .or_else(|| {
                current
                    .root_profile
                    .get("profileId")
                    .and_then(Value::as_str)
            })
            .ok_or("Stored Root profile is missing")?;
        let worker_id = input
            .worker_profile_id
            .as_deref()
            .or_else(|| {
                current
                    .worker_profile
                    .get("profileId")
                    .and_then(Value::as_str)
            })
            .ok_or("Stored Worker profile is missing")?;
        let root_profile = edit_profile(database, root_id, &current.root_profile, "root")?;
        let worker_profile = edit_profile(database, worker_id, &current.worker_profile, "worker")?;
        let policy: Option<ProjectProviderPolicy> = current
            .configuration
            .get("providerPolicy")
            .filter(|value| !value.is_null())
            .cloned()
            .map(serde_json::from_value)
            .transpose()?;
        if !allowed_profile(policy.as_ref(), &root_profile)
            || !allowed_profile(policy.as_ref(), &worker_profile)
        {
            return Err(Box::new(TaskFailure::new(
                "Select agents with providers and logins allowed by this project",
                422,
            )));
        }
        let delivery_target = input
            .delivery_target
            .as_deref()
            .unwrap_or(&current.delivery_target);
        if current
            .configuration
            .pointer("/integration/repository/kind")
            .and_then(Value::as_str)
            == Some("bitbucket")
            && ["pull_request_ready", "merged"].contains(&delivery_target)
        {
            return Err(Box::new(TaskFailure::new(
                "Bitbucket supports draft pull requests. Select a supported delivery target.",
                422,
            )));
        }
        let stored_tests = current
            .configuration
            .get("runProjectTests")
            .and_then(Value::as_bool)
            .ok_or("Stored task test choice is missing")?;
        let stored_visual = current
            .configuration
            .get("visualEvidence")
            .and_then(Value::as_str)
            .ok_or("Stored task visual evidence choice is missing")?;
        let details = TaskDetailsWrite {
            title: input
                .title
                .clone()
                .unwrap_or_else(|| current.task.title.clone()),
            description: input
                .description
                .clone()
                .unwrap_or_else(|| current.task.description.clone()),
            delivery_target: delivery_target.to_owned(),
            workflow: workflow.to_owned(),
            run_project_tests: input.run_project_tests.unwrap_or(stored_tests),
            visual_evidence: input
                .visual_evidence
                .clone()
                .unwrap_or_else(|| stored_visual.to_owned()),
            root_profile,
            worker_profile,
            advisor_profiles: json!({}),
        };
        if !repository::update_details(database, task_id, &details, now)? {
            return Err(Box::new(TaskFailure::new(
                "Only tasks in the backlog can be edited. Open archived tasks before editing them.",
                409,
            )));
        }
        repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)
    })
}

pub fn rename_user_task(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    input: &TaskRenameBody,
    now: DateTime<Utc>,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let current = repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)?;
        companies::require_company_access(database, actor_user_id, &current.company_id)?;
        if !repository::rename(database, task_id, &input.title, now)? {
            return Err(Box::new(TaskFailure::new(
                "Open archived tasks before renaming them.",
                409,
            )));
        }
        repository::task_by_id(database, task_id)?
            .ok_or_else(|| Box::new(TaskFailure::new("Not found", 404)) as Box<dyn Error>)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        http::contracts::typed::tasks, identity::auth, platform::database::OpenMode,
        tasks::response,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn standard_request_hash_matches_typescript_parsed_request() {
        let raw = json!({"projectId":"p","title":"  Make thing  ","idempotencyKey":"abcdefgh"});
        let request = tasks::parse_task_create(Some(&raw)).unwrap();
        assert_eq!(
            task_request_hash(&request, "u").unwrap(),
            "b8e10adbdf1c3537ab26f518bbf8b5f50ee112efa9bae587f22c7d22a80c58e1"
        );
        assert_eq!(
            task_branch_name("Build the task route", "task_123456abcdef"),
            "feature/build-task-route-abcdef"
        );
        let local = json!({
            "projectId": "task_http_project", "title": "Build the task route",
            "idempotencyKey": "task-http-key", "deliveryTarget": "local_worktree"
        });
        let local = tasks::parse_task_create(Some(&local)).unwrap();
        assert_eq!(
            task_request_hash(&local, "u").unwrap(),
            "b10d948006f8f7e077804b2e76b52bcca01f0d38f8ca749e12935f7eb41210b5"
        );
        let immediate = json!({
            "projectId":"task_http_project", "title":"Start on creation",
            "idempotencyKey":"task-immediate-key", "deliveryTarget":"local_worktree",
            "startImmediately":true
        });
        let immediate = tasks::parse_task_create(Some(&immediate)).unwrap();
        assert_eq!(
            task_request_hash(&immediate, "u").unwrap(),
            "a4e5c026d27619def492a2b36d8f674cb7a7a27a077b69e6bb6c913997326c85"
        );
        for (name, typescript_hash) in [
            (
                "all_fields",
                "1bc72dd67f9d405edc7ad4bbc0915fa7333a6a422c460a7c116b549abed71d00",
            ),
            (
                "null_issue",
                "f7f6c244dd7c018a5207b9780de6371484a8d4c08e6650b497f8943bc492ebb3",
            ),
            (
                "pull_request_source",
                "52a8b95bbf6172ab29b486520b0208da973e556bfe759976b33da0d0d21b0fa8",
            ),
            (
                "max_dependencies",
                "fdafad3b61bff764b50e64fac62de23cea6f0e113cdde871b78c0db1481a0880",
            ),
            (
                "max_blocked_prs",
                "306598268dbbbea657e86045b33635986e4438ccdf510d9c9e4ba4d5a603d39f",
            ),
        ] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("tests/parity/tasks.TaskBodySchema")
                .join(format!("{name}.json"));
            let fixture: Value =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            let request = tasks::parse_task_create(Some(&fixture["input"])).unwrap();
            assert_eq!(
                task_request_hash(&request, "u").unwrap(),
                typescript_hash,
                "{name}"
            );
        }
    }

    #[test]
    fn live_authority_and_after_commit_wake_follow_task_start() {
        let filename =
            std::env::temp_dir().join(format!("suplex_task_command_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('command_company', 'Command company', 'active', ?1)",
            [timestamp(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('command_project', 'command_company', 'Command project', '/tmp/suplex-command-project', '/tmp/suplex-command-worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', ?1, ?2, ?2)",
            params![json!({"workflowIds":["standard"],"defaultWorkflowId":"standard","rootProfileIds":["profile_native_root"],"workerProfileIds":["profile_native_worker"]}).to_string(), timestamp(now)],
        ).unwrap();
        let project = service::get(&database, &user.id, "command_project").unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "command_company".into(),
            project_id: "command_project".into(),
            title: "Command task".into(),
            description: "Run Codex".into(),
            configuration: json!({"repository":"owner/repo","branch":"task-command","baseBranch":"main","baselineSha":"head"}),
            idempotency_key: "command-key".into(),
            request_hash: "command-hash".into(),
            creator: TaskCreator::User(user.id.clone()),
            delivery_target: "local_worktree".into(),
            delivery_intent: json!({"repository":"owner/repo","headBranch":"task-command","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
            root_profile: json!({"profileId":"profile_native_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            worker_profile: json!({"profileId":"profile_native_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            advisor_profiles: json!({}),
            issue: None,
            start_queued: false,
            copied_from_task_id: None,
            depends_on: vec![],
        };
        let artifact_root = filename.with_extension("artifacts");
        let image = DecodedTaskImage {
            filename: "proof.png".into(),
            mime_type: "image/png".into(),
            bytes: vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        };
        let wakes = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&wakes);
        let created = create_user_task_with_images(
            &mut database,
            &user.id,
            &project,
            &prepared,
            ImageFiles {
                root: &artifact_root,
                images: std::slice::from_ref(&image),
            },
            now,
            move |_| {
                count.fetch_add(1, Ordering::SeqCst);
            },
        )
        .unwrap();
        assert!(created.created);
        assert_eq!(created.task.status, "backlog");
        assert_eq!(wakes.load(Ordering::SeqCst), 0);
        let count = Arc::clone(&wakes);
        assert!(
            start_user_task(
                &mut database,
                "missing-user",
                &created.task.id,
                now,
                move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                }
            )
            .is_err()
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 0);
        let count = Arc::clone(&wakes);
        let started = start_user_task(&mut database, &user.id, &created.task.id, now, move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        assert_eq!(started.status, "active");
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        let body =
            serde_json::to_string(&response::get(&database, &created.task.id).unwrap().unwrap())
                .unwrap();
        assert!(body.starts_with(&format!("{{\"id\":\"{}\",\"companyId\":\"command_company\",\"projectId\":\"command_project\",\"issueKey\":null", created.task.id)));
        assert!(body.contains("\"status\":\"active\""));
        let created_snapshot =
            serde_json::to_value(response::get(&database, &created.task.id).unwrap().unwrap())
                .unwrap();
        let stored_image = root_session_store::task_artifact(
            &database,
            &created.task.id,
            created_snapshot["images"][0]["artifactId"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            artifacts::read(
                &artifact_root,
                &stored_image.company_id,
                &stored_image.storage_path
            )
            .unwrap(),
            image.bytes
        );
        let count = Arc::clone(&wakes);
        let repeated = create_user_task_with_images(
            &mut database,
            &user.id,
            &project,
            &prepared,
            ImageFiles {
                root: &artifact_root,
                images: std::slice::from_ref(&image),
            },
            now,
            move |_| {
                count.fetch_add(1, Ordering::SeqCst);
            },
        )
        .unwrap();
        assert!(!repeated.created);
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        let image_count: i64 = database
            .connection()
            .query_row(
                "SELECT count(*) FROM suplex_artifacts WHERE task_id = ?1",
                [&created.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(image_count, 1);
        let mut invalid = prepared.clone();
        invalid.id = repository::new_task_id();
        invalid.idempotency_key = "command-failing-image".into();
        invalid.request_hash = "command-failing-image-hash".into();
        invalid.depends_on = vec!["missing-dependency".into()];
        assert!(
            create_user_task_with_images(
                &mut database,
                &user.id,
                &project,
                &invalid,
                ImageFiles {
                    root: &artifact_root,
                    images: std::slice::from_ref(&image)
                },
                now,
                |_| {},
            )
            .is_err()
        );
        let image_count: i64 = database
            .connection()
            .query_row("SELECT count(*) FROM suplex_artifacts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(image_count, 1);
        let stored_path = artifact_root.join(&stored_image.storage_path);
        assert_eq!(
            std::fs::read_dir(stored_path.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
        let root = root_session_store::reserve_root(&mut database, &created.task.id, now).unwrap();
        assert!(
            root_session_store::ask_human_for_root(
                &mut database,
                &created.task.id,
                &root.id,
                root.generation,
                "Use main?",
                &json!([]),
                now,
            )
            .unwrap()
        );
        let question_id: String = database
            .connection()
            .query_row(
                "SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?1",
                [&created.task.id],
                |row| row.get(0),
            )
            .unwrap();
        let answer = AnswerBody {
            question_id: question_id.clone(),
            answer: "Proceed".into(),
            confirm_commands_stopped: None,
        };
        let count = Arc::clone(&wakes);
        assert!(
            answer_user_task(
                &mut database,
                "missing-user",
                &created.task.id,
                &answer,
                now,
                move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                }
            )
            .is_err()
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        let count = Arc::clone(&wakes);
        assert_eq!(
            answer_user_task(
                &mut database,
                &user.id,
                &created.task.id,
                &answer,
                now,
                move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                }
            )
            .unwrap()
            .status,
            "active"
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 3);
        let note = TaskNoteBody {
            note: "Check the current result.".into(),
        };
        let count = Arc::clone(&wakes);
        assert!(
            send_user_note(
                &mut database,
                "missing-user",
                &created.task.id,
                &note,
                now,
                move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                },
            )
            .is_err()
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 3);
        let count = Arc::clone(&wakes);
        let reopen = filename.clone();
        assert_eq!(send_user_note(
            &mut database,
            &user.id,
            &created.task.id,
            &note,
            now,
            move |id| {
                let observed = SuplexDatabase::open(&reopen, OpenMode::ReadWrite).unwrap();
                let persisted: i64 = observed.connection().query_row(
                    "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompt_text = 'Human note:' || char(10) || 'Check the current result.'",
                    [&id],
                    |row| row.get(0),
                ).unwrap();
                assert_eq!(persisted, 1);
                count.fetch_add(1, Ordering::SeqCst);
            },
        ).unwrap().status, "active");
        assert_eq!(wakes.load(Ordering::SeqCst), 4);
        let note_audits: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'task_note_added'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(note_audits, 0);
        let pause = json!({
            "kind":"task_limit", "reason":"turns",
            "limits":{"budgetUsd":15,"maxTurns":40},
            "usage":{"estimatedCostUsd":null,"admittedTurns":40},
            "proposedLimits":{"budgetUsd":15,"maxTurns":80}
        });
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'More turns?', human_question_id = 'command-limit', limit_pause_json = ?1 WHERE task_id = ?2",
            params![pause.to_string(), created.task.id],
        ).unwrap();
        let limit = LimitDecisionBody {
            question_id: "command-limit".into(),
            limit_decision: TaskLimitDecision::CancelTask,
        };
        let count = Arc::clone(&wakes);
        assert!(
            answer_user_task_limit(
                &mut database,
                "missing-user",
                &created.task.id,
                &limit,
                now,
                move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                },
            )
            .is_err()
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 4);
        let count = Arc::clone(&wakes);
        assert_eq!(
            answer_user_task_limit(
                &mut database,
                &user.id,
                &created.task.id,
                &limit,
                now,
                move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                },
            )
            .unwrap()
            .status,
            "cancelled"
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 5);
        let audited: String = database.connection().query_row(
            "SELECT action FROM suplex_audit_events WHERE company_id = 'command_company' ORDER BY rowid DESC LIMIT 1",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(audited, "task_cancelled");
        let count = Arc::clone(&wakes);
        assert!(
            answer_user_task(
                &mut database,
                &user.id,
                &created.task.id,
                &answer,
                now,
                move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                }
            )
            .is_err()
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 5);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
