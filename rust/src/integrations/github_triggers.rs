//! GitHub trigger rules: configuration, preview, dispatch, and the poller
//! (`src/integrations/github/triggers.ts`, `trigger-repository.ts`,
//! `trigger-poller.ts`, and the trigger admission paths of `tasks/tasks.ts`).

use crate::identity::IdentityError;
use crate::platform::PlatformError;
use crate::projects::ProjectError;
use crate::shared::ids::random_hex_id;
use crate::tasks::TaskError;
use std::{
    error::Error,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use crate::shared::time::{now_millis_rfc3339, rfc3339_millis};
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::{
    github_delivery::{Github, GithubFailure},
    github_triggers_dispatches::{
        self as dispatches, Dispatch, DispatchPolicy, DispatchPrepare, DispatchProfiles, Preset,
        TaskBinding,
    },
    github_triggers_inspection::{
        PullRequestInspection, inspect_pull_request, list_open_pull_requests_by_label,
        observe_repository, validate_label, validate_protected_paths,
    },
};
use crate::http::contracts::typed::projects::RepositoryConnection;
use crate::{
    coordination::{advisor_bridge::AdvisorRole, workflow_records, workflows::workflow_definition},
    http::{
        AppState,
        contracts::typed::github_triggers::{GithubTriggerCreate, GithubTriggerPatch},
    },
    identity::companies,
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    projects::{
        git,
        service::{self as projects, Project},
    },
    tasks::{commands, control::TaskProfile, repository::assert_pull_request_available, sources},
};

pub type Failure = Box<dyn Error + Send + Sync>;

/// A public trigger rejection (`AuthFailure` and `PreviewFailure` in TypeScript).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TriggerFailure {
    pub message: String,
    pub status: u16,
    pub retry_at: Option<String>,
}

impl From<TriggerFailure> for crate::shared::PublicFailure {
    fn from(failure: TriggerFailure) -> Self {
        Self::new(failure.status, failure.message)
    }
}

fn public(message: impl Into<String>, status: u16) -> Failure {
    Box::new(TriggerFailure {
        message: message.into(),
        status,
        retry_at: None,
    })
}

fn task_failure(message: &str, status: u16) -> Failure {
    TaskError::new(message, status).into()
}

const CHANGED: &str = "This GitHub rule changed. Refresh and try again.";
const UNAVAILABLE: &str = "GitHub could not complete this check.";

/// Keep the failure class of a database error while making it `Send`.
pub fn send(error: Box<dyn Error>) -> Failure {
    macro_rules! keep {
        ($error:ident, $($kind:ty),*) => {$(
            let $error = match $error.downcast::<$kind>() {
                Ok(value) => return value,
                Err(error) => error,
            };
        )*};
    }
    let error: Box<dyn Error> = match error.downcast::<TaskError>() {
        Ok(task) if matches!(*task, TaskError::Failure { .. } | TaskError::Source { .. }) => {
            return task;
        }
        Ok(task) if matches!(*task, TaskError::PullRequestOwned) => {
            return public("A task already uses this pull request.", 409);
        }
        Ok(task) => task,
        Err(error) => error,
    };
    keep!(
        error,
        TriggerFailure,
        IdentityError,
        ProjectError,
        GithubFailure,
        PlatformError
    );
    error.to_string().into()
}

/// Database access for the HTTP state and the host poller.
pub trait Db: Sync {
    fn run<T>(&self, operation: impl FnOnce(&mut SuplexDatabase) -> T) -> T;
}

impl Db for AppState {
    fn run<T>(&self, operation: impl FnOnce(&mut SuplexDatabase) -> T) -> T {
        self.with_database(operation)
    }
}

impl Db for Mutex<SuplexDatabase> {
    fn run<T>(&self, operation: impl FnOnce(&mut SuplexDatabase) -> T) -> T {
        operation(&mut self.lock().expect("trigger database lock"))
    }
}

fn db<D: Db, T>(
    database: &D,
    operation: impl FnOnce(&mut SuplexDatabase) -> DatabaseResult<T>,
) -> Result<T, Failure> {
    database.run(operation).map_err(send)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub company_id: String,
    pub project_id: String,
    pub name: String,
    pub label: String,
    pub workflow_id: String,
    pub delivery_target: String,
    pub protected_paths: Vec<String>,
    pub repository_id: i64,
    pub repository_name: String,
    pub authority_user_id: String,
    pub enabled: bool,
    pub archived_at: Option<String>,
    pub revision: i64,
    pub last_successful_check_at: Option<String>,
    pub next_retry_at: Option<String>,
    pub latest_error: Option<String>,
    pub failure_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub at: String,
    pub pull_request_number: Option<i64>,
    pub url: Option<String>,
    pub outcome: String,
    pub reason: String,
    pub matching_paths: Vec<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub task_status: Option<String>,
    #[serde(default)]
    pub previously_processed: bool,
}

impl Activity {
    fn new(number: i64, url: Option<&str>, outcome: &str, reason: &str) -> Self {
        Self {
            at: now_millis_rfc3339(),
            pull_request_number: Some(number),
            url: url.map(str::to_owned),
            outcome: outcome.into(),
            reason: reason.into(),
            matching_paths: Vec::new(),
            task_id: None,
            task_status: None,
            previously_processed: false,
        }
    }
}

