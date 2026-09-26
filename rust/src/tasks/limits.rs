//! Task limit admission, pause, and answer handling.
use crate::coordination::{
    persistence::{new_turn_id, session},
    root_session_store::{cancel_open_turns, insert_pending_turn, observe_lifecycle},
};
use crate::{
    coordination::CoordinationError,
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::{js_json, time::rfc3339_millis},
    tasks::control::*,
};
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TaskLimitUsage {
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskLimits {
    budget_usd: f64,
    max_turns: i64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedLimitUsage {
    estimated_cost_usd: Option<f64>,
    admitted_turns: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedLimitPause {
    kind: String,
    reason: String,
    limits: TaskLimits,
    usage: PersistedLimitUsage,
    proposed_limits: TaskLimits,
}

pub(crate) fn suggested_budget(proposed: f64, spent: f64) -> f64 {
    (proposed / 5.0)
        .round()
        .mul_add(5.0, 0.0)
        .max(((spent / 5.0).floor() + 1.0) * 5.0)
}

fn task_limit_question(
    reason: &str,
    limits: TaskLimits,
    proposed: TaskLimits,
    usage: PersistedLimitUsage,
) -> String {
    let reached = match reason {
        "budget" => "estimated spend budget",
        "turns" => "turn limit",
        _ => "estimated spend budget and turn limit",
    };
    let spend = match usage.estimated_cost_usd {
        None => "Estimated spend is not available.".to_owned(),
        Some(cost) if limits.budget_usd == 0.0 => {
            format!("Estimated spend is ${cost:.2}. The budget is disabled.")
        }
        Some(cost) => format!(
            "Estimated spend is ${cost:.2} of ${:.2}.",
            limits.budget_usd
        ),
    };
    let turns = if limits.max_turns == 0 {
        format!(
            "{} turns were admitted. The turn limit is disabled.",
            usage.admitted_turns
        )
    } else {
        format!(
            "Admitted turns are {} of {}.",
            usage.admitted_turns, limits.max_turns
        )
    };
    let budget = if reason == "turns" {
        proposed.budget_usd
    } else {
        suggested_budget(proposed.budget_usd, usage.estimated_cost_usd.unwrap_or(0.0))
    };
    let proposed_budget = if budget == 0.0 {
        "no budget limit".to_owned()
    } else {
        format!("a ${budget:.2} budget")
    };
    let proposed_turns = if proposed.max_turns == 0 {
        "no turn limit".to_owned()
    } else {
        format!("{} turns", proposed.max_turns)
    };
    format!(
        "This task reached its {reached}. {spend} {turns} Suplex proposes {proposed_budget} and {proposed_turns}. A native turn already in progress can finish before Suplex pauses. Select how to continue."
    )
}

/// Apply the current task-limit decision as one durable control and prompt update.
pub fn answer_task_limit(
    database: &mut SuplexDatabase,
    task_id: &str,
    question_id: &str,
    decision: &TaskLimitDecision,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(true, |database| {
        let row: Option<(String, Option<String>, Option<String>)> = database
            .connection()
            .query_row(
                "SELECT human_question,limit_pause_json,root_session_id FROM suplex_task_controls WHERE task_id = ?1 AND status = 'waiting_human' AND human_question_id = ?2",
                params![task_id, question_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((question, Some(raw_pause), root_id)) = row else {
            return Err(CoordinationError::refused("question_identity_mismatch").into());
        };
        let pause: PersistedLimitPause = serde_json::from_str(&raw_pause)?;
        if pause.kind != "task_limit"
            || !matches!(pause.reason.as_str(), "budget" | "turns" | "budget_and_turns")
            || !pause.limits.budget_usd.is_finite()
            || pause.limits.budget_usd < 0.0
            || pause.limits.max_turns < 0
            || pause.usage.estimated_cost_usd.is_some_and(|cost| !cost.is_finite() || cost < 0.0)
            || pause.usage.admitted_turns < 0
            || !pause.proposed_limits.budget_usd.is_finite()
            || pause.proposed_limits.budget_usd < 0.0
            || pause.proposed_limits.max_turns < 0
        {
            return Err(CoordinationError::refused("invalid_task_limit_pause").into());
        }
        let time = rfc3339_millis(now);
        if matches!(decision, TaskLimitDecision::CancelTask) {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'cancelled', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?1 WHERE task_id = ?2",
                params![time, task_id],
            )?;
            database.connection().execute(
                "UPDATE suplex_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = COALESCE(stop_requested_at, ?1), updated_at = ?1 WHERE task_id = ?2 AND stopped_at IS NULL",
                params![time, task_id],
            )?;
            cancel_open_turns(database, task_id, None, &time)?;
            return Ok(());
        }
        let root_id = root_id.ok_or_else(|| CoordinationError::refused("root_notification_unavailable"))?;
        let root = database
            .connection()
            .query_row(
                "SELECT * FROM suplex_task_sessions WHERE id = ?1 AND task_id = ?2 AND kind = 'root' AND is_current = 1 AND lifecycle <> 'cancelled'",
                params![root_id, task_id],
                session,
            )
            .optional()?
            .ok_or_else(|| CoordinationError::refused("root_notification_unavailable"))?;
        let limits = match decision {
            TaskLimitDecision::AddAllowance => pause.proposed_limits,
            TaskLimitDecision::ChangeLimits { limits } => TaskLimits {
                budget_usd: limits.budget_usd,
                max_turns: limits.max_turns as i64,
            },
            TaskLimitDecision::CancelTask => unreachable!(),
        };
        let prompt = js_json::stringify(&serde_json::json!({"question": question, "decision": decision}));
        let id = new_turn_id(now)?;
        insert_pending_turn(database, &id, task_id, &root.id, root.generation, None, &prompt, None, &time)?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'active', budget_usd = ?1, max_turns = ?2, limit_pause_json = NULL, human_question = NULL, human_question_id = NULL, human_question_options_json = '[]', wake_at = ?3, updated_at = ?3 WHERE task_id = ?4",
            params![limits.budget_usd, limits.max_turns, time, task_id],
        )?;
        Ok(())
    })?;
    observe_lifecycle(database, task_id)
}

/// TypeScript `TaskLimitStore.reconcilePause`: resume a limit-paused task
/// when observed usage is within its current limits, or refresh the pause.
pub fn reconcile_task_limit_pause(
    database: &mut SuplexDatabase,
    task_id: &str,
    question_id: &str,
    usage: TaskLimitUsage,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        let row: Option<(Option<f64>, Option<i64>, String)> = database.connection().query_row(
            "SELECT budget_usd, max_turns, limit_pause_json FROM suplex_task_controls WHERE task_id = ?1 AND human_question_id = ?2 AND status = 'waiting_human' AND limit_pause_json IS NOT NULL",
            params![task_id, question_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((budget_usd, max_turns, raw_pause)) = row else { return Ok(false); };
        let _: PersistedLimitPause = serde_json::from_str(&raw_pause)?;
        let settings = crate::platform::environment_settings::read(database)?;
        let defaults = TaskLimits { budget_usd: settings.default_budget_usd, max_turns: settings.default_max_turns };
        let limits = TaskLimits { budget_usd: budget_usd.unwrap_or(defaults.budget_usd), max_turns: max_turns.unwrap_or(defaults.max_turns) };
        if limits.budget_usd > 0.0 && usage.estimated_cost_usd.is_none() { return Ok(false); }
        let admitted_turns: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompted_at IS NOT NULL",
            [task_id], |row| row.get(0),
        )?;
        let time = rfc3339_millis(now);
        let hit_budget = limits.budget_usd > 0.0 && usage.estimated_cost_usd.is_some_and(|cost| cost >= limits.budget_usd);
        let hit_turns = limits.max_turns > 0 && admitted_turns >= limits.max_turns;
        if !hit_budget && !hit_turns {
            return Ok(database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'active', limit_pause_json = NULL, human_question = NULL, human_question_id = NULL, human_question_options_json = '[]', wake_at = ?1, updated_at = ?1 WHERE task_id = ?2 AND status = 'waiting_human' AND human_question_id = ?3",
                params![time, task_id, question_id],
            )? == 1);
        }
        // ponytail: same evaluation as `claim_prompt`; share one helper once both packages merge.
        let reason = match (hit_budget, hit_turns) { (true, true) => "budget_and_turns", (true, false) => "budget", _ => "turns" };
        let budget_allowance = if defaults.budget_usd > 0.0 { defaults.budget_usd } else { limits.budget_usd };
        let turn_allowance = if defaults.max_turns > 0 { defaults.max_turns } else { limits.max_turns };
        let proposed = TaskLimits {
            budget_usd: if hit_budget { suggested_budget(usage.estimated_cost_usd.unwrap_or(0.0) + budget_allowance, usage.estimated_cost_usd.unwrap_or(0.0)) } else { limits.budget_usd },
            max_turns: if hit_turns { admitted_turns + turn_allowance } else { limits.max_turns },
        };
        let observed = PersistedLimitUsage { estimated_cost_usd: usage.estimated_cost_usd, admitted_turns };
        let pause = js_json::stringify(&serde_json::json!({ "kind": "task_limit", "reason": reason, "limits": limits, "usage": observed, "proposedLimits": proposed }));
        if pause != js_json::stringify(&serde_json::from_str(&raw_pause)?) {
            database.connection().execute(
                "UPDATE suplex_task_controls SET limit_pause_json = ?1, human_question = ?2, updated_at = ?3 WHERE task_id = ?4 AND status = 'waiting_human' AND human_question_id = ?5",
                params![pause, task_limit_question(reason, limits, proposed, observed), time, task_id, question_id],
            )?;
        }
        Ok(false)
    })
}

pub(crate) enum Admission {
    Allowed,
    Blocked,
}

pub(crate) fn check_admission(
    database: &SuplexDatabase,
    task_id: &str,
    usage: TaskLimitUsage,
    now: DateTime<Utc>,
) -> DatabaseResult<Admission> {
    let control = database
        .connection()
        .query_row(
            "SELECT status, budget_usd, max_turns FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, TaskStatus>(0)?,
                    row.get::<_, Option<f64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((status, budget_usd, max_turns)) = control else {
        return Ok(Admission::Blocked);
    };
    if status != TaskStatus::Active {
        return Ok(Admission::Blocked);
    }
    let dependency_blocked = crate::tasks::dependencies::blocked(database, task_id)?;
    if dependency_blocked {
        return Ok(Admission::Blocked);
    }
    let settings = crate::platform::environment_settings::read(database)?;
    let defaults = TaskLimits {
        budget_usd: settings.default_budget_usd,
        max_turns: settings.default_max_turns,
    };
    let limits = TaskLimits {
        budget_usd: budget_usd.unwrap_or(defaults.budget_usd),
        max_turns: max_turns.unwrap_or(defaults.max_turns),
    };
    let admitted_turns: i64 = database.connection().query_row(
        "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompted_at IS NOT NULL",
        [task_id],
        |row| row.get(0),
    )?;
    let reservations: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status = 'unknown' AND prompted_at IS NULL",
            [task_id], |row| row.get(0),
        )?;
    let hit_budget = limits.budget_usd > 0.0
        && usage
            .estimated_cost_usd
            .is_some_and(|cost| cost >= limits.budget_usd);
    let hit_turns = limits.max_turns > 0 && admitted_turns >= limits.max_turns;
    if hit_budget || hit_turns {
        let reason = match (hit_budget, hit_turns) {
            (true, true) => "budget_and_turns",
            (true, false) => "budget",
            _ => "turns",
        };
        let budget_allowance = if defaults.budget_usd > 0.0 {
            defaults.budget_usd
        } else {
            limits.budget_usd
        };
        let turn_allowance = if defaults.max_turns > 0 {
            defaults.max_turns
        } else {
            limits.max_turns
        };
        let proposed = TaskLimits {
            budget_usd: if hit_budget {
                suggested_budget(
                    usage.estimated_cost_usd.unwrap_or(0.0) + budget_allowance,
                    usage.estimated_cost_usd.unwrap_or(0.0),
                )
            } else {
                limits.budget_usd
            },
            max_turns: if hit_turns {
                admitted_turns + turn_allowance
            } else {
                limits.max_turns
            },
        };
        let observed = PersistedLimitUsage {
            estimated_cost_usd: usage.estimated_cost_usd,
            admitted_turns,
        };
        let pause = serde_json::json!({ "kind": "task_limit", "reason": reason, "limits": limits, "usage": observed, "proposedLimits": proposed });
        let time = rfc3339_millis(now);
        database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', limit_pause_json = ?1, human_question = ?2, human_question_options_json = '[]', human_question_id = ?3, wake_at = NULL, updated_at = ?4 WHERE task_id = ?5 AND status = 'active'",
                params![pause.to_string(), task_limit_question(reason, limits, proposed, observed), Uuid::new_v4().to_string(), time, task_id],
            )?;
        return Ok(Admission::Blocked);
    }
    if limits.max_turns > 0 && admitted_turns + reservations >= limits.max_turns {
        return Ok(Admission::Blocked);
    }
    Ok(Admission::Allowed)
}
