//! User task commands keep authorization, intent, audit, and wake admission together.

use crate::profiles::agent_profiles::{allowed_profile, read_profile};

use crate::shared::hash::sha256_hex;
use crate::shared::time::rfc3339_millis;
use crate::tasks::TaskError;
use crate::tasks::control::{DeliveryIntent, DeliveryTarget, TaskProfile, TaskStatus};
use std::{collections::BTreeMap, path::Path};

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    coordination::{
        advisor_bridge::AdvisorRole,
        root_prompts, root_session_store,
        workflows::{self, AgentSelection, Workflow},
    },
    http::contracts::typed::{
        projects::ProjectProviderPolicy,
        task_answers::{AnswerBody, LimitDecisionBody, TaskLimitDecision},
        tasks::{
            TaskAgentSelectionBody, TaskContinueDeliveryBody, TaskCoordinatorReplacementBody,
            TaskCreateBody, TaskDependenciesBody, TaskDetailsBody, TaskNoteBody, TaskRenameBody,
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
use super::pull_request_dependencies;
use super::repository::{self, PreparedTask, TaskCreator, TaskDetailsWrite, TaskRecord, TaskWrite};

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
    Ok(sha256_hex(
        crate::shared::js_json::stringify(&payload).as_bytes(),
    ))
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
        return Err(
            TaskError::new("This idempotency key belongs to a different request", 409).into(),
        );
    }
    repository::task_by_id(database, &task_id)
}

