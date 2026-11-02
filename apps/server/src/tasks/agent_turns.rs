//! Turn metadata for a paired agent: what a task did and what its turns cost.
//! No prompt or message content is read.

use std::collections::HashMap;

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

struct PromptedTurn {
    id: String,
    native_session_id: String,
    prompted_at_ms: i64,
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
) -> DatabaseResult<Vec<AgentTaskTurn>> {
    let (created, id) = after.map_or(("~", ""), |(created, id)| (created.as_str(), id.as_str()));
    let mut statement = database.connection().prepare(
        "SELECT t.id, t.session_id, s.kind, t.status, t.created_at, t.prompted_at, t.completed_at FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.task_id = ?1 AND (t.created_at < ?2 OR (t.created_at = ?2 AND t.id < ?3)) ORDER BY t.created_at DESC, t.id DESC LIMIT ?4",
    )?;
    let rows = statement
        .query_map(params![task_id, created, id, (limit + 1) as i64], |row| {
            Ok(AgentTaskTurn {
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
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every prompted turn of the task, oldest first.
fn prompted_turns(
    database: &crate::platform::database::SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Vec<PromptedTurn>> {
    let mut statement = database.connection().prepare(
        "SELECT t.id, s.native_session_id, t.prompted_at FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.task_id = ?1 AND t.prompted_at IS NOT NULL AND s.native_session_id IS NOT NULL ORDER BY t.prompted_at, t.id",
    )?;
    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, native_session_id, prompted_at)| {
            let prompted_at_ms = chrono::DateTime::parse_from_rfc3339(&prompted_at)
                .ok()?
                .timestamp_millis();
            Some(PromptedTurn {
                id,
                native_session_id,
                prompted_at_ms,
            })
        })
        .collect())
}

/// Usage grouped by Suplex turn. Some providers report the Suplex turn id.
/// Others, such as Claude Code, have their own ids, and a session runs one turn
/// at a time, so that usage belongs to the session's last turn prompted before
/// it started.
fn usage_by_turn<'a>(
    entries: &'a [(String, String, UsageEntry)],
    prompted: &[PromptedTurn],
) -> HashMap<String, Vec<&'a UsageEntry>> {
    let mut owned: HashMap<String, Vec<&UsageEntry>> = HashMap::new();
    for (native_session_id, _, entry) in entries {
        let owner = prompted
            .iter()
            .find(|turn| turn.id == entry.turn_id)
            .or_else(|| {
                prompted.iter().rev().find(|turn| {
                    turn.native_session_id == *native_session_id
                        && turn.prompted_at_ms <= entry.started_at_ms
                })
            });
        if let Some(owner) = owner {
            owned.entry(owner.id.clone()).or_default().push(entry);
        }
    }
    owned
}

/// The cost, tokens, and failure of one turn from its usage entries. A turn
/// without entries, or with only unpriced ones, has no cost to report.
fn turn_usage(own: &[&UsageEntry]) -> (Option<f64>, Option<AgentTurnTokens>, Option<bool>) {
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
    let (database_path, scope, mut rows, prompted) = state.with_database(|database| {
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
            prompted_turns(database, task_id)?,
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
        .then(|| rows.last().map(encode_cursor))
        .flatten();
    let usage = usage_by_turn(&entries, &prompted);
    let turns = rows
        .into_iter()
        .map(|turn| {
            let (cost_usd, tokens, failed) =
                turn_usage(usage.get(&turn.id).map_or(&[], Vec::as_slice));
            AgentTaskTurn {
                cost_usd,
                tokens,
                failed,
                ..turn
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::native::UsageTokens;

    fn turn(id: &str, native_session_id: &str, prompted_at_ms: i64) -> PromptedTurn {
        PromptedTurn {
            id: id.to_owned(),
            native_session_id: native_session_id.to_owned(),
            prompted_at_ms,
        }
    }

    fn usage(native_session_id: &str, turn_id: &str, started_at_ms: i64) -> (String, String, UsageEntry) {
        (
            native_session_id.to_owned(),
            "root".to_owned(),
            UsageEntry {
                message_id: format!("{turn_id}-{started_at_ms}"),
                turn_id: turn_id.to_owned(),
                provider: "anthropic".to_owned(),
                model: "test".to_owned(),
                started_at_ms,
                completed_at_ms: None,
                failed: false,
                tokens: UsageTokens::default(),
                cost_usd: 1.0,
                subsidized: false,
                summary: false,
                steps: 1.0,
                source: "test",
                generation_ms: None,
                first_response_ms: None,
            },
        )
    }

    #[test]
    fn usage_with_a_provider_turn_id_belongs_to_the_session_turn_prompted_before_it() {
        let prompted = [
            turn("turn_a1", "native_a", 100),
            turn("turn_b1", "native_b", 150),
            turn("turn_a2", "native_a", 200),
        ];
        let entries = [
            usage("native_a", "uuid-1", 120),
            usage("native_a", "uuid-1", 190),
            usage("native_a", "uuid-2", 250),
            usage("native_b", "uuid-3", 900),
            usage("native_a", "uuid-0", 50),
        ];
        let owned = usage_by_turn(&entries, &prompted);
        let count = |id: &str| owned.get(id).map_or(0, Vec::len);
        assert_eq!(count("turn_a1"), 2);
        assert_eq!(count("turn_a2"), 1);
        assert_eq!(count("turn_b1"), 1, "another session's later prompt does not take this usage");
        assert_eq!(owned.values().map(Vec::len).sum::<usize>(), 4, "usage before any prompt has no turn");
    }

    #[test]
    fn usage_naming_a_suplex_turn_belongs_to_that_turn_whatever_its_time() {
        let prompted = [turn("turn_1", "native", 100), turn("turn_2", "native", 200)];
        let entries = [usage("native", "turn_1", 0), usage("native", "turn_2", 0)];
        let owned = usage_by_turn(&entries, &prompted);
        assert_eq!(owned["turn_1"].len(), 1);
        assert_eq!(owned["turn_2"].len(), 1);
    }
}