fn rule(row: &Row<'_>) -> rusqlite::Result<Rule> {
    let paths: String = row.get("protected_paths_json")?;
    Ok(Rule {
        id: row.get("id")?,
        company_id: row.get("company_id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        label: row.get("label")?,
        workflow_id: row.get("workflow_id")?,
        delivery_target: row.get("delivery_target")?,
        protected_paths: serde_json::from_str(&paths).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        repository_id: row.get("repository_id")?,
        repository_name: row.get("repository_name")?,
        authority_user_id: row.get("authority_user_id")?,
        enabled: row.get::<_, i64>("enabled")? == 1,
        archived_at: row.get("archived_at")?,
        revision: row.get("revision")?,
        last_successful_check_at: row.get("last_successful_check_at")?,
        next_retry_at: row.get("next_retry_at")?,
        latest_error: row.get("latest_error")?,
        failure_count: row.get("failure_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list_rules(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<Vec<Rule>> {
    let mut statement = database.connection().prepare("SELECT * FROM suplex_github_trigger_rules WHERE company_id = ?1 ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, id")?;
    Ok(statement
        .query_map([company_id], rule)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn get_rule(
    database: &SuplexDatabase,
    company_id: &str,
    id: &str,
) -> DatabaseResult<Option<Rule>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT * FROM suplex_github_trigger_rules WHERE company_id = ?1 AND id = ?2",
            params![company_id, id],
            rule,
        )
        .optional()?)
}

fn required_rule(database: &SuplexDatabase, company_id: &str, id: &str) -> DatabaseResult<Rule> {
    get_rule(database, company_id, id)?.ok_or_else(|| {
        Box::new(TriggerFailure {
            message: "Not found".into(),
            status: 404,
            retry_at: None,
        }) as _
    })
}

fn enabled_due(database: &SuplexDatabase) -> DatabaseResult<Vec<Rule>> {
    let mut statement = database.connection().prepare("SELECT r.* FROM suplex_github_trigger_rules r JOIN suplex_companies c ON c.id = r.company_id WHERE r.enabled = 1 AND r.archived_at IS NULL AND c.status = 'active' AND (r.next_retry_at IS NULL OR r.next_retry_at <= ?1) ORDER BY r.created_at, r.id")?;
    Ok(statement
        .query_map([now_millis_rfc3339()], rule)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn stored_activity(
    database: &SuplexDatabase,
    company_id: &str,
    id: &str,
) -> DatabaseResult<Vec<Activity>> {
    let raw: Option<String> = database
        .connection()
        .query_row(
            "SELECT recent_activity_json FROM suplex_github_trigger_rules WHERE company_id = ?1 AND id = ?2",
            params![company_id, id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => Vec::new(),
    })
}

fn owns_pull_request(
    database: &SuplexDatabase,
    repository: &str,
    number: i64,
) -> DatabaseResult<bool> {
    match assert_pull_request_available(database, "", repository, number) {
        Ok(()) => Ok(false),
        Err(error) if TaskError::is_pull_request_owned(&*error) => Ok(true),
        Err(error) => Err(error),
    }
}

fn audit(
    database: &SuplexDatabase,
    user_id: &str,
    action: &str,
    rule: &Rule,
) -> DatabaseResult<()> {
    crate::identity::audit::record(
        database,
        &crate::identity::audit::AuditEvent {
            id: &random_hex_id("audit")?,
            actor_user_id: Some(user_id),
            actor_agent_id: None,
            action,
            target_user_id: None,
            company_id: Some(&rule.company_id),
            metadata_json: &json!({"ruleId": rule.id}).to_string(),
            created_at: &now_millis_rfc3339(),
        },
    )?;
    Ok(())
}

fn update_rule(
    database: &SuplexDatabase,
    next: &Rule,
    expected_revision: i64,
) -> DatabaseResult<bool> {
    Ok(database.connection().execute(
        "UPDATE suplex_github_trigger_rules SET project_id=?1, name=?2, label=?3, workflow_id=?4, delivery_target=?5, protected_paths_json=?6, repository_id=?7, repository_name=?8, authority_user_id=?9, enabled=?10, archived_at=?11, revision=?12, last_successful_check_at=?13, next_retry_at=?14, latest_error=?15, failure_count=?16, updated_at=?17 WHERE id=?18 AND company_id=?19 AND revision=?20",
        params![next.project_id, next.name, next.label, next.workflow_id, next.delivery_target, serde_json::to_string(&next.protected_paths)?, next.repository_id, next.repository_name, next.authority_user_id, i64::from(next.enabled), next.archived_at, next.revision, next.last_successful_check_at, next.next_retry_at, next.latest_error, next.failure_count, next.updated_at, next.id, next.company_id, expected_revision],
    )? == 1)
}

/// `GithubTriggerRepository.record`: append activity and the check outcome.
/// A check without an error succeeded.
fn record(
    database: &mut SuplexDatabase,
    rule: &Rule,
    activity: &[Activity],
    error: Option<&str>,
    next_retry_at: Option<&str>,
    disable: bool,
    verify: impl FnOnce(&SuplexDatabase) -> DatabaseResult<()>,
) -> DatabaseResult<bool> {
    let success = error.is_none();
    database.transaction(true, |database| {
        verify(database)?;
        let mut all = stored_activity(database, &rule.company_id, &rule.id)?;
        all.extend_from_slice(activity);
        let recent = &all[all.len().saturating_sub(100)..];
        let now = now_millis_rfc3339();
        Ok(database.connection().execute(
            "UPDATE suplex_github_trigger_rules SET recent_activity_json=?1, enabled=?2, last_successful_check_at=?3, latest_error=?4, next_retry_at=?5, failure_count=?6, updated_at=?7 WHERE id=?8 AND company_id=?9 AND revision=?10",
            params![serde_json::to_string(recent)?, i64::from(!disable && rule.enabled), if success { Some(now.clone()) } else { rule.last_successful_check_at.clone() }, error, next_retry_at, if success { 0 } else { rule.failure_count + 1 }, now, rule.id, rule.company_id, rule.revision],
        )? == 1)
    })
}

fn admin(database: &SuplexDatabase, user_id: &str, company_id: &str) -> DatabaseResult<()> {
    companies::require_company_access(database, user_id, company_id)?;
    if active_role(database, user_id)?.as_deref() != Some("admin") {
        return Err(Box::new(TriggerFailure {
            message: "Administrator access required".into(),
            status: 403,
            retry_at: None,
        }));
    }
    Ok(())
}

fn active_role(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<Option<String>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
            [user_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// The trigger's configurable fields.
#[derive(Clone, Debug)]
pub struct Config {
    pub project_id: String,
    pub name: String,
    pub label: String,
    pub workflow_id: String,
    pub delivery_target: String,
    pub protected_paths: Vec<String>,
    pub authority_user_id: String,
}

impl From<&Rule> for Config {
    fn from(rule: &Rule) -> Self {
        Self {
            project_id: rule.project_id.clone(),
            name: rule.name.clone(),
            label: rule.label.clone(),
            workflow_id: rule.workflow_id.clone(),
            delivery_target: rule.delivery_target.clone(),
            protected_paths: rule.protected_paths.clone(),
            authority_user_id: rule.authority_user_id.clone(),
        }
    }
}

/// Local facts a dispatch depends on; they must not change before a write.
#[derive(Clone, Debug, PartialEq)]
struct Dependencies {
    repository: String,
    repository_path: String,
    worktree_root: String,
    base_branch: String,
    setup_command: String,
    verification_command: String,
    engine: String,
    run_project_tests: bool,
    visual_evidence: String,
    profiles: DispatchProfiles,
}

/// The local dependencies of a dispatch and the workflow preset it captures.
#[derive(Clone, Debug)]
pub struct Local {
    dependencies: Dependencies,
    preset: Value,
}

/// TypeScript `normalizeWorkflowInput` applied to a stored workflow preset.
fn normalized_run_project_tests(
    preset: &Preset,
    delivery_target: &str,
) -> Result<Option<bool>, String> {
    let engine = preset.engine.as_str();
    let definition = workflow_definition(engine).ok_or("The selected workflow does not exist")?;
    let extra = ["reviewer", "planner_a", "planner_b", "rater"]
        .iter()
        .filter(|role| {
            preset.advisor_profile_ids.contains_key(**role)
                && !definition.advisor_roles.contains(role)
        })
        .map(|role| crate::coordination::workflows::advisor_label(role))
        .collect::<Vec<_>>();
    if !extra.is_empty() {
        return Err(format!(
            "The {} workflow has no {} Advisor",
            definition.name,
            extra.join(", ")
        ));
    }
    let run = preset.run_project_tests;
    if engine != "refine_pull_request" {
        return Ok(run);
    }
    if delivery_target != "merged" {
        return Err("Pull request repair always delivers a merged pull request".into());
    }
    if run.is_some_and(|run| !run) {
        return Err("Pull request repair always runs the project tests".into());
    }
    Ok(Some(true))
}

fn local_failure(message: impl Into<String>, status: u16) -> Box<dyn Error> {
    Box::new(TriggerFailure {
        message: message.into(),
        status,
        retry_at: None,
    })
}

/// The task profile snapshot of one live profile, or the unavailable-profile refusal.
fn profile_snapshot(
    database: &SuplexDatabase,
    id: &str,
    role: &str,
) -> DatabaseResult<TaskProfile> {
    database
        .connection()
        .query_row(
            "SELECT id, provider, model, reasoning_level, service_tier FROM suplex_profiles WHERE id = ?1 AND role = ?2 AND archived_at IS NULL",
            params![id, role],
            |row| {
                Ok(TaskProfile {
                    profile_id: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    reasoning_level: row.get(3)?,
                    service_tier: row.get(4)?,
                    provider_instance_id: None,
                    instance_home_directory: None,
                })
            },
        )
        .optional()?
        .ok_or_else(|| local_failure("Selected workflow profile is unavailable", 422))
}

/// The authority's workflow preset with this id, as stored and as read.
fn workflow_preset(
    database: &SuplexDatabase,
    authority: &str,
    workflow_id: &str,
) -> DatabaseResult<(Value, Preset)> {
    for record in workflow_records::list(database, authority, true)? {
        let value = serde_json::to_value(record)?;
        let preset = Preset::of(&value)?;
        if preset.id == workflow_id {
            return Ok((value, preset));
        }
    }
    Err(local_failure("Not found", 404))
}

fn local(
    database: &SuplexDatabase,
    actor: &str,
    company_id: &str,
    config: &Config,
) -> DatabaseResult<Local> {
    admin(database, actor, company_id)?;
    if active_role(database, &config.authority_user_id)?.as_deref() != Some("admin") {
        return Err(local_failure("GitHub authority is unavailable", 422));
    }
    let company =
        companies::require_company_access(database, &config.authority_user_id, company_id)?;
    if company.status != "active" {
        return Err(local_failure("Company is not active", 409));
    }
    let project = projects::get(database, &config.authority_user_id, &config.project_id)?;
    if project.company_id != company_id {
        return Err(ProjectError::new("Not found", 404, vec![]).into());
    }
    let repository = project
        .repository
        .clone()
        .ok_or_else(|| local_failure("Project repository is not configured", 422))?;
    let (preset, view) = workflow_preset(database, &config.authority_user_id, &config.workflow_id)?;
    if view.archived_at.is_some() {
        return Err(local_failure("Selected workflow is archived", 422));
    }
    let run = normalized_run_project_tests(&view, &config.delivery_target)
        .map_err(|message| local_failure(message, 422))?;
    let root_default = view
        .root_profile_id
        .as_deref()
        .unwrap_or(&project.root_profile_id);
    let root = profile_snapshot(database, root_default, "root")?;
    let worker = profile_snapshot(
        database,
        view.worker_profile_id
            .as_deref()
            .unwrap_or(&project.worker_profile_id),
        "worker",
    )?;
    let mut advisors = std::collections::BTreeMap::new();
    for role in
        workflow_definition(&view.engine).map_or(&[][..], |definition| definition.advisor_roles)
    {
        let id = view
            .advisor_profile_ids
            .get(*role)
            .map_or(root_default, String::as_str);
        let profile = profile_snapshot(database, id, "root")?;
        if let Some(role) = AdvisorRole::parse(role) {
            advisors.insert(role, profile);
        }
    }
    validate_protected_paths(&config.protected_paths)
        .map_err(|_| local_failure("Protected paths are invalid", 422))?;
    Ok(Local {
        dependencies: Dependencies {
            repository,
            repository_path: project.repository_path,
            worktree_root: project.worktree_root,
            base_branch: project.base_branch,
            setup_command: project.setup_command,
            verification_command: project.verification_command,
            engine: view.engine,
            run_project_tests: run.unwrap_or(true),
            visual_evidence: view.visual_evidence.unwrap_or_else(|| "off".into()),
            profiles: DispatchProfiles {
                root,
                worker,
                advisors,
            },
        },
        preset,
    })
}

fn same_local(
    database: &SuplexDatabase,
    actor: &str,
    company_id: &str,
    config: &Config,
    expected: &Local,
) -> DatabaseResult<()> {
    if local(database, actor, company_id, config)?.dependencies != expected.dependencies {
        return Err(local_failure(CHANGED, 409));
    }
    Ok(())
}

async fn provider(
    github: &Github,
    repository: &str,
    label: &str,
) -> Result<(i64, String), Failure> {
    let binding = observe_repository(github, repository).await?;
    validate_label(github, &binding.full_name, label).await?;
    Ok((binding.id, binding.full_name))
}

/// TypeScript `message`: the public activity text and any provider retry time.
fn message(error: &(dyn Error + 'static)) -> (String, Option<String>) {
    if let Some(failure) = error.downcast_ref::<TriggerFailure>() {
        return (failure.message.clone(), failure.retry_at.clone());
    }
    if let Some(failure) = error.downcast_ref::<GithubFailure>() {
        let text = match failure.code {
            "authentication-required" => "GitHub could not authenticate this request.",
            "provider-rate-limited" => "GitHub checks are delayed.",
            _ => UNAVAILABLE,
        };
        return (text.into(), failure.retry_at.clone());
    }
    if let Some(IdentityError::Auth { message, .. }) = error.downcast_ref() {
        return ((*message).into(), None);
    }
    (UNAVAILABLE.into(), None)
}

fn millis(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value).map_or(i64::MIN, |time| time.timestamp_millis())
}

fn later(current: Option<String>, candidate: Option<String>) -> Option<String> {
    match (current, candidate) {
        (Some(current), Some(candidate)) if millis(&candidate) > millis(&current) => {
            Some(candidate)
        }
        (None, candidate) => candidate,
        (current, _) => current,
    }
}

fn retry_after(failure_count: i64, provider: Option<&str>) -> String {
    let delay = (60_000_i64 * 2_i64.pow(failure_count.clamp(0, 4) as u32)).min(15 * 60_000);
    let now = Utc::now().timestamp_millis();
    match provider {
        Some(value) if millis(value) > now + delay => value.to_owned(),
        _ => rfc3339_millis(DateTime::from_timestamp_millis(now + delay).expect("retry time")),
    }
}

fn task_status<D: Db>(database: &D, user_id: &str, task_id: &str) -> Result<String, Failure> {
    db(database, |database| {
        let row = database.connection().query_row(
            "SELECT t.company_id, c.status FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).optional()?;
        let (company, status) = row.ok_or_else(TaskError::not_found)?;
        companies::require_company_access(database, user_id, &company)?;
        Ok(status)
    })
}

// ponytail: one process-wide queue, like the TypeScript promise chain; per-rule queues if checks contend.
static QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn list<D: Db>(database: &D, user_id: &str, company_id: &str) -> Result<Vec<Rule>, Failure> {
    db(database, |database| {
        admin(database, user_id, company_id)?;
        list_rules(database, company_id)
    })
}

pub fn activity<D: Db>(
    database: &D,
    user_id: &str,
    company_id: &str,
    rule_id: &str,
) -> Result<Vec<Activity>, Failure> {
    let mut activity = db(database, |database| {
        admin(database, user_id, company_id)?;
        required_rule(database, company_id, rule_id)?;
        let mut activity = stored_activity(database, company_id, rule_id)?;
        let seen = activity
            .iter()
            .filter_map(|value| value.task_id.clone())
            .collect::<Vec<_>>();
        for dispatch in dispatches::list_by_rule(database, company_id, rule_id)? {
            if let Some(task_id) = dispatch.task_id.filter(|id| !seen.contains(id)) {
                activity.push(Activity {
                    at: dispatch.updated_at,
                    task_id: Some(task_id),
                    previously_processed: true,
                    ..Activity::new(
                        dispatch.pull_request_number,
                        None,
                        "eligible",
                        "Backlog task created.",
                    )
                });
            }
        }
        Ok(activity)
    })?;
    for value in &mut activity {
        if let Some(task_id) = &value.task_id {
            value.task_status = Some(task_status(database, user_id, task_id)?);
        }
    }
    Ok(activity)
}

pub async fn create<D: Db>(
    database: &D,
    github: &Github,
    user_id: &str,
    company_id: &str,
    input: GithubTriggerCreate,
) -> Result<Rule, Failure> {
    db(database, |database| admin(database, user_id, company_id))?;
    let config = Config {
        project_id: input.project_id,
        name: input.name,
        label: input.label,
        workflow_id: input.workflow_id,
        delivery_target: input.delivery_target.to_string(),
        protected_paths: input.protected_paths,
        authority_user_id: user_id.to_owned(),
    };
    let expected = db(database, |database| {
        local(database, user_id, company_id, &config)
    })?;
    let (repository_id, repository_name) =
        provider(github, &expected.dependencies.repository, &config.label).await?;
    let time = now_millis_rfc3339();
    let created = Rule {
        id: format!("github_trigger_{}", uuid::Uuid::new_v4().simple()),
        company_id: company_id.to_owned(),
        project_id: config.project_id.clone(),
        name: config.name.clone(),
        label: config.label.clone(),
        workflow_id: config.workflow_id.clone(),
        delivery_target: config.delivery_target.clone(),
        protected_paths: config.protected_paths.clone(),
        repository_id,
        repository_name,
        authority_user_id: user_id.to_owned(),
        enabled: false,
        archived_at: None,
        revision: 1,
        last_successful_check_at: None,
        next_retry_at: None,
        latest_error: None,
        failure_count: 0,
        created_at: time.clone(),
        updated_at: time,
    };
    let written = database.run(|database| {
        database.transaction(true, |database| {
            same_local(database, user_id, company_id, &config, &expected)?;
            database.connection().execute(
                "INSERT INTO suplex_github_trigger_rules (id, company_id, project_id, name, label, workflow_id, delivery_target, protected_paths_json, repository_id, repository_name, authority_user_id, enabled, archived_at, revision, last_successful_check_at, next_retry_at, latest_error, failure_count, recent_activity_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, NULL, 1, NULL, NULL, NULL, 0, '[]', ?12, ?13)",
                params![created.id, created.company_id, created.project_id, created.name, created.label, created.workflow_id, created.delivery_target, serde_json::to_string(&created.protected_paths)?, created.repository_id, created.repository_name, created.authority_user_id, created.created_at, created.updated_at],
            )?;
            audit(database, user_id, "github_trigger_created", &created)
        })
    });
    match written {
        Ok(()) => Ok(created),
        Err(error)
            if error
                .to_string()
                .contains("suplex_github_trigger_rules_enabled_repository_unique") =>
        {
            Err(public(
                "An enabled GitHub rule already exists for this repository",
                409,
            ))
        }
        Err(error) => Err(send(error)),
    }
}

fn write<D: Db>(
    database: &D,
    user_id: &str,
    current: &Rule,
    next: Rule,
    verify: Option<(&Config, &Local)>,
) -> Result<Rule, Failure> {
    let written = database.run(|database| {
        database.transaction(true, |database| {
            admin(database, user_id, &current.company_id)?;
            if let Some((config, expected)) = verify {
                same_local(database, user_id, &current.company_id, config, expected)?;
            }
            let updated = update_rule(database, &next, current.revision)?;
            if updated {
                audit(database, user_id, "github_trigger_updated", current)?;
            }
            Ok(updated)
        })
    });
    match written {
        Ok(true) => Ok(next),
        Ok(false) => Err(public(CHANGED, 409)),
        Err(error)
            if error.to_string().contains(
                "UNIQUE constraint failed: suplex_github_trigger_rules.repository_id",
            ) =>
        {
            Err(public(
                "An enabled GitHub rule already exists for this repository",
                409,
            ))
        }
        Err(error) => Err(send(error)),
    }
}

pub async fn update<D: Db>(
    database: &D,
    github: &Github,
    user_id: &str,
    company_id: &str,
    rule_id: &str,
    patch: GithubTriggerPatch,
) -> Result<Rule, Failure> {
    let current = db(database, |database| {
        admin(database, user_id, company_id)?;
        required_rule(database, company_id, rule_id)
    })?;
    if patch.expected_revision != current.revision {
        return Err(public(CHANGED, 409));
    }
    let configures = patch.project_id.is_some()
        || patch.name.is_some()
        || patch.label.is_some()
        || patch.workflow_id.is_some()
        || patch.delivery_target.is_some()
        || patch.protected_paths.is_some();
    let time = now_millis_rfc3339();
    if patch.enabled == Some(false) || patch.archived == Some(true) {
        if configures || patch.archived == Some(false) {
            return Err(public(
                "Stop or archive a rule separately from configuration changes",
                422,
            ));
        }
        let next = Rule {
            enabled: false,
            archived_at: if patch.archived == Some(true) {
                Some(time.clone())
            } else {
                current.archived_at.clone()
            },
            revision: current.revision + 1,
            updated_at: time,
            ..current.clone()
        };
        return write(database, user_id, &current, next, None);
    }
    if patch.archived == Some(false) && patch.enabled == Some(true) {
        return Err(public("Restore a rule before enabling it", 422));
    }
    if patch.archived == Some(false) {
        let next = Rule {
            enabled: false,
            archived_at: None,
            revision: current.revision + 1,
            updated_at: time,
            ..current.clone()
        };
        return write(database, user_id, &current, next, None);
    }
    let config = Config {
        project_id: patch
            .project_id
            .unwrap_or_else(|| current.project_id.clone()),
        name: patch.name.unwrap_or_else(|| current.name.clone()),
        label: patch.label.unwrap_or_else(|| current.label.clone()),
        workflow_id: patch
            .workflow_id
            .unwrap_or_else(|| current.workflow_id.clone()),
        delivery_target: patch
            .delivery_target
            .map(|target| target.to_string())
            .unwrap_or_else(|| current.delivery_target.clone()),
        protected_paths: patch
            .protected_paths
            .unwrap_or_else(|| current.protected_paths.clone()),
        authority_user_id: user_id.to_owned(),
    };
    let expected = db(database, |database| {
        local(database, user_id, company_id, &config)
    })?;
    let (repository_id, repository_name) =
        provider(github, &expected.dependencies.repository, &config.label).await?;
    let changed_binding =
        repository_id != current.repository_id || repository_name != current.repository_name;
    if current.enabled && changed_binding {
        return Err(public(
            "Disable this rule before changing its repository binding",
            409,
        ));
    }
    if changed_binding && patch.enabled == Some(true) {
        return Err(public(
            "Save the new repository binding before enabling this rule",
            422,
        ));
    }
    let next = Rule {
        project_id: config.project_id.clone(),
        name: config.name.clone(),
        label: config.label.clone(),
        workflow_id: config.workflow_id.clone(),
        delivery_target: config.delivery_target.clone(),
        protected_paths: config.protected_paths.clone(),
        authority_user_id: config.authority_user_id.clone(),
        repository_id,
        repository_name,
        enabled: patch.enabled.unwrap_or(current.enabled),
        revision: current.revision + 1,
        updated_at: now_millis_rfc3339(),
        ..current.clone()
    };
    write(
        database,
        user_id,
        &current,
        next,
        Some((&config, &expected)),
    )
}

/// `check`: preview the current labelled pull requests without admitting any.
pub async fn check<D: Db>(
    database: &D,
    github: &Github,
    user_id: &str,
    company_id: &str,
    rule_id: &str,
) -> Result<Vec<Activity>, Failure> {
    let _queue = QUEUE.lock().await;
    let rule = db(database, |database| {
        admin(database, user_id, company_id)?;
        required_rule(database, company_id, rule_id)
    })?;
    if rule.archived_at.is_some() {
        return Err(public("This GitHub rule is archived", 409));
    }
    let config = Config::from(&rule);
    let mut activity = Vec::new();
    let result = preview(
        database,
        github,
        user_id,
        company_id,
        &rule,
        &config,
        &mut activity,
    )
    .await;
    if let Err(error) = &result {
        let (text, provider_retry) = message(error.as_ref());
        let retry_at = retry_after(rule.failure_count, provider_retry.as_deref());
        let _ = database.run(|database| {
            record(
                database,
                &rule,
                &activity,
                Some(&text),
                Some(&retry_at),
                false,
                |_| Ok(()),
            )
        });
    }
    result
}

async fn preview<D: Db>(
    database: &D,
    github: &Github,
    user_id: &str,
    company_id: &str,
    rule: &Rule,
    config: &Config,
    activity: &mut Vec<Activity>,
) -> Result<Vec<Activity>, Failure> {
    let expected = db(database, |database| {
        local(database, user_id, company_id, config)
    })?;
    let (binding_id, binding_name) =
        provider(github, &expected.dependencies.repository, &rule.label).await?;
    if db(database, |database| {
        required_rule(database, company_id, &rule.id)
    })?
    .revision
        != rule.revision
    {
        return Err(public(CHANGED, 409));
    }
    if binding_id != rule.repository_id || binding_name != rule.repository_name {
        let retry = rfc3339_millis(Utc::now() + chrono::Duration::seconds(60));
        let recorded = db(database, |database| {
            record(
                database,
                rule,
                &[],
                Some("Repository binding changed. The rule was disabled."),
                Some(&retry),
                true,
                |database| same_local(database, user_id, company_id, config, &expected),
            )
        })?;
        if !recorded {
            return Err(public(CHANGED, 409));
        }
        return Err(public(
            "Repository binding changed. The rule was disabled.",
            409,
        ));
    }
    let candidates =
        list_open_pull_requests_by_label(github, &rule.repository_name, &rule.label).await?;
    let (mut candidate_failure, mut candidate_retry) = (false, None);
    for number in candidates {
        let observed = preview_candidate(
            database,
            github,
            rule,
            &expected,
            (binding_id, &binding_name),
            number,
        )
        .await;
        match observed {
            Ok(value) => activity.push(value),
            Err(error) => {
                candidate_failure = true;
                let (text, retry) = message(error.as_ref());
                candidate_retry = later(candidate_retry, retry);
                activity.push(Activity::new(number, None, "error", &text));
            }
        }
    }
    if db(database, |database| {
        required_rule(database, company_id, &rule.id)
    })?
    .revision
        != rule.revision
    {
        return Err(public(CHANGED, 409));
    }
    if candidate_failure {
        return Err(Box::new(TriggerFailure {
            message: UNAVAILABLE.into(),
            status: 502,
            retry_at: candidate_retry,
        }));
    }
    let recorded = db(database, |database| {
        record(database, rule, activity, None, None, false, |database| {
            same_local(database, user_id, company_id, config, &expected)
        })
    })?;
    if !recorded {
        return Err(public(CHANGED, 409));
    }
    Ok(std::mem::take(activity))
}

/// The preview activity of one labelled pull request.
async fn preview_candidate<D: Db>(
    database: &D,
    github: &Github,
    rule: &Rule,
    expected: &Local,
    (binding_id, binding_name): (i64, &str),
    number: i64,
) -> Result<Activity, Failure> {
    let pull = inspect_pull_request(github, &rule.repository_name, number).await?;
    let matching_paths = pull.matching_paths(&rule.protected_paths);
    let same = pull.base_repository.id == rule.repository_id
        && pull.base_repository.id == binding_id
        && pull.base_repository.full_name == rule.repository_name.to_lowercase()
        && pull.base_repository.full_name == binding_name.to_lowercase();
    let owned = db(database, |database| {
        owns_pull_request(database, &rule.repository_name, pull.number)
    })?;
    let reason = if !same {
        "The pull request repository does not match this rule."
    } else if pull.state != "open" {
        "The pull request is closed."
    } else if pull.is_draft {
        "The pull request is a draft."
    } else if pull.is_cross_repository {
        "The pull request comes from a fork."
    } else if pull.base_branch != expected.dependencies.base_branch {
        "The pull request targets a different base branch."
    } else if !pull.labels.contains(&rule.label) {
        "The pull request does not have the required label."
    } else if !matching_paths.is_empty() {
        "The pull request changes a protected path."
    } else if owned {
        "A task already uses this pull request."
    } else {
        "Eligible."
    };
    let (dispatch, processed) = db(database, |database| {
        Ok((
            dispatches::find(database, &rule.id, pull.base_repository.id, pull.number)?,
            dispatches::previously_processed(database, pull.base_repository.id, pull.number)?,
        ))
    })?;
    let task_id = dispatch.and_then(|dispatch| dispatch.task_id);
    let task_status = match &task_id {
        Some(task_id) => Some(task_status(database, &rule.authority_user_id, task_id)?),
        None => None,
    };
    Ok(Activity {
        matching_paths,
        task_id,
        task_status,
        previously_processed: processed,
        ..Activity::new(
            pull.number,
            Some(&pull.url),
            if reason == "Eligible." {
                "eligible"
            } else {
                "excluded"
            },
            reason,
        )
    })
}

/// `eligible`: the exclusion reason for a pull request, if any.
fn eligible(
    database: &SuplexDatabase,
    rule: &Rule,
    local: &Local,
    pull: &PullRequestInspection,
    policy: Option<&DispatchPolicy>,
) -> DatabaseResult<(Option<&'static str>, Vec<String>)> {
    let protected = policy.map_or(&rule.protected_paths, |policy| &policy.protected_paths);
    let matching = pull.matching_paths(protected);
    let (repository_id, repository_name) = policy.map_or(
        (rule.repository_id, rule.repository_name.as_str()),
        |policy| (policy.repository_id, policy.repository_name.as_str()),
    );
    let same = pull.base_repository.id == repository_id
        && pull.base_repository.full_name == repository_name.to_lowercase()
        && pull.head_repository.as_ref().is_some_and(|head| {
            head.id == repository_id && head.full_name == repository_name.to_lowercase()
        });
    let drift = policy.is_some_and(|policy| {
        pull.head_sha != policy.head_sha
            || pull.base_sha != policy.base_sha
            || pull.head_branch != policy.head_branch
            || pull.base_branch != policy.base_branch
    });
    let reason = if pull.number < 1 {
        Some("The pull request is invalid.")
    } else if !same {
        Some("The pull request repository does not match this rule.")
    } else if pull.state != "open" {
        Some("The pull request is closed.")
    } else if pull.is_draft {
        Some("The pull request is a draft.")
    } else if pull.is_cross_repository {
        Some("The pull request comes from a fork.")
    } else if pull.base_branch != local.dependencies.base_branch {
        Some("The pull request targets a different base branch.")
    } else if !pull.labels.contains(&rule.label) {
        Some("The pull request does not have the required label.")
    } else if !matching.is_empty() {
        Some("The pull request changes a protected path.")
    } else if drift {
        Some("The pull request changed before admission.")
    } else if owns_pull_request(database, &rule.repository_name, pull.number)? {
        Some("A task already uses this pull request.")
    } else {
        None
    };
    Ok((reason, matching))
}

/// `processEnabledRules`: admit eligible pull requests for every due rule.
pub async fn process_enabled_rules<D: Db>(
    database: &D,
    github: &Github,
    wake: &(dyn Fn(String) + Sync),
) {
    let _queue = QUEUE.lock().await;
    let Ok(rules) = db(database, |database| enabled_due(database)) else {
        return;
    };
    for rule in rules {
        // Each repository has its own retry state.
        let _ = dispatch_rule(database, github, &rule, wake).await;
    }
}

async fn dispatch_rule<D: Db>(
    database: &D,
    github: &Github,
    rule: &Rule,
    wake: &(dyn Fn(String) + Sync),
) -> Result<(), Failure> {
    let mut activity = Vec::new();
    let result = admit(database, github, rule, wake, &mut activity).await;
    if let Err(error) = &result {
        record_failure(database, rule, &activity, error.as_ref());
    }
    result
}

fn record_failure<D: Db>(
    database: &D,
    rule: &Rule,
    activity: &[Activity],
    error: &(dyn Error + 'static),
) {
    let (text, retry) = message(error);
    let retry = retry.unwrap_or_else(|| rfc3339_millis(Utc::now() + chrono::Duration::seconds(60)));
    let _ = database.run(|database| {
        record(
            database,
            rule,
            activity,
            Some(&text),
            Some(&retry),
            false,
            |_| Ok(()),
        )
    });
}

/// TypeScript records a failed GitHub provider call on each due rule; an
/// unavailable GitHub login fails every due rule the same way.
pub async fn record_provider_unavailable<D: Db>(
    database: &D,
    error: &(dyn Error + Send + Sync + 'static),
) {
    let _queue = QUEUE.lock().await;
    let Ok(rules) = db(database, |database| enabled_due(database)) else {
        return;
    };
    for rule in rules {
        record_failure(database, &rule, &[], error);
    }
}

async fn admit<D: Db>(
    database: &D,
    github: &Github,
    rule: &Rule,
    wake: &(dyn Fn(String) + Sync),
    activity: &mut Vec<Activity>,
) -> Result<(), Failure> {
    let config = Config::from(rule);
    let (authority, company) = (rule.authority_user_id.as_str(), rule.company_id.as_str());
    let expected = db(database, |database| {
        local(database, authority, company, &config)
    })?;
    let current = db(database, |database| {
        required_rule(database, company, &rule.id)
    })?;
    if !current.enabled || current.revision != rule.revision {
        return Ok(());
    }
    let (binding_id, binding_name) =
        provider(github, &expected.dependencies.repository, &rule.label).await?;
    if binding_id != rule.repository_id || binding_name != rule.repository_name.to_lowercase() {
        let retry = rfc3339_millis(Utc::now() + chrono::Duration::seconds(60));
        db(database, |database| {
            record(
                database,
                rule,
                &[],
                Some("Repository binding changed. The rule was disabled."),
                Some(&retry),
                true,
                |_| Ok(()),
            )
        })?;
        return Ok(());
    }
    let mut pass = Pass {
        database,
        github,
        rule,
        wake,
        config,
        expected,
        activity,
        failed: false,
        provider_retry: None,
    };
    pass.resume_pending().await?;
    pass.start_linked().await?;
    pass.admit_candidates().await?;
    pass.finish()
}

/// The rule, its authority, and the local dependencies are still the ones this pass read.
fn rule_current(
    database: &SuplexDatabase,
    rule: &Rule,
    config: &Config,
    expected: &Local,
) -> DatabaseResult<()> {
    let current = required_rule(database, &rule.company_id, &rule.id)?;
    if !current.enabled
        || current.revision != rule.revision
        || current.authority_user_id != rule.authority_user_id
    {
        return Err(local_failure(CHANGED, 409));
    }
    same_local(
        database,
        &rule.authority_user_id,
        &rule.company_id,
        config,
        expected,
    )
}

/// One admission pass over a due rule. Each pull request failure becomes an
/// activity row and a retry; the pass records its outcome once.
struct Pass<'a, D: Db> {
    database: &'a D,
    github: &'a Github,
    rule: &'a Rule,
    wake: &'a (dyn Fn(String) + Sync),
    config: Config,
    expected: Local,
    activity: &'a mut Vec<Activity>,
    failed: bool,
    provider_retry: Option<String>,
}

impl<D: Db> Pass<'_, D> {
    /// Record a failed pull request; return the provider retry time it carries.
    fn fail(&mut self, error: Failure, number: i64, task_id: Option<String>) -> Option<String> {
        self.failed = true;
        let (text, retry) = message(error.as_ref());
        self.activity.push(Activity {
            previously_processed: task_id.is_some(),
            task_status: task_id.as_ref().map(|_| "backlog".to_owned()),
            task_id,
            ..Activity::new(number, None, "error", &text)
        });
        retry
    }

    fn outcome(&mut self, number: i64, result: Result<Activity, Failure>) {
        match result {
            Ok(value) => self.activity.push(value),
            Err(error) => {
                let retry = self.fail(error, number, None);
                self.provider_retry = later(self.provider_retry.take(), retry);
            }
        }
    }

    /// Create the task of each captured dispatch that has none yet.
    async fn resume_pending(&mut self) -> Result<(), Failure> {
        let rule = self.rule;
        let pending = db(self.database, |database| dispatches::unfinished(database))?;
        for pending in pending.iter().filter(|value| value.rule_id == rule.id) {
            let result = self.resume(pending).await;
            self.outcome(pending.pull_request_number, result);
        }
        Ok(())
    }

    async fn resume(&self, pending: &Dispatch) -> Result<Activity, Failure> {
        let (database, rule) = (self.database, self.rule);
        let pull = inspect_pull_request(
            self.github,
            &pending.repository_name,
            pending.pull_request_number,
        )
        .await?;
        let (reason, matching) = db(database, |database| {
            eligible(database, rule, &self.expected, &pull, Some(&pending.policy))
        })?;
        if let Some(reason) = reason {
            return Ok(Activity {
                matching_paths: matching,
                ..Activity::new(pull.number, Some(&pull.url), "excluded", reason)
            });
        }
        db(database, |database| {
            rule_current(database, rule, &self.config, &self.expected)
        })?;
        let (task_id, status) = create_task_from_trigger(database, &pending.id, self.wake).await?;
        Ok(Activity {
            task_id: Some(task_id),
            task_status: Some(status),
            previously_processed: true,
            ..Activity::new(
                pull.number,
                Some(&pull.url),
                "eligible",
                "Backlog task created.",
            )
        })
    }

    /// Start each linked task. A start failure keeps the provider retry of the next pass.
    async fn start_linked(&mut self) -> Result<(), Failure> {
        let (company, rule_id) = (self.rule.company_id.as_str(), self.rule.id.as_str());
        let linked = db(self.database, |database| {
            dispatches::list_by_rule(database, company, rule_id)
        })?;
        for linked in linked.into_iter().filter(|value| value.task_id.is_some()) {
            if let Err(error) =
                start_task_from_trigger(self.database, self.github, &linked.id, self.wake).await
            {
                self.fail(error, linked.pull_request_number, linked.task_id);
            }
        }
        Ok(())
    }

    /// Admit each labelled pull request this rule has not processed.
    async fn admit_candidates(&mut self) -> Result<(), Failure> {
        let candidates = list_open_pull_requests_by_label(
            self.github,
            &self.rule.repository_name,
            &self.rule.label,
        )
        .await?;
        for number in candidates {
            let result = self.candidate(number).await;
            self.outcome(number, result);
        }
        Ok(())
    }

    async fn candidate(&self, number: i64) -> Result<Activity, Failure> {
        let (database, rule, expected) = (self.database, self.rule, &self.expected);
        let pull = inspect_pull_request(self.github, &rule.repository_name, number).await?;
        let (reason, matching) = db(database, |database| {
            eligible(database, rule, expected, &pull, None)
        })?;
        let prior = db(database, |database| {
            dispatches::find(database, &rule.id, pull.base_repository.id, pull.number)
        })?;
        if reason.is_some() || prior.is_some() {
            let task_id = prior.as_ref().and_then(|prior| prior.task_id.clone());
            let task_status = task_id
                .as_deref()
                .map(|id| task_status(database, &rule.authority_user_id, id))
                .transpose()?;
            let reason = if prior.is_some() {
                "This pull request was previously processed."
            } else {
                reason.unwrap_or_default()
            };
            return Ok(Activity {
                matching_paths: matching,
                previously_processed: prior.is_some(),
                task_id,
                task_status,
                ..Activity::new(pull.number, Some(&pull.url), "excluded", reason)
            });
        }
        let last = inspect_pull_request(self.github, &rule.repository_name, pull.number).await?;
        let (last_reason, _) = db(database, |database| {
            eligible(database, rule, expected, &last, None)
        })?;
        if last.head_sha != pull.head_sha
            || last.base_sha != pull.base_sha
            || last.head_branch != pull.head_branch
            || last.base_branch != pull.base_branch
            || last_reason.is_some()
        {
            return Ok(Activity::new(
                pull.number,
                Some(&last.url),
                "excluded",
                "The pull request changed before admission.",
            ));
        }
        let prepared = db(database, |database| {
            database.transaction(true, |database| {
                rule_current(database, rule, &self.config, expected)?;
                assert_pull_request_available(database, "", &rule.repository_name, pull.number)?;
                dispatches::prepare(database, self.capture(&pull))
            })
        })?;
        create_task_from_trigger(database, &prepared.id, self.wake).await?;
        let (task_id, status) =
            start_task_from_trigger(database, self.github, &prepared.id, self.wake).await?;
        Ok(Activity {
            task_id: Some(task_id),
            task_status: Some(status),
            previously_processed: true,
            ..Activity::new(pull.number, Some(&pull.url), "eligible", "Task started.")
        })
    }

    /// The dispatch capture of an eligible pull request.
    fn capture(&self, pull: &PullRequestInspection) -> DispatchPrepare {
        let (rule, local) = (self.rule, &self.expected.dependencies);
        let profiles = &local.profiles;
        let advisor_ids = profiles
            .advisors
            .iter()
            .map(|(role, profile)| (*role, profile.profile_id.as_str()))
            .collect::<std::collections::BTreeMap<_, _>>();
        let request = json!({
            "projectId": rule.project_id, "title": pull.title, "description": "Apply the selected workflow to this pull request.", "images": [],
            "rootProfileId": profiles.root.profile_id, "workerProfileId": profiles.worker.profile_id, "advisorProfileIds": advisor_ids,
            "workflow": local.engine, "deliveryTarget": rule.delivery_target, "runProjectTests": local.run_project_tests, "visualEvidence": local.visual_evidence,
            "source": {"kind": "pull_request", "number": pull.number},
        });
        DispatchPrepare {
            rule_id: rule.id.clone(),
            company_id: rule.company_id.clone(),
            project_id: rule.project_id.clone(),
            repository_id: rule.repository_id,
            repository_name: rule.repository_name.clone(),
            pull_request_number: pull.number,
            authority_user_id: rule.authority_user_id.clone(),
            request,
            policy: DispatchPolicy {
                head_sha: pull.head_sha.clone(),
                base_sha: pull.base_sha.clone(),
                head_branch: pull.head_branch.clone(),
                base_branch: pull.base_branch.clone(),
                protected_paths: rule.protected_paths.clone(),
                repository_id: rule.repository_id,
                repository_name: rule.repository_name.clone(),
                delivery_target: rule.delivery_target.clone(),
            },
            preset: self.expected.preset.clone(),
            profiles: profiles.clone(),
        }
    }

    /// Record the pass: a failure schedules a retry; success needs unchanged local facts.
    fn finish(self) -> Result<(), Failure> {
        let (database, rule, activity) = (self.database, self.rule, &*self.activity);
        if self.failed {
            let retry = retry_after(rule.failure_count, self.provider_retry.as_deref());
            db(database, |database| {
                record(
                    database,
                    rule,
                    activity,
                    Some(UNAVAILABLE),
                    Some(&retry),
                    false,
                    |_| Ok(()),
                )
            })?;
        } else if !db(database, |database| {
            record(database, rule, activity, None, None, false, |database| {
                same_local(
                    database,
                    &rule.authority_user_id,
                    &rule.company_id,
                    &self.config,
                    &self.expected,
                )
            })
        })? {
            return Err(public(CHANGED, 409));
        }
        Ok(())
    }
}

/// `requireGithubTriggerAdmission`: live authority, rule, preset, and profiles.
fn require_admission(database: &SuplexDatabase, dispatch: &Dispatch) -> DatabaseResult<()> {
    let failure =
        |message: &str, status: u16| -> Box<dyn Error> { TaskError::new(message, status).into() };
    if active_role(database, &dispatch.authority_user_id)?.as_deref() != Some("admin") {
        return Err(failure("GitHub trigger authority is not available", 422));
    }
    let company = companies::require_company_access(
        database,
        &dispatch.authority_user_id,
        &dispatch.company_id,
    )?;
    if company.status != "active" {
        return Err(failure("Company is not active", 409));
    }
    let rule = get_rule(database, &dispatch.company_id, &dispatch.rule_id)?.filter(|rule| {
        rule.project_id == dispatch.project_id
            && rule.repository_id == dispatch.repository_id
            && rule.repository_name.to_lowercase() == dispatch.repository_name.to_lowercase()
            && rule.authority_user_id == dispatch.authority_user_id
            && rule.enabled
            && rule.archived_at.is_none()
    });
    if rule.is_none() {
        return Err(failure("GitHub trigger rule is not available", 409));
    }
    let preset: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_workflows WHERE id = ?1 AND archived_at IS NULL)",
        [Preset::of(&dispatch.preset)?.id],
        |row| row.get(0),
    )?;
    if !preset {
        return Err(failure("GitHub trigger preset is not available", 422));
    }
    let profiles = &dispatch.profiles;
    for (profile, role) in [(&profiles.root, "root"), (&profiles.worker, "worker")]
        .into_iter()
        .chain(profiles.advisors.values().map(|profile| (profile, "root")))
    {
        if crate::profiles::agent_profiles::read_profile(database, &profile.profile_id, role)?
            .is_none()
        {
            return Err(failure("The selected agent profile does not exist", 422));
        }
    }
    Ok(())
}

/// `createTaskFromGithubTrigger`: create the backlog task for a captured dispatch.
pub async fn create_task_from_trigger<D: Db>(
    database: &D,
    dispatch_id: &str,
    wake: &(dyn Fn(String) + Sync),
) -> Result<(String, String), Failure> {
    let dispatch = db(database, |database| dispatches::get(database, dispatch_id))?
        .ok_or_else(|| task_failure("GitHub trigger dispatch was not found", 404))?;
    let body = dispatch.request_body().map_err(send)?;
    if body.start_immediately || !body.images.is_empty() {
        return Err(task_failure("GitHub trigger dispatch is invalid", 422));
    }
    let authority = dispatch.authority_user_id.clone();
    if let Some(task_id) = &dispatch.task_id {
        return Ok((task_id.clone(), task_status(database, &authority, task_id)?));
    }
    db(database, |database| require_admission(database, &dispatch))?;
    let hash = commands::task_request_hash(&body, &authority).map_err(send)?;
    let existing = db(database, |database| {
        commands::existing_user_task(
            database,
            &dispatch.company_id,
            &body.idempotency_key,
            &hash,
            &authority,
        )
    })?;
    if let Some(task) = existing {
        db(database, |database| {
            database.transaction(true, |database| {
                require_admission(database, &dispatch)?;
                dispatches::link_task(database, &dispatch.id, &task.id)
            })
        })?;
        return Ok((task.id, task.status.to_string()));
    }
    let project = db(database, |database| {
        let project = projects::get(database, &authority, &dispatch.project_id)?;
        if project.company_id != dispatch.company_id {
            return Err(ProjectError::new("Not found", 404, vec![]).into());
        }
        Ok(project)
    })?;
    let source = sources::creation_source(
        &project,
        &body.title,
        &body.description,
        dispatch.request.get("source"),
        None,
    )
    .await
    .map_err(send)?;
    let (repository_path, base_branch) = (
        PathBuf::from(&project.repository_path),
        project.base_branch.clone(),
    );
    let host = match project
        .integration
        .as_ref()
        .map(|integration| &integration.repository)
    {
        Some(RepositoryConnection::Bitbucket { .. }) => "bitbucket",
        _ => "github",
    };
    let base_sha = git::capture_local_task_heads(
        &git::Github::default(),
        &repository_path,
        &base_branch,
        host,
    )
    .await
    .map_err(|findings| -> Failure {
        ProjectError::Rejected {
            message: "Project configuration could not be captured",
            status: 422,
            findings,
        }
        .into()
    })?;
    let created = db(database, |database| {
        create_captured(
            database, &dispatch, &project, &body, source, &base_sha, wake,
        )
    })?;
    Ok(created)
}

fn create_captured(
    database: &mut SuplexDatabase,
    dispatch: &Dispatch,
    project: &Project,
    body: &crate::http::contracts::typed::tasks::TaskCreateBody,
    source: sources::CreationSource,
    base_sha: &str,
    wake: &(dyn Fn(String) + Sync),
) -> DatabaseResult<(String, String)> {
    let authority = &dispatch.authority_user_id;
    let now = Utc::now();
    let profiles = commands::select_local_profiles(database, project, body)?;
    let mut prepared = commands::prepare_local_user_task(
        &dispatch.company_id,
        authority,
        project,
        body,
        profiles,
        base_sha,
        now,
    )?;
    sources::apply(&mut prepared, source)?;
    let policy = &dispatch.policy;
    if !TaskBinding::of(&prepared.configuration).matches(dispatch.pull_request_number, policy)
        || project
            .repository
            .as_deref()
            .map(str::to_lowercase)
            .as_deref()
            != Some(dispatch.repository_name.as_str())
        || project.base_branch != policy.base_branch
    {
        return Err(TaskError::new("GitHub trigger source changed", 409).into());
    }
    // TypeScript creates the task from the captured profile snapshots.
    prepared.root_profile = dispatch.profiles.root.clone();
    prepared.worker_profile = dispatch.profiles.worker.clone();
    prepared.advisor_profiles = dispatch.profiles.advisors.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let task = database.transaction(true, |database| {
        require_admission(database, dispatch)?;
        let written = commands::create_user_task_with_images(
            database,
            authority,
            project,
            &prepared,
            commands::ImageFiles {
                root: Path::new(""),
                images: &[],
            },
            now,
            move |id| {
                let _ = sender.send(id);
            },
        )?;
        dispatches::link_task(database, &dispatch.id, &written.task.id)?;
        Ok(written.task)
    })?;
    if let Ok(id) = receiver.try_recv() {
        wake(id);
    }
    Ok((task.id, task.status.to_string()))
}

/// The task status and whether a live backlog or queued task may start.
fn startable(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<(String, bool)> {
    let (status, live) = database.connection().query_row(
        "SELECT c.status, t.archived_at IS NULL FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
        [task_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
    )?;
    let can_start = live && matches!(status.as_str(), "backlog" | "queued");
    Ok((status, can_start))
}

/// The pull request still matches its capture, carries the label, and changes no protected path.
fn still_eligible(dispatch: &Dispatch, pull: &PullRequestInspection, label: &str) -> bool {
    let policy = &dispatch.policy;
    let repository = dispatch.repository_name.as_str();
    pull.number == dispatch.pull_request_number
        && pull.state == "open"
        && !pull.is_draft
        && !pull.is_cross_repository
        && pull.base_repository.id == dispatch.repository_id
        && pull.base_repository.full_name == repository
        && pull
            .head_repository
            .as_ref()
            .is_some_and(|head| head.id == dispatch.repository_id && head.full_name == repository)
        && pull.head_sha == policy.head_sha
        && pull.base_sha == policy.base_sha
        && pull.head_branch == policy.head_branch
        && pull.base_branch == policy.base_branch
        && pull.labels.iter().any(|value| value == label)
        && pull.matching_paths(&policy.protected_paths).is_empty()
}

/// Start the linked task in one transaction once its captured source is unchanged.
fn start_linked_task(
    database: &mut SuplexDatabase,
    dispatch_id: &str,
    task_id: &str,
    wake: impl FnOnce(String) + Send + 'static,
) -> DatabaseResult<(String, String)> {
    let current = dispatches::get(database, dispatch_id)?
        .filter(|value| value.task_id.is_some())
        .ok_or_else(|| -> Box<dyn Error> {
            TaskError::new("GitHub trigger dispatch is not linked to a task", 404).into()
        })?;
    let (status, can_start) = startable(database, task_id)?;
    if !can_start {
        return Ok((task_id.to_owned(), status));
    }
    require_admission(database, &current)?;
    let configuration: Value = serde_json::from_str(&database.connection().query_row(
        "SELECT configuration_json FROM suplex_tasks WHERE id = ?1",
        [task_id],
        |row| row.get::<_, String>(0),
    )?)?;
    let binding = TaskBinding::of(&configuration);
    if !binding.repository_is(&current.repository_name)
        || !binding.matches(current.pull_request_number, &current.policy)
    {
        return Err(TaskError::new("GitHub trigger task source changed", 409).into());
    }
    let task = commands::start_user_task(
        database,
        &current.authority_user_id,
        task_id,
        Utc::now(),
        wake,
    )?;
    Ok((task.id, task.status.to_string()))
}

/// `startTaskFromGithubTrigger`: start the linked task once the pull request still matches its capture.
pub async fn start_task_from_trigger<D: Db>(
    database: &D,
    github: &Github,
    dispatch_id: &str,
    wake: &(dyn Fn(String) + Sync),
) -> Result<(String, String), Failure> {
    let not_linked = || task_failure("GitHub trigger dispatch is not linked to a task", 404);
    let dispatch =
        db(database, |database| dispatches::get(database, dispatch_id))?.ok_or_else(not_linked)?;
    let task_id = dispatch.task_id.clone().ok_or_else(not_linked)?;
    let status = task_status(database, &dispatch.authority_user_id, &task_id)?;
    let (_, can_start) = db(database, |database| startable(database, &task_id))?;
    if !can_start {
        return Ok((task_id, status));
    }
    db(database, |database| require_admission(database, &dispatch))?;
    let pull = inspect_pull_request(
        github,
        &dispatch.repository_name,
        dispatch.pull_request_number,
    )
    .await?;
    let label = db(database, |database| {
        get_rule(database, &dispatch.company_id, &dispatch.rule_id)
    })?
    .map(|rule| rule.label)
    .ok_or_else(|| task_failure("GitHub trigger rule is not available", 409))?;
    if !still_eligible(&dispatch, &pull, &label) {
        return Err(task_failure(
            "GitHub trigger pull request is no longer eligible",
            409,
        ));
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let started = db(database, |database| {
        database.transaction(true, |database| {
            start_linked_task(database, dispatch_id, &task_id, move |id| {
                let _ = sender.send(id);
            })
        })
    })?;
    if let Ok(id) = receiver.try_recv() {
        wake(id);
    }
    Ok(started)
}

/// Run `processEnabledRules` now and one minute after each pass ends.
async fn poller_loop<F, Fut>(mut pass: F, mut shutdown: watch::Receiver<bool>, period: Duration)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), Failure>>,
{
    loop {
        if let Err(error) = pass().await {
            eprintln!("GitHub trigger poll failed: {error}");
        }
        tokio::select! {
            changed = shutdown.changed() => if changed.is_err() || *shutdown.borrow() { return; },
            () = tokio::time::sleep(period) => {},
        }
    }
}

pub fn spawn_poller(
    database_path: PathBuf,
    wake: impl Fn(String) + Send + Sync + 'static,
    shutdown: watch::Receiver<bool>,
) {
    let wake: std::sync::Arc<dyn Fn(String) + Send + Sync> = std::sync::Arc::new(wake);
    tokio::spawn(poller_loop(
        move || {
            let database_path = database_path.clone();
            let wake = wake.clone();
            async move {
                let database = Mutex::new(
                    SuplexDatabase::open(&database_path, OpenMode::ReadWrite).map_err(send)?,
                );
                match Github::load().await {
                    Ok(github) => process_enabled_rules(&database, &github, wake.as_ref()).await,
                    Err(error) => record_provider_unavailable(&database, &error).await,
                }
                Ok(())
            }
        },
        shutdown,
        Duration::from_secs(60),
    ));
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use axum::{Json, Router, extract::OriginalUri, http::StatusCode, response::IntoResponse};

    use super::*;
    use crate::{
        http::routes::avatars::tests::{call, json_body},
        identity::auth as identity_auth,
    };

    type Replies = Arc<std::sync::Mutex<HashMap<String, (u16, Value)>>>;

    /// A loopback GitHub REST API answering each path and query from `replies`.
    async fn fake_github(replies: Replies) -> (Github, String, tokio::task::JoinHandle<()>) {
        let app = Router::new().fallback(move |OriginalUri(uri): OriginalUri| {
            let replies = replies.clone();
            async move {
                let key = uri
                    .path_and_query()
                    .map(|value| value.as_str().to_owned())
                    .unwrap_or_default();
                match replies.lock().unwrap().get(&key).cloned() {
                    Some((status, body)) => {
                        let mut response =
                            (StatusCode::from_u16(status).unwrap(), Json(body)).into_response();
                        if status == 429 {
                            let reset = (Utc::now() + chrono::Duration::minutes(10))
                                .timestamp()
                                .to_string();
                            response
                                .headers_mut()
                                .insert("x-ratelimit-reset", reset.parse().unwrap());
                        }
                        response
                    }
                    None => (
                        StatusCode::NOT_FOUND,
                        Json(json!({"message": format!("missing {key}")})),
                    )
                        .into_response(),
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let access =
            crate::integrations::github::Access::for_api(&base, Some("test-token".into())).unwrap();
        let mut github = Github::new(access);
        github.retry_pauses.clear();
        (github, base, server)
    }

    fn pull(number: i64, base_branch: &str, files: i64) -> Value {
        json!({
            "number": number, "html_url": format!("https://github.com/owner/repo/pull/{number}"), "state": "open", "draft": false,
            "changed_files": files, "labels": [{"name": "ready"}], "title": "Candidate",
            "head": {"ref": "feature", "sha": "a".repeat(40), "repo": {"id": 9, "full_name": "owner/repo"}},
            "base": {"ref": base_branch, "sha": "b".repeat(40), "repo": {"id": 9, "full_name": "owner/repo"}},
        })
    }

    fn renamed_file() -> Value {
        json!({"sha": "c", "filename": "src/new.ts", "previous_filename": "src/old.ts", "status": "renamed", "additions": 1, "deletions": 0, "changes": 1,
            "blob_url": "https://github.com/b", "raw_url": "https://github.com/r", "contents_url": "https://api.github.com/c"})
    }

    fn replies(candidates: &[i64]) -> Replies {
        let mut map = HashMap::new();
        map.insert(
            "/repos/owner/repo".into(),
            (200, json!({"id": 9, "full_name": "owner/repo"})),
        );
        map.insert(
            "/repos/owner/repo/labels/ready".into(),
            (200, json!({"name": "ready"})),
        );
        map.insert(
            "/repos/owner/repo/issues?state=open&labels=ready&per_page=100&page=1".into(),
            (
                200,
                json!(
                    candidates
                        .iter()
                        .map(|number| json!({"number": number, "pull_request": {}}))
                        .collect::<Vec<_>>()
                ),
            ),
        );
        Arc::new(std::sync::Mutex::new(map))
    }

    struct Fixture {
        state: AppState,
        filename: PathBuf,
        admin: String,
        cookie: String,
    }

    fn fixture() -> Fixture {
        let (state, filename) = crate::http::routes::auth::tests::state();
        let now = Utc::now();
        let admin = state
            .with_database(|database| identity_auth::development_sign_in(database, now))
            .unwrap();
        state.with_database(|database| {
            let time = rfc3339_millis(now);
            let connection = database.connection();
            connection.execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('c','C','active',?1)", [&time]).unwrap();
            connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('p','c','P','/tmp/trigger-repo','/tmp/trigger-worktrees','owner/repo','main','','','profile_native_root','profile_native_worker','{}',?1,?1)", [&time]).unwrap();
        });
        Fixture {
            state,
            filename,
            cookie: format!("sid_v1={}", admin.session_token),
            admin: admin.user.id,
        }
    }

    fn create_input(paths: &[&str]) -> GithubTriggerCreate {
        GithubTriggerCreate {
            project_id: "p".into(),
            name: "Ready".into(),
            label: "ready".into(),
            workflow_id: "workflow_native_standard".into(),
            delivery_target: crate::tasks::control::DeliveryTarget::PullRequestDraft,
            protected_paths: paths.iter().map(|path| (*path).to_owned()).collect(),
        }
    }

    fn patch(revision: i64) -> GithubTriggerPatch {
        GithubTriggerPatch {
            expected_revision: revision,
            ..GithubTriggerPatch::default()
        }
    }

    fn tasks(state: &AppState) -> i64 {
        state.with_database(|database| {
            database
                .connection()
                .query_row("SELECT count(*) FROM suplex_tasks", [], |row| row.get(0))
                .unwrap()
        })
    }

    #[test]
    fn captured_local_authority_ignores_display_metadata_but_rechecks_execution_facts() {
        let f = fixture();
        let config = Config {
            project_id: "p".into(),
            name: "Ready".into(),
            label: "ready".into(),
            workflow_id: "workflow_native_standard".into(),
            delivery_target: "pull_request_draft".into(),
            protected_paths: vec![],
            authority_user_id: f.admin.clone(),
        };
        let captured = f
            .state
            .with_database(|database| local(database, &f.admin, "c", &config))
            .unwrap();
        f.state.with_database(|database| {
            for sql in [
                "UPDATE suplex_users SET display_name = 'Renamed user' WHERE id = ?1",
                "UPDATE suplex_companies SET name = 'Renamed company' WHERE id = 'c'",
                "UPDATE suplex_projects SET name = 'Renamed project' WHERE id = 'p'",
                "UPDATE suplex_profiles SET updated_at = 'later' WHERE id = 'profile_native_root'",
            ] {
                if sql.contains("?1") {
                    database.connection().execute(sql, [&f.admin]).unwrap();
                } else {
                    database.connection().execute(sql, []).unwrap();
                }
            }
            same_local(database, &f.admin, "c", &config, &captured).unwrap();
        });
        for (change, restore) in [
            (
                "UPDATE suplex_projects SET base_branch = 'release' WHERE id = 'p'",
                "UPDATE suplex_projects SET base_branch = 'main' WHERE id = 'p'",
            ),
            (
                "UPDATE suplex_projects SET repository_identity = 'owner/other' WHERE id = 'p'",
                "UPDATE suplex_projects SET repository_identity = 'owner/repo' WHERE id = 'p'",
            ),
            (
                "UPDATE suplex_profiles SET model = 'changed' WHERE id = 'profile_native_root'",
                "UPDATE suplex_profiles SET model = 'gpt-5.6-sol' WHERE id = 'profile_native_root'",
            ),
            (
                "UPDATE suplex_companies SET status = 'paused' WHERE id = 'c'",
                "UPDATE suplex_companies SET status = 'active' WHERE id = 'c'",
            ),
            (
                "UPDATE suplex_users SET status = 'revoked' WHERE id = ?1",
                "UPDATE suplex_users SET status = 'active' WHERE id = ?1",
            ),
        ] {
            f.state.with_database(|database| {
                if change.contains("?1") {
                    database.connection().execute(change, [&f.admin]).unwrap();
                } else {
                    database.connection().execute(change, []).unwrap();
                }
                assert!(
                    same_local(database, &f.admin, "c", &config, &captured).is_err(),
                    "{change}"
                );
                if restore.contains("?1") {
                    database.connection().execute(restore, [&f.admin]).unwrap();
                } else {
                    database.connection().execute(restore, []).unwrap();
                }
                same_local(database, &f.admin, "c", &config, &captured).unwrap();
            });
        }
        let _ = std::fs::remove_file(f.filename);
    }

    #[tokio::test]
    async fn poller_waits_after_each_pass_and_stops_after_an_in_flight_pass() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let first = Arc::new(tokio::sync::Notify::new());
        let second = Arc::new(tokio::sync::Notify::new());
        let (stop, shutdown) = watch::channel(false);
        let running = tokio::spawn(poller_loop(
            {
                let calls = calls.clone();
                let first = first.clone();
                let second = second.clone();
                move || {
                    let number = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    let first = first.clone();
                    let second = second.clone();
                    async move {
                        match number {
                            1 => first.notified().await,
                            2 => second.notified().await,
                            _ => {}
                        }
                        Ok(())
                    }
                }
            },
            shutdown,
            Duration::from_millis(20),
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        first.notify_one();
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        stop.send(true).unwrap();
        second.notify_one();
        tokio::time::timeout(Duration::from_secs(1), running)
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn poller_retries_after_a_failed_pass() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let (stop, shutdown) = watch::channel(false);
        let running = tokio::spawn(poller_loop(
            {
                let calls = calls.clone();
                move || {
                    let number = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    async move {
                        if number == 1 {
                            Err(public("offline", 503))
                        } else {
                            Ok(())
                        }
                    }
                }
            },
            shutdown,
            Duration::from_millis(20),
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        stop.send(true).unwrap();
        running.await.unwrap();
        assert!(calls.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn routes_create_disabled_rules_check_without_tasks_and_scope_access() {
        let f = fixture();
        let (_, base, server) = fake_github(replies(&[])).await;
        *crate::http::routes::github_triggers::TEST_GITHUB_API
            .lock()
            .unwrap() = Some(base);
        let app = crate::http::router(f.state.clone());
        let cookie = Some(f.cookie.as_str());
        let payload = json!({"projectId":"p","name":" Ready ","label":"ready","workflowId":"workflow_native_standard","deliveryTarget":"pull_request_draft","protectedPaths":["src/"]});
        let (status, _, body) = call(
            &app,
            "POST",
            "/api/companies/c/github-triggers",
            cookie,
            Some(payload.clone()),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "{}",
            String::from_utf8_lossy(&body)
        );
        let created = json_body(&body);
        assert_eq!(
            (
                created["enabled"].clone(),
                created["authorityUserId"].clone(),
                created["repositoryId"].clone(),
                created["name"].clone()
            ),
            (json!(false), json!(f.admin), json!(9), json!("Ready"))
        );
        let id = created["id"].as_str().unwrap().to_owned();
        let (status, _, body) = call(
            &app,
            "POST",
            &format!("/api/companies/c/github-triggers/{id}/check"),
            cookie,
            None,
        )
        .await;
        assert_eq!(
            (status, json_body(&body)),
            (StatusCode::OK, json!({"activity": []}))
        );
        assert_eq!(tasks(&f.state), 0);
        let (_, _, body) = call(
            &app,
            "GET",
            "/api/companies/c/github-triggers",
            cookie,
            None,
        )
        .await;
        assert!(json_body(&body)["rules"][0]["lastSuccessfulCheckAt"].is_string());
        let mut injected = payload.clone();
        injected["authorityUserId"] = json!("other");
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/companies/c/github-triggers",
                cookie,
                Some(injected)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let (status, _, body) = call(
            &app,
            "PATCH",
            &format!("/api/companies/c/github-triggers/{id}"),
            cookie,
            Some(json!({"enabled": true, "expectedRevision": 9})),
        )
        .await;
        assert_eq!(
            (status, json_body(&body)["error"].clone()),
            (
                StatusCode::CONFLICT,
                json!("This GitHub rule changed. Refresh and try again.")
            )
        );
        let (status, _, body) = call(
            &app,
            "PATCH",
            &format!("/api/companies/c/github-triggers/{id}"),
            cookie,
            Some(json!({"archived": true, "expectedRevision": 1})),
        )
        .await;
        assert_eq!(
            (
                status,
                json_body(&body)["archivedAt"].is_string(),
                json_body(&body)["enabled"].clone()
            ),
            (StatusCode::OK, true, json!(false))
        );
        let (status, _, body) = call(
            &app,
            "POST",
            &format!("/api/companies/c/github-triggers/{id}/check"),
            cookie,
            None,
        )
        .await;
        assert_eq!(
            (status, json_body(&body)["error"].clone()),
            (StatusCode::CONFLICT, json!("This GitHub rule is archived"))
        );
        let (status, _, body) = call(
            &app,
            "PATCH",
            &format!("/api/companies/c/github-triggers/{id}"),
            cookie,
            Some(json!({"archived": false, "enabled": true, "expectedRevision": 2})),
        )
        .await;
        assert_eq!(
            (status, json_body(&body)["error"].clone()),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                json!("Restore a rule before enabling it")
            )
        );
        let (status, _, body) = call(
            &app,
            "GET",
            &format!("/api/companies/c/github-triggers/{id}/activity"),
            cookie,
            None,
        )
        .await;
        assert_eq!(
            (status, json_body(&body)),
            (StatusCode::OK, json!({"activity": []}))
        );
        assert_eq!(
            call(&app, "GET", "/api/companies/c/github-triggers", None, None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let member = f.state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'M', 'member', 'member', 'active', ?1, ?1, 1)", [now_millis_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_memberships (company_id, user_id, created_at) VALUES ('c', 'member', ?1)", [now_millis_rfc3339()]).unwrap();
            identity_auth::create_session(database, "member", Utc::now()).unwrap()
        });
        let (status, _, body) = call(
            &app,
            "GET",
            "/api/companies/c/github-triggers",
            Some(&format!("sid_v1={member}")),
            None,
        )
        .await;
        assert_eq!(
            (status, json_body(&body)["error"].clone()),
            (
                StatusCode::FORBIDDEN,
                json!("Administrator access required")
            )
        );
        *crate::http::routes::github_triggers::TEST_GITHUB_API
            .lock()
            .unwrap() = None;
        server.abort();
        drop(app);
        let _ = std::fs::remove_file(f.filename);
    }

    #[tokio::test]
    async fn preview_records_exclusions_failures_and_the_latest_provider_retry() {
        let f = fixture();
        let replies = replies(&[7, 8]);
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7".into(),
            (200, pull(7, "release", 1)),
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7/files?per_page=100&page=1".into(),
            (200, json!([renamed_file()])),
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/8".into(),
            (500, json!({"message": "unavailable"})),
        );
        let (github, _, server) = fake_github(replies.clone()).await;
        let rule = create(&f.state, &github, &f.admin, "c", create_input(&["src/"]))
            .await
            .unwrap();
        let rule = update(
            &f.state,
            &github,
            &f.admin,
            "c",
            &rule.id,
            GithubTriggerPatch {
                enabled: Some(true),
                ..patch(rule.revision)
            },
        )
        .await
        .unwrap();
        let error = check(&f.state, &github, &f.admin, "c", &rule.id)
            .await
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<TriggerFailure>()
                .map(|failure| failure.status),
            Some(502)
        );
        let saved = activity(&f.state, &f.admin, "c", &rule.id).unwrap();
        assert_eq!(
            (saved[0].outcome.as_str(), saved[0].reason.as_str()),
            (
                "excluded",
                "The pull request targets a different base branch."
            )
        );
        assert_eq!(saved[0].matching_paths, ["src/new.ts", "src/old.ts"]);
        assert_eq!(
            (
                saved[1].pull_request_number,
                saved[1].outcome.as_str(),
                saved[1].reason.as_str()
            ),
            (Some(8), "error", UNAVAILABLE)
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/8".into(),
            (429, json!({"message": "API rate limit exceeded"})),
        );
        check(&f.state, &github, &f.admin, "c", &rule.id)
            .await
            .unwrap_err();
        let stored = f
            .state
            .with_database(|database| required_rule(database, "c", &rule.id))
            .unwrap();
        assert!(
            millis(stored.next_retry_at.as_deref().unwrap())
                > Utc::now().timestamp_millis() + 9 * 60_000
        );
        assert_eq!(
            (
                stored.last_successful_check_at,
                stored.failure_count,
                stored.latest_error.as_deref()
            ),
            (None, 2, Some(UNAVAILABLE))
        );
        assert_eq!(
            activity(&f.state, &f.admin, "c", &rule.id)
                .unwrap()
                .last()
                .unwrap()
                .reason,
            "GitHub checks are delayed."
        );
        server.abort();
        let _ = std::fs::remove_file(f.filename);
    }

    #[tokio::test]
    async fn enabled_rule_pass_excludes_ineligible_pull_requests_without_dispatch_or_task() {
        let f = fixture();
        let replies = replies(&[7]);
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7".into(),
            (200, pull(7, "main", 1)),
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7/files?per_page=100&page=1".into(),
            (200, json!([renamed_file()])),
        );
        let (github, _, server) = fake_github(replies).await;
        let rule = create(&f.state, &github, &f.admin, "c", create_input(&["src/"]))
            .await
            .unwrap();
        update(
            &f.state,
            &github,
            &f.admin,
            "c",
            &rule.id,
            GithubTriggerPatch {
                enabled: Some(true),
                ..patch(rule.revision)
            },
        )
        .await
        .unwrap();
        process_enabled_rules(&f.state, &github, &|_| {}).await;
        let saved = activity(&f.state, &f.admin, "c", &rule.id).unwrap();
        assert_eq!(
            (saved.len(), saved[0].reason.as_str()),
            (1, "The pull request changes a protected path.")
        );
        let dispatched: i64 = f.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT count(*) FROM suplex_github_trigger_dispatches",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        });
        assert_eq!((dispatched, tasks(&f.state)), (0, 0));
        let stored = f
            .state
            .with_database(|database| required_rule(database, "c", &rule.id))
            .unwrap();
        assert!(stored.last_successful_check_at.is_some());
        server.abort();
        let _ = std::fs::remove_file(f.filename);
    }

    #[tokio::test]
    async fn unavailable_github_access_records_the_provider_error_on_every_due_rule() {
        let f = fixture();
        let (github, _, server) = fake_github(replies(&[])).await;
        let rule = create(&f.state, &github, &f.admin, "c", create_input(&[]))
            .await
            .unwrap();
        update(
            &f.state,
            &github,
            &f.admin,
            "c",
            &rule.id,
            GithubTriggerPatch {
                enabled: Some(true),
                ..patch(rule.revision)
            },
        )
        .await
        .unwrap();
        server.abort();
        let denied = crate::integrations::github_delivery::failure(
            "authentication-required",
            "GitHub sign-in is necessary",
        );
        record_provider_unavailable(&f.state, &denied).await;
        let stored = f
            .state
            .with_database(|database| required_rule(database, "c", &rule.id))
            .unwrap();
        assert!(stored.latest_error.is_some());
        assert!(stored.next_retry_at.is_some());
        let _ = std::fs::remove_file(f.filename);
    }

    #[tokio::test]
    async fn dispatch_capture_is_immutable_and_links_only_its_exact_task() {
        let f = fixture();
        let (github, _, server) = fake_github(replies(&[])).await;
        let rule = create(&f.state, &github, &f.admin, "c", create_input(&[]))
            .await
            .unwrap();
        let rule = update(
            &f.state,
            &github,
            &f.admin,
            "c",
            &rule.id,
            GithubTriggerPatch {
                enabled: Some(true),
                ..patch(rule.revision)
            },
        )
        .await
        .unwrap();
        let expected = f
            .state
            .with_database(|database| local(database, &f.admin, "c", &Config::from(&rule)))
            .unwrap();
        let input = |number: i64| DispatchPrepare {
            rule_id: rule.id.clone(),
            company_id: "c".into(),
            project_id: "p".into(),
            repository_id: 9,
            repository_name: "owner/repo".into(),
            pull_request_number: number,
            authority_user_id: f.admin.clone(),
            request: json!({"projectId":"p","title":"Candidate","description":"Apply the selected workflow to this pull request.","images":[],
                "rootProfileId":"profile_native_root","workerProfileId":"profile_native_worker","advisorProfileIds":{},"workflow":"standard",
                "deliveryTarget":"pull_request_draft","runProjectTests":true,"visualEvidence":"off","source":{"kind":"pull_request","number":number}}),
            policy: DispatchPolicy {
                head_sha: "a".repeat(40),
                base_sha: "b".repeat(40),
                head_branch: "feature".into(),
                base_branch: "main".into(),
                protected_paths: vec![],
                repository_id: 9,
                repository_name: "owner/repo".into(),
                delivery_target: "pull_request_draft".into(),
            },
            preset: expected.preset.clone(),
            profiles: expected.dependencies.profiles.clone(),
        };
        let first = f
            .state
            .with_database(|database| dispatches::prepare(database, input(7)))
            .unwrap();
        let again = f
            .state
            .with_database(|database| dispatches::prepare(database, input(7)))
            .unwrap();
        assert_eq!(first, again);
        let mut changed_retry = input(7);
        changed_retry.request["title"] = json!("Changed since capture");
        changed_retry.preset["visualEvidence"] = json!("required");
        let replay = f
            .state
            .with_database(|database| dispatches::prepare(database, changed_retry))
            .unwrap();
        assert_eq!(replay, first);
        assert_eq!(
            first.idempotency_key,
            format!("github-trigger:{}", first.id)
        );
        assert!(!first.request_body().unwrap().start_immediately);
        let mut contradictory = input(8);
        contradictory.request["source"]["number"] = json!(9);
        assert_eq!(
            f.state
                .with_database(|database| dispatches::prepare(database, contradictory))
                .unwrap_err()
                .to_string(),
            "GitHub trigger dispatch capture is contradictory"
        );
        let unknown = f
            .state
            .with_database(|database| dispatches::link_task(database, &first.id, "missing"))
            .unwrap_err();
        assert_eq!(
            unknown.to_string(),
            "Task does not match GitHub trigger dispatch"
        );
        assert!(
            f.state
                .with_database(|database| dispatches::trigger_delivery_policy(database, "missing"))
                .unwrap()
                .is_none()
        );
        // The task host admits only enabled rules; the linked dispatch appears in activity.
        f.state.with_database(|database| {
            let time = now_millis_rfc3339();
            database.connection().execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_user_id,created_at,updated_at) VALUES ('task_x','c','p','T','','{}','k','h',?1,?2,?2)", params![f.admin, time]).unwrap();
            database.connection().execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,status_changed_at,created_at,updated_at) VALUES ('task_x','T','pull_request_draft','{}','backlog','{}','{}','standard','{}','{}',?1,?1,?1)", [&time]).unwrap();
            database.connection().execute("UPDATE suplex_github_trigger_dispatches SET task_id = 'task_x' WHERE id = ?1", [&first.id]).unwrap();
        });
        let listed = activity(&f.state, &f.admin, "c", &rule.id).unwrap();
        assert_eq!(
            (
                listed[0].task_id.as_deref(),
                listed[0].task_status.as_deref(),
                listed[0].reason.as_str()
            ),
            (Some("task_x"), Some("backlog"), "Backlog task created.")
        );
        let policy = f
            .state
            .with_database(|database| dispatches::trigger_delivery_policy(database, "task_x"))
            .unwrap()
            .unwrap();
        assert_eq!(
            (policy.pull_request_number, policy.head_sha.clone()),
            (7, "a".repeat(40))
        );
        let review = json!({"baseSha": "b".repeat(40), "headSha": "d".repeat(40), "files": [], "commits": []});
        f.state
            .with_database(|database| {
                dispatches::record_trigger_push(
                    database,
                    "task_x",
                    &first.id,
                    &"a".repeat(40),
                    &"d".repeat(40),
                    &review,
                )
            })
            .unwrap();
        f.state
            .with_database(|database| {
                dispatches::record_trigger_push(
                    database,
                    "task_x",
                    &first.id,
                    &"a".repeat(40),
                    &"d".repeat(40),
                    &review,
                )
            })
            .unwrap();
        assert!(
            f.state
                .with_database(|database| dispatches::record_trigger_push(
                    database,
                    "task_x",
                    &first.id,
                    &"c".repeat(40),
                    &"d".repeat(40),
                    &review
                ))
                .is_err()
        );
        server.abort();
        let _ = std::fs::remove_file(f.filename);
    }

    #[tokio::test]
    async fn inspection_pages_files_rechecks_the_revision_and_rejects_malformed_data() {
        let replies = replies(&[]);
        let (github, _, server) = fake_github(replies.clone()).await;
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7".into(),
            (200, pull(7, "main", 1)),
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7/files?per_page=100&page=1".into(),
            (200, json!([renamed_file()])),
        );
        let inspected = inspect_pull_request(&github, "Owner/Repo", 7)
            .await
            .unwrap();
        assert_eq!(
            (
                inspected.files.len(),
                inspected.is_cross_repository,
                inspected.base_repository.full_name.as_str()
            ),
            (1, false, "owner/repo")
        );
        let mut malformed = renamed_file();
        malformed
            .as_object_mut()
            .unwrap()
            .remove("previous_filename");
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7/files?per_page=100&page=1".into(),
            (200, json!([malformed])),
        );
        assert_eq!(
            inspect_pull_request(&github, "owner/repo", 7)
                .await
                .unwrap_err()
                .summary,
            "GitHub trigger response is malformed: pull request rename metadata"
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7/files?per_page=100&page=1".into(),
            (200, json!([])),
        );
        assert_eq!(
            inspect_pull_request(&github, "owner/repo", 7)
                .await
                .unwrap_err()
                .summary,
            "GitHub trigger response is malformed: incomplete pull request file list"
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/issues?state=open&labels=ready&per_page=100&page=1".into(),
            (
                200,
                json!([{"number": 3}, {"number": 3, "pull_request": {}}]),
            ),
        );
        assert_eq!(
            list_open_pull_requests_by_label(&github, "owner/repo", "ready")
                .await
                .unwrap_err()
                .summary,
            "GitHub trigger response is malformed: duplicate labelled issue page"
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/labels/ready".into(),
            (200, json!({"name": "Ready"})),
        );
        assert_eq!(
            validate_label(&github, "owner/repo", "ready")
                .await
                .unwrap_err()
                .summary,
            "GitHub trigger response is malformed: repository label"
        );
        server.abort();
    }

    #[tokio::test]
    async fn inspection_reads_every_file_page_through_the_three_thousand_file_limit() {
        for count in [101, 3000] {
            let replies = replies(&[]);
            replies.lock().unwrap().insert(
                "/repos/owner/repo/pulls/7".into(),
                (200, pull(7, "main", count)),
            );
            for page in 1..=((count + 99) / 100) {
                let start = (page - 1) * 100;
                let files = (start..(start + 100).min(count))
                    .map(|index| {
                        let mut file = renamed_file();
                        file["status"] = json!("modified");
                        file.as_object_mut().unwrap().remove("previous_filename");
                        file["filename"] = json!(format!("src/{index}.ts"));
                        file
                    })
                    .collect::<Vec<_>>();
                replies.lock().unwrap().insert(
                    format!("/repos/owner/repo/pulls/7/files?per_page=100&page={page}"),
                    (200, json!(files)),
                );
            }
            let (github, _, server) = fake_github(replies).await;
            let inspected = inspect_pull_request(&github, "owner/repo", 7)
                .await
                .unwrap();
            assert_eq!(inspected.files.len(), count as usize);
            server.abort();
        }
    }

    #[tokio::test]
    async fn labelled_issue_pages_keep_only_pull_requests_and_reject_later_failures() {
        let replies = replies(&[]);
        let first = (1..=100)
            .map(|number| json!({"number": number, "pull_request": {}}))
            .collect::<Vec<_>>();
        let path = "/repos/owner/repo/issues?state=open&labels=ready&per_page=100&page=";
        replies
            .lock()
            .unwrap()
            .insert(format!("{path}1"), (200, json!(first)));
        replies.lock().unwrap().insert(
            format!("{path}2"),
            (
                200,
                json!([{"number":101,"pull_request":{}},{"number":102}]),
            ),
        );
        let (github, _, server) = fake_github(replies.clone()).await;
        assert_eq!(
            list_open_pull_requests_by_label(&github, "owner/repo", "ready")
                .await
                .unwrap(),
            (1..=101).collect::<Vec<_>>()
        );
        replies
            .lock()
            .unwrap()
            .insert(format!("{path}2"), (500, json!({"message":"offline"})));
        assert!(
            list_open_pull_requests_by_label(&github, "owner/repo", "ready")
                .await
                .is_err()
        );
        server.abort();
    }

    #[tokio::test]
    async fn admission_capture_stores_its_exact_request_and_profiles_and_links_its_task() {
        let f = fixture();
        let plans = f.state.with_database(|database| {
            let values = json!({"name": "Plans", "description": "", "engine": "competing_plans",
                "advisorProfileIds": {"planner_b": "profile_native_root"}});
            workflow_records::create(database, &f.admin, values.as_object().unwrap().clone())
                .map(|record| json!(record)["id"].as_str().unwrap().to_owned())
                .unwrap()
        });
        let replies = replies(&[]);
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7".into(),
            (200, pull(7, "main", 1)),
        );
        replies.lock().unwrap().insert(
            "/repos/owner/repo/pulls/7/files?per_page=100&page=1".into(),
            (200, json!([{"sha": "c", "filename": "docs/a.md", "status": "modified", "additions": 1, "deletions": 0, "changes": 1,
                "blob_url": "https://github.com/b", "raw_url": "https://github.com/r", "contents_url": "https://api.github.com/c"}])),
        );
        let (github, _, server) = fake_github(replies).await;
        let rule = create(
            &f.state,
            &github,
            &f.admin,
            "c",
            GithubTriggerCreate {
                workflow_id: plans,
                ..create_input(&[])
            },
        )
        .await
        .unwrap();
        let rule = update(
            &f.state,
            &github,
            &f.admin,
            "c",
            &rule.id,
            GithubTriggerPatch {
                enabled: Some(true),
                ..patch(rule.revision)
            },
        )
        .await
        .unwrap();
        let expected = f
            .state
            .with_database(|database| local(database, &f.admin, "c", &Config::from(&rule)))
            .unwrap();
        let pull = inspect_pull_request(&github, "owner/repo", 7)
            .await
            .unwrap();
        let mut activity = Vec::new();
        let pass = Pass {
            database: &f.state,
            github: &github,
            rule: &rule,
            wake: &|_| {},
            config: Config::from(&rule),
            expected,
            activity: &mut activity,
            failed: false,
            provider_retry: None,
        };
        let dispatch = f
            .state
            .with_database(|database| dispatches::prepare(database, pass.capture(&pull)))
            .unwrap();
        let (request, profiles): (String, String) = f.state.with_database(|database| {
            database.connection().query_row(
                "SELECT request_json, profiles_json FROM suplex_github_trigger_dispatches WHERE id = ?1",
                [&dispatch.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        }).unwrap();
        // The stored bytes are the ones the untyped capture wrote.
        assert_eq!(
            request.replace(&dispatch.id, "ID"),
            r#"{"projectId":"p","title":"Candidate","description":"Apply the selected workflow to this pull request.","idempotencyKey":"github-trigger:ID","images":[],"rootProfileId":"profile_native_root","workerProfileId":"profile_native_worker","startImmediately":false,"deliveryTarget":"pull_request_draft","runProjectTests":true,"visualEvidence":"off","source":{"kind":"pull_request","number":7},"workflow":"competing_plans","advisorProfileIds":{"planner_a":"profile_native_root","planner_b":"profile_native_root"},"dependsOn":[],"blockedByPullRequests":[]}"#
        );
        assert_eq!(
            profiles,
            r#"{"root":{"profileId":"profile_native_root","provider":"codex","model":"gpt-5.6-sol","reasoningLevel":"medium","serviceTier":"default"},"worker":{"profileId":"profile_native_worker","provider":"codex","model":"gpt-5.6-luna","reasoningLevel":"max","serviceTier":"priority"},"advisors":{"planner_a":{"profileId":"profile_native_root","provider":"codex","model":"gpt-5.6-sol","reasoningLevel":"medium","serviceTier":"default"},"planner_b":{"profileId":"profile_native_root","provider":"codex","model":"gpt-5.6-sol","reasoningLevel":"medium","serviceTier":"default"}}}"#
        );
        assert!(still_eligible(&dispatch, &pull, "ready"));
        assert!(!still_eligible(&dispatch, &pull, "other"));
        // A backlog task created from exactly this capture links; another profile does not.
        let hash =
            commands::task_request_hash(&dispatch.request_body().unwrap(), &f.admin).unwrap();
        let insert = |id: &str, root: &TaskProfile| {
            f.state.with_database(|database| {
                let time = now_millis_rfc3339();
                let configuration = json!({"repository": "Owner/Repo", "source": {"kind": "pull_request", "number": 7},
                    "startingSha": "a".repeat(40), "baselineSha": "b".repeat(40), "branch": "feature", "baseBranch": "main",
                    "runProjectTests": true, "visualEvidence": "off"});
                database.connection().execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_user_id,created_at,updated_at) VALUES (?1,'c','p','T','',?2,?3,?4,?5,?6,?6)",
                    params![id, configuration.to_string(), dispatch.idempotency_key, hash, f.admin, time]).unwrap();
                database.connection().execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,status_changed_at,created_at,updated_at) VALUES (?1,'T','pull_request_draft','{}','backlog',?2,?3,'competing_plans',?4,'{}',?5,?5,?5)",
                    params![id, serde_json::to_string(root).unwrap(), serde_json::to_string(&dispatch.profiles.worker).unwrap(), serde_json::to_string(&dispatch.profiles.advisors).unwrap(), time]).unwrap();
            })
        };
        let other = TaskProfile {
            model: "other".into(),
            ..dispatch.profiles.root.clone()
        };
        insert("task_other", &other);
        let project = f
            .state
            .with_database(|database| projects::get(database, &f.admin, "p"))
            .unwrap();
        let body = dispatch.request_body().unwrap();
        let before: (i64, i64, i64) = f.state.with_database(|database| database.connection().query_row(
            "SELECT (SELECT count(*) FROM suplex_tasks), (SELECT next_issue_number FROM suplex_companies WHERE id = 'c'), (SELECT count(*) FROM suplex_audit_events WHERE action = 'task_created')",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).unwrap());
        let drift = sources::captured_pull_request_for_test(7, &"d".repeat(40), &"b".repeat(40));
        assert!(
            f.state
                .with_database(|database| create_captured(
                    database,
                    &dispatch,
                    &project,
                    &body,
                    drift,
                    &"b".repeat(40),
                    &|_| {}
                ))
                .is_err()
        );
        // A concurrent linkage failure must roll the entire task write back.
        f.state.with_database(|database| {
            database.connection().execute("UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.source.number', 8) WHERE id = 'task_other'", []).unwrap();
            database.connection().execute("UPDATE suplex_tasks SET idempotency_key = 'unrelated-task' WHERE id = 'task_other'", []).unwrap();
            database.connection().execute("UPDATE suplex_github_trigger_dispatches SET task_id = 'task_other' WHERE id = ?1", [&dispatch.id]).unwrap();
        });
        let captured = sources::captured_pull_request_for_test(7, &"a".repeat(40), &"b".repeat(40));
        assert_eq!(
            f.state
                .with_database(|database| create_captured(
                    database,
                    &dispatch,
                    &project,
                    &body,
                    captured,
                    &"b".repeat(40),
                    &|_| {}
                ))
                .unwrap_err()
                .to_string(),
            "GitHub trigger dispatch already links another task"
        );
        let after: (i64, i64, i64) = f.state.with_database(|database| database.connection().query_row(
            "SELECT (SELECT count(*) FROM suplex_tasks), (SELECT next_issue_number FROM suplex_companies WHERE id = 'c'), (SELECT count(*) FROM suplex_audit_events WHERE action = 'task_created')",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).unwrap());
        assert_eq!(after, before);
        f.state.with_database(|database| {
            database.connection().execute("UPDATE suplex_github_trigger_dispatches SET task_id = NULL WHERE id = ?1", [&dispatch.id]).unwrap();
            database.connection().execute("UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.source.number', 7) WHERE id = 'task_other'", []).unwrap();
            database.connection().execute("UPDATE suplex_tasks SET idempotency_key = ?1 WHERE id = 'task_other'", [&dispatch.idempotency_key]).unwrap();
            database.connection().execute("INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) SELECT 'other_creator',display_name,'other_creator',role,status,created_at,updated_at,identity_version FROM suplex_users WHERE id = ?1", [&f.admin]).unwrap();
        });
        for (change, restore, original) in [
            (
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.startingSha', 'wrong') WHERE id = 'task_other'",
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.startingSha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') WHERE id = 'task_other'",
                None,
            ),
            (
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.baselineSha', 'wrong') WHERE id = 'task_other'",
                "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.baselineSha', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') WHERE id = 'task_other'",
                None,
            ),
            (
                "UPDATE suplex_task_controls SET delivery_target = 'local_worktree' WHERE task_id = 'task_other'",
                "UPDATE suplex_task_controls SET delivery_target = 'pull_request_draft' WHERE task_id = 'task_other'",
                None,
            ),
            (
                "UPDATE suplex_tasks SET request_hash = 'wrong' WHERE id = 'task_other'",
                "UPDATE suplex_tasks SET request_hash = ?1 WHERE id = 'task_other'",
                Some(hash.as_str()),
            ),
            (
                "UPDATE suplex_tasks SET creator_user_id = 'other_creator' WHERE id = 'task_other'",
                "UPDATE suplex_tasks SET creator_user_id = ?1 WHERE id = 'task_other'",
                Some(f.admin.as_str()),
            ),
            (
                "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = 'task_other'",
                "UPDATE suplex_task_controls SET status = 'backlog' WHERE task_id = 'task_other'",
                None,
            ),
        ] {
            f.state.with_database(|database| {
                database.connection().execute(change, []).unwrap();
                assert!(dispatches::link_task(database, &dispatch.id, "task_other").is_err());
                assert!(
                    dispatches::get(database, &dispatch.id)
                        .unwrap()
                        .unwrap()
                        .task_id
                        .is_none()
                );
                match original {
                    Some(value) => database.connection().execute(restore, [value]).unwrap(),
                    None => database.connection().execute(restore, []).unwrap(),
                };
            });
        }
        assert_eq!(
            f.state
                .with_database(|database| dispatches::link_task(
                    database,
                    &dispatch.id,
                    "task_other"
                ))
                .unwrap_err()
                .to_string(),
            "Task profiles do not match GitHub trigger dispatch"
        );
        f.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_task_controls SET root_profile_json = ?1 WHERE task_id = 'task_other'",
                    [serde_json::to_string(&dispatch.profiles.root).unwrap()],
                )
                .unwrap();
        });
        let linked = f
            .state
            .with_database(|database| dispatches::link_task(database, &dispatch.id, "task_other"))
            .unwrap();
        assert_eq!(linked.task_id.as_deref(), Some("task_other"));
        let replay = f
            .state
            .with_database(|database| dispatches::link_task(database, &dispatch.id, "task_other"))
            .unwrap();
        assert_eq!(replay, linked);
        server.abort();
        let _ = std::fs::remove_file(f.filename);
    }
}
