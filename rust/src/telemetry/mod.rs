//! Product telemetry. The host forwards committed rows to PostHog: audit
//! events, task lifecycle events, pull request state, and a daily count.
//!
//! Nothing leaves the host before an administrator saw the notice, while the
//! Environment setting is off, under `DO_NOT_TRACK=1` or `SUPLEX_TELEMETRY=0`,
//! or without a PostHog project key. Rows written while telemetry is off are
//! never sent later. `docs/telemetry.md` lists every event and property; this
//! module sends nothing else. It never sends code, prompts, titles, names,
//! repository names, branches, or file paths.
//!
//! Telemetry is an observation. A failed send is retried on the next tick and
//! never changes the operation that produced the row.

use std::{
    collections::BTreeMap,
    error::Error,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::shared::hash::sha256_hex;
use crate::{
    platform::{
        database::{DatabaseResult, OpenMode, SuplexDatabase},
        environment_settings,
    },
    shared::time::rfc3339_millis,
    tasks::control::{DeliveryTarget, TaskProfile},
};

const DEFAULT_HOST: &str = "https://us.i.posthog.com";
const PERIOD: Duration = Duration::from_secs(60);
const BATCH: i64 = 500;

/// Audit actions forwarded under the same event name.
const AUDIT_ACTIONS: [&str; 8] = [
    "company_created",
    "project_created",
    "task_created",
    "task_started",
    "task_answered",
    "task_cancelled",
    "workflow_created",
    "membership_added",
];

#[derive(Clone, Debug)]
pub struct Config {
    pub key: String,
    pub host: String,
    pub installation_id: String,
}

/// `DO_NOT_TRACK=1` or `SUPLEX_TELEMETRY=0|false|off` turn telemetry off.
fn opted_out(variable: impl Fn(&str) -> Option<String>) -> bool {
    variable("DO_NOT_TRACK").is_some_and(|value| !value.is_empty() && value != "0")
        || variable("SUPLEX_TELEMETRY").is_some_and(|value| {
            matches!(value.to_ascii_lowercase().as_str(), "0" | "false" | "off")
        })
}

/// The send configuration, or `None` when this build or environment never
/// sends. Release builds compile the project key in; source builds have none.
pub fn config(installation_id: &str) -> Option<Config> {
    let variable = |name: &str| std::env::var(name).ok();
    if opted_out(variable) {
        return None;
    }
    let key = variable("SUPLEX_POSTHOG_KEY")
        .or(option_env!("SUPLEX_POSTHOG_KEY").map(str::to_owned))
        .filter(|key| !key.is_empty())?;
    Some(Config {
        key,
        host: variable("SUPLEX_POSTHOG_HOST").unwrap_or_else(|| DEFAULT_HOST.to_owned()),
        installation_id: installation_id.to_owned(),
    })
}

struct State {
    notice_at: Option<String>,
    email: Option<String>,
    email_sent_at: Option<String>,
    audit_cursor: Option<i64>,
    lifecycle_cursor: Option<i64>,
    daily_at: Option<String>,
    last_app_version: Option<String>,
    last_app_revision: Option<String>,
}

fn state(database: &SuplexDatabase) -> DatabaseResult<Option<State>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT notice_at, email, email_sent_at, audit_cursor, lifecycle_cursor, daily_at, last_app_version, last_app_revision FROM suplex_telemetry WHERE id = 'host'",
            [],
            |row| {
                Ok(State {
                    notice_at: row.get(0)?,
                    email: row.get(1)?,
                    email_sent_at: row.get(2)?,
                    audit_cursor: row.get(3)?,
                    lifecycle_cursor: row.get(4)?,
                    daily_at: row.get(5)?,
                    last_app_version: row.get(6)?,
                    last_app_revision: row.get(7)?,
                })
            },
        )
        .optional()?)
}

/// True when an administrator still has to see the notice: this build sends,
/// the setting is on, and nobody acknowledged it on this host.
pub fn notice_required(database: &SuplexDatabase, configured: bool) -> DatabaseResult<bool> {
    Ok(configured
        && environment_settings::read(database)?.telemetry_enabled
        && state(database)?.and_then(|state| state.notice_at).is_none())
}