fn selected_profile(
    database: &SuplexDatabase,
    project: &Project,
    selected: Option<&str>,
    default_id: &str,
    role: &str,
) -> DatabaseResult<TaskProfile> {
    let id = selected.unwrap_or(default_id);
    let profile = read_profile(database, id, role)?
        .ok_or_else(|| TaskError::new("The selected agent profile does not exist", 422))?;
    if allowed_profile(project.provider_policy.as_ref(), &profile) {
        return Ok(profile);
    }
    if selected.is_some() {
        return Err(TaskError::new(
            "Select agents with providers and logins allowed by this project",
            422,
        )
        .into());
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
    Err(TaskError::new(
        "Create an agent with a provider and login allowed by this project",
        422,
    )
    .into())
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
    root: TaskProfile,
    worker: TaskProfile,
    advisors: BTreeMap<AdvisorRole, TaskProfile>,
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
    // TypeScript `create`: each workflow Advisor defaults to the Coordinator profile.
    let mut advisors = BTreeMap::new();
    let selected = serde_json::to_value(&input.advisor_profile_ids)?;
    for role in workflows::advisor_roles(input.workflow.as_str()) {
        let id = selected[role.as_str()].as_str().unwrap_or(&root.profile_id);
        let profile = selected_profile(database, project, Some(id), id, "root")?;
        advisors.insert(role, profile);
    }
    Ok(LocalProfiles {
        root,
        worker,
        advisors,
    })
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
        TaskError::new(
            "Configure the project repository before creating a task",
            422,
        )
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
        ("capturedAt", json!(rfc3339_millis(now))),
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
        delivery_target: input.delivery_target.to_string(),
        delivery_intent: DeliveryIntent {
            repository: repository.to_owned(),
            head_branch: branch,
            base_branch: project.base_branch.clone(),
            baseline_sha: base_sha.to_owned(),
            pull_request_number: None,
        },
        root_profile: profiles.root,
        worker_profile: profiles.worker,
        advisor_profiles: profiles.advisors,
        issue: None,
        start_queued: input.start_immediately,
        copied_from_task_id: None,
        depends_on: input.depends_on.clone(),
        pull_request_dependencies: vec![],
        workflow: input.workflow,
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
    crate::identity::audit::record(
        database,
        &crate::identity::audit::AuditEvent {
            id: &format!("audit_{}", Uuid::new_v4().simple()),
            actor_user_id: Some(actor_user_id),
            actor_agent_id: None,
            action,
            target_user_id: None,
            company_id: Some(&task.company_id),
            metadata_json: &json!({"taskId": task.id, "resultingState": resulting_state})
                .to_string(),
            created_at: &rfc3339_millis(now),
        },
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

/// The actor belongs to the active company and is the task's creator.
fn require_creator_scope(
    database: &SuplexDatabase,
    actor_user_id: &str,
    prepared: &PreparedTask,
) -> DatabaseResult<()> {
    let company = companies::require_company_access(database, actor_user_id, &prepared.company_id)?;
    if company.status != "active" {
        return Err(TaskError::new("The company is not active", 409).into());
    }
    if prepared.creator != TaskCreator::User(actor_user_id.to_owned()) {
        return Err(TaskError::not_found().into());
    }
    Ok(())
}

/// The project still belongs to the company and has the configuration the task captured.
fn require_unchanged_project(
    database: &SuplexDatabase,
    actor_user_id: &str,
    prepared: &PreparedTask,
    expected_project: &Project,
) -> DatabaseResult<()> {
    let current_project = service::get(database, actor_user_id, &prepared.project_id)?;
    if current_project.company_id != prepared.company_id {
        return Err(TaskError::not_found().into());
    }
    if project_signature(&current_project) != project_signature(expected_project) {
        return Err(TaskError::new("Project configuration changed", 409).into());
    }
    Ok(())
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
        require_creator_scope(database, actor_user_id, prepared)?;
        if let Some(task) = repository::existing(database, prepared)? {
            if task.status == TaskStatus::Active {
                let id = task.id.clone();
                database.after_commit(move || wake(id));
            }
            return Ok(TaskWrite {
                task,
                created: false,
            });
        }
        require_unchanged_project(database, actor_user_id, prepared, expected_project)?;
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
        if result.created && prepared.workflow != Workflow::Standard {
            database.connection().execute(
                "UPDATE suplex_task_controls SET workflow = ?1 WHERE task_id = ?2",
                params![prepared.workflow, result.task.id],
            )?;
        }
        if result.task.status == TaskStatus::Active {
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
    let task = database.transaction(true, |database| {
        let scope = database
            .connection()
            .query_row(
                "SELECT company_id, archived_at FROM suplex_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &scope.0)?;
        if archive::in_progress(task_id) {
            return Err(TaskError::new("Archive cleanup is in progress", 409).into());
        }
        if scope.1.is_some() {
            return Err(TaskError::new("This task cannot be started", 409).into());
        }
        let task = repository::start(database, task_id, now)?
            .ok_or_else(|| TaskError::new("This task cannot be started", 409))?;
        if task.status == TaskStatus::Active {
            let id = task.id.clone();
            database.after_commit(move || wake(id));
        }
        Ok(task)
    })?;
    audit(database, actor_user_id, "task_started", &task, now)?;
    Ok(task)
}

/// TypeScript `getTask`: the task exists and the live user can read its company.
fn require_user_task(
    database: &SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
) -> DatabaseResult<TaskRecord> {
    let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
    companies::require_company_access(database, actor_user_id, &task.company_id)?;
    Ok(task)
}

/// Return a queued task to the manual backlog. The same people who can start a task can disarm it.
pub fn disarm_user_task(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<TaskRecord> {
    let task = require_user_task(database, actor_user_id, task_id)?;
    let archived: bool = database.connection().query_row(
        "SELECT archived_at IS NOT NULL FROM suplex_tasks WHERE id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    if archived || !repository::disarm(database, task_id, now)? {
        return Err(TaskError::new("Only a task in the backlog can be disarmed", 409).into());
    }
    let task = repository::task_by_id(database, task_id)?.unwrap_or(task);
    audit(database, actor_user_id, "task_disarmed", &task, now)?;
    Ok(task)
}

/// Move a delivered pull request task toward a later target.
pub fn continue_user_delivery(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    request: &TaskContinueDeliveryBody,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let task = require_user_task(database, actor_user_id, task_id)?;
        if archive::in_progress(task_id) {
            return Err(TaskError::new("Archive cleanup is in progress", 409).into());
        }
        root_session_store::continue_delivery(database, task_id, request.delivery_target)?;
        let task = repository::task_by_id(database, task_id)?.unwrap_or(task);
        if task.status == TaskStatus::Active {
            let id = task_id.to_owned();
            database.after_commit(move || wake(id));
        }
        Ok(task)
    })
}

/// TypeScript `selectTaskAgent`: choose the Coordinator or Worker profile. A
/// Coordinator with a session is replaced; otherwise the choice starts the
/// first Coordinator or records the Worker for current and future assignments.
pub fn select_user_task_agent(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    request: &TaskAgentSelectionBody,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    require_user_task(database, actor_user_id, task_id)?;
    let conflict = |message: &str| TaskError::new(message, 409).into();
    let coordinator_changed =
        "The Coordinator changed. Read the current Coordinator before selecting another.";
    if request.role == "root"
        && let Some(expected_session_id) = &request.expected_session_id
    {
        let (root_session_id, root_profile): (Option<String>, String) =
            database.connection().query_row(
                "SELECT root_session_id, root_profile_json FROM suplex_task_controls WHERE task_id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        let root_profile: Value = serde_json::from_str(&root_profile)?;
        if root_session_id.as_ref() == Some(expected_session_id)
            && root_profile["profileId"] != request.expected_profile_id.as_str()
        {
            return Err(conflict(coordinator_changed));
        }
        let replacement = TaskCoordinatorReplacementBody {
            session_id: expected_session_id.clone(),
            root_profile_id: request.profile_id.clone(),
            handoff: Some(request.direction.clone()),
            resume: request.resume,
            question_id: request.question_id.clone(),
        };
        return replace_user_coordinator(database, actor_user_id, task_id, &replacement, now, wake);
    }
    let intent = AgentSelection {
        role: request.role.clone(),
        expected_profile_id: request.expected_profile_id.clone(),
        expected_session_id: request.expected_session_id.clone(),
        profile_id: request.profile_id.clone(),
        direction: request.direction.clone(),
        resume: request.resume,
        question_id: request.question_id.clone().filter(|_| request.resume),
    };
    if request.role == "root" {
        root_session_store::select_initial_root(database, task_id, &intent, now)?;
    } else {
        root_session_store::select_delegate(database, task_id, &intent, now)?;
    }
    let id = task_id.to_owned();
    database.after_commit(move || wake(id));
    require_user_task(database, actor_user_id, task_id)
}

/// TypeScript `observePullRequestDependencies` failures for a user command.
pub fn pull_request_rejection(rejection: pull_request_dependencies::Rejection) -> TaskError {
    match rejection {
        pull_request_dependencies::Rejection::Unobservable(number) => TaskError::new(
            format!(
                "Suplex cannot observe pull request #{number}. Try again when GitHub is available."
            ),
            422,
        ),
        pull_request_dependencies::Rejection::NotFound(number) => {
            TaskError::new(format!("Pull request #{number} was not found"), 422)
        }
    }
}

/// Replace a task's prerequisites, then admit or wake it if none still blocks it.
/// `pull_requests` are the GitHub observations of `blockedByPullRequests`.
pub fn set_user_task_dependencies(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    request: &TaskDependenciesBody,
    pull_requests: &[Value],
    now: DateTime<Utc>,
) -> DatabaseResult<TaskRecord> {
    let task = require_user_task(database, actor_user_id, task_id)?;
    for dependency in &request.depends_on {
        require_user_task(database, actor_user_id, dependency)?;
    }
    super::dependencies::replace(
        database,
        task_id,
        &task.company_id,
        &request.depends_on,
        now,
        false,
    )?;
    // Replace every prerequisite before a queued task is considered for admission.
    database.transaction(true, |database| {
        pull_request_dependencies::replace(database, task_id, pull_requests)?;
        repository::reconcile_dependency_release(database, task_id, now)
    })?;
    let task = repository::task_by_id(database, task_id)?.unwrap_or(task);
    audit(
        database,
        actor_user_id,
        "task_dependencies_updated",
        &task,
        now,
    )?;
    Ok(task)
}

/// The configuration of a task the user can read, for provider reads outside a transaction.
pub fn user_task_configuration(
    database: &SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
) -> DatabaseResult<Value> {
    require_user_task(database, actor_user_id, task_id)?;
    let raw: String = database.connection().query_row(
        "SELECT configuration_json FROM suplex_tasks WHERE id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&raw)?)
}

/// TypeScript `setTaskIssue` after the tracker read: store the tracker's
/// current issue, and drop captured context while native work has not started.
pub fn set_user_task_issue(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    resolved: Option<&Value>,
    now: DateTime<Utc>,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let current = require_user_task(database, actor_user_id, task_id)?;
        database.connection().execute(
            "UPDATE suplex_tasks SET issue_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![resolved.map(crate::shared::js_json::stringify), rfc3339_millis(now), task_id],
        )?;
        let started: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions WHERE task_id = ?1 AND native_session_id IS NOT NULL UNION ALL SELECT 1 FROM suplex_task_turns WHERE task_id = ?1 AND status IN ('prompted', 'unknown', 'completed'))",
            [task_id],
            |row| row.get(0),
        )?;
        if matches!(current.status, TaskStatus::Backlog | TaskStatus::Queued) && !started {
            database.connection().execute(
                "UPDATE suplex_tasks SET issue_context_json = NULL WHERE id = ?1",
                [task_id],
            )?;
        }
        Ok(current)
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
    let cancelled = database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        if task.status == TaskStatus::Delivered {
            return Err(TaskError::new("Delivered tasks cannot be cancelled", 409).into());
        }
        if !root_session_store::cancel_task(database, task_id, now)? {
            return Err(TaskError::new("This task cannot be cancelled", 409).into());
        }
        let cancelled =
            repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(cancelled)
    })?;
    audit(database, actor_user_id, "task_cancelled", &cancelled, now)?;
    Ok(cancelled)
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
        let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        let archived: bool = database.connection().query_row(
            "SELECT archived_at IS NOT NULL FROM suplex_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        if archived || !matches!(task.status, TaskStatus::Active | TaskStatus::Delivered) {
            return Err(TaskError::new(
                "Start the task or answer its current decision before you send a message.",
                409,
            )
            .into());
        }
        root_session_store::send_note(database, task_id, &request.note, now)?;
        let updated =
            repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(updated)
    })
}

