//! Immutable trigger dispatch captures and their delivery policy
//! (`src/integrations/github/trigger-dispatches.ts`, `trigger-delivery-policy.ts`).

use std::{error::Error, sync::LazyLock};

use regex::Regex;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::github_triggers_inspection::validate_protected_paths;
use crate::{
    coordination::workflows::{ReviewRange, workflow_definition},
    http::contracts::typed::tasks::{TaskCreateBody, parse_task_create},
    platform::database::{DatabaseResult, SuplexDatabase},
    tasks::commands::task_request_hash,
};

static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40,64}$").unwrap());
static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[a-z0-9][a-z0-9_.-]{0,99}/[a-z0-9][a-z0-9_.-]{0,99}$").unwrap()
});

fn fail(message: &str) -> Box<dyn Error> {
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
    pub request: Value,
    pub policy: DispatchPolicy,
    pub preset: Value,
    /// `{root, worker, advisors}` task profile snapshots.
    pub profiles: Value,
    pub idempotency_key: String,
    pub task_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Dispatch {
    pub fn request_body(&self) -> DatabaseResult<TaskCreateBody> {
        parse_task_create(Some(&self.request))
            .map_err(|_| fail("GitHub trigger dispatch request is invalid"))
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
    pub profiles: Value,
}

fn dispatch(row: &Row<'_>) -> rusqlite::Result<(Dispatch, [String; 3])> {
    Ok((
        Dispatch {
            id: row.get("id")?,
            rule_id: row.get("rule_id")?,
            company_id: row.get("company_id")?,
            project_id: row.get("project_id")?,
            repository_id: row.get("repository_id")?,
            repository_name: row.get("repository_name")?,
            pull_request_number: row.get("pull_request_number")?,
            authority_user_id: row.get("authority_user_id")?,
            request: Value::Null,
            policy: DispatchPolicy {
                head_sha: String::new(),
                base_sha: String::new(),
                head_branch: String::new(),
                base_branch: String::new(),
                protected_paths: Vec::new(),
                repository_id: 0,
                repository_name: String::new(),
                delivery_target: String::new(),
            },
            preset: Value::Null,
            profiles: Value::Null,
            idempotency_key: row.get("idempotency_key")?,
            task_id: row.get("task_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        },
        [
            row.get("request_json")?,
            row.get("policy_json")?,
            row.get("preset_json")?,
        ],
    ))
}

fn query(
    database: &SuplexDatabase,
    sql: &str,
    values: impl rusqlite::Params,
) -> DatabaseResult<Vec<Dispatch>> {
    let mut statement = database.connection().prepare(sql)?;
    let rows = statement
        .query_map(values, |row| {
            let (dispatch, texts) = dispatch(row)?;
            Ok((dispatch, texts, row.get::<_, String>("profiles_json")?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(mut value, [request, policy, preset], profiles)| {
            value.request = serde_json::from_str(&request)?;
            value.request_body()?;
            value.policy = DispatchPolicy::parse(serde_json::from_str(&policy)?)?;
            value.preset = serde_json::from_str(&preset)?;
            value.profiles = serde_json::from_str(&profiles)?;
            Ok(value)
        })
        .collect()
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

fn sorted_keys(value: &Value) -> Vec<String> {
    let mut keys = value
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    keys.sort();
    keys
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
        let preset = &input.preset;
        let rule = database.connection().query_row(
            "SELECT company_id, project_id, repository_id, repository_name, authority_user_id, workflow_id, delivery_target, protected_paths_json FROM suplex_github_trigger_rules WHERE id = ?1",
            [&input.rule_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?)),
        ).optional()?;
        let matches_rule = rule.is_some_and(|rule| {
            rule.0 == input.company_id
                && rule.1 == input.project_id
                && rule.2 == input.repository_id
                && rule.3.to_lowercase() == input.repository_name.to_lowercase()
                && rule.4 == input.authority_user_id
                && preset["id"] == rule.5.as_str()
                && rule.6 == policy.delivery_target
                && serde_json::from_str::<Value>(&rule.7).ok() == Some(json!(policy.protected_paths))
        });
        if !matches_rule {
            return Err(fail("GitHub trigger dispatch does not match rule"));
        }
        validate_protected_paths(&policy.protected_paths)?;
        let request = &input.request;
        if policy.repository_id != input.repository_id
            || policy.repository_name != input.repository_name.to_lowercase()
            || request["deliveryTarget"] != policy.delivery_target.as_str()
            || request["projectId"] != input.project_id.as_str()
            || request["source"]["kind"] != "pull_request"
            || request["source"]["number"] != input.pull_request_number
        {
            return Err(fail("GitHub trigger dispatch capture is contradictory"));
        }
        let id = format!("github_trigger_dispatch_{}", uuid::Uuid::new_v4().simple());
        let key = format!("github-trigger:{id}");
        let mut raw = request.clone();
        raw["idempotencyKey"] = json!(key);
        raw["startImmediately"] = json!(false);
        let body = parse_task_create(Some(&raw))
            .map_err(|_| fail("GitHub trigger dispatch request is invalid"))?;
        let request = serde_json::to_value(&body)?;
        let profiles = &input.profiles;
        if profiles["root"]["profileId"] != request["rootProfileId"]
            || profiles["worker"]["profileId"] != request["workerProfileId"]
            || preset["engine"] != request["workflow"]
        {
            return Err(fail("GitHub trigger dispatch profiles do not match request"));
        }
        for (field, value) in [
            ("rootProfileId", &request["rootProfileId"]),
            ("workerProfileId", &request["workerProfileId"]),
            ("runProjectTests", &request["runProjectTests"]),
            ("visualEvidence", &request["visualEvidence"]),
        ] {
            if !preset[field].is_null() && &preset[field] != value {
                return Err(fail("GitHub trigger dispatch does not match preset"));
            }
        }
        let mut roles = workflow_definition(&body.workflow)
            .map_or(&[][..], |definition| definition.advisor_roles)
            .iter()
            .map(|role| (*role).to_owned())
            .collect::<Vec<_>>();
        roles.sort();
        let requested = &request["advisorProfileIds"];
        if sorted_keys(requested) != roles
            || sorted_keys(&profiles["advisors"]) != roles
            || roles.iter().any(|role| {
                requested[role] != profiles["advisors"][role]["profileId"]
                    || !requested[role].is_string()
                    || (!preset["advisorProfileIds"][role].is_null()
                        && preset["advisorProfileIds"][role] != requested[role])
            })
        {
            return Err(fail("GitHub trigger dispatch Advisors do not match request"));
        }
        let now = crate::shared::time::now_millis_rfc3339();
        let repository_name = input.repository_name.to_lowercase();
        database.connection().execute(
            "INSERT INTO suplex_github_trigger_dispatches (id, rule_id, company_id, project_id, repository_id, repository_name, pull_request_number, authority_user_id, request_json, policy_json, preset_json, profiles_json, idempotency_key, task_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14, ?14)",
            params![id, input.rule_id, input.company_id, input.project_id, input.repository_id, repository_name, input.pull_request_number, input.authority_user_id, request.to_string(), serde_json::to_string(&policy)?, preset.to_string(), profiles.to_string(), key, now],
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
        let task = database.connection().query_row(
            "SELECT t.company_id, t.project_id, t.idempotency_key, t.request_hash, t.creator_user_id, t.creator_agent_id, t.configuration_json, t.archived_at, c.status, c.delivery_target, c.workflow, c.root_profile_json, c.worker_profile_json, c.advisor_profiles_json FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [task_id],
            |row| Ok((
                [row.get::<_, String>(0)?, row.get(1)?, row.get(2)?, row.get(3)?],
                row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?,
                [row.get::<_, String>(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?],
            )),
        ).optional()?;
        let hash = task_request_hash(&current.request_body()?, &current.authority_user_id)?;
        let Some(([company, project, key, request_hash], creator_user, creator_agent, configuration, archived, [status, delivery_target, workflow, root, worker, advisors])) = task
            .filter(|task| {
                task.4.is_none()
                    && task.5[0] == "backlog"
                    && task.0[0] == current.company_id
                    && task.0[1] == current.project_id
                    && task.0[2] == current.idempotency_key
                    && task.1.as_deref() == Some(current.authority_user_id.as_str())
                    && task.2.is_none()
                    && task.0[3] == hash
            })
        else {
            return Err(fail("Task does not match GitHub trigger dispatch"));
        };
        let _ = (company, project, key, request_hash, creator_user, creator_agent, archived, status);
        let config: Value = serde_json::from_str(&configuration)?;
        let policy = &current.policy;
        if config["repository"].as_str().map(str::to_lowercase).as_deref() != Some(current.repository_name.as_str())
            || config["source"]["kind"] != "pull_request"
            || config["source"]["number"] != current.pull_request_number
            || config["startingSha"] != policy.head_sha.as_str()
            || config["baselineSha"] != policy.base_sha.as_str()
            || config["branch"] != policy.head_branch.as_str()
            || config["baseBranch"] != policy.base_branch.as_str()
            || config["runProjectTests"] != current.request["runProjectTests"]
            || config["visualEvidence"] != current.request["visualEvidence"]
            || delivery_target != policy.delivery_target
            || current.request["workflow"] != workflow.as_str()
        {
            return Err(fail("Task configuration does not match GitHub trigger dispatch"));
        }
        let profiles = json!({
            "root": serde_json::from_str::<Value>(&root)?,
            "worker": serde_json::from_str::<Value>(&worker)?,
            "advisors": serde_json::from_str::<Value>(&advisors)?,
        });
        if profiles != current.profiles {
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
