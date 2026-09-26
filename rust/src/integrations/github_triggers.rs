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
    github_triggers_dispatches::{self as dispatches, Dispatch, DispatchPolicy, DispatchPrepare},
    github_triggers_inspection::{
        PullRequestInspection, inspect_pull_request, list_open_pull_requests_by_label,
        matches_protected_paths, observe_repository, validate_label, validate_protected_paths,
    },
};
use crate::{
    coordination::{workflow_records, workflows::workflow_definition},
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
    tasks::{commands, repository::assert_pull_request_available, sources},
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

fn get_rule(database: &SuplexDatabase, company_id: &str, id: &str) -> DatabaseResult<Option<Rule>> {
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
        &random_hex_id("audit")?,
        (Some(user_id), None),
        action,
        None,
        Some(&rule.company_id),
        &json!({"ruleId": rule.id}).to_string(),
        &now_millis_rfc3339(),
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
fn record(
    database: &mut SuplexDatabase,
    rule: &Rule,
    activity: &[Activity],
    success: bool,
    error: Option<&str>,
    next_retry_at: Option<&str>,
    disable: bool,
    verify: impl FnOnce(&SuplexDatabase) -> DatabaseResult<()>,
) -> DatabaseResult<bool> {
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

/// Local facts a dispatch depends on; `dependencies` must not change before a write.
#[derive(Clone, Debug)]
pub struct Local {
    repository: String,
    base_branch: String,
    preset: Value,
    engine: String,
    run_project_tests: bool,
    visual_evidence: String,
    profiles: Vec<Value>,
    dependencies: Value,
}

/// TypeScript `normalizeWorkflowInput` applied to a stored workflow preset.
fn normalized_run_project_tests(
    preset: &Value,
    delivery_target: &str,
) -> Result<Option<bool>, String> {
    let engine = preset["engine"].as_str().unwrap_or_default();
    let definition = workflow_definition(engine).ok_or("The selected workflow does not exist")?;
    let advisors = preset["advisorProfileIds"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let extra = ["reviewer", "planner_a", "planner_b", "rater"]
        .iter()
        .filter(|role| {
            advisors.get(**role).is_some_and(|value| !value.is_null())
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
    let run = preset["runProjectTests"].as_bool();
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

fn local(
    database: &SuplexDatabase,
    actor: &str,
    company_id: &str,
    config: &Config,
) -> DatabaseResult<Local> {
    let failure = |message: String, status: u16| -> Box<dyn Error> {
        Box::new(TriggerFailure {
            message,
            status,
            retry_at: None,
        })
    };
    admin(database, actor, company_id)?;
    if active_role(database, &config.authority_user_id)?.as_deref() != Some("admin") {
        return Err(failure("GitHub authority is unavailable".into(), 422));
    }
    let company =
        companies::require_company_access(database, &config.authority_user_id, company_id)?;
    if company.status != "active" {
        return Err(failure("Company is not active".into(), 409));
    }
    let project = projects::get(database, &config.authority_user_id, &config.project_id)?;
    if project.company_id != company_id {
        return Err(ProjectError::new("Not found", 404, vec![]).into());
    }
    let repository = project
        .repository
        .clone()
        .ok_or_else(|| failure("Project repository is not configured".into(), 422))?;
    let preset = workflow_records::list(database, &config.authority_user_id, true)?
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .find(|record| record["id"] == config.workflow_id.as_str())
        .ok_or_else(|| failure("Not found".into(), 404))?;
    if !preset["archivedAt"].is_null() {
        return Err(failure("Selected workflow is archived".into(), 422));
    }
    let run = normalized_run_project_tests(&preset, &config.delivery_target)
        .map_err(|message| failure(message, 422))?;
    let engine = preset["engine"].as_str().unwrap_or_default().to_owned();
    let root_default = preset["rootProfileId"]
        .as_str()
        .unwrap_or(&project.root_profile_id)
        .to_owned();
    let mut ids = vec![
        (root_default.clone(), "root"),
        (
            preset["workerProfileId"]
                .as_str()
                .unwrap_or(&project.worker_profile_id)
                .to_owned(),
            "worker",
        ),
    ];
    for role in workflow_definition(&engine).map_or(&[][..], |definition| definition.advisor_roles)
    {
        ids.push((
            preset["advisorProfileIds"][*role]
                .as_str()
                .unwrap_or(&root_default)
                .to_owned(),
            "root",
        ));
    }
    let mut profiles = Vec::new();
    for (id, role) in ids {
        let profile = database.connection().query_row(
            "SELECT id, provider, model, reasoning_level, service_tier FROM suplex_profiles WHERE id = ?1 AND role = ?2 AND archived_at IS NULL",
            params![id, role],
            |row| Ok(json!({"profileId": row.get::<_, String>(0)?, "provider": row.get::<_, String>(1)?, "model": row.get::<_, String>(2)?, "reasoningLevel": row.get::<_, String>(3)?, "serviceTier": row.get::<_, String>(4)?})),
        ).optional()?;
        profiles.push(
            profile
                .ok_or_else(|| failure("Selected workflow profile is unavailable".into(), 422))?,
        );
    }
    validate_protected_paths(&config.protected_paths)
        .map_err(|_| failure("Protected paths are invalid".into(), 422))?;
    let run_project_tests = run.unwrap_or(true);
    let visual_evidence = preset["visualEvidence"]
        .as_str()
        .unwrap_or("off")
        .to_owned();
    Ok(Local {
        dependencies: json!({
            "project": {"repository": repository, "repositoryPath": project.repository_path, "worktreeRoot": project.worktree_root, "baseBranch": project.base_branch, "setupCommand": project.setup_command, "verificationCommand": project.verification_command},
            "workflow": {"engine": engine, "runProjectTests": run_project_tests, "visualEvidence": visual_evidence},
            "profiles": profiles,
        }),
        repository,
        base_branch: project.base_branch,
        preset,
        engine,
        run_project_tests,
        visual_evidence,
        profiles,
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
        return Err(Box::new(TriggerFailure {
            message: CHANGED.into(),
            status: 409,
            retry_at: None,
        }));
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
        provider(github, &expected.repository, &config.label).await?;
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
        provider(github, &expected.repository, &config.label).await?;
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
                false,
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
    let (binding_id, binding_name) = provider(github, &expected.repository, &rule.label).await?;
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
                false,
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
        let observed: Result<Activity, Failure> = async {
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
            } else if pull.base_branch != expected.base_branch {
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
                    dispatches::previously_processed(
                        database,
                        pull.base_repository.id,
                        pull.number,
                    )?,
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
        record(
            database,
            rule,
            activity,
            true,
            None,
            None,
            false,
            |database| same_local(database, user_id, company_id, config, &expected),
        )
    })?;
    if !recorded {
        return Err(public(CHANGED, 409));
    }
    Ok(std::mem::take(activity))
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
    } else if pull.base_branch != local.base_branch {
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
            false,
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
    let (binding_id, binding_name) = provider(github, &expected.repository, &rule.label).await?;
    if binding_id != rule.repository_id || binding_name != rule.repository_name.to_lowercase() {
        let retry = rfc3339_millis(Utc::now() + chrono::Duration::seconds(60));
        db(database, |database| {
            record(
                database,
                rule,
                &[],
                false,
                Some("Repository binding changed. The rule was disabled."),
                Some(&retry),
                true,
                |_| Ok(()),
            )
        })?;
        return Ok(());
    }
    let rule_current = |database: &SuplexDatabase| -> DatabaseResult<()> {
        let current = required_rule(database, company, &rule.id)?;
        if !current.enabled
            || current.revision != rule.revision
            || current.authority_user_id != rule.authority_user_id
        {
            return Err(Box::new(TriggerFailure {
                message: CHANGED.into(),
                status: 409,
                retry_at: None,
            }));
        }
        same_local(database, authority, company, &config, &expected)
    };
    let (mut failed, mut provider_retry) = (false, None);
    let fail = |error: Failure,
                number: i64,
                task_id: Option<String>,
                activity: &mut Vec<Activity>|
     -> Option<String> {
        let (text, retry) = message(error.as_ref());
        activity.push(Activity {
            previously_processed: task_id.is_some(),
            task_status: task_id.as_ref().map(|_| "backlog".to_owned()),
            task_id,
            ..Activity::new(number, None, "error", &text)
        });
        retry
    };
    let pending = db(database, |database| dispatches::unfinished(database))?
        .into_iter()
        .filter(|value| value.rule_id == rule.id);
    for pending in pending {
        let result: Result<Option<Activity>, Failure> = async {
            let pull = inspect_pull_request(
                github,
                &pending.repository_name,
                pending.pull_request_number,
            )
            .await?;
            let (reason, matching) = db(database, |database| {
                eligible(database, rule, &expected, &pull, Some(&pending.policy))
            })?;
            if let Some(reason) = reason {
                return Ok(Some(Activity {
                    matching_paths: matching,
                    ..Activity::new(pull.number, Some(&pull.url), "excluded", reason)
                }));
            }
            db(database, |database| rule_current(database))?;
            let (task_id, status) = create_task_from_trigger(database, &pending.id, wake).await?;
            Ok(Some(Activity {
                task_id: Some(task_id),
                task_status: Some(status),
                previously_processed: true,
                ..Activity::new(
                    pull.number,
                    Some(&pull.url),
                    "eligible",
                    "Backlog task created.",
                )
            }))
        }
        .await;
        match result {
            Ok(value) => activity.extend(value),
            Err(error) => {
                failed = true;
                provider_retry = later(
                    provider_retry,
                    fail(error, pending.pull_request_number, None, activity),
                );
            }
        }
    }
    for linked in db(database, |database| {
        dispatches::list_by_rule(database, company, &rule.id)
    })?
    .into_iter()
    .filter(|value| value.task_id.is_some())
    {
        if let Err(error) = start_task_from_trigger(database, github, &linked.id, wake).await {
            // Start failures keep the provider retry of the next pass.
            failed = true;
            fail(
                error,
                linked.pull_request_number,
                linked.task_id.clone(),
                activity,
            );
        }
    }
    for number in
        list_open_pull_requests_by_label(github, &rule.repository_name, &rule.label).await?
    {
        let result: Result<Activity, Failure> = async {
            let pull = inspect_pull_request(github, &rule.repository_name, number).await?;
            let (reason, matching) = db(database, |database| eligible(database, rule, &expected, &pull, None))?;
            let prior = db(database, |database| dispatches::find(database, &rule.id, pull.base_repository.id, pull.number))?;
            if reason.is_some() || prior.is_some() {
                let task_id = prior.as_ref().and_then(|prior| prior.task_id.clone());
                let task_status = match &task_id { Some(id) => Some(task_status(database, authority, id)?), None => None };
                let reason = if prior.is_some() { "This pull request was previously processed." } else { reason.unwrap_or_default() };
                return Ok(Activity { matching_paths: matching, previously_processed: prior.is_some(), task_id, task_status, ..Activity::new(pull.number, Some(&pull.url), "excluded", reason) });
            }
            let last = inspect_pull_request(github, &rule.repository_name, pull.number).await?;
            let (last_reason, _) = db(database, |database| eligible(database, rule, &expected, &last, None))?;
            if last.head_sha != pull.head_sha || last.base_sha != pull.base_sha || last.head_branch != pull.head_branch || last.base_branch != pull.base_branch || last_reason.is_some() {
                return Ok(Activity::new(pull.number, Some(&last.url), "excluded", "The pull request changed before admission."));
            }
            let roles = workflow_definition(&expected.engine).map_or(&[][..], |definition| definition.advisor_roles);
            let advisors = roles.iter().enumerate().map(|(index, role)| ((*role).to_owned(), expected.profiles[index + 2].clone())).collect::<serde_json::Map<_, _>>();
            let advisor_ids = advisors.iter().map(|(role, profile)| (role.clone(), profile["profileId"].clone())).collect::<serde_json::Map<_, _>>();
            let request = json!({
                "projectId": rule.project_id, "title": pull.title, "description": "Apply the selected workflow to this pull request.", "images": [],
                "rootProfileId": expected.profiles[0]["profileId"], "workerProfileId": expected.profiles[1]["profileId"], "advisorProfileIds": advisor_ids,
                "workflow": expected.engine, "deliveryTarget": rule.delivery_target, "runProjectTests": expected.run_project_tests, "visualEvidence": expected.visual_evidence,
                "source": {"kind": "pull_request", "number": pull.number},
            });
            let prepared = db(database, |database| database.transaction(true, |database| {
                rule_current(database)?;
                assert_pull_request_available(database, "", &rule.repository_name, pull.number)?;
                dispatches::prepare(database, DispatchPrepare {
                    rule_id: rule.id.clone(), company_id: company.to_owned(), project_id: rule.project_id.clone(),
                    repository_id: rule.repository_id, repository_name: rule.repository_name.clone(), pull_request_number: pull.number,
                    authority_user_id: authority.to_owned(), request,
                    policy: DispatchPolicy { head_sha: pull.head_sha.clone(), base_sha: pull.base_sha.clone(), head_branch: pull.head_branch.clone(), base_branch: pull.base_branch.clone(), protected_paths: rule.protected_paths.clone(), repository_id: rule.repository_id, repository_name: rule.repository_name.clone(), delivery_target: rule.delivery_target.clone() },
                    preset: expected.preset.clone(),
                    profiles: json!({"root": expected.profiles[0], "worker": expected.profiles[1], "advisors": advisors}),
                })
            }))?;
            create_task_from_trigger(database, &prepared.id, wake).await?;
            let (task_id, status) = start_task_from_trigger(database, github, &prepared.id, wake).await?;
            Ok(Activity { task_id: Some(task_id), task_status: Some(status), previously_processed: true, ..Activity::new(pull.number, Some(&pull.url), "eligible", "Task started.") })
        }.await;
        match result {
            Ok(value) => activity.push(value),
            Err(error) => {
                failed = true;
                provider_retry = later(provider_retry, fail(error, number, None, activity));
            }
        }
    }
    if failed {
        let retry = retry_after(rule.failure_count, provider_retry.as_deref());
        db(database, |database| {
            record(
                database,
                rule,
                activity,
                false,
                Some(UNAVAILABLE),
                Some(&retry),
                false,
                |_| Ok(()),
            )
        })?;
    } else if !db(database, |database| {
        record(
            database,
            rule,
            activity,
            true,
            None,
            None,
            false,
            |database| same_local(database, authority, company, &config, &expected),
        )
    })? {
        return Err(public(CHANGED, 409));
    }
    Ok(())
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
    let rule: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_github_trigger_rules WHERE id = ?1 AND company_id = ?2 AND project_id = ?3 AND repository_id = ?4 AND lower(repository_name) = lower(?5) AND authority_user_id = ?6 AND enabled = 1 AND archived_at IS NULL)",
        params![dispatch.rule_id, dispatch.company_id, dispatch.project_id, dispatch.repository_id, dispatch.repository_name, dispatch.authority_user_id],
        |row| row.get(0),
    )?;
    if !rule {
        return Err(failure("GitHub trigger rule is not available", 409));
    }
    let preset: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_workflows WHERE id = ?1 AND archived_at IS NULL)",
        [dispatch.preset["id"].as_str().unwrap_or_default()],
        |row| row.get(0),
    )?;
    if !preset {
        return Err(failure("GitHub trigger preset is not available", 422));
    }
    let advisors = dispatch.profiles["advisors"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (profile, role) in [
        (&dispatch.profiles["root"], "root"),
        (&dispatch.profiles["worker"], "worker"),
    ]
    .into_iter()
    .chain(advisors.values().map(|profile| (profile, "root")))
    {
        if crate::profiles::agent_profiles::read_profile(
            database,
            profile["profileId"].as_str().unwrap_or_default(),
            role,
        )?
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
    if dispatch.request["startImmediately"] == true
        || dispatch.request["images"]
            .as_array()
            .is_some_and(|images| !images.is_empty())
    {
        return Err(task_failure("GitHub trigger dispatch is invalid", 422));
    }
    let authority = dispatch.authority_user_id.clone();
    if let Some(task_id) = &dispatch.task_id {
        return Ok((task_id.clone(), task_status(database, &authority, task_id)?));
    }
    let body = db(database, |database| {
        require_admission(database, &dispatch)?;
        dispatch.request_body()
    })?;
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
    let host = match &project.integration {
        Some(integration)
            if serde_json::to_value(&integration.repository)?["kind"] == "bitbucket" =>
        {
            "bitbucket"
        }
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
    let configuration = &prepared.configuration;
    let policy = &dispatch.policy;
    if configuration["source"]["kind"] != "pull_request"
        || configuration["source"]["number"] != dispatch.pull_request_number
        || configuration["startingSha"] != policy.head_sha.as_str()
        || configuration["baselineSha"] != policy.base_sha.as_str()
        || configuration["branch"] != policy.head_branch.as_str()
        || configuration["baseBranch"] != policy.base_branch.as_str()
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
    prepared.root_profile = serde_json::from_value(dispatch.profiles["root"].clone())?;
    prepared.worker_profile = serde_json::from_value(dispatch.profiles["worker"].clone())?;
    prepared.advisor_profiles = serde_json::from_value(dispatch.profiles["advisors"].clone())?;
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
            body.workflow.as_str(),
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
    let authority = dispatch.authority_user_id.clone();
    let startable = |database: &SuplexDatabase| -> DatabaseResult<(String, bool)> {
        let status = database.connection().query_row(
            "SELECT c.status, t.archived_at IS NULL FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [&task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )?;
        Ok((
            status.0.clone(),
            status.1 && matches!(status.0.as_str(), "backlog" | "queued"),
        ))
    };
    let status = task_status(database, &authority, &task_id)?;
    let (_, can_start) = db(database, |database| startable(database))?;
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
    let label: String = db(database, |database| {
        Ok(database.connection().query_row(
            "SELECT label FROM suplex_github_trigger_rules WHERE id = ?1",
            [&dispatch.rule_id],
            |row| row.get(0),
        )?)
    })?;
    let policy = &dispatch.policy;
    let protected = pull.files.iter().any(|file| {
        std::iter::once(&file.filename)
            .chain(&file.previous_filename)
            .any(|path| {
                matches_protected_paths(&policy.protected_paths, path, None).unwrap_or(false)
            })
    });
    let repository = dispatch.repository_name.as_str();
    let valid = pull.number == dispatch.pull_request_number
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
        && pull.labels.contains(&label)
        && !protected;
    if !valid {
        return Err(task_failure(
            "GitHub trigger pull request is no longer eligible",
            409,
        ));
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let started = db(database, |database| {
        database.transaction(true, |database| {
            let current = dispatches::get(database, dispatch_id)?
                .filter(|value| value.task_id.is_some())
                .ok_or_else(|| -> Box<dyn Error> {
                    TaskError::new("GitHub trigger dispatch is not linked to a task", 404).into()
                })?;
            let (status, can_start) = startable(database)?;
            if !can_start {
                return Ok((task_id.clone(), status));
            }
            require_admission(database, &current)?;
            let configuration: Value = serde_json::from_str(&database.connection().query_row(
                "SELECT configuration_json FROM suplex_tasks WHERE id = ?1",
                [&task_id],
                |row| row.get::<_, String>(0),
            )?)?;
            let policy = &current.policy;
            if configuration["repository"]
                .as_str()
                .map(str::to_lowercase)
                .as_deref()
                != Some(current.repository_name.as_str())
                || configuration["startingSha"] != policy.head_sha.as_str()
                || configuration["baselineSha"] != policy.base_sha.as_str()
                || configuration["branch"] != policy.head_branch.as_str()
                || configuration["baseBranch"] != policy.base_branch.as_str()
                || configuration["source"]["kind"] != "pull_request"
                || configuration["source"]["number"] != current.pull_request_number
            {
                return Err(TaskError::new("GitHub trigger task source changed", 409).into());
            }
            let task = commands::start_user_task(
                database,
                &current.authority_user_id,
                &task_id,
                Utc::now(),
                move |id| {
                    let _ = sender.send(id);
                },
            )?;
            Ok((task.id, task.status.to_string()))
        })
    })?;
    if let Ok(id) = receiver.try_recv() {
        wake(id);
    }
    Ok(started)
}

/// Run `processEnabledRules` now and one minute after each pass ends.
pub fn spawn_poller(
    database_path: PathBuf,
    wake: impl Fn(String) + Send + Sync + 'static,
    mut shutdown: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        loop {
            let pass = async {
                let database = Mutex::new(
                    SuplexDatabase::open(&database_path, OpenMode::ReadWrite).map_err(send)?,
                );
                match Github::load().await {
                    Ok(github) => process_enabled_rules(&database, &github, &wake).await,
                    Err(error) => record_provider_unavailable(&database, &error).await,
                }
                Ok::<(), Failure>(())
            };
            if let Err(error) = pass.await {
                eprintln!("GitHub trigger poll failed: {error}");
            }
            tokio::select! {
                changed = shutdown.changed() => if changed.is_err() || *shutdown.borrow() { return; },
                () = tokio::time::sleep(Duration::from_secs(60)) => {},
            }
        }
    });
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
            profiles: json!({"root": expected.profiles[0], "worker": expected.profiles[1], "advisors": {}}),
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
        assert_eq!(
            first.idempotency_key,
            format!("github-trigger:{}", first.id)
        );
        assert_eq!(first.request["startImmediately"], false);
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
}