/// Answer the current question and wake only after the durable answer commit.
/// The answer names the current question of an open task, no limit decision
/// is pending, and interrupted commands are confirmed stopped.
fn require_answerable(
    database: &SuplexDatabase,
    task_id: &str,
    answer: &AnswerBody,
) -> DatabaseResult<()> {
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
        return Err(TaskError::new(
            "The question changed. Read the current question before answering",
            409,
        )
        .into());
    }
    if limit_pause {
        return Err(TaskError::new("Select a task limit action before you continue", 409).into());
    }
    if recovery_turn && !answer.confirm_commands_stopped.unwrap_or(false) {
        return Err(TaskError::new(
            "Confirm that the commands have stopped before you continue",
            409,
        )
        .into());
    }
    Ok(())
}

pub fn answer_user_task(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    answer: &AnswerBody,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    let answered = database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        require_answerable(database, task_id, answer)?;
        root_session_store::answer_human(
            database,
            task_id,
            &answer.question_id,
            &answer.answer,
            answer.confirm_commands_stopped.unwrap_or(false),
            now,
        )?;
        let answered =
            repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(answered)
    })?;
    audit(database, actor_user_id, "task_answered", &answered, now)?;
    Ok(answered)
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
        let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        root_session_store::replace_worker(database, task_id, request, now)
            .map_err(|error| TaskError::new(error.to_string(), 409))?;
        let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(task)
    })
}

/// Select a fresh Root after checking the live task's company. The host wakes
/// only after the replacement session and its first prompt are durable.
pub fn replace_user_coordinator(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    request: &TaskCoordinatorReplacementBody,
    now: DateTime<Utc>,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<TaskRecord> {
    database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        let rows = root_session_store::root_observation_rows(database, task_id)?;
        let initial = root_prompts::initial_coordinator_prompt(
            &rows.control,
            &rows.context,
            &rows.dependencies,
        );
        root_session_store::replace_coordinator(database, task_id, request, &initial, now)
            .map_err(|error| TaskError::new(error.to_string(), 409))?;
        let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
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
    let answered = database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?
            .ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &task.company_id)?;
        let (archived, status, question, has_limit_pause): (bool, TaskStatus, Option<String>, bool) = database
            .connection()
            .query_row(
                "SELECT t.archived_at IS NOT NULL,c.status,c.human_question_id,c.limit_pause_json IS NOT NULL FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        if archived
            || status != TaskStatus::WaitingHuman
            || question.as_deref() != Some(answer.question_id.as_str())
            || !has_limit_pause
        {
            return Err(TaskError::new(
                "The question changed. Read the current question before answering",
                409,
            ).into());
        }
        root_session_store::answer_task_limit(
            database,
            task_id,
            &answer.question_id,
            &answer.limit_decision,
            now,
        )?;
        let answered = repository::task_by_id(database, task_id)?
            .ok_or_else(TaskError::not_found)?;
        let id = task_id.to_owned();
        database.after_commit(move || wake(id));
        Ok(answered)
    })?;
    let action = if matches!(answer.limit_decision, TaskLimitDecision::CancelTask) {
        "task_cancelled"
    } else {
        "task_answered"
    };
    audit(database, actor_user_id, action, &answered, now)?;
    Ok(answered)
}

fn edit_profile(
    database: &SuplexDatabase,
    id: &str,
    current: Option<&TaskProfile>,
    role: &str,
) -> DatabaseResult<TaskProfile> {
    if let Some(current) = current.filter(|current| current.profile_id == id) {
        return Ok(current.clone());
    }
    read_profile(database, id, role)?
        .ok_or_else(|| TaskError::new("The selected agent profile does not exist", 422).into())
}

/// The edit names at least one setting.
fn has_detail_edits(input: &TaskDetailsBody) -> bool {
    input.title.is_some()
        || input.description.is_some()
        || input.root_profile_id.is_some()
        || input.worker_profile_id.is_some()
        || input.delivery_target.is_some()
        || input.run_project_tests.is_some()
        || input.visual_evidence.is_some()
        || input.workflow.is_some()
        || input.advisor_profile_ids.is_some()
}

