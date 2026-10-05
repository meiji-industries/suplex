//! Durable task analytics (`src/tasks/analytics/{analytics,contracts,metrics,store}.ts`).

pub mod collector;

use crate::shared::time::rfc3339_millis;
use crate::tasks::TaskError;
use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{
    http::contracts::task_reads::{TaskCost, TaskCostsResponse},
    identity::companies,
    platform::database::{DatabaseResult, SuplexDatabase},
    tasks::response as task_response,
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct CacheTokens {
    pub read: f64,
    pub write: f64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Tokens {
    pub input: f64,
    pub output: f64,
    pub reasoning: f64,
    pub cache: CacheTokens,
}

impl Tokens {
    fn total(&self) -> f64 {
        self.input + self.output + self.reasoning + self.cache.read + self.cache.write
    }
}

/// `TaskUsageSchema`: field order is the persisted and public order.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub session_id: String,
    pub message_id: String,
    pub turn_id: String,
    pub role: String,
    pub provider: String,
    pub model: String,
    pub started_at: f64,
    pub completed_at: Option<f64>,
    pub failed: bool,
    pub summary: bool,
    pub steps: f64,
    pub cost: f64,
    #[serde(default)]
    pub subsidized: bool,
    pub tokens: Tokens,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnalyticsEvent {
    pub status: String,
    pub question_id: Option<String>,
    pub observed_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnalyticsSession {
    pub session_id: String,
    pub observed_at: Option<String>,
    pub error_at: Option<String>,
}

pub struct AnalyticsData {
    pub usage: Vec<TaskUsage>,
    pub sessions: Vec<AnalyticsSession>,
    pub events: Vec<AnalyticsEvent>,
}

fn millis(value: &str) -> f64 {
    DateTime::parse_from_rfc3339(value).map_or(f64::NAN, |time| time.timestamp_millis() as f64)
}

/// JSON text in `JSON.stringify` form, so whole-number costs and times stay integers.
pub fn js(value: &impl Serialize) -> String {
    crate::shared::js_json::stringify(&serde_json::to_value(value).expect("usage serializes"))
}

/// `TaskAnalyticsStore.record`: replace one native session's saved usage.
pub fn record(
    database: &mut SuplexDatabase,
    task_id: &str,
    session_id: &str,
    usage: &[TaskUsage],
    at: &str,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        let connection = database.connection();
        // An empty read keeps the saved rows: the native source no longer has them.
        if let Some(entry) = usage.first() {
            connection.execute(
                "DELETE FROM suplex_task_usage WHERE task_id = ?1 AND session_id = ?2",
                params![task_id, entry.session_id],
            )?;
        }
        for entry in usage {
            connection.execute(
                "INSERT INTO suplex_task_usage (task_id, session_id, message_id, snapshot, observed_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(session_id, message_id) DO UPDATE SET snapshot = excluded.snapshot, observed_at = excluded.observed_at",
                params![task_id, entry.session_id, entry.message_id, js(entry), at],
            )?;
        }
        connection.execute(
            "INSERT INTO suplex_task_analytics_sessions (session_id, task_id, observed_at, error_at) VALUES (?1, ?2, ?3, NULL) ON CONFLICT(session_id) DO UPDATE SET observed_at = excluded.observed_at, error_at = NULL",
            params![session_id, task_id, at],
        )?;
        Ok(())
    })
}

pub fn failed(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: &str,
    at: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "INSERT INTO suplex_task_analytics_sessions (session_id, task_id, error_at) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET error_at = excluded.error_at",
        params![session_id, task_id, at],
    )?;
    Ok(())
}

