//! Immutable trigger dispatch captures and their delivery policy
//! (`src/integrations/github/trigger-dispatches.ts`, `trigger-delivery-policy.ts`).

use std::{collections::BTreeMap, error::Error, sync::LazyLock};

use regex::Regex;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    github_triggers::get_rule, github_triggers_inspection::validate_protected_paths,
    provider_http::optional_metadata,
};
use crate::tasks::control::TaskStatus;
use crate::{
    coordination::{
        advisor_bridge::AdvisorRole,
        workflows::{ReviewRange, workflow_definition},
    },
    http::contracts::typed::tasks::{
        AdvisorProfileIds, TaskCreateBody, TaskSource, parse_task_create,
    },
    platform::database::{DatabaseResult, SuplexDatabase},
    tasks::{commands::task_request_hash, control::TaskProfile},
};

static SHA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40,64}$").expect("valid regex"));
static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z0-9][a-z0-9_.-]{0,99}/[a-z0-9][a-z0-9_.-]{0,99}$").expect("valid regex")
});

fn fail(message: &str) -> Box<dyn Error + Send + Sync> {
    message.into()
}

/// TypeScript branch schema: no leading `.` or `/`, and no ref-unsafe sequence.
fn valid_branch(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(['.', '/'])
        && !value.contains("..")
        && !value.ends_with('.')
        && !value.ends_with(".lock")
        && !value.contains("//")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchPolicy {
    pub head_sha: String,
    pub base_sha: String,
    pub head_branch: String,
    pub base_branch: String,
    pub protected_paths: Vec<String>,
    pub repository_id: i64,
    pub repository_name: String,
    pub delivery_target: String,
}

impl DispatchPolicy {
    /// `GithubTriggerDispatchPolicySchema.parse`: validate and lower-case the repository.
    pub fn parse(value: Value) -> DatabaseResult<Self> {
        let mut policy: Self = serde_json::from_value(value)?;
        if !SHA.is_match(&policy.head_sha)
            || !SHA.is_match(&policy.base_sha)
            || !valid_branch(&policy.head_branch)
            || !valid_branch(&policy.base_branch)
            || policy.repository_id <= 0
            || !REPOSITORY.is_match(&policy.repository_name)
            || crate::http::contracts::typed::delivery_target(&policy.delivery_target, &()).is_err()
        {
            return Err(fail("GitHub trigger dispatch policy is invalid"));
        }
        policy.repository_name = policy.repository_name.to_lowercase();
        Ok(policy)
    }
}

/// `{root, worker, advisors}` task profile snapshots.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DispatchProfiles {
    pub root: TaskProfile,
    pub worker: TaskProfile,
    pub advisors: BTreeMap<AdvisorRole, TaskProfile>,
}

/// The fields a trigger reads from a captured workflow preset (`WorkflowRecord` JSON).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub engine: String,
    pub root_profile_id: Option<String>,
    pub worker_profile_id: Option<String>,
    #[serde(default)]
    pub advisor_profile_ids: BTreeMap<String, String>,
    pub run_project_tests: Option<bool>,
    pub visual_evidence: Option<String>,
    pub archived_at: Option<String>,
}

impl Preset {
    pub fn of(value: &Value) -> DatabaseResult<Self> {
        Ok(Self::deserialize(value)?)
    }
}

#[derive(Default, Deserialize)]
struct SourceBinding {
    #[serde(default, deserialize_with = "optional_metadata")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    number: Option<i64>,
}

/// The task configuration facts a trigger capture binds.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBinding {
    #[serde(default, deserialize_with = "optional_metadata")]
    repository: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    source: Option<SourceBinding>,
    #[serde(default, deserialize_with = "optional_metadata")]
    starting_sha: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    baseline_sha: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    branch: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    base_branch: Option<String>,
    #[serde(default, deserialize_with = "optional_metadata")]
    run_project_tests: Option<bool>,
    #[serde(default, deserialize_with = "optional_metadata")]
    visual_evidence: Option<String>,
}