/// The workflow input the edit states, normalized by the workflow rules. The
/// task keeps the source it was created from, so the rules judge the edit
/// against that source.
fn normalized_edit(
    input: &TaskDetailsBody,
    current: &repository::TaskEditSnapshot,
) -> DatabaseResult<Map<String, Value>> {
    let mut normalized = Map::new();
    normalized.insert(
        "workflow".into(),
        json!(
            input
                .workflow
                .map(|workflow| workflow.as_str())
                .unwrap_or(&current.workflow)
        ),
    );
    normalized.insert(
        "advisorProfileIds".into(),
        serde_json::to_value(input.advisor_profile_ids.clone().unwrap_or_default())?,
    );
    if let Some(source) = current
        .configuration
        .get("source")
        .filter(|source| !source.is_null())
    {
        normalized.insert("source".into(), source.clone());
    }
    if let Some(target) = &input.delivery_target {
        normalized.insert("deliveryTarget".into(), json!(target));
    }
    if let Some(tests) = input.run_project_tests {
        normalized.insert("runProjectTests".into(), json!(tests));
    }
    crate::coordination::workflow_records::normalize_workflow_input(&mut normalized, true)
        .map_err(|message| TaskError::new(message, 422))?;
    Ok(normalized)
}

/// The Advisor profiles of the edited workflow. A request that names its
/// Advisors states them all; only a request without any Advisor selection
/// keeps the stored ones. An unnamed role follows the Coordinator profile.
fn edited_advisor_profiles(
    database: &SuplexDatabase,
    input: &TaskDetailsBody,
    current: &repository::TaskEditSnapshot,
    normalized: &Map<String, Value>,
    root_profile: &TaskProfile,
) -> DatabaseResult<BTreeMap<AdvisorRole, TaskProfile>> {
    let workflow = normalized["workflow"].as_str().unwrap_or("standard");
    let mut advisor_profiles = BTreeMap::new();
    for role in workflows::advisor_roles(workflow) {
        let stored_profile = current.advisor_profiles.get(&role);
        let stored = input
            .advisor_profile_ids
            .is_none()
            .then(|| stored_profile.map(|profile| profile.profile_id.as_str()))
            .flatten();
        let id = normalized["advisorProfileIds"][role.as_str()]
            .as_str()
            .or(stored)
            .unwrap_or(&root_profile.profile_id);
        let profile = if root_profile.profile_id == id {
            root_profile.clone()
        } else {
            edit_profile(database, id, stored_profile, "root")?
        };
        advisor_profiles.insert(role, profile);
    }
    Ok(advisor_profiles)
}

/// The project's provider policy allows every edited agent, and a Bitbucket
/// repository supports the edited delivery target.
fn check_edit_policy(
    current: &repository::TaskEditSnapshot,
    profiles: &[&TaskProfile],
    delivery_target: &str,
) -> DatabaseResult<()> {
    let policy: Option<ProjectProviderPolicy> = current
        .configuration
        .get("providerPolicy")
        .filter(|value| !value.is_null())
        .cloned()
        .map(serde_json::from_value)
        .transpose()?;
    if profiles
        .iter()
        .any(|profile| !allowed_profile(policy.as_ref(), profile))
    {
        return Err(TaskError::new(
            "Select agents with providers and logins allowed by this project",
            422,
        )
        .into());
    }
    if current
        .configuration
        .pointer("/integration/repository/kind")
        .and_then(Value::as_str)
        == Some("bitbucket")
        && DeliveryTarget::parse(delivery_target).is_some_and(|target| !target.bitbucket_supports())
    {
        return Err(TaskError::new(
            "Bitbucket supports draft pull requests. Select a supported delivery target.",
            422,
        )
        .into());
    }
    Ok(())
}

/// The stored test and visual evidence choices an edit keeps when it omits them.
fn stored_choices(current: &repository::TaskEditSnapshot) -> DatabaseResult<(bool, &str)> {
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
    Ok((stored_tests, stored_visual))
}