/// Records that an administrator saw the notice, with an optional email that
/// links this host to the person who downloaded Suplex.
pub fn acknowledge(
    database: &mut SuplexDatabase,
    email: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let email = email.map(|email| email.trim().to_lowercase());
    database.connection().execute(
        "INSERT INTO suplex_telemetry (id, notice_at, email) VALUES ('host', ?1, ?2) ON CONFLICT(id) DO UPDATE SET notice_at = COALESCE(notice_at, excluded.notice_at), email = COALESCE(excluded.email, email), email_sent_at = CASE WHEN excluded.email IS NULL THEN email_sent_at END",
        params![rfc3339_millis(now), email],
    )?;
    Ok(())
}

/// Forgets the send position, so rows written while telemetry is off are
/// never sent. The next send starts from the rows that exist then.
fn forget(database: &SuplexDatabase) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_telemetry SET audit_cursor = NULL, lifecycle_cursor = NULL WHERE id = 'host'",
        [],
    )?;
    Ok(())
}

/// Starts the send position at the rows that exist now. History from before
/// the notice, or from while telemetry was off, is never sent.
fn baseline(database: &mut SuplexDatabase) -> DatabaseResult<()> {
    database.transaction(true, |database| {
        database.connection().execute(
            "UPDATE suplex_telemetry SET audit_cursor = (SELECT COALESCE(MAX(rowid), 0) FROM suplex_audit_events), lifecycle_cursor = (SELECT COALESCE(MAX(id), 0) FROM suplex_task_analytics_events) WHERE id = 'host'",
            [],
        )?;
        database.connection().execute(
            "INSERT INTO suplex_telemetry_pull_requests (task_id, merged) SELECT task_id, COALESCE(json_extract(pull_request_json, '$.state') = 'merged', 0) FROM suplex_task_controls WHERE pull_request_json IS NOT NULL ON CONFLICT(task_id) DO UPDATE SET merged = excluded.merged",
            [],
        )?;
        Ok(())
    })
}

/// One batch and the send position it moves to.
#[derive(Debug, Default)]
struct Collected {
    events: Vec<Value>,
    audit_cursor: i64,
    lifecycle_cursor: i64,
    pull_requests: Vec<(String, bool)>,
    email_sent: bool,
    daily: bool,
    version_observed: bool,
}

fn event(
    config: &Config,
    name: &str,
    company_id: Option<&str>,
    timestamp: &str,
    properties: Value,
) -> Value {
    event_with_seed(config, name, company_id, timestamp, properties, None)
}

fn durable_event(
    config: &Config,
    name: &str,
    company_id: Option<&str>,
    timestamp: &str,
    properties: Value,
    source_key: &str,
) -> Value {
    event_with_seed(
        config,
        name,
        company_id,
        timestamp,
        properties,
        Some(source_key),
    )
}