impl TaskBinding {
    pub fn of(configuration: &Value) -> Self {
        Self::deserialize(configuration).unwrap_or_default()
    }

    /// The pull request source and revisions are the captured ones.
    pub fn matches(&self, number: i64, policy: &DispatchPolicy) -> bool {
        self.source.as_ref().is_some_and(|source| {
            source.kind.as_deref() == Some("pull_request") && source.number == Some(number)
        }) && self.starting_sha.as_deref() == Some(policy.head_sha.as_str())
            && self.baseline_sha.as_deref() == Some(policy.base_sha.as_str())
            && self.branch.as_deref() == Some(policy.head_branch.as_str())
            && self.base_branch.as_deref() == Some(policy.base_branch.as_str())
    }

    /// The configured repository, compared case-insensitively.
    pub fn repository_is(&self, repository: &str) -> bool {
        self.repository.as_deref().map(str::to_lowercase).as_deref() == Some(repository)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Dispatch {
    pub id: String,
    pub rule_id: String,
    pub company_id: String,
    pub project_id: String,
    pub repository_id: i64,
    pub repository_name: String,
    pub pull_request_number: i64,
    pub authority_user_id: String,
    /// The captured task request, as stored.
    pub request: Value,
    pub policy: DispatchPolicy,
    /// The captured workflow preset, as stored.
    pub preset: Value,
    pub profiles: DispatchProfiles,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn request_body(request: &Value) -> DatabaseResult<TaskCreateBody> {
    parse_task_create(Some(request)).map_err(|_| fail("GitHub trigger dispatch request is invalid"))
}

impl Dispatch {
    pub fn request_body(&self) -> DatabaseResult<TaskCreateBody> {
        request_body(&self.request)
    }
}

/// The capture fields a new dispatch starts from.
pub struct DispatchPrepare {
    pub rule_id: String,
    pub company_id: String,
    pub project_id: String,
    pub repository_id: i64,
    pub repository_name: String,
    pub pull_request_number: i64,
    pub authority_user_id: String,
    pub request: Value,
    pub policy: DispatchPolicy,
    pub preset: Value,
    pub profiles: DispatchProfiles,
}

/// A dispatch row with its JSON columns still as text.
struct StoredDispatch {
    id: String,
    rule_id: String,
    company_id: String,
    project_id: String,
    repository_id: i64,
    repository_name: String,
    pull_request_number: i64,
    authority_user_id: String,
    request: String,
    policy: String,
    preset: String,
    profiles: String,
    idempotency_key: String,
    task_id: Option<String>,
    created_at: String,
    updated_at: String,
}

impl StoredDispatch {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            rule_id: row.get("rule_id")?,
            company_id: row.get("company_id")?,
            project_id: row.get("project_id")?,
            repository_id: row.get("repository_id")?,
            repository_name: row.get("repository_name")?,
            pull_request_number: row.get("pull_request_number")?,
            authority_user_id: row.get("authority_user_id")?,
            request: row.get("request_json")?,
            policy: row.get("policy_json")?,
            preset: row.get("preset_json")?,
            profiles: row.get("profiles_json")?,
            idempotency_key: row.get("idempotency_key")?,
            task_id: row.get("task_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

impl TryFrom<StoredDispatch> for Dispatch {
    type Error = Box<dyn Error + Send + Sync>;

    fn try_from(row: StoredDispatch) -> DatabaseResult<Self> {
        let request = serde_json::from_str(&row.request)?;
        request_body(&request)?;
        Ok(Self {
            id: row.id,
            rule_id: row.rule_id,
            company_id: row.company_id,
            project_id: row.project_id,
            repository_id: row.repository_id,
            repository_name: row.repository_name,
            pull_request_number: row.pull_request_number,
            authority_user_id: row.authority_user_id,
            request,
            policy: DispatchPolicy::parse(serde_json::from_str(&row.policy)?)?,
            preset: serde_json::from_str(&row.preset)?,
            profiles: serde_json::from_str(&row.profiles)?,
            idempotency_key: row.idempotency_key,
            task_id: row.task_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

fn query(
    database: &SuplexDatabase,
    sql: &str,
    values: impl rusqlite::Params,
) -> DatabaseResult<Vec<Dispatch>> {
    let mut statement = database.connection().prepare(sql)?;
    let rows = statement
        .query_map(values, StoredDispatch::read)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(Dispatch::try_from).collect()
}

pub fn get(database: &SuplexDatabase, id: &str) -> DatabaseResult<Option<Dispatch>> {
    Ok(query(
        database,
        "SELECT * FROM suplex_github_trigger_dispatches WHERE id = ?1",
        [id],
    )?
    .pop())
}

pub fn find(
    database: &SuplexDatabase,
    rule_id: &str,
    repository_id: i64,
    number: i64,
) -> DatabaseResult<Option<Dispatch>> {
    Ok(query(database, "SELECT * FROM suplex_github_trigger_dispatches WHERE rule_id = ?1 AND repository_id = ?2 AND pull_request_number = ?3", params![rule_id, repository_id, number])?.pop())
}

pub fn list_by_rule(
    database: &SuplexDatabase,
    company_id: &str,
    rule_id: &str,
) -> DatabaseResult<Vec<Dispatch>> {
    query(
        database,
        "SELECT * FROM suplex_github_trigger_dispatches WHERE company_id = ?1 AND rule_id = ?2 ORDER BY created_at, id",
        params![company_id, rule_id],
    )
}

pub fn unfinished(database: &SuplexDatabase) -> DatabaseResult<Vec<Dispatch>> {
    query(
        database,
        "SELECT * FROM suplex_github_trigger_dispatches WHERE task_id IS NULL ORDER BY created_at, id",
        [],
    )
}

pub fn previously_processed(
    database: &SuplexDatabase,
    repository_id: i64,
    number: i64,
) -> DatabaseResult<bool> {
    Ok(database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_github_trigger_dispatches WHERE repository_id = ?1 AND pull_request_number = ?2)",
        params![repository_id, number],
        |row| row.get(0),
    )?)
}

/// The rule still binds this capture: company, project, repository,
/// authority, preset, delivery target, and protected paths.
fn matches_rule(
    database: &SuplexDatabase,
    input: &DispatchPrepare,
    policy: &DispatchPolicy,
    preset: &Preset,
) -> DatabaseResult<bool> {
    let rule = get_rule(database, &input.company_id, &input.rule_id)?;
    Ok(rule.is_some_and(|rule| {
        rule.project_id == input.project_id
            && rule.repository_id == input.repository_id
            && rule.repository_name.to_lowercase() == input.repository_name.to_lowercase()
            && rule.authority_user_id == input.authority_user_id
            && preset.id == rule.workflow_id
            && rule.delivery_target == policy.delivery_target
            && rule.protected_paths == policy.protected_paths
    }))
}

/// The request names the captured project, pull request, and delivery target.
fn matches_capture(
    body: &TaskCreateBody,
    input: &DispatchPrepare,
    policy: &DispatchPolicy,
) -> bool {
    policy.repository_id == input.repository_id
        && policy.repository_name == input.repository_name.to_lowercase()
        && body.delivery_target.as_str() == policy.delivery_target
        && body.project_id == input.project_id
        && matches!(body.source, Some(TaskSource::PullRequest { number })
            if i64::try_from(number) == Ok(input.pull_request_number))
}

/// The request names the captured profiles and the preset engine.
fn matches_profiles(body: &TaskCreateBody, profiles: &DispatchProfiles, preset: &Preset) -> bool {
    body.root_profile_id.as_ref() == Some(&profiles.root.profile_id)
        && body.worker_profile_id.as_ref() == Some(&profiles.worker.profile_id)
        && preset.engine == body.workflow.as_str()
}

/// The request keeps every choice the preset made.
fn matches_preset(body: &TaskCreateBody, preset: &Preset) -> bool {
    let preset_allows = |chosen: &Option<String>, requested: &Option<String>| {
        chosen.is_none() || chosen.as_ref() == requested.as_ref()
    };
    preset_allows(&preset.root_profile_id, &body.root_profile_id)
        && preset_allows(&preset.worker_profile_id, &body.worker_profile_id)
        && preset
            .run_project_tests
            .is_none_or(|run| run == body.run_project_tests)
        && preset_allows(&preset.visual_evidence, &Some(body.visual_evidence.clone()))
}

fn requested_advisors(ids: &AdvisorProfileIds) -> BTreeMap<AdvisorRole, &str> {
    [
        (AdvisorRole::Reviewer, &ids.reviewer),
        (AdvisorRole::PlannerA, &ids.planner_a),
        (AdvisorRole::PlannerB, &ids.planner_b),
        (AdvisorRole::Rater, &ids.rater),
    ]
    .into_iter()
    .filter_map(|(role, id)| Some((role, id.as_deref()?)))
    .collect()
}

/// Each workflow Advisor is requested, captured, and allowed by the preset.
fn matches_advisors(body: &TaskCreateBody, profiles: &DispatchProfiles, preset: &Preset) -> bool {
    let roles = workflow_definition(body.workflow.as_str())
        .map_or(&[][..], |definition| definition.advisor_roles)
        .iter()
        .filter_map(|role| AdvisorRole::parse(role))
        .collect::<Vec<_>>();
    let requested = requested_advisors(&body.advisor_profile_ids);
    requested.keys().eq(roles.iter())
        && profiles.advisors.keys().eq(roles.iter())
        && roles.iter().all(|role| {
            let id = requested[role];
            profiles.advisors[role].profile_id == id
                && preset
                    .advisor_profile_ids
                    .get(role.as_str())
                    .is_none_or(|chosen| chosen == id)
        })
}

/// Capture a dispatch once per rule and pull request; a repeat returns the first capture.
pub fn prepare(database: &mut SuplexDatabase, input: DispatchPrepare) -> DatabaseResult<Dispatch> {
    database.transaction(true, |database| {
        if let Some(existing) = find(database, &input.rule_id, input.repository_id, input.pull_request_number)? {
            if existing.company_id != input.company_id
                || existing.project_id != input.project_id
                || existing.repository_name != input.repository_name.to_lowercase()
                || existing.authority_user_id != input.authority_user_id
            {
                return Err(fail("GitHub trigger dispatch binding does not match capture"));
            }
            return Ok(existing);
        }
        let policy = DispatchPolicy::parse(serde_json::to_value(&input.policy)?)?;
        let preset = Preset::of(&input.preset)?;
        if !matches_rule(database, &input, &policy, &preset)? {
            return Err(fail("GitHub trigger dispatch does not match rule"));
        }
        validate_protected_paths(&policy.protected_paths)?;
        let id = format!("github_trigger_dispatch_{}", uuid::Uuid::new_v4().simple());
        let key = format!("github-trigger:{id}");
        let mut raw = input.request.clone();
        raw["idempotencyKey"] = Value::from(key.as_str());
        raw["startImmediately"] = Value::from(false);
        let body = request_body(&raw)?;
        if !matches_capture(&body, &input, &policy) {
            return Err(fail("GitHub trigger dispatch capture is contradictory"));
        }
        if !matches_profiles(&body, &input.profiles, &preset) {
            return Err(fail("GitHub trigger dispatch profiles do not match request"));
        }
        if !matches_preset(&body, &preset) {
            return Err(fail("GitHub trigger dispatch does not match preset"));
        }
        if !matches_advisors(&body, &input.profiles, &preset) {
            return Err(fail("GitHub trigger dispatch Advisors do not match request"));
        }
        let request = serde_json::to_value(&body)?;
        let now = crate::shared::time::now_millis_rfc3339();
        let repository_name = input.repository_name.to_lowercase();
        database.connection().execute(
            "INSERT INTO suplex_github_trigger_dispatches (id, rule_id, company_id, project_id, repository_id, repository_name, pull_request_number, authority_user_id, request_json, policy_json, preset_json, profiles_json, idempotency_key, task_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14, ?14)",
            params![id, input.rule_id, input.company_id, input.project_id, input.repository_id, repository_name, input.pull_request_number, input.authority_user_id, request.to_string(), serde_json::to_string(&policy)?, input.preset.to_string(), serde_json::to_string(&input.profiles)?, key, now],
        )?;
        Ok(Dispatch {
            id,
            rule_id: input.rule_id,
            company_id: input.company_id,
            project_id: input.project_id,
            repository_id: input.repository_id,
            repository_name,
            pull_request_number: input.pull_request_number,
            authority_user_id: input.authority_user_id,
            request,
            policy,
            preset: input.preset,
            profiles: input.profiles,
            idempotency_key: key,
            task_id: None,
            created_at: now.clone(),
            updated_at: now,
        })
    })
}

/// The task row a dispatch may link to.
struct LinkedTask {
    company_id: String,
    project_id: String,
    idempotency_key: String,
    request_hash: String,
    creator_user_id: Option<String>,
    creator_agent_id: Option<String>,
    configuration: String,
    archived_at: Option<String>,
    status: String,
    delivery_target: String,
    workflow: String,
    root_profile: String,
    worker_profile: String,
    advisor_profiles: String,
}

impl LinkedTask {
    fn read(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Option<Self>> {
        Ok(database.connection().query_row(
            "SELECT t.company_id, t.project_id, t.idempotency_key, t.request_hash, t.creator_user_id, t.creator_agent_id, t.configuration_json, t.archived_at, c.status, c.delivery_target, c.workflow, c.root_profile_json, c.worker_profile_json, c.advisor_profiles_json FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [task_id],
            |row| Ok(Self {
                company_id: row.get("company_id")?,
                project_id: row.get("project_id")?,
                idempotency_key: row.get("idempotency_key")?,
                request_hash: row.get("request_hash")?,
                creator_user_id: row.get("creator_user_id")?,
                creator_agent_id: row.get("creator_agent_id")?,
                configuration: row.get("configuration_json")?,
                archived_at: row.get("archived_at")?,
                status: row.get("status")?,
                delivery_target: row.get("delivery_target")?,
                workflow: row.get("workflow")?,
                root_profile: row.get("root_profile_json")?,
                worker_profile: row.get("worker_profile_json")?,
                advisor_profiles: row.get("advisor_profiles_json")?,
            }),
        ).optional()?)
    }

    /// A live backlog task the authority created from this capture's request.
    fn created_from(&self, dispatch: &Dispatch, hash: &str) -> bool {
        self.archived_at.is_none()
            && self.status == TaskStatus::Backlog.as_str()
            && self.company_id == dispatch.company_id
            && self.project_id == dispatch.project_id
            && self.idempotency_key == dispatch.idempotency_key
            && self.creator_user_id.as_deref() == Some(dispatch.authority_user_id.as_str())
            && self.creator_agent_id.is_none()
            && self.request_hash == hash
    }

    fn configured_for(&self, dispatch: &Dispatch, body: &TaskCreateBody) -> DatabaseResult<bool> {
        let binding = TaskBinding::of(&serde_json::from_str(&self.configuration)?);
        Ok(binding.repository_is(&dispatch.repository_name)
            && binding.matches(dispatch.pull_request_number, &dispatch.policy)
            && binding.run_project_tests == Some(body.run_project_tests)
            && binding.visual_evidence.as_ref() == Some(&body.visual_evidence)
            && self.delivery_target == dispatch.policy.delivery_target
            && body.workflow.as_str() == self.workflow)
    }

    fn profiles(&self) -> Option<DispatchProfiles> {
        Some(DispatchProfiles {
            root: serde_json::from_str(&self.root_profile).ok()?,
            worker: serde_json::from_str(&self.worker_profile).ok()?,
            advisors: serde_json::from_str(&self.advisor_profiles).ok()?,
        })
    }
}

/// Move a linked task that has not started onto the pull request's current revisions.
/// New commits and an advanced base are normal; the task starts from what GitHub shows now.
pub fn rebind_revisions(
    database: &SuplexDatabase,
    dispatch: &Dispatch,
    task_id: &str,
    head_sha: &str,
    base_sha: &str,
) -> DatabaseResult<()> {
    if dispatch.policy.head_sha == head_sha && dispatch.policy.base_sha == base_sha {
        return Ok(());
    }
    if !SHA.is_match(head_sha) || !SHA.is_match(base_sha) {
        return Err(fail("GitHub trigger pull request revision is invalid"));
    }
    let policy = DispatchPolicy {
        head_sha: head_sha.to_owned(),
        base_sha: base_sha.to_owned(),
        ..dispatch.policy.clone()
    };
    let connection = database.connection();
    connection.execute(
        "UPDATE suplex_github_trigger_dispatches SET policy_json = ?1, updated_at = ?2 WHERE id = ?3 AND task_id = ?4",
        params![serde_json::to_string(&policy)?, crate::shared::time::now_millis_rfc3339(), dispatch.id, task_id],
    )?;
    connection.execute(
        "UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.startingSha', ?1, '$.baselineSha', ?2) WHERE id = ?3",
        params![head_sha, base_sha, task_id],
    )?;
    connection.execute(
        "UPDATE suplex_task_controls SET delivery_intent_json = json_set(delivery_intent_json, '$.baselineSha', ?1) WHERE task_id = ?2",
        params![base_sha, task_id],
    )?;
    Ok(())
}

/// Bind the dispatch to the task created from its exact capture.
pub fn link_task(
    database: &mut SuplexDatabase,
    dispatch_id: &str,
    task_id: &str,
) -> DatabaseResult<Dispatch> {
    database.transaction(true, |database| {
        let current = get(database, dispatch_id)?
            .ok_or_else(|| fail("GitHub trigger dispatch was not found"))?;
        if let Some(linked) = &current.task_id {
            if linked != task_id {
                return Err(fail("GitHub trigger dispatch already links another task"));
            }
            return Ok(current);
        }
        let task = LinkedTask::read(database, task_id)?;
        let body = current.request_body()?;
        let hash = task_request_hash(&body, &current.authority_user_id)?;
        let Some(task) = task.filter(|task| task.created_from(&current, &hash)) else {
            return Err(fail("Task does not match GitHub trigger dispatch"));
        };
        if !task.configured_for(&current, &body)? {
            return Err(fail("Task configuration does not match GitHub trigger dispatch"));
        }
        if task.profiles().as_ref() != Some(&current.profiles) {
            return Err(fail("Task profiles do not match GitHub trigger dispatch"));
        }
        database.connection().execute(
            "UPDATE suplex_github_trigger_dispatches SET task_id = ?1, updated_at = ?2 WHERE id = ?3 AND (task_id IS NULL OR task_id = ?1)",
            params![task_id, crate::shared::time::now_millis_rfc3339(), dispatch_id],
        )?;
        get(database, dispatch_id)?.ok_or_else(|| fail("GitHub trigger dispatch was not found"))
    })
}

/// The pull request facts a trigger task's delivery must preserve.
#[derive(Clone, Debug, PartialEq)]
pub struct DeliveryPolicy {
    pub dispatch_id: String,
    pub repository_id: i64,
    pub repository_name: String,
    pub pull_request_number: i64,
    pub head_sha: String,
    pub base_sha: String,
    pub head_branch: String,
    pub base_branch: String,
    pub protected_paths: Vec<String>,
}

fn policy(
    database: &SuplexDatabase,
    task_id: &str,
    dispatch_id: Option<&str>,
) -> DatabaseResult<Option<DeliveryPolicy>> {
    let row = database.connection().query_row(
        "SELECT id, task_id, repository_id, repository_name, pull_request_number, policy_json FROM suplex_github_trigger_dispatches WHERE task_id = ?1 AND (?2 IS NULL OR id = ?2)",
        params![task_id, dispatch_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, String>(5)?)),
    ).optional()?;
    let Some((id, bound, repository_id, repository_name, number, policy_json)) = row else {
        return Ok(None);
    };
    if bound.as_deref() != Some(task_id) {
        return Err(fail("GitHub trigger dispatch task binding is invalid"));
    }
    let parsed = DispatchPolicy::parse(serde_json::from_str(&policy_json)?)?;
    if parsed.repository_id != repository_id
        || parsed.repository_name != repository_name.to_lowercase()
    {
        return Err(fail("GitHub trigger dispatch policy identity is invalid"));
    }
    Ok(Some(DeliveryPolicy {
        dispatch_id: id,
        repository_id,
        repository_name: repository_name.to_lowercase(),
        pull_request_number: number,
        head_sha: parsed.head_sha,
        base_sha: parsed.base_sha,
        head_branch: parsed.head_branch,
        base_branch: parsed.base_branch,
        protected_paths: parsed.protected_paths,
    }))
}

/// `triggerDeliveryPolicy`: the dispatch policy bound to a task, if any.
pub fn trigger_delivery_policy(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<DeliveryPolicy>> {
    policy(database, task_id, None)
}

/// `recordTriggerPush`: record one confirmed head move of a trigger pull request.
pub fn record_trigger_push(
    database: &mut SuplexDatabase,
    task_id: &str,
    dispatch_id: &str,
    from_head_sha: &str,
    to_head_sha: &str,
    review: &Value,
) -> DatabaseResult<()> {
    database.transaction(true, |database| {
        let invalid = || fail("GitHub trigger delivery transition is invalid");
        let review: ReviewRange = serde_json::from_value(review.clone()).map_err(|_| invalid())?;
        if !SHA.is_match(from_head_sha) || !SHA.is_match(to_head_sha) {
            return Err(invalid());
        }
        if policy(database, task_id, Some(dispatch_id))?.is_none()
            || from_head_sha == to_head_sha
            || review.head_sha != to_head_sha
        {
            return Err(invalid());
        }
        let review_json = serde_json::to_string(&review)?;
        let existing = database.connection().query_row(
            "SELECT task_id, from_head_sha, review_json FROM suplex_github_trigger_delivery_operations WHERE dispatch_id = ?1 AND to_head_sha = ?2",
            params![dispatch_id, to_head_sha],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        ).optional()?;
        if let Some((existing_task, existing_from, existing_review)) = existing {
            let same_review = serde_json::from_str::<ReviewRange>(&existing_review)
                .ok()
                .and_then(|value| serde_json::to_string(&value).ok())
                == Some(review_json);
            if existing_task == task_id && existing_from == from_head_sha && same_review {
                return Ok(());
            }
            return Err(fail("GitHub trigger delivery transition conflicts"));
        }
        database.connection().execute(
            "INSERT INTO suplex_github_trigger_delivery_operations (id, task_id, dispatch_id, from_head_sha, to_head_sha, review_json, confirmed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![format!("github_trigger_delivery_{}", uuid::Uuid::new_v4().simple()), task_id, dispatch_id, from_head_sha, to_head_sha, review_json, crate::shared::time::now_millis_rfc3339()],
        )?;
        Ok(())
    })
}