/// Append a lifecycle event when the status or open question changed.
pub fn observe(
    database: &SuplexDatabase,
    task_id: &str,
    status: &str,
    question_id: Option<&str>,
    at: &str,
) -> DatabaseResult<()> {
    let prior = database
        .connection()
        .query_row(
            "SELECT status, question_id FROM suplex_task_analytics_events WHERE task_id = ?1 ORDER BY id DESC LIMIT 1",
            [task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if prior
        .as_ref()
        .is_some_and(|(last, question)| last == status && question.as_deref() == question_id)
    {
        return Ok(());
    }
    database.connection().execute(
        "INSERT INTO suplex_task_analytics_events (task_id, status, question_id, observed_at) VALUES (?1, ?2, ?3, ?4)",
        params![task_id, status, question_id, at],
    )?;
    Ok(())
}

/// Lifecycle hook for status writes: observe the current control row.
pub fn observe_lifecycle(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<()> {
    let (status, question): (String, Option<String>) = database.connection().query_row(
        "SELECT status, human_question_id FROM suplex_task_controls WHERE task_id = ?1",
        [task_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    observe(
        database,
        task_id,
        &status,
        question.as_deref().filter(|id| !id.is_empty()),
        &crate::shared::time::now_millis_rfc3339(),
    )
}

pub fn session_observations(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Vec<AnalyticsSession>> {
    let mut statement = database.connection().prepare(
        "SELECT session_id, observed_at, error_at FROM suplex_task_analytics_sessions WHERE task_id = ?1",
    )?;
    Ok(statement
        .query_map([task_id], |row| {
            Ok(AnalyticsSession {
                session_id: row.get(0)?,
                observed_at: row.get(1)?,
                error_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn read(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<AnalyticsData> {
    let mut statement = database
        .connection()
        .prepare("SELECT snapshot FROM suplex_task_usage WHERE task_id = ?1")?;
    let usage = statement
        .query_map([task_id], |row| row.get::<_, String>(0))?
        .map(|snapshot| -> DatabaseResult<TaskUsage> { Ok(serde_json::from_str(&snapshot?)?) })
        .collect::<DatabaseResult<Vec<_>>>()?;
    let mut statement = database.connection().prepare(
        "SELECT status, question_id, observed_at FROM suplex_task_analytics_events WHERE task_id = ?1 ORDER BY id",
    )?;
    let events = statement
        .query_map([task_id], |row| {
            Ok(AnalyticsEvent {
                status: row.get(0)?,
                question_id: row.get(1)?,
                observed_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(AnalyticsData {
        usage,
        sessions: session_observations(database, task_id)?,
        events,
    })
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMetrics {
    pub cost: Option<f64>,
    pub measured_messages: usize,
    pub unpriced_messages: usize,
    pub subsidized: bool,
    pub subsidized_messages: usize,
    pub tokens: Tokens,
    pub total_tokens: f64,
    pub turns: usize,
    pub root_turns: usize,
    pub worker_turns: usize,
    pub steps: f64,
    pub failed_turns: usize,
    pub incomplete_messages: usize,
    pub summaries: usize,
    pub duration_ms: f64,
}

pub fn usage_is_unpriced(entry: &TaskUsage) -> bool {
    entry.cost == 0.0 && entry.tokens.total() > 0.0
}

pub fn usage_metrics(usage: &[TaskUsage]) -> UsageMetrics {
    let mut tokens = Tokens::default();
    let (mut root, mut worker, mut failed) = (HashSet::new(), HashSet::new(), HashSet::new());
    let mut intervals = BTreeMap::<&str, Vec<(f64, f64)>>::new();
    let (mut cost, mut steps, mut unpriced, mut subsidized) = (0.0, 0.0, 0, 0);
    for entry in usage {
        tokens.input += entry.tokens.input;
        tokens.output += entry.tokens.output;
        tokens.reasoning += entry.tokens.reasoning;
        tokens.cache.read += entry.tokens.cache.read;
        tokens.cache.write += entry.tokens.cache.write;
        cost += entry.cost;
        steps += entry.steps;
        if usage_is_unpriced(entry) {
            unpriced += 1;
        }
        if entry.subsidized {
            subsidized += 1;
        }
        let turn = format!("{}:{}", entry.session_id, entry.turn_id);
        if entry.failed {
            failed.insert(turn.clone());
        }
        if entry.role == "root" {
            root.insert(turn);
        } else {
            worker.insert(turn);
        }
        if let Some(completed) = entry.completed_at {
            intervals
                .entry(&entry.session_id)
                .or_default()
                .push((entry.started_at, entry.started_at.max(completed)));
        }
    }
    let mut duration_ms = 0.0;
    for list in intervals.values_mut() {
        list.sort_by(|left, right| left.0.total_cmp(&right.0));
        let mut end = f64::NEG_INFINITY;
        for (start, finish) in list.iter() {
            duration_ms += (finish - start.max(end)).max(0.0);
            end = end.max(*finish);
        }
    }
    UsageMetrics {
        cost: (!usage.is_empty() && (cost > 0.0 || unpriced == 0)).then_some(cost),
        measured_messages: usage.len(),
        unpriced_messages: unpriced,
        subsidized: subsidized > 0
            && usage
                .iter()
                .all(|entry| entry.subsidized || entry.cost <= 0.0),
        subsidized_messages: subsidized,
        total_tokens: tokens.total(),
        tokens,
        turns: root.len() + worker.len(),
        root_turns: root.len(),
        worker_turns: worker.len(),
        steps,
        failed_turns: failed.len(),
        incomplete_messages: usage
            .iter()
            .filter(|entry| entry.completed_at.is_none())
            .count(),
        summaries: usage.iter().filter(|entry| entry.summary).count(),
        duration_ms,
    }
}

/// `taskAnalytics`: one task row of the analytics response.
pub fn task_analytics(
    task: &Value,
    native_session_ids: &[String],
    data: AnalyticsData,
    now: f64,
) -> Value {
    let events = &data.events;
    let observed_at = data
        .sessions
        .iter()
        .filter_map(|session| session.observed_at.clone())
        .max();
    let mut observed_wait_ms = 0.0;
    for (index, event) in events.iter().enumerate() {
        if event.status != "waiting_human" {
            continue;
        }
        let end = match events.get(index + 1) {
            Some(next) => millis(&next.observed_at),
            None => now.min(millis(observed_at.as_deref().unwrap_or(&event.observed_at))),
        };
        observed_wait_ms += (end - millis(&event.observed_at)).max(0.0);
    }
    let created_at = task["createdAt"].as_str().unwrap_or_default();
    let starts_at_creation = events
        .first()
        .is_some_and(|first| (millis(&first.observed_at) - millis(created_at)).abs() < 1000.0);
    let start = (starts_at_creation
        || events
            .first()
            .is_some_and(|first| matches!(first.status.as_str(), "backlog" | "queued")))
    .then(|| events.iter().find(|event| event.status == "active"))
    .flatten();
    let delivered = start.and_then(|start| {
        events
            .iter()
            .find(|event| event.status == "delivered" && event.observed_at >= start.observed_at)
    });
    let sessions = native_session_ids
        .iter()
        .chain(data.sessions.iter().map(|session| &session.session_id))
        .collect::<HashSet<_>>()
        .len();
    let mut value = Map::new();
    for key in ["id", "title"] {
        value.insert(key.into(), task[key].clone());
    }
    value.insert(
        "issueKey".into(),
        task.get("issueKey").cloned().unwrap_or(Value::Null),
    );
    value.insert("projectId".into(), task["projectId"].clone());
    value.insert("status".into(), task["status"].clone());
    if let Some(state) = task["pullRequest"].get("state") {
        value.insert("pullRequestState".into(), state.clone());
    }
    value.insert("deliveryTarget".into(), task["deliveryTarget"].clone());
    value.insert("archived".into(), json!(!task["archivedAt"].is_null()));
    value.insert("createdAt".into(), json!(created_at));
    value.insert(
        "usage".into(),
        serde_json::to_value(&data.usage).expect("usage"),
    );
    value.insert("sessions".into(), json!(sessions));
    value.insert(
        "observedSessions".into(),
        json!(
            data.sessions
                .iter()
                .filter(|session| session.observed_at.is_some())
                .count()
        ),
    );
    value.insert(
        "staleSessions".into(),
        json!(
            data.sessions
                .iter()
                .filter(|session| session.error_at.is_some())
                .count()
        ),
    );
    value.insert("observedAt".into(), json!(observed_at));
    value.insert(
        "observationStartedAt".into(),
        json!(events.first().map(|event| &event.observed_at)),
    );
    value.insert(
        "questions".into(),
        json!(
            events
                .iter()
                .filter_map(|event| event.question_id.as_ref())
                .collect::<HashSet<_>>()
                .len()
        ),
    );
    value.insert("observedWaitMs".into(), json!(observed_wait_ms));
    value.insert(
        "deliveryMs".into(),
        json!(start.zip(delivered).map(|(start, delivered)| {
            (millis(&delivered.observed_at) - millis(&start.observed_at)).max(0.0)
        })),
    );
    Value::Object(value)
}

/// `TaskService.listTasks` for one company, in the task list order.
pub fn company_task_ids(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
    archived: bool,
) -> DatabaseResult<Vec<String>> {
    let visible = companies::list_visible_companies(database, user_id)?;
    if !visible.iter().any(|company| company.id == company_id) {
        return Err(TaskError::not_found().into());
    }
    let mut statement = database.connection().prepare(
        "SELECT t.id FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.company_id = ?1 AND (t.archived_at IS NOT NULL) = ?2 ORDER BY julianday(CASE WHEN julianday(t.updated_at) >= julianday(c.updated_at) THEN t.updated_at ELSE c.updated_at END) DESC, t.id",
    )?;
    Ok(statement
        .query_map(params![company_id, archived], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn native_session_ids(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Vec<String>> {
    let mut statement = database.connection().prepare(
        "SELECT id FROM suplex_task_sessions WHERE task_id = ?1 AND native_session_id IS NOT NULL",
    )?;
    Ok(statement
        .query_map([task_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// `TaskService.analytics`: active tasks, then archived tasks.
pub fn analytics(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Value> {
    let mut ids = company_task_ids(database, user_id, company_id, false)?;
    ids.extend(company_task_ids(database, user_id, company_id, true)?);
    let mut tasks = Vec::new();
    for id in ids {
        let Some(task) = task_response::get(database, &id)? else {
            continue;
        };
        tasks.push(task_analytics(
            &serde_json::to_value(task)?,
            &native_session_ids(database, &id)?,
            read(database, &id)?,
            now.timestamp_millis() as f64,
        ));
    }
    Ok(json!({"generatedAt": rfc3339_millis(now), "tasks": tasks}))
}

/// The task-costs projection of `analytics`.
pub fn task_costs(analytics: &Value) -> DatabaseResult<TaskCostsResponse> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CostSource {
        id: String,
        usage: Vec<TaskUsage>,
        sessions: u64,
        observed_sessions: u64,
        stale_sessions: u64,
    }

    let tasks = analytics["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|task| -> DatabaseResult<TaskCost> {
            let task: CostSource = serde_json::from_value(task.clone())?;
            let metrics = usage_metrics(&task.usage);
            Ok(TaskCost {
                id: task.id,
                cost: metrics.cost,
                unpriced: metrics.unpriced_messages > 0,
                subsidized: metrics.subsidized,
                partial: metrics.unpriced_messages > 0
                    || task.stale_sessions > 0
                    || task.observed_sessions < task.sessions
                    || task.usage.iter().any(|entry| entry.completed_at.is_none()),
            })
        })
        .collect::<DatabaseResult<Vec<_>>>()?;
    Ok(TaskCostsResponse { tasks })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn entry(message_id: &str, cost: f64) -> TaskUsage {
        TaskUsage {
            session_id: "ses".into(),
            message_id: message_id.into(),
            turn_id: "msg_turn".into(),
            role: "root".into(),
            provider: "openai".into(),
            model: "model".into(),
            started_at: 100.0,
            completed_at: Some(200.0),
            failed: false,
            summary: false,
            steps: 1.0,
            cost,
            subsidized: false,
            tokens: Tokens {
                input: 10.0,
                output: 5.0,
                ..Tokens::default()
            },
            source: "steps".into(),
        }
    }

    #[test]
    fn task_cost_projection_preserves_missing_usage_and_partial_observations() {
        let source = |id: &str, usage: Vec<TaskUsage>, observed: u64, stale: u64| json!({"id": id, "usage": usage, "sessions": 1, "observedSessions": observed, "staleSessions": stale});
        let input = json!({"tasks": [
            source("empty", vec![], 0, 0),
            source("priced", vec![entry("priced", 3.0)], 1, 0),
            source("unpriced", vec![entry("unpriced", 0.0)], 1, 0),
            source("stale", vec![entry("stale", 2.0)], 1, 1),
            source("running", vec![TaskUsage { completed_at: None, ..entry("running", 1.0) }], 1, 0),
            source("subsidized", vec![TaskUsage { subsidized: true, ..entry("subsidized", 2.0) }], 1, 0),
        ]});
        assert_eq!(
            serde_json::to_value(task_costs(&input).unwrap()).unwrap(),
            json!({"tasks": [
                {"id":"empty","cost":null,"unpriced":false,"subsidized":false,"partial":true},
                {"id":"priced","cost":3.0,"unpriced":false,"subsidized":false,"partial":false},
                {"id":"unpriced","cost":null,"unpriced":true,"subsidized":false,"partial":true},
                {"id":"stale","cost":2.0,"unpriced":false,"subsidized":false,"partial":true},
                {"id":"running","cost":1.0,"unpriced":false,"subsidized":false,"partial":true},
                {"id":"subsidized","cost":2.0,"unpriced":false,"subsidized":true,"partial":false},
            ]})
        );
    }

    #[test]
    fn metrics_count_correlated_turns_once_and_union_overlapping_time_in_each_session() {
        let first = entry("msg_first", 3.0);
        let next = TaskUsage {
            message_id: "msg_next".into(),
            started_at: 150.0,
            completed_at: Some(250.0),
            ..first.clone()
        };
        let result = usage_metrics(&[first.clone(), next]);
        assert_eq!(
            (
                result.turns,
                result.root_turns,
                result.steps,
                result.cost,
                result.duration_ms
            ),
            (1, 1, 2.0, Some(6.0), 150.0)
        );
        assert_eq!(usage_metrics(&[]).cost, None);
        let unpriced = usage_metrics(&[TaskUsage { cost: 0.0, ..first }]);
        assert_eq!(
            (
                unpriced.cost,
                unpriced.unpriced_messages,
                unpriced.measured_messages
            ),
            (None, 1, 1)
        );
    }

    #[test]
    fn mixed_billed_and_subsidized_entries_are_not_wholly_subsidized() {
        let subsidized = TaskUsage {
            subsidized: true,
            ..entry("msg_subsidized", 2.0)
        };
        assert!(usage_metrics(std::slice::from_ref(&subsidized)).subsidized);
        let billed = entry("msg_billed", 3.0);
        assert!(!usage_metrics(&[subsidized, billed]).subsidized);
    }

    #[test]
    fn old_usage_snapshots_default_to_non_subsidized_and_keep_integer_json() {
        let mut value = serde_json::to_value(entry("msg", 3.0)).unwrap();
        value.as_object_mut().unwrap().remove("subsidized");
        let parsed: TaskUsage = serde_json::from_value(value).unwrap();
        assert!(!parsed.subsidized);
        assert!(js(&parsed).contains(r#""startedAt":100,"completedAt":200"#));
    }

    #[test]
    fn analytics_measure_waits_questions_and_delivery_from_lifecycle_events() {
        let task = json!({"id":"t","title":"T","issueKey":null,"projectId":"p","status":"delivered",
            "pullRequest":{"state":"merged"},"deliveryTarget":"merged","archivedAt":null,
            "createdAt":"2026-01-01T00:00:00.000Z"});
        let event = |status: &str, question: Option<&str>, at: &str| AnalyticsEvent {
            status: status.into(),
            question_id: question.map(str::to_owned),
            observed_at: at.into(),
        };
        let data = AnalyticsData {
            usage: vec![],
            sessions: vec![AnalyticsSession {
                session_id: "s1".into(),
                observed_at: Some("2026-01-01T00:10:00.000Z".into()),
                error_at: None,
            }],
            events: vec![
                event("backlog", None, "2026-01-01T00:00:00.000Z"),
                event("active", None, "2026-01-01T00:01:00.000Z"),
                event("waiting_human", Some("q1"), "2026-01-01T00:02:00.000Z"),
                event("active", None, "2026-01-01T00:03:00.000Z"),
                event("delivered", None, "2026-01-01T00:05:00.000Z"),
            ],
        };
        let value = task_analytics(&task, &["s1".into(), "s2".into()], data, f64::MAX);
        assert_eq!(value["pullRequestState"], "merged");
        assert_eq!(value["sessions"], 2);
        assert_eq!(value["observedSessions"], 1);
        assert_eq!(value["questions"], 1);
        assert_eq!(value["observedWaitMs"], 60_000.0);
        assert_eq!(value["deliveryMs"], 240_000.0);
        assert_eq!(value["observationStartedAt"], "2026-01-01T00:00:00.000Z");
        let without_pr = task_analytics(
            &json!({"pullRequest": null, "createdAt": "2026-01-01T00:00:00.000Z", "archivedAt": null}),
            &[],
            AnalyticsData {
                usage: vec![],
                sessions: vec![],
                events: vec![],
            },
            0.0,
        );
        assert!(without_pr.get("pullRequestState").is_none());
        assert_eq!(without_pr["deliveryMs"], Value::Null);
    }
}
