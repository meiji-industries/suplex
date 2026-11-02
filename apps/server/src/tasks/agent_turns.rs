//! Turn metadata for a paired agent: what a task did and what its turns cost.
//! No prompt or message content is read.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::params;
use serde::Serialize;

use crate::{
    http::{AppState, contracts::typed::agent_api::TaskTurnsQuery},
    identity::external_agents::Principal,
    platform::database::DatabaseResult,
    runtimes::task_harness::UsageEntry,
    tasks::{
        TaskError,
        agent_api::authorize_read,
        control::{SessionKind, TurnStatus},
        limits::{self, TaskLimits},
    },
};

crate::shared::wire_enum! {
    pub enum UsageObservation {
        Observed = "observed",
        Unavailable = "unavailable",
    }
}

const NATIVE_SESSION_UNAVAILABLE: &str =
    "The native session reader did not answer, so Suplex cannot read the usage of this task.";

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentTaskTurns {
    pub task_id: String,
    pub limits: TaskLimits,
    pub usage: AgentTaskUsage,
    pub turns: Vec<AgentTaskTurn>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskUsage {
    pub admitted_turns: i64,
    pub estimated_cost_usd: Option<f64>,
    pub observation: UsageObservation,
    pub observation_reason: Option<String>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskTurn {
    pub id: String,
    pub session_id: String,
    pub role: SessionKind,
    pub status: TurnStatus,
    pub created_at: String,
    pub prompted_at: Option<String>,
    pub completed_at: Option<String>,
    pub cost_usd: Option<f64>,
    pub tokens: Option<AgentTurnTokens>,
    pub failed: Option<bool>,
}

#[derive(Debug, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnTokens {
    pub input: i64,
    pub output: i64,
    pub reasoning: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

struct TurnRow {
    turn: AgentTaskTurn,
    native_turn_id: Option<String>,
}

fn cursor_invalid() -> Box<dyn std::error::Error + Send + Sync> {
    TaskError::Failure {
        message: "The turn cursor is not available".into(),
        status: 400,
        code: "cursor_invalid",
    }
    .into()
}

fn encode_cursor(turn: &AgentTaskTurn) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}\n{}", turn.created_at, turn.id))
}

fn decode_cursor(cursor: &str) -> DatabaseResult<(String, String)> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| cursor_invalid())?;
    let text = String::from_utf8(bytes).map_err(|_| cursor_invalid())?;
    text.split_once('\n')
        .map(|(created, id)| (created.to_owned(), id.to_owned()))
        .ok_or_else(cursor_invalid)
}

/// Newest first, one extra row to learn whether another page follows.
fn turn_rows(
    database: &crate::platform::database::SuplexDatabase,
    task_id: &str,
    after: Option<&(String, String)>,
    limit: u64,
) -> DatabaseResult<Vec<TurnRow>> {
    let (created, id) = after.map_or(("~", ""), |(created, id)| (created.as_str(), id.as_str()));
    let mut statement = database.connection().prepare(
        "SELECT t.id, t.session_id, s.kind, t.status, t.created_at, t.prompted_at, t.completed_at, t.native_turn_id FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.task_id = ?1 AND (t.created_at < ?2 OR (t.created_at = ?2 AND t.id < ?3)) ORDER BY t.created_at DESC, t.id DESC LIMIT ?4",
    )?;
    let rows = statement
        .query_map(params![task_id, created, id, (limit + 1) as i64], |row| {
            Ok(TurnRow {
                turn: AgentTaskTurn {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    prompted_at: row.get(5)?,
                    completed_at: row.get(6)?,
                    cost_usd: None,
                    tokens: None,
                    failed: None,
                },
                native_turn_id: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The cost, tokens, and failure of one turn from its usage entries. A turn
/// without entries, or with only unpriced ones, has no cost to report.
fn turn_usage(
    entries: &[(String, String, UsageEntry)],
    turn_id: &str,
    native_turn_id: Option<&str>,
) -> (Option<f64>, Option<AgentTurnTokens>, Option<bool>) {
    let own = entries
        .iter()
        .map(|(_, _, entry)| entry)
        .filter(|entry| entry.turn_id == turn_id || Some(entry.turn_id.as_str()) == native_turn_id)
        .collect::<Vec<_>>();
    if own.is_empty() {
        return (None, None, None);
    }
    let cost: f64 = own.iter().map(|entry| entry.cost_usd).sum();
    let wholly_unpriced = cost <= 0.0 && own.iter().any(|entry| limits::unpriced(entry));
    let sum = |field: fn(&UsageEntry) -> f64| own.iter().map(|entry| field(entry)).sum::<f64>() as i64;
    (
        (!wholly_unpriced).then_some(cost),
        Some(AgentTurnTokens {
            input: sum(|entry| entry.tokens.input),
            output: sum(|entry| entry.tokens.output),
            reasoning: sum(|entry| entry.tokens.reasoning),
            cache_read: sum(|entry| entry.tokens.cache_read),
            cache_write: sum(|entry| entry.tokens.cache_write),
        }),
        Some(own.iter().any(|entry| entry.failed)),
    )
}

/// Read-only. Usage comes from the native session reader and is never stored.
pub async fn read(
    state: &AppState,
    principal: &Principal,
    task_id: &str,
    query: &TaskTurnsQuery,
) -> DatabaseResult<AgentTaskTurns> {
    let (database_path, scope, mut rows) = state.with_database(|database| {
        authorize_read(database, principal, task_id)?;
        let after = query.cursor.as_deref().map(decode_cursor).transpose()?;
        let path = database
            .connection()
            .path()
            .map(std::path::PathBuf::from)
            .ok_or("Task database has no path")?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>((
            path,
            limits::usage_scope(database, task_id)?,
            turn_rows(database, task_id, after.as_ref(), query.limit)?,
        ))
    })?;
    let (sessions, budget_usd, max_turns, admitted_turns) = scope;
    let observed = limits::observe_priced_usage(&database_path, sessions).await;
    let has_more = rows.len() as u64 > query.limit;
    rows.truncate(query.limit as usize);
    let (entries, estimated_cost_usd, observation, observation_reason) = match observed {
        Ok(entries) => {
            let cost = limits::total_cost(&entries);
            (entries, cost, UsageObservation::Observed, None)
        }
        Err(_) => (
            Vec::new(),
            None,
            UsageObservation::Unavailable,
            Some(NATIVE_SESSION_UNAVAILABLE.to_owned()),
        ),
    };
    let next_cursor = has_more
        .then(|| rows.last().map(|row| encode_cursor(&row.turn)))
        .flatten();
    let turns = rows
        .into_iter()
        .map(|row| {
            let (cost_usd, tokens, failed) = turn_usage(
                &entries,
                &row.turn.id,
                row.native_turn_id.as_deref(),
            );
            AgentTaskTurn {
                cost_usd,
                tokens,
                failed,
                ..row.turn
            }
        })
        .collect();
    Ok(AgentTaskTurns {
        task_id: task_id.to_owned(),
        limits: TaskLimits {
            budget_usd,
            max_turns,
        },
        usage: AgentTaskUsage {
            admitted_turns,
            estimated_cost_usd,
            observation,
            observation_reason,
        },
        turns,
        next_cursor,
    })
}