fn event_with_seed(
    config: &Config,
    name: &str,
    company_id: Option<&str>,
    timestamp: &str,
    properties: Value,
    source_key: Option<&str>,
) -> Value {
    let mut properties = match properties {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let mut groups = json!({"host": config.installation_id});
    if let Some(company_id) = company_id {
        groups["company"] = json!(company_id);
    }
    properties.extend([
        ("$lib".to_owned(), json!("suplex-host")),
        ("app_version".to_owned(), json!(env!("CARGO_PKG_VERSION"))),
        ("app_revision".to_owned(), json!(env!("SUPLEX_REVISION"))),
        ("os".to_owned(), json!(std::env::consts::OS)),
        ("arch".to_owned(), json!(std::env::consts::ARCH)),
        ("$groups".to_owned(), groups),
    ]);
    let generated_seed;
    let seed = match source_key {
        Some(source_key) => source_key,
        None => {
            generated_seed = serde_json::to_string(&json!({
                "event": name,
                "distinct_id": config.installation_id,
                "timestamp": timestamp,
                "properties": &properties,
            }))
            .expect("telemetry event serializes");
            &generated_seed
        }
    };
    let uuid = deterministic_uuid(&format!("{}\0{seed}", config.installation_id));
    json!({
        "event": name,
        "distinct_id": config.installation_id,
        "timestamp": timestamp,
        "uuid": uuid,
        "properties": properties,
    })
}

fn deterministic_uuid(seed: &str) -> String {
    let hash = sha256_hex(seed);
    let mut bytes = hash.as_bytes()[..32].to_vec();
    bytes[12] = b'5';
    bytes[16] = match bytes[16] {
        b'0'..=b'3' => b'8',
        b'4'..=b'7' => b'9',
        b'8'..=b'b' => b'a',
        _ => b'b',
    };
    let hex = String::from_utf8(bytes).expect("hex is utf-8");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditMetadata {
    project_id: Option<String>,
    task_id: Option<String>,
}

struct TaskMetrics {
    workflow: crate::coordination::workflows::Workflow,
    delivery_target: DeliveryTarget,
    root: TaskProfile,
    worker: TaskProfile,
    advisor_count: usize,
    created_at: String,
}

fn task_metrics(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Option<TaskMetrics>> {
    let raw: Option<(String, String, String, String, String, String)> = database
        .connection()
        .query_row(
            "SELECT c.workflow, c.delivery_target, c.root_profile_json, c.worker_profile_json, c.advisor_profiles_json, t.created_at FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()?;
    Ok(raw.and_then(
        |(workflow, delivery_target, root, worker, advisors, created_at)| {
            Some(TaskMetrics {
                workflow: serde_json::from_value(json!(workflow)).ok()?,
                delivery_target: serde_json::from_value(json!(delivery_target)).ok()?,
                root: serde_json::from_str(&root).ok()?,
                worker: serde_json::from_str(&worker).ok()?,
                advisor_count: serde_json::from_str::<BTreeMap<String, TaskProfile>>(&advisors)
                    .ok()?
                    .len(),
                created_at,
            })
        },
    ))
}

fn task_properties(metrics: &TaskMetrics) -> Map<String, Value> {
    Map::from_iter([
        ("workflow".into(), json!(metrics.workflow)),
        ("delivery_target".into(), json!(metrics.delivery_target)),
        ("coordinator_provider".into(), json!(metrics.root.provider)),
        ("worker_provider".into(), json!(metrics.worker.provider)),
        ("advisor_count".into(), json!(metrics.advisor_count)),
    ])
}

fn audit_properties(
    database: &SuplexDatabase,
    action: &str,
    by_agent: bool,
    metadata: &str,
    observed_at: &str,
) -> DatabaseResult<Value> {
    let metadata = serde_json::from_str::<AuditMetadata>(metadata).unwrap_or_default();
    Ok(match action {
        "project_created" => {
            let (git_host, tracker): (Option<String>, Option<String>) = database
                .connection()
                .query_row(
                    "SELECT json_extract(integration_json, '$.repository.kind'), json_extract(integration_json, '$.tracker.kind') FROM suplex_projects WHERE id = ?1",
                    [metadata.project_id.as_deref().unwrap_or("")],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .unwrap_or_default();
            json!({
                "git_host": git_host.unwrap_or_else(|| "none".to_owned()),
                "tracker": tracker.unwrap_or_else(|| "none".to_owned()),
            })
        }
        "task_created" | "task_started" | "task_answered" | "task_cancelled" => {
            let task_id = metadata.task_id.as_deref().unwrap_or("");
            let has_image: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_artifacts WHERE task_id = ?1 AND kind = 'task-image')",
                [task_id],
                |row| row.get(0),
            )?;
            let Some(metrics) = task_metrics(database, task_id)? else {
                return Ok(if action == "task_created" {
                    json!({"source": if by_agent { "agent" } else { "user" }, "has_image": has_image})
                } else {
                    json!({})
                });
            };
            let duration_s = DateTime::parse_from_rfc3339(&metrics.created_at)
                .ok()
                .zip(DateTime::parse_from_rfc3339(observed_at).ok())
                .map(|(created, observed)| (observed - created).num_seconds().max(0));
            let mut properties = Value::Object(task_properties(&metrics));
            if action == "task_created" {
                properties["source"] = json!(if by_agent { "agent" } else { "user" });
                properties["has_image"] = json!(has_image);
            }
            if action == "task_cancelled" {
                properties["duration_s"] = json!(duration_s);
            }
            properties
        }
        _ => json!({}),
    })
}

fn collect_audit(
    database: &SuplexDatabase,
    config: &Config,
    cursor: i64,
    collected: &mut Collected,
) -> DatabaseResult<()> {
    collected.audit_cursor = cursor;
    let mut statement = database.connection().prepare(
        "SELECT rowid, action, company_id, actor_agent_id IS NOT NULL, metadata_json, created_at FROM suplex_audit_events WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
    )?;
    let rows = statement
        .query_map(params![cursor, BATCH], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (rowid, action, company_id, by_agent, metadata, created_at) in rows {
        collected.audit_cursor = rowid;
        if AUDIT_ACTIONS.contains(&action.as_str()) {
            let properties = audit_properties(database, &action, by_agent, &metadata, &created_at)?;
            collected.events.push(durable_event(
                config,
                &action,
                company_id.as_deref(),
                &created_at,
                properties,
                &format!("audit:{rowid}"),
            ));
        }
    }
    Ok(())
}

fn collect_lifecycle(
    database: &SuplexDatabase,
    config: &Config,
    cursor: i64,
    collected: &mut Collected,
) -> DatabaseResult<()> {
    collected.lifecycle_cursor = cursor;
    let mut statement = database.connection().prepare(
        "SELECT e.id, e.task_id, e.status, e.observed_at, t.company_id, t.created_at FROM suplex_task_analytics_events e LEFT JOIN suplex_tasks t ON t.id = e.task_id WHERE e.id > ?1 ORDER BY e.id LIMIT ?2",
    )?;
    let rows = statement
        .query_map(params![cursor, BATCH], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, task_id, status, observed_at, company_id, created_at) in rows {
        collected.lifecycle_cursor = id;
        let metrics = task_metrics(database, &task_id)?;
        let properties = match status.as_str() {
            "waiting_human" => {
                Value::Object(metrics.as_ref().map(task_properties).unwrap_or_default())
            }
            "delivered" => {
                let seconds = created_at
                    .and_then(|created| DateTime::parse_from_rfc3339(&created).ok())
                    .zip(DateTime::parse_from_rfc3339(&observed_at).ok())
                    .map(|(created, delivered)| (delivered - created).num_seconds().max(0));
                let mut properties = metrics.as_ref().map(task_properties).unwrap_or_default();
                properties.insert("duration_s".into(), json!(seconds));
                Value::Object(properties)
            }
            _ => continue,
        };
        collected.events.push(durable_event(
            config,
            &format!("task_{status}"),
            company_id.as_deref(),
            &observed_at,
            properties,
            &format!("lifecycle:{id}"),
        ));
    }
    Ok(())
}

fn collect_pull_requests(
    database: &SuplexDatabase,
    config: &Config,
    now: &str,
    collected: &mut Collected,
) -> DatabaseResult<()> {
    let mut statement = database.connection().prepare(
        "SELECT c.task_id, t.company_id, COALESCE(json_extract(c.pull_request_json, '$.state') = 'merged', 0), COALESCE(json_extract(t.configuration_json, '$.integration.repository.kind'), 'github'), r.merged FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id LEFT JOIN suplex_telemetry_pull_requests r ON r.task_id = c.task_id WHERE c.pull_request_json IS NOT NULL AND (r.task_id IS NULL OR (r.merged = 0 AND json_extract(c.pull_request_json, '$.state') = 'merged')) LIMIT ?1",
    )?;
    let rows = statement
        .query_map([BATCH], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<bool>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (task_id, company_id, merged, git_host, reported) in rows {
        let properties = json!({"git_host": git_host});
        if reported.is_none() {
            collected.events.push(durable_event(
                config,
                "pr_opened",
                Some(&company_id),
                now,
                properties.clone(),
                &format!("pull-request:{task_id}:opened"),
            ));
        }
        if merged {
            collected.events.push(durable_event(
                config,
                "pr_merged",
                Some(&company_id),
                now,
                properties,
                &format!("pull-request:{task_id}:merged"),
            ));
        }
        collected.pull_requests.push((task_id, merged));
    }
    Ok(())
}

fn count(database: &SuplexDatabase, sql: &str) -> DatabaseResult<i64> {
    Ok(database.connection().query_row(sql, [], |row| row.get(0))?)
}

/// `host_daily` and one `$groupidentify` per active company: counts only.
fn collect_daily(
    database: &SuplexDatabase,
    config: &Config,
    now: &str,
    collected: &mut Collected,
) -> DatabaseResult<()> {
    collected.daily = true;
    collected.events.push(event(
        config,
        "host_daily",
        None,
        now,
        json!({
            "users": count(database, "SELECT COUNT(*) FROM suplex_users WHERE status = 'active'")?,
            "companies": count(database, "SELECT COUNT(*) FROM suplex_companies WHERE status = 'active'")?,
            "projects": count(database, "SELECT COUNT(*) FROM suplex_projects")?,
            "tasks_running": count(database, "SELECT COUNT(*) FROM suplex_task_controls WHERE status IN ('active', 'waiting_human')")?,
            "tasks_created_7d": count(database, "SELECT COUNT(*) FROM suplex_tasks WHERE julianday(created_at) > julianday('now', '-7 days')")?,
            "tasks_delivered_7d": count(database, "SELECT COUNT(*) FROM suplex_task_analytics_events WHERE status = 'delivered' AND julianday(observed_at) > julianday('now', '-7 days')")?,
            "move_runs_7d": count(database, "SELECT COUNT(*) FROM suplex_move_runs WHERE julianday(started_at) > julianday('now', '-7 days')")?,
            "task_templates": count(database, "SELECT COUNT(*) FROM suplex_task_templates")?,
            "github_triggers_enabled": count(database, "SELECT COUNT(*) FROM suplex_github_trigger_rules WHERE enabled = 1")?,
            "profiles_opencode": count(database, "SELECT COUNT(*) FROM suplex_profiles WHERE provider = 'opencode' AND archived_at IS NULL")?,
            "profiles_claude_code": count(database, "SELECT COUNT(*) FROM suplex_profiles WHERE provider = 'claude-code' AND archived_at IS NULL")?,
            "profiles_devin": count(database, "SELECT COUNT(*) FROM suplex_profiles WHERE provider = 'devin' AND archived_at IS NULL")?,
            "profiles_codex": count(database, "SELECT COUNT(*) FROM suplex_profiles WHERE provider = 'codex' AND archived_at IS NULL")?,
        }),
    ));
    let mut statement = database.connection().prepare(
        "SELECT c.id, (SELECT COUNT(*) FROM suplex_projects p WHERE p.company_id = c.id) FROM suplex_companies c WHERE c.status = 'active'",
    )?;
    let companies = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (company_id, projects) in companies {
        // The seat count and plan label billing uses, so usage and revenue
        // reports agree.
        let seats = crate::billing::required_seats(database, &company_id)?;
        let (plan, _) = crate::billing::plan_label(database, &company_id, Utc::now())?;
        collected.events.push(json!({
            "event": "$groupidentify",
            "distinct_id": config.installation_id,
            "timestamp": now,
            "uuid": deterministic_uuid(&format!("groupidentify\0{}\0{}\0{}", config.installation_id, company_id, now)),
            "properties": {
                "$group_type": "company",
                "$group_key": company_id,
                "$group_set": {
                    "seats": seats,
                    "projects": projects,
                    "plan": plan.unwrap_or("unknown"),
                },
            },
        }));
    }
    Ok(())
}

fn collect(
    database: &SuplexDatabase,
    config: &Config,
    state: &State,
    now: DateTime<Utc>,
    first_since_start: bool,
) -> DatabaseResult<Collected> {
    let stamp = rfc3339_millis(now);
    let mut collected = Collected {
        version_observed: true,
        ..Collected::default()
    };
    if first_since_start {
        collected
            .events
            .push(event(config, "host_started", None, &stamp, json!({})));
    }
    if let Some(previous) = state.last_app_version.as_deref()
        && previous != env!("CARGO_PKG_VERSION")
    {
        let mut properties = json!({"previous_app_version": previous});
        if let Some(previous_revision) = state.last_app_revision.as_deref() {
            properties["previous_app_revision"] = json!(previous_revision);
        }
        collected.events.push(durable_event(
            config,
            "host_upgraded",
            None,
            &stamp,
            properties,
            &format!("upgrade:{previous}:{}", env!("CARGO_PKG_VERSION")),
        ));
    }
    if let (Some(email), None) = (&state.email, &state.email_sent_at) {
        collected.email_sent = true;
        let identified_at = state.notice_at.as_deref().unwrap_or(&stamp);
        collected.events.push(json!({
            "event": "$identify",
            "distinct_id": config.installation_id,
            "timestamp": identified_at,
            "uuid": deterministic_uuid(&format!("identify\0{}\0{}", config.installation_id, email)),
            "properties": {"$set": {"email": email}},
        }));
    }
    collect_audit(
        database,
        config,
        state.audit_cursor.unwrap_or(0),
        &mut collected,
    )?;
    collect_lifecycle(
        database,
        config,
        state.lifecycle_cursor.unwrap_or(0),
        &mut collected,
    )?;
    collect_pull_requests(database, config, &stamp, &mut collected)?;
    let daily_due = state
        .daily_at
        .as_deref()
        .and_then(|last| DateTime::parse_from_rfc3339(last).ok())
        .is_none_or(|last| now.signed_duration_since(last) >= chrono::Duration::hours(24));
    if daily_due {
        collect_daily(database, config, &stamp, &mut collected)?;
    }
    Ok(collected)
}

fn commit(database: &mut SuplexDatabase, collected: &Collected, now: &str) -> DatabaseResult<()> {
    database.transaction(true, |database| {
        database.connection().execute(
            "UPDATE suplex_telemetry SET audit_cursor = ?1, lifecycle_cursor = ?2, email_sent_at = CASE WHEN ?3 THEN COALESCE(email_sent_at, ?4) ELSE email_sent_at END, daily_at = CASE WHEN ?5 THEN ?4 ELSE daily_at END, last_app_version = CASE WHEN ?6 THEN ?7 ELSE last_app_version END, last_app_revision = CASE WHEN ?6 THEN ?8 ELSE last_app_revision END WHERE id = 'host'",
            params![
                collected.audit_cursor,
                collected.lifecycle_cursor,
                collected.email_sent,
                now,
                collected.daily
                ,collected.version_observed
                ,env!("CARGO_PKG_VERSION")
                ,env!("SUPLEX_REVISION")
            ],
        )?;
        for (task_id, merged) in &collected.pull_requests {
            database.connection().execute(
                "INSERT INTO suplex_telemetry_pull_requests (task_id, merged) VALUES (?1, ?2) ON CONFLICT(task_id) DO UPDATE SET merged = excluded.merged",
                params![task_id, merged],
            )?;
        }
        Ok(())
    })
}

/// What one tick should send, after preparing the send position. `None`
/// means nothing may be sent now.
fn prepare(
    database: &mut SuplexDatabase,
    config: &Config,
    now: DateTime<Utc>,
    first_since_start: bool,
) -> DatabaseResult<Option<Collected>> {
    if !environment_settings::read(database)?.telemetry_enabled {
        forget(database)?;
        return Ok(None);
    }
    let Some(current) = state(database)? else {
        return Ok(None);
    };
    if current.notice_at.is_none() {
        return Ok(None);
    }
    if current.audit_cursor.is_none() || current.lifecycle_cursor.is_none() {
        baseline(database)?;
    }
    let current = state(database)?.ok_or("Telemetry state disappeared")?;
    Ok(Some(collect(
        database,
        config,
        &current,
        now,
        first_since_start,
    )?))
}

async fn tick(
    database_path: &Path,
    config: &Config,
    http: &reqwest::Client,
    started: &AtomicBool,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let now = Utc::now();
    let collected = {
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)
            .map_err(|error| error.to_string())?;
        prepare(&mut database, config, now, !started.load(Ordering::Relaxed))
            .map_err(|error| error.to_string())?
    };
    let Some(collected) = collected else {
        return Ok(());
    };
    if !collected.events.is_empty() {
        http.post(format!("{}/batch/", config.host.trim_end_matches('/')))
            .timeout(Duration::from_secs(15))
            .json(&json!({"api_key": config.key, "batch": &collected.events}))
            .send()
            .await?
            .error_for_status()?;
    }
    started.store(true, Ordering::Relaxed);
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)
        .map_err(|error| error.to_string())?;
    commit(&mut database, &collected, &rfc3339_millis(now)).map_err(|error| error.to_string())?;
    Ok(())
}

/// Starts the send loop when this build and environment send. Otherwise it
/// forgets the send position, so a later start never sends old rows.
pub fn spawn(database_path: PathBuf, installation_id: &str) -> Option<tokio::task::JoinHandle<()>> {
    let Some(config) = config(installation_id) else {
        if let Ok(database) = SuplexDatabase::open(&database_path, OpenMode::ReadWrite) {
            let _ = forget(&database);
        }
        return None;
    };
    Some(tokio::spawn(async move {
        let http = reqwest::Client::new();
        let started = AtomicBool::new(false);
        let mut interval = tokio::time::interval(PERIOD);
        loop {
            interval.tick().await;
            if let Err(error) = tick(&database_path, &config, &http, &started).await {
                eprintln!("Telemetry send will be retried: {error}");
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            key: "phc_test".to_owned(),
            host: DEFAULT_HOST.to_owned(),
            installation_id: "install-1".to_owned(),
        }
    }

    fn database() -> SuplexDatabase {
        let directory = std::env::temp_dir().join(format!(
            "suplex-telemetry-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let database =
            SuplexDatabase::open(&directory.join("suplex.db"), OpenMode::Migrate).unwrap();
        database
            .connection()
            .execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_1', 'Acme', 'active', '2026-10-02T00:00:00.000Z')", [])
            .unwrap();
        database
    }

    fn set_enabled(database: &mut SuplexDatabase, enabled: bool) {
        let current = environment_settings::read(database).unwrap();
        environment_settings::update(
            database,
            environment_settings::EnvironmentSettings {
                telemetry_enabled: enabled,
                ..current
            },
        )
        .unwrap();
    }

    fn names(collected: &Collected) -> Vec<&str> {
        collected
            .events
            .iter()
            .map(|event| event["event"].as_str().unwrap())
            .collect()
    }

    fn audit(database: &SuplexDatabase, action: &str, metadata: &str) {
        database.connection().execute(
            "INSERT INTO suplex_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?1, NULL, ?2, 'company_1', ?3, '2026-10-02T00:00:00.000Z')",
            params![format!("audit_{}", uuid::Uuid::new_v4().simple()), action, metadata],
        ).unwrap();
    }

    #[test]
    fn environment_opt_out_wins() {
        let env = |pairs: &'static [(&str, &str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| (*value).to_owned())
            }
        };
        assert!(opted_out(env(&[("DO_NOT_TRACK", "1")])));
        assert!(opted_out(env(&[("SUPLEX_TELEMETRY", "off")])));
        assert!(!opted_out(env(&[("DO_NOT_TRACK", "0")])));
        assert!(!opted_out(env(&[])));
    }

    #[test]
    fn nothing_is_sent_before_the_notice_or_while_the_setting_is_off() {
        let mut database = database();
        let now = Utc::now();
        audit(&database, "company_created", "{}");
        assert!(
            prepare(&mut database, &test_config(), now, true)
                .unwrap()
                .is_none()
        );
        assert!(notice_required(&database, true).unwrap());
        assert!(!notice_required(&database, false).unwrap());

        acknowledge(&mut database, Some(" Adam@Example.com "), now).unwrap();
        assert!(!notice_required(&database, true).unwrap());
        // History before the notice is never sent.
        let collected = prepare(&mut database, &test_config(), now, true)
            .unwrap()
            .unwrap();
        assert_eq!(
            names(&collected),
            ["host_started", "$identify", "host_daily", "$groupidentify"]
        );
        assert_eq!(
            collected.events[3]["properties"]["$group_set"],
            json!({"seats": 1, "projects": 0, "plan": "free"})
        );
        assert_eq!(collected.events[1]["distinct_id"], "install-1");
        assert_eq!(
            collected.events[1]["properties"]["$set"]["email"],
            "adam@example.com"
        );
        assert!(collected.events[1]["properties"]["$anon_distinct_id"].is_null());
        commit(&mut database, &collected, &rfc3339_millis(now)).unwrap();

        // Rows written while the setting is off are never sent later.
        set_enabled(&mut database, false);
        audit(&database, "task_created", r#"{"taskId":"task_off"}"#);
        assert!(
            prepare(&mut database, &test_config(), now, false)
                .unwrap()
                .is_none()
        );
        set_enabled(&mut database, true);
        let collected = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        assert!(names(&collected).is_empty());
        commit(&mut database, &collected, &rfc3339_millis(now)).unwrap();

        audit(&database, "task_created", r#"{"taskId":"task_on"}"#);
        audit(&database, "user_invitation_created", "{}");
        let collected = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        assert_eq!(names(&collected), ["task_created"]);
        let properties = &collected.events[0]["properties"];
        assert_eq!(properties["source"], "user");
        assert_eq!(properties["has_image"], false);
        assert_eq!(properties["$groups"]["company"], "company_1");
        assert_eq!(collected.events[0]["distinct_id"], "install-1");
        commit(&mut database, &collected, &rfc3339_millis(now)).unwrap();
        let collected = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        assert!(names(&collected).is_empty());
    }

    #[test]
    fn lifecycle_and_pull_requests_report_each_step_once() {
        let mut database = database();
        let now = Utc::now();
        acknowledge(&mut database, None, now).unwrap();
        let collected = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        commit(&mut database, &collected, &rfc3339_millis(now)).unwrap();
        let connection = database.connection();
        connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('p','company_1','P','/tmp/r','/tmp/w',NULL,'main','','','root','worker','{}','2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')", []).unwrap();
        connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('u', 'U', 'u', 'admin', 'active', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 1)", []).unwrap();
        connection.execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_user_id,created_at,updated_at) VALUES ('t','company_1','p','Secret title','','{\"integration\":{\"repository\":{\"kind\":\"bitbucket\"}}}','k','h','u','2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')", []).unwrap();
        connection.execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,pull_request_json,status_changed_at,created_at,updated_at) VALUES ('t','T','pull_request_ready','{}','active','{\"profileId\":\"r\",\"provider\":\"codex\",\"model\":\"gpt\",\"reasoningLevel\":\"medium\",\"serviceTier\":\"default\"}','{\"profileId\":\"w\",\"provider\":\"claude-code\",\"model\":\"fable\",\"reasoningLevel\":\"medium\",\"serviceTier\":\"default\"}','standard','{}','{}','{\"repository\":\"owner/secret\",\"number\":7,\"state\":\"open\"}','2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')", []).unwrap();
        for status in ["active", "waiting_human", "delivered"] {
            connection.execute("INSERT INTO suplex_task_analytics_events (task_id, status, observed_at) VALUES ('t', ?1, '2026-10-02T00:01:30.000Z')", [status]).unwrap();
        }
        let collected = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        assert_eq!(
            names(&collected),
            ["task_waiting_human", "task_delivered", "pr_opened"]
        );
        assert_eq!(collected.events[1]["properties"]["duration_s"], 90);
        assert_eq!(
            collected.events[1]["properties"]["delivery_target"],
            "pull_request_ready"
        );
        assert_eq!(
            collected.events[1]["properties"]["coordinator_provider"],
            "codex"
        );
        assert_eq!(
            collected.events[1]["properties"]["worker_provider"],
            "claude-code"
        );
        assert_eq!(collected.events[2]["properties"]["git_host"], "bitbucket");
        let sent = serde_json::to_string(&collected.events).unwrap();
        assert!(!sent.contains("secret") && !sent.contains("Secret"));
        let delivered_uuid = collected.events[1]["uuid"].clone();
        database.connection().execute("UPDATE suplex_task_controls SET root_profile_json = '{\"profileId\":\"r\",\"provider\":\"opencode\",\"model\":\"m\",\"reasoningLevel\":\"medium\",\"serviceTier\":\"default\"}' WHERE task_id = 't'", []).unwrap();
        let collected = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        assert_eq!(collected.events[1]["uuid"], delivered_uuid);
        assert_eq!(
            collected.events[1]["properties"]["coordinator_provider"],
            "opencode"
        );
        commit(&mut database, &collected, &rfc3339_millis(now)).unwrap();
        database.connection().execute("UPDATE suplex_task_controls SET pull_request_json = json_set(pull_request_json, '$.state', 'merged')", []).unwrap();
        let collected = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        assert_eq!(names(&collected), ["pr_merged"]);
        commit(&mut database, &collected, &rfc3339_millis(now)).unwrap();
        let collected = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        assert!(names(&collected).is_empty());
    }

    #[test]
    fn events_carry_only_listed_properties() {
        let event = event(&test_config(), "task_started", Some("c"), "t", json!({}));
        assert!(uuid::Uuid::parse_str(event["uuid"].as_str().unwrap()).is_ok());
        let mut keys: Vec<_> = event["properties"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "$groups",
                "$lib",
                "app_revision",
                "app_version",
                "arch",
                "os"
            ]
        );
    }

    #[test]
    fn a_semver_change_is_reported_once_separately_from_the_revision() {
        let mut database = database();
        let now = Utc::now();
        acknowledge(&mut database, None, now).unwrap();
        let initial = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        commit(&mut database, &initial, &rfc3339_millis(now)).unwrap();
        database.connection().execute(
            "UPDATE suplex_telemetry SET last_app_version = '0.9.0', last_app_revision = 'old-revision' WHERE id = 'host'",
            [],
        ).unwrap();
        let upgraded = prepare(&mut database, &test_config(), now, false)
            .unwrap()
            .unwrap();
        assert_eq!(names(&upgraded), ["host_upgraded"]);
        assert_eq!(
            upgraded.events[0]["properties"]["previous_app_version"],
            "0.9.0"
        );
        assert_eq!(
            upgraded.events[0]["properties"]["previous_app_revision"],
            "old-revision"
        );
        assert_eq!(
            upgraded.events[0]["properties"]["app_version"],
            env!("CARGO_PKG_VERSION")
        );
        assert_eq!(
            upgraded.events[0]["properties"]["app_revision"],
            env!("SUPLEX_REVISION")
        );
        commit(&mut database, &upgraded, &rfc3339_millis(now)).unwrap();
        assert!(
            names(
                &prepare(&mut database, &test_config(), now, false)
                    .unwrap()
                    .unwrap()
            )
            .is_empty()
        );
    }
}