/// The UI edit resolves a full settings snapshot against the stored task.
pub fn update_user_task_details(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    task_id: &str,
    input: &TaskDetailsBody,
    now: DateTime<Utc>,
) -> DatabaseResult<TaskRecord> {
    if !has_detail_edits(input) {
        // The HTTP schema accepts {}, but the TypeScript service refinement throws.
        return Err(TaskError::internal("Internal server error").into());
    }
    database.transaction(true, |database| {
        let scope = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &scope.company_id)?;
        let current =
            repository::edit_snapshot(database, task_id)?.ok_or_else(TaskError::not_found)?;
        let normalized = normalized_edit(input, &current)?;
        let workflow = normalized["workflow"].as_str().unwrap_or("standard");
        let root_id = input
            .root_profile_id
            .as_deref()
            .unwrap_or(&current.root_profile.profile_id);
        let worker_id = input
            .worker_profile_id
            .as_deref()
            .unwrap_or(&current.worker_profile.profile_id);
        let root_profile = edit_profile(database, root_id, Some(&current.root_profile), "root")?;
        let worker_profile =
            edit_profile(database, worker_id, Some(&current.worker_profile), "worker")?;
        let advisor_profiles =
            edited_advisor_profiles(database, input, &current, &normalized, &root_profile)?;
        let delivery_target = normalized
            .get("deliveryTarget")
            .and_then(Value::as_str)
            .unwrap_or(&current.delivery_target);
        let profiles = [&root_profile, &worker_profile]
            .into_iter()
            .chain(advisor_profiles.values())
            .collect::<Vec<_>>();
        check_edit_policy(&current, &profiles, delivery_target)?;
        let (stored_tests, stored_visual) = stored_choices(&current)?;
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
            run_project_tests: normalized
                .get("runProjectTests")
                .and_then(Value::as_bool)
                .unwrap_or(stored_tests),
            visual_evidence: input
                .visual_evidence
                .clone()
                .unwrap_or_else(|| stored_visual.to_owned()),
            root_profile,
            worker_profile,
            advisor_profiles,
        };
        if !repository::update_details(database, task_id, &details, now)? {
            return Err(TaskError::new(
                "Only tasks in the backlog can be edited. Open archived tasks before editing them.",
                409,
            )
            .into());
        }
        repository::task_by_id(database, task_id)?.ok_or_else(|| TaskError::not_found().into())
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
        let current =
            repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, actor_user_id, &current.company_id)?;
        if !repository::rename(database, task_id, &input.title, now)? {
            return Err(TaskError::new("Open archived tasks before renaming them.", 409).into());
        }
        repository::task_by_id(database, task_id)?.ok_or_else(|| TaskError::not_found().into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        http::contracts::typed::tasks, identity::auth, platform::database::OpenMode,
        tasks::response,
    };
    use std::error::Error;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    /// A migrated database with one signed-in user, company, and project.
    fn command_fixture() -> (std::path::PathBuf, SuplexDatabase, String, PreparedTask) {
        let filename =
            std::env::temp_dir().join(format!("suplex_task_command_{}.sqlite", Uuid::new_v4()));
        let now = Utc::now();
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('command_company', 'Command company', 'active', ?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('command_project', 'command_company', 'Command project', '/tmp/suplex-command-project', '/tmp/suplex-command-worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', ?1, ?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "command_company".into(),
            project_id: "command_project".into(),
            title: "Command task".into(),
            description: "".into(),
            configuration: json!({"repository":"owner/repo","branch":"task-command","baseBranch":"main","baselineSha":"head","runProjectTests":false,"visualEvidence":"off"}),
            idempotency_key: "command-key".into(),
            request_hash: "command-hash".into(),
            creator: TaskCreator::User(user.id.clone()),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-command","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(json!({"profileId":"profile_native_root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(json!({"profileId":"profile_native_worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(),
            issue: None,
            start_queued: false,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        };
        (filename, database, user.id, prepared)
    }

    fn another(prepared: &PreparedTask, key: &str) -> PreparedTask {
        PreparedTask {
            id: repository::new_task_id(),
            idempotency_key: key.into(),
            request_hash: format!("{key}-hash"),
            ..prepared.clone()
        }
    }

    fn failure(error: Box<dyn Error>) -> (u16, String) {
        let failure = crate::shared::PublicFailure::from(*error.downcast::<TaskError>().unwrap());
        (failure.status.as_u16(), failure.message)
    }

    #[test]
    fn concurrent_pull_request_admissions_persist_only_one_owner() {
        let (filename, database, _, mut prepared) = command_fixture();
        prepared.configuration["source"] = json!({"kind":"pull_request","number":7});
        prepared.delivery_intent.pull_request_number = Some(7);
        let second = another(&prepared, "owner-race-two");
        drop(database);
        let gate = Arc::new(std::sync::Barrier::new(2));
        let pending = [prepared, second]
            .into_iter()
            .map(|input| {
                let filename = filename.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    let mut database =
                        SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
                    gate.wait();
                    repository::create(&mut database, &input, Utc::now())
                        .map(|result| result.task.id)
                        .map_err(|error| TaskError::is_pull_request_owned(&*error))
                })
            })
            .collect::<Vec<_>>();
        let outcomes = pending
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|result| matches!(result, Err(true)))
                .count(),
            1
        );
        let database = SuplexDatabase::open(&filename, OpenMode::ReadOnly).unwrap();
        assert_eq!(
            database
                .connection()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM suplex_tasks", [], |row| row.get(0))
                .unwrap(),
            1
        );
        assert_eq!(
            database
                .connection()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM suplex_task_controls", [], |row| row
                    .get(0))
                .unwrap(),
            1
        );
        drop(database);
        std::fs::remove_file(filename).unwrap();
    }

    #[test]
    fn pull_request_owner_follows_repository_rename_aliases() {
        let (filename, mut database, user, mut prepared) = command_fixture();
        let now = rfc3339_millis(Utc::now());
        database.connection().execute(
            "INSERT INTO suplex_workflows (id, name, description, engine, configuration_json, created_at, updated_at) VALUES ('alias_workflow', 'Alias', '', 'standard', '{}', ?1, ?1)",
            [&now],
        ).unwrap();
        for (id, name) in [("old_alias", "old/repo"), ("new_alias", "new/repo")] {
            database.connection().execute(
                "INSERT INTO suplex_github_trigger_rules (id, company_id, project_id, name, label, workflow_id, delivery_target, protected_paths_json, repository_id, repository_name, authority_user_id, created_at, updated_at) VALUES (?1, 'command_company', 'command_project', ?2, 'ready', 'alias_workflow', 'pull_request_draft', '[]', 42, ?2, ?3, ?4, ?4)",
                params![id, name, user, now],
            ).unwrap();
        }
        prepared.configuration["repository"] = json!("old/repo");
        prepared.configuration["source"] = json!({"kind":"pull_request","number":7});
        prepared.delivery_intent.repository = "old/repo".into();
        prepared.delivery_intent.pull_request_number = Some(7);
        let owner = repository::create(&mut database, &prepared, Utc::now())
            .unwrap()
            .task;
        assert!(TaskError::is_pull_request_owned(
            &*repository::assert_pull_request_available(&database, "candidate", "new/repo", 7)
                .unwrap_err()
        ));
        repository::assert_pull_request_available(&database, "candidate", "other/repo", 7).unwrap();
        repository::assert_pull_request_available(&database, &owner.id, "new/repo", 7).unwrap();
        drop(database);
        std::fs::remove_file(filename).unwrap();
    }

    #[test]
    fn branch_source_starts_without_claiming_a_pull_request() {
        let (filename, mut database, user, mut prepared) = command_fixture();
        prepared.configuration["source"] = json!({"kind":"branch","branch":"feature"});
        let task = repository::create(&mut database, &prepared, Utc::now())
            .unwrap()
            .task;
        let started = start_user_task(&mut database, &user, &task.id, Utc::now(), |_| {}).unwrap();
        assert_eq!(started.status, TaskStatus::Active);
        let (source, number): (String, Option<i64>) = database.connection().query_row(
            "SELECT json_extract(t.configuration_json, '$.source.kind'), json_extract(c.delivery_intent_json, '$.pullRequestNumber') FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [&task.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(source, "branch");
        assert_eq!(number, None);
        drop(database);
        std::fs::remove_file(filename).unwrap();
    }

    #[test]
    fn disarm_returns_only_a_queued_task_to_the_backlog() {
        let (filename, mut database, user, prepared) = command_fixture();
        let now = Utc::now();
        let blocker = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task;
        let queued_input = PreparedTask {
            start_queued: true,
            depends_on: vec![blocker.id.clone()],
            pull_request_dependencies: vec![],
            ..another(&prepared, "command-queued")
        };
        let queued = repository::create(&mut database, &queued_input, now)
            .unwrap()
            .task;
        assert_eq!(queued.status, TaskStatus::Queued);
        assert!(disarm_user_task(&mut database, "missing-user", &queued.id, now).is_err());
        assert_eq!(
            disarm_user_task(&mut database, &user, &queued.id, now)
                .unwrap()
                .status,
            TaskStatus::Backlog
        );
        assert_eq!(
            disarm_user_task(&mut database, &user, &queued.id, now)
                .unwrap()
                .status,
            TaskStatus::Backlog
        );
        let audits: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'task_disarmed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audits, 2);
        start_user_task(&mut database, &user, &blocker.id, now, |_| {}).unwrap();
        assert_eq!(
            failure(disarm_user_task(&mut database, &user, &blocker.id, now).unwrap_err()),
            (409, "Only a task in the backlog can be disarmed".into())
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
    }

    #[test]
    fn continue_delivery_resumes_the_coordinator_toward_the_new_target() {
        let (filename, mut database, user, prepared) = command_fixture();
        let task = repository::create(&mut database, &prepared, Utc::now())
            .unwrap()
            .task;
        let target = |delivery_target: &str| TaskContinueDeliveryBody {
            delivery_target: DeliveryTarget::parse(delivery_target).unwrap(),
        };
        let wakes = Arc::new(AtomicUsize::new(0));
        let run = |database: &mut SuplexDatabase, delivery_target: &str| {
            let count = Arc::clone(&wakes);
            continue_user_delivery(
                database,
                &user,
                &task.id,
                &target(delivery_target),
                move |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                },
            )
        };
        let set = |database: &SuplexDatabase, status: &str, delivery_target: &str| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_controls SET status = ?1, delivery_target = ?2 WHERE task_id = ?3",
                    params![status, delivery_target, task.id],
                )
                .unwrap();
        };
        assert_eq!(
            failure(run(&mut database, "merged").unwrap_err()),
            (
                409,
                "Only delivered pull request tasks can continue delivery.".into()
            )
        );
        set(&database, "delivered", "pull_request_draft");
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.acceptedDelivery', json('{\"baseSha\":\"b\",\"headSha\":\"a\",\"files\":[],\"commits\":[]}')) WHERE task_id = ?1",
                [&task.id],
            )
            .unwrap();
        assert_eq!(
            run(&mut database, "merged").unwrap().status,
            TaskStatus::Active
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        let rows = root_session_store::root_observation_rows(&database, &task.id).unwrap();
        assert_eq!(
            rows.control.delivery_target,
            crate::tasks::control::DeliveryTarget::Merged
        );
        assert_eq!(
            serde_json::json!(rows.control.workflow_state)["followUp"],
            true
        );
        assert!(serde_json::json!(rows.control.workflow_state)["acceptedDelivery"].is_null());
        assert_eq!(
            serde_json::json!(rows.control.workflow_state)["deliveryHistory"][0]["acceptedDelivery"]
                ["headSha"],
            "a"
        );
        assert_eq!(
            rows.turns.len(),
            2,
            "the initial Coordinator prompt and one continuation"
        );
        assert!(rows.turns.iter().any(|turn| {
            turn.prompt_text
                .contains("from pull_request_draft to merged")
        }));
        assert!(rows.root.is_some());
        assert_eq!(
            run(&mut database, "merged").unwrap().status,
            TaskStatus::Active
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        assert_eq!(
            failure(run(&mut database, "pull_request_ready").unwrap_err()),
            (409, "The delivery target cannot move backward.".into())
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.integration', json('{\"repository\":{\"kind\":\"bitbucket\"}}')) WHERE id = ?1",
                [&task.id],
            )
            .unwrap();
        assert_eq!(failure(run(&mut database, "merged").unwrap_err()).0, 422);
        database
            .connection()
            .execute(
                "UPDATE suplex_tasks SET archived_at = created_at WHERE id = ?1",
                [&task.id],
            )
            .unwrap();
        assert_eq!(
            failure(run(&mut database, "merged").unwrap_err()),
            (
                409,
                "Open the archived task before you continue delivery.".into()
            )
        );
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        drop(database);
        let _ = std::fs::remove_file(&filename);
    }

    #[test]
    fn issue_link_stores_the_tracker_issue_and_clears_unstarted_context() {
        let (filename, mut database, user, prepared) = command_fixture();
        let now = Utc::now();
        let issue = json!({"kind":"github","repository":"owner/repo","number":12,"id":"123","key":"GH-12","title":"Issue","url":"https://github.com/owner/repo/issues/12"});
        let linked = PreparedTask {
            issue: Some(issue.clone()),
            ..prepared.clone()
        };
        let task = repository::create(&mut database, &linked, now)
            .unwrap()
            .task;
        database
            .connection()
            .execute(
                "UPDATE suplex_tasks SET issue_context_json = '{}' WHERE id = ?1",
                [&task.id],
            )
            .unwrap();
        let mut resolved = issue.clone();
        resolved["title"] = json!("Current title");
        set_user_task_issue(&mut database, &user, &task.id, Some(&resolved), now).unwrap();
        let stored: String = database
            .connection()
            .query_row(
                "SELECT issue_json FROM suplex_tasks WHERE id = ?1",
                [&task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&stored).unwrap()["title"],
            "Current title"
        );
        assert!(set_user_task_issue(&mut database, "missing-user", &task.id, None, now).is_err());
        set_user_task_issue(&mut database, &user, &task.id, None, now).unwrap();
        let (issue_json, context): (Option<String>, Option<String>) = database
            .connection()
            .query_row(
                "SELECT issue_json, issue_context_json FROM suplex_tasks WHERE id = ?1",
                [&task.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((issue_json, context), (None, None));
        drop(database);
        let _ = std::fs::remove_file(&filename);
    }

    #[test]
    fn dependency_replacement_rejects_cycles_and_admits_a_released_queued_task() {
        let (filename, mut database, user, prepared) = command_fixture();
        let now = Utc::now();
        let first = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task;
        let second_input = PreparedTask {
            start_queued: true,
            depends_on: vec![first.id.clone()],
            pull_request_dependencies: vec![],
            ..another(&prepared, "command-second")
        };
        let second = repository::create(&mut database, &second_input, now)
            .unwrap()
            .task;
        assert_eq!(second.status, TaskStatus::Queued);
        let body = |depends_on: Vec<String>, pull_requests: Value| {
            tasks::parse_task_dependencies(Some(
                &json!({"dependsOn": depends_on, "blockedByPullRequests": pull_requests}),
            ))
            .unwrap()
        };
        assert_eq!(
            failure(
                set_user_task_dependencies(
                    &mut database,
                    &user,
                    &first.id,
                    &body(vec![second.id.clone()], json!([])),
                    &[],
                    now
                )
                .unwrap_err()
            ),
            (422, "The dependency creates a cycle".into())
        );
        assert_eq!(
            failure(
                set_user_task_dependencies(
                    &mut database,
                    &user,
                    &first.id,
                    &body(vec![first.id.clone()], json!([])),
                    &[],
                    now
                )
                .unwrap_err()
            ),
            (422, "A task cannot depend on itself".into())
        );
        // An observed open pull request keeps the queued task waiting until GitHub reports its merge.
        let open = json!({"number": 7, "state": "open", "title": "Blocker", "url": "https://github.com/owner/repo/pull/7", "observedAt": "2026-09-25T00:00:00.000Z"});
        let blocked = set_user_task_dependencies(
            &mut database,
            &user,
            &second.id,
            &body(vec![], json!([{"number": 7}])),
            std::slice::from_ref(&open),
            now,
        )
        .unwrap();
        assert_eq!(blocked.status, TaskStatus::Queued);
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT title FROM suplex_task_pull_request_dependencies WHERE task_id = ?1 AND pull_request_number = 7",
                    [&second.id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Blocker"
        );
        assert_eq!(
            pull_request_rejection(pull_request_dependencies::Rejection::NotFound(7)).to_string(),
            "Pull request #7 was not found"
        );
        assert!(
            set_user_task_dependencies(
                &mut database,
                &user,
                &second.id,
                &body(vec!["missing".into()], json!([])),
                &[],
                now
            )
            .is_err()
        );
        let released = set_user_task_dependencies(
            &mut database,
            &user,
            &second.id,
            &body(vec![], json!([])),
            &[],
            now,
        )
        .unwrap();
        assert_eq!(released.status, TaskStatus::Active);
        let (edges, audits): (i64, i64) = database
            .connection()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM suplex_task_dependencies WHERE task_id = ?1), (SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'task_dependencies_updated')",
                [&second.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (edges, audits),
            (0, 2),
            "the pull request and the release replacement each audit"
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
    }

    #[test]
    fn pull_request_prerequisite_states_control_initial_admission_and_wait_reason() {
        let (filename, mut database, _, prepared) = command_fixture();
        let observed = |number: i64, state: &str| json!({"number":number,"state":state,"title":format!("Pull {number}"),"url":format!("https://github.com/owner/repo/pull/{number}"),"observedAt":"2026-09-26T00:00:00.000Z"});
        for (key, number, state, expected_status, reason) in [
            ("merged", 41, "merged", TaskStatus::Active, None),
            (
                "open",
                42,
                "open",
                TaskStatus::Queued,
                Some("prerequisite_pull_request_open"),
            ),
            (
                "closed",
                43,
                "closed",
                TaskStatus::Queued,
                Some("prerequisite_pull_request_closed"),
            ),
        ] {
            let input = PreparedTask {
                start_queued: true,
                pull_request_dependencies: vec![observed(number, state)],
                ..another(&prepared, key)
            };
            let task = repository::create(&mut database, &input, Utc::now())
                .unwrap()
                .task;
            assert_eq!(task.status, expected_status);
            let response = serde_json::to_value(
                repository::task_response(&database, &task.id)
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(response["blockedBy"][0]["state"], state);
            if let Some(reason) = reason {
                assert_eq!(response["queue"]["waitingOn"][0]["reason"], reason);
            } else {
                assert_eq!(response["queue"]["waitingOn"], json!([]));
            }
        }
        assert_eq!(
            pull_request_rejection(pull_request_dependencies::Rejection::Unobservable(45))
                .to_string(),
            "Suplex cannot observe pull request #45. Try again when GitHub is available."
        );
        drop(database);
        std::fs::remove_file(filename).unwrap();
    }

    #[test]
    fn agent_selection_starts_a_coordinator_and_records_a_worker_profile() {
        let (filename, mut database, user, prepared) = command_fixture();
        let now = Utc::now();
        for (id, role) in [("alternate-root", "root"), ("alternate-worker", "worker")] {
            database.connection().execute(
                "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES (?1,?1,?2,?1,'codex','test','medium','default',?3,?3)",
                params![id, role, rfc3339_millis(now)],
            ).unwrap();
        }
        let active = PreparedTask {
            start_queued: true,
            ..prepared.clone()
        };
        let task = repository::create(&mut database, &active, now)
            .unwrap()
            .task;
        assert_eq!(task.status, TaskStatus::Active);
        let wakes = Arc::new(AtomicUsize::new(0));
        let select = |database: &mut SuplexDatabase, body: Value| {
            let request = tasks::parse_task_agent_selection(Some(&body)).unwrap();
            let count = Arc::clone(&wakes);
            select_user_task_agent(database, &user, &task.id, &request, now, move |_| {
                count.fetch_add(1, Ordering::SeqCst);
            })
        };
        let root = json!({"role":"root","expectedProfileId":"profile_native_root","expectedSessionId":null,"profileId":"alternate-root","direction":" Build it ","resume":false});
        select(&mut database, root.clone()).unwrap();
        select(&mut database, root.clone()).unwrap();
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        let rows = root_session_store::root_observation_rows(&database, &task.id).unwrap();
        let root_session = rows.root.unwrap();
        assert_eq!(root_session.profile.unwrap().profile_id, "alternate-root");
        assert_eq!(
            serde_json::json!(rows.control)["rootProfile"]["profileId"],
            "alternate-root"
        );
        let prompts = rows
            .turns
            .iter()
            .map(|turn| turn.prompt_text.clone())
            .collect::<Vec<_>>();
        assert_eq!(prompts.len(), 2);
        assert!(prompts[0].ends_with("\n\nAdditional direction from the user:\nBuild it"));
        assert_eq!(
            prompts[1],
            "Human note:\nAdditional direction from the user:\nBuild it"
        );
        assert_eq!(
            failure(select(&mut database, json!({"role":"root","expectedProfileId":"profile_native_root","expectedSessionId":null,"profileId":"alternate-root","direction":"","resume":false})).unwrap_err()),
            (409, "The Coordinator changed. Read the current Coordinator before selecting another.".into())
        );
        let worker = json!({"role":"worker","expectedProfileId":"profile_native_worker","expectedSessionId":null,"profileId":"alternate-worker","direction":"","resume":false});
        select(&mut database, worker.clone()).unwrap();
        let rows = root_session_store::root_observation_rows(&database, &task.id).unwrap();
        assert_eq!(
            serde_json::json!(rows.control)["workerProfile"]["profileId"],
            "alternate-worker"
        );
        assert!(rows.turns.iter().any(|turn| turn.prompt_text
            == "Human note:\nThe user selected Worker profile alternate-worker.\n\nUse this selection for future assignments. Do not repeat completed work."));
        for pane in [Some("obsolete-pane"), None, Some("recreated-pane")] {
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_sessions SET pane_id = ?1 WHERE task_id = ?2",
                    params![pane, task.id],
                )
                .unwrap();
            select(&mut database, worker.clone()).unwrap();
        }
        assert_eq!(
            root_session_store::root_observation_rows(&database, &task.id)
                .unwrap()
                .turns
                .len(),
            3
        );
        assert_eq!(
            failure(select(&mut database, json!({"role":"worker","expectedProfileId":"profile_native_worker","expectedSessionId":null,"profileId":"profile_native_worker","direction":"","resume":false})).unwrap_err()),
            (409, "The agent changed. Read the current agent before selecting another.".into())
        );
        assert_eq!(
            failure(select(&mut database, json!({"role":"reviewer","expectedProfileId":"x","expectedSessionId":null,"profileId":"x","direction":"","resume":false})).unwrap_err()),
            (409, "The selected role is not in this workflow.".into())
        );
        // An unfinished Worker assignment moves to a fresh session with the new profile.
        database.connection().execute(
            "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('third-worker','third-worker','worker','third-worker','codex','test','medium','default',?1,?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,delegate_slot,created_at,updated_at) VALUES ('worker-one',?1,'worker',1,1,'live','delegate',?2,?2)",
            params![task.id, rfc3339_millis(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES ('worker-turn',?1,'worker-one',1,'hash','Build the feature','prompted',?2,?2)",
            params![task.id, rfc3339_millis(now)],
        ).unwrap();
        select(&mut database, json!({"role":"worker","expectedProfileId":"alternate-worker","expectedSessionId":"worker-one","profileId":"third-worker","direction":"Use tests","resume":false})).unwrap();
        let (replacement, prompt, old_lifecycle): (String, String, String) = database.connection().query_row(
            "SELECT s.id, t.prompt_text, (SELECT lifecycle FROM suplex_task_sessions WHERE id = 'worker-one') FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id WHERE s.replaces_session_id = 'worker-one'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(old_lifecycle, "cancelled");
        assert_eq!(
            prompt,
            "Build the feature\n\nFresh Worker handoff:\nAdditional direction from the user:\nUse tests\n\nContinue the preserved assignment. Inspect current work and evidence before changing it."
        );
        let rows = root_session_store::root_observation_rows(&database, &task.id).unwrap();
        assert_eq!(
            serde_json::json!(rows.control)["workerSessionId"],
            replacement.as_str()
        );
        assert!(rows.turns.iter().any(|turn| turn.prompt_text
            == format!("Human note:\nThe user selected Worker profile third-worker.\n\nAdditional direction from the user:\nUse tests\n\nContinue with replacement session {replacement} and the preserved assignment.").as_str()));
        // A workflow Advisor defaults to the Coordinator profile and records its own selection.
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET workflow = 'independent_review' WHERE task_id = ?1",
                [&task.id],
            )
            .unwrap();
        select(&mut database, json!({"role":"reviewer","expectedProfileId":"alternate-root","expectedSessionId":null,"profileId":"alternate-root","direction":"","resume":false})).unwrap();
        let rows = root_session_store::root_observation_rows(&database, &task.id).unwrap();
        assert_eq!(
            serde_json::json!(rows.control)["advisorProfiles"]["reviewer"]["profileId"],
            "alternate-root"
        );
        assert!(rows.turns.iter().any(|turn| turn.prompt_text
            == "Human note:\nThe user selected Reviewer profile alternate-root.\n\nUse this selection for future assignments. Do not repeat completed work."));
        assert_eq!(
            failure(select(&mut database, json!({"role":"rater","expectedProfileId":"x","expectedSessionId":null,"profileId":"x","direction":"","resume":false})).unwrap_err()),
            (409, "The selected role is not in this workflow.".into())
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
    }

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
    fn task_branch_names_preserve_frozen_typescript_title_rules() {
        let id = "task_e37a6f28b1dd43d1ac46fc97357d3d7f";
        for (title, expected) in [
            ("Fix search", "fix/search-7d3d7f"),
            ("Bump dependencies", "chore/dependencies-7d3d7f"),
            ("Better branch names", "feature/better-branch-names-7d3d7f"),
            (
                "Show error toast on failed save",
                "feature/show-error-toast-failed-7d3d7f",
            ),
            (
                "Use the new task branch name for every worktree",
                "feature/new-task-branch-name-7d3d7f",
            ),
            ("--- !!! ---", "feature/task-7d3d7f"),
        ] {
            assert_eq!(task_branch_name(title, id), expected);
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
            [rfc3339_millis(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('command_project', 'command_company', 'Command project', '/tmp/suplex-command-project', '/tmp/suplex-command-worktrees', 'owner/repo', 'main', '', '', 'profile_native_root', 'profile_native_worker', ?1, ?2, ?2)",
            params![json!({"workflowIds":["standard"],"defaultWorkflowId":"standard","rootProfileIds":["profile_native_root"],"workerProfileIds":["profile_native_worker"]}).to_string(), rfc3339_millis(now)],
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
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-command","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(json!({"profileId":"profile_native_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(json!({"profileId":"profile_native_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(json!({})).unwrap(),
            issue: None,
            start_queued: false,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
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
        assert_eq!(created.task.status, TaskStatus::Backlog);
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
        assert_eq!(started.status, TaskStatus::Active);
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
        // The audit row follows the committed answer; its failure cannot undo the answer.
        database
            .connection()
            .execute_batch("CREATE TEMP TRIGGER reject_audit BEFORE INSERT ON suplex_audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;")
            .unwrap();
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
        assert_eq!(wakes.load(Ordering::SeqCst), 3);
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_audit")
            .unwrap();
        let (status, open_question): (String, bool) = database
            .connection()
            .query_row(
                "SELECT status, human_question_id IS NOT NULL FROM suplex_task_controls WHERE task_id = ?1",
                [&created.task.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), open_question), ("active", false));
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
        ).unwrap().status, TaskStatus::Active);
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
            TaskStatus::Cancelled
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
