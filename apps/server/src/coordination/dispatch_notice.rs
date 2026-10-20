//! Why the host has not dispatched the next Coordinator or Worker turn.
//!
//! A display observation for the task view. Dispatch never reads it: retries
//! continue, and the task status does not change. A prompt admission clears it,
//! and so does any task status change (a database trigger).

use crate::platform::database::{DatabaseResult, SuplexDatabase};
use crate::shared::time::rfc3339_millis;
use crate::tasks::control::HarnessKind;
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

crate::shared::wire_enum! {
    pub enum DispatchAgent {
        Coordinator = "coordinator",
        Worker = "worker",
    }
}

crate::shared::wire_enum! {
    /// `dispatch`: the runtime did not accept a prompt. `sweep`: the host sweep
    /// failed before dispatch. `idle_wait`: the idle Coordinator wake waits.
    pub enum DispatchNoticeKind {
        Dispatch = "dispatch",
        Sweep = "sweep",
        IdleWait = "idle_wait",
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DispatchNotice {
    pub kind: DispatchNoticeKind,
    pub agent: DispatchAgent,
    pub text: String,
    pub observed_at: String,
    /// When the host next tries, for a deferred wake.
    pub next_wake_at: Option<String>,
}

impl DispatchNotice {
    pub fn new(
        kind: DispatchNoticeKind,
        agent: DispatchAgent,
        text: String,
        next_wake_at: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            kind,
            agent,
            text,
            observed_at: rfc3339_millis(now),
            next_wake_at: next_wake_at.map(rfc3339_millis),
        }
    }

    /// The runtime answered a dispatch without admitting the prompt.
    pub fn not_admitted(
        agent: DispatchAgent,
        provider: HarnessKind,
        reason: &str,
        now: DateTime<Utc>,
    ) -> Self {
        let runtime = provider_label(provider);
        let why = match reason {
            "native_status_unavailable" | "native_read_unavailable" => {
                format!("{runtime} is not connected.")
            }
            "native_session_busy" => format!("The {runtime} session is busy."),
            "message_not_observed" => format!("{runtime} did not receive the prompt."),
            "final_response_not_observed" => format!("{runtime} did not send a response."),
            "dispatch_process_stopped" => format!("The {runtime} process stopped."),
            "native_error" => format!("{runtime} returned an error."),
            other => format!("{runtime} did not accept the prompt ({other})."),
        };
        Self::new(
            DispatchNoticeKind::Dispatch,
            agent,
            format!(
                "Suplex could not start the {}. {why} Suplex tries again.",
                agent_label(agent)
            ),
            None,
            now,
        )
    }

    /// Another live process holds the session operation.
    pub fn session_held(agent: DispatchAgent, now: DateTime<Utc>) -> Self {
        Self::new(
            DispatchNoticeKind::Dispatch,
            agent,
            format!(
                "Another Suplex process holds the {} session. Suplex tries again.",
                agent_label(agent)
            ),
            None,
            now,
        )
    }

    /// This process could not read its own identity to claim the session.
    pub fn process_unknown(agent: DispatchAgent, now: DateTime<Utc>) -> Self {
        Self::new(
            DispatchNoticeKind::Dispatch,
            agent,
            format!(
                "Suplex could not read its own process, so it could not start the {}. Suplex tries again.",
                agent_label(agent)
            ),
            None,
            now,
        )
    }

    /// The host sweep failed before dispatch.
    pub fn sweep_failed(error: &str, now: DateTime<Utc>) -> Self {
        let error = error.trim().trim_end_matches('.');
        Self::new(
            DispatchNoticeKind::Sweep,
            DispatchAgent::Coordinator,
            format!(
                "Suplex could not prepare the next Coordinator turn: {error}. Suplex tries again."
            ),
            None,
            now,
        )
    }

    /// The idle Coordinator wake waits `delay_seconds` after its last turn.
    pub fn idle_wait(delay_seconds: i64, next_wake_at: DateTime<Utc>, now: DateTime<Utc>) -> Self {
        Self::new(
            DispatchNoticeKind::IdleWait,
            DispatchAgent::Coordinator,
            format!(
                "The Coordinator is idle. Suplex waits {} between idle Coordinator wakes.",
                duration_words(delay_seconds)
            ),
            Some(next_wake_at),
            now,
        )
    }
}

fn agent_label(agent: DispatchAgent) -> &'static str {
    match agent {
        DispatchAgent::Coordinator => "Coordinator",
        DispatchAgent::Worker => "Worker",
    }
}

fn provider_label(provider: HarnessKind) -> &'static str {
    match provider {
        HarnessKind::Opencode => "OpenCode",
        HarnessKind::ClaudeCode => "Claude Code",
        HarnessKind::Devin => "Devin",
        HarnessKind::Codex => "Codex",
        HarnessKind::Pi => "Pi",
        HarnessKind::Omp => "OMP",
    }
}

fn duration_words(seconds: i64) -> String {
    let (count, unit) = if seconds < 60 {
        (seconds, "second")
    } else {
        ((seconds + 30) / 60, "minute")
    };
    format!("{count} {unit}{}", if count == 1 { "" } else { "s" })
}

/// Store the notice for an active task. An unchanged notice (same kind,
/// agent, text, and next wake) writes nothing, so the open task is not
/// published again on each sweep.
pub fn record(
    database: &SuplexDatabase,
    task_id: &str,
    notice: &DispatchNotice,
) -> DatabaseResult<bool> {
    Ok(database.connection().execute(
        "UPDATE suplex_task_controls SET dispatch_notice_json = ?1 WHERE task_id = ?2 AND status = 'active' AND (dispatch_notice_json IS NULL OR json_extract(dispatch_notice_json, '$.kind') IS NOT ?3 OR json_extract(dispatch_notice_json, '$.agent') IS NOT ?4 OR json_extract(dispatch_notice_json, '$.text') IS NOT ?5 OR json_extract(dispatch_notice_json, '$.nextWakeAt') IS NOT ?6)",
        params![
            serde_json::to_string(notice)?,
            task_id,
            notice.kind,
            notice.agent,
            notice.text,
            notice.next_wake_at,
        ],
    )? == 1)
}

/// Remove the notice. With `kind`, remove it only when it has that kind.
pub fn clear(
    database: &SuplexDatabase,
    task_id: &str,
    kind: Option<DispatchNoticeKind>,
) -> DatabaseResult<bool> {
    Ok(database.connection().execute(
        "UPDATE suplex_task_controls SET dispatch_notice_json = NULL WHERE task_id = ?1 AND dispatch_notice_json IS NOT NULL AND (?2 IS NULL OR json_extract(dispatch_notice_json, '$.kind') = ?2)",
        params![task_id, kind],
    )? == 1)
}

/// The stored notice. A notice this version cannot read is not shown.
pub fn read(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Option<DispatchNotice>> {
    let raw: Option<String> = database
        .connection()
        .query_row(
            "SELECT dispatch_notice_json FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
}

/// Record a notice from the host. A failed write is logged; it never changes
/// the dispatch result.
pub fn observe(database: &SuplexDatabase, task_id: &str, notice: &DispatchNotice) {
    if let Err(error) = record(database, task_id, notice) {
        eprintln!("Task {task_id} dispatch notice was not saved: {error}");
    }
}

#[cfg(test)]
#[path = "../../tests/coordination/dispatch_notice.rs"]
mod tests;
