//! Task limit admission, pause, and answer handling.
use crate::coordination::{
    persistence::{new_turn_id, session},
    root_session_store::{NewTurn, cancel_open_turns, insert_pending_turn, observe_lifecycle},
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

/// The saved pause is a well-formed task-limit pause.
fn valid_pause(pause: &PersistedLimitPause) -> bool {
    let valid_limits = |limits: &TaskLimits| {
        limits.budget_usd.is_finite() && limits.budget_usd >= 0.0 && limits.max_turns >= 0
    };
    pause.kind == "task_limit"
        && matches!(
            pause.reason.as_str(),
            "budget" | "turns" | "budget_and_turns"
        )
        && valid_limits(&pause.limits)
        && !pause
            .usage
            .estimated_cost_usd
            .is_some_and(|cost| !cost.is_finite() || cost < 0.0)
        && pause.usage.admitted_turns >= 0
        && valid_limits(&pause.proposed_limits)
}

/// Cancel the task from its limit decision and stop its sessions.
fn cancel_for_limit(database: &SuplexDatabase, task_id: &str, time: &str) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_task_controls SET status = 'cancelled', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?1 WHERE task_id = ?2",
        params![time, task_id],
    )?;
    database.connection().execute(
        "UPDATE suplex_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = COALESCE(stop_requested_at, ?1), updated_at = ?1 WHERE task_id = ?2 AND stopped_at IS NULL",
        params![time, task_id],
    )?;
    cancel_open_turns(database, task_id, None, time)
}

/// The current Root that receives the limit decision.
fn decision_root(
    database: &SuplexDatabase,
    task_id: &str,
    root_id: Option<String>,
) -> DatabaseResult<SessionRow> {
    let root_id =
        root_id.ok_or_else(|| CoordinationError::refused("root_notification_unavailable"))?;
    database
        .connection()
        .query_row(
            "SELECT * FROM suplex_task_sessions WHERE id = ?1 AND task_id = ?2 AND kind = 'root' AND is_current = 1 AND lifecycle <> 'cancelled'",
            params![root_id, task_id],
            session,
        )
        .optional()?
        .ok_or_else(|| CoordinationError::refused("root_notification_unavailable").into())
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
        if !valid_pause(&pause) {
            return Err(CoordinationError::refused("invalid_task_limit_pause").into());
        }
        let time = rfc3339_millis(now);
        let limits = match decision {
            TaskLimitDecision::CancelTask => return cancel_for_limit(database, task_id, &time),
            TaskLimitDecision::AddAllowance => pause.proposed_limits,
            TaskLimitDecision::ChangeLimits { limits } => TaskLimits {
                budget_usd: limits.budget_usd,
                max_turns: limits.max_turns as i64,
            },
        };
        let root = decision_root(database, task_id, root_id)?;
        let prompt = js_json::stringify(&serde_json::json!({"question": question, "decision": decision}));
        let id = new_turn_id(now)?;
        insert_pending_turn(database, &NewTurn { id: &id, task_id, session_id: &root.id, generation: root.generation, assignment_hash: None, prompt: &prompt, workflow_input: None }, &time)?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'active', budget_usd = ?1, max_turns = ?2, limit_pause_json = NULL, human_question = NULL, human_question_id = NULL, human_question_options_json = '[]', wake_at = ?3, updated_at = ?3 WHERE task_id = ?4",
            params![limits.budget_usd, limits.max_turns, time, task_id],
        )?;
        Ok(())
    })?;
    observe_lifecycle(database, task_id)
}

fn admitted_turn_count(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<i64> {
    Ok(database.connection().query_row(
        "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompted_at IS NOT NULL",
        [task_id],
        |row| row.get(0),
    )?)
}

fn default_limits(database: &SuplexDatabase) -> DatabaseResult<TaskLimits> {
    let settings = crate::platform::environment_settings::read(database)?;
    Ok(TaskLimits {
        budget_usd: settings.default_budget_usd,
        max_turns: settings.default_max_turns,
    })
}

/// The saved task-limit pause, in the TypeScript field order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LimitPause {
    kind: &'static str,
    reason: &'static str,
    limits: TaskLimits,
    usage: PersistedLimitUsage,
    proposed_limits: TaskLimits,
}

/// A task limit the observed usage reached, with the limits Suplex proposes.
struct LimitHit {
    reason: &'static str,
    limits: TaskLimits,
    proposed: TaskLimits,
    observed: PersistedLimitUsage,
}

impl LimitHit {
    /// Which limit the usage reached. The proposal adds one default allowance
    /// (or the current limit when the default is disabled) to each reached limit.
    fn evaluate(
        limits: TaskLimits,
        defaults: TaskLimits,
        usage: TaskLimitUsage,
        admitted_turns: i64,
    ) -> Option<Self> {
        let hit_budget = limits.budget_usd > 0.0
            && usage
                .estimated_cost_usd
                .is_some_and(|cost| cost >= limits.budget_usd);
        let hit_turns = limits.max_turns > 0 && admitted_turns >= limits.max_turns;
        let reason = match (hit_budget, hit_turns) {
            (true, true) => "budget_and_turns",
            (true, false) => "budget",
            (false, true) => "turns",
            (false, false) => return None,
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
        let spent = usage.estimated_cost_usd.unwrap_or(0.0);
        let proposed = TaskLimits {
            budget_usd: if hit_budget {
                suggested_budget(spent + budget_allowance, spent)
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
        Some(Self {
            reason,
            limits,
            proposed,
            observed,
        })
    }

    fn pause(&self) -> LimitPause {
        LimitPause {
            kind: "task_limit",
            reason: self.reason,
            limits: self.limits,
            usage: self.observed,
            proposed_limits: self.proposed,
        }
    }

    fn question(&self) -> String {
        task_limit_question(self.reason, self.limits, self.proposed, self.observed)
    }
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
        let defaults = default_limits(database)?;
        let limits = TaskLimits { budget_usd: budget_usd.unwrap_or(defaults.budget_usd), max_turns: max_turns.unwrap_or(defaults.max_turns) };
        if limits.budget_usd > 0.0 && usage.estimated_cost_usd.is_none() { return Ok(false); }
        let admitted_turns = admitted_turn_count(database, task_id)?;
        let time = rfc3339_millis(now);
        let Some(hit) = LimitHit::evaluate(limits, defaults, usage, admitted_turns) else {
            return Ok(database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'active', limit_pause_json = NULL, human_question = NULL, human_question_id = NULL, human_question_options_json = '[]', wake_at = ?1, updated_at = ?1 WHERE task_id = ?2 AND status = 'waiting_human' AND human_question_id = ?3",
                params![time, task_id, question_id],
            )? == 1);
        };
        let pause = js_json::stringify(&serde_json::to_value(hit.pause())?);
        if pause != js_json::stringify(&serde_json::from_str(&raw_pause)?) {
            database.connection().execute(
                "UPDATE suplex_task_controls SET limit_pause_json = ?1, human_question = ?2, updated_at = ?3 WHERE task_id = ?4 AND status = 'waiting_human' AND human_question_id = ?5",
                params![pause, hit.question(), time, task_id, question_id],
            )?;
        }
        Ok(false)
    })
}

pub(crate) enum Admission {
    Allowed,
    Blocked,
}

/// The task's status and saved budget and turn limit overrides.
type AdmissionControl = (TaskStatus, Option<f64>, Option<i64>);

fn admission_control(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<AdmissionControl>> {
    Ok(database
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
        .optional()?)
}

pub(crate) fn check_admission(
    database: &SuplexDatabase,
    task_id: &str,
    usage: TaskLimitUsage,
    now: DateTime<Utc>,
) -> DatabaseResult<Admission> {
    let Some((status, budget_usd, max_turns)) = admission_control(database, task_id)? else {
        return Ok(Admission::Blocked);
    };
    if status != TaskStatus::Active || crate::tasks::dependencies::blocked(database, task_id)? {
        return Ok(Admission::Blocked);
    }
    let defaults = default_limits(database)?;
    let limits = TaskLimits {
        budget_usd: budget_usd.unwrap_or(defaults.budget_usd),
        max_turns: max_turns.unwrap_or(defaults.max_turns),
    };
    let admitted_turns = admitted_turn_count(database, task_id)?;
    let reservations: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status = 'unknown' AND prompted_at IS NULL",
            [task_id], |row| row.get(0),
        )?;
    if let Some(hit) = LimitHit::evaluate(limits, defaults, usage, admitted_turns) {
        let time = rfc3339_millis(now);
        database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', limit_pause_json = ?1, human_question = ?2, human_question_options_json = '[]', human_question_id = ?3, wake_at = NULL, updated_at = ?4 WHERE task_id = ?5 AND status = 'active'",
                params![serde_json::to_string(&hit.pause())?, hit.question(), Uuid::new_v4().to_string(), time, task_id],
            )?;
        return Ok(Admission::Blocked);
    }
    if limits.max_turns > 0 && admitted_turns + reservations >= limits.max_turns {
        return Ok(Admission::Blocked);
    }
    Ok(Admission::Allowed)
}
use crate::{
    coordination::root_session_store,
    profiles::model_pricing::ModelsDevCatalogReader,
    runtimes::{
        task_harness::{NativeTimeline, ReaderSession, UsageEntry},
        task_harness_registry,
    },
    shared::time::now_millis_rfc3339,
    tasks::TaskError,
};
use std::{path::Path, sync::OnceLock};
/// A native session whose usage counts toward the task limits: Suplex id,
/// native id, kind, and instance home directory.
type UsageSession = (String, String, String, Option<String>);

/// The sessions with admitted turns, the effective budget and turn limit, and
/// the admitted turn count.
fn usage_scope(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<(Vec<UsageSession>, f64, i64, i64)> {
    let (budget_override, turns_override): (Option<f64>, Option<i64>) =
        database.connection().query_row(
            "SELECT budget_usd,max_turns FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
    let defaults = default_limits(database)?;
    let admitted_turns = admitted_turn_count(database, task_id)?;
    let sessions = database
        .connection()
        .prepare(
            "SELECT DISTINCT s.id,s.native_session_id,s.kind,json_extract(s.profile_json,'$.instanceHomeDirectory') FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id WHERE s.task_id = ?1 AND s.native_session_id IS NOT NULL AND (t.prompted_at IS NOT NULL OR t.status = 'unknown') ORDER BY s.created_at,s.id",
        )?
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((
        sessions,
        budget_override.unwrap_or(defaults.budget_usd),
        turns_override.unwrap_or(defaults.max_turns),
        admitted_turns,
    ))
}

/// The pricing catalog, read only when some observed usage is unpriced.
async fn pricing_for_unpriced(
    observed: &[(String, String, NativeTimeline)],
) -> Option<std::sync::Arc<crate::profiles::model_pricing::ModelPricingCatalog>> {
    static PRICING: OnceLock<Result<ModelsDevCatalogReader, String>> = OnceLock::new();
    if !observed
        .iter()
        .any(|(_, _, timeline)| timeline.usage.iter().any(unpriced))
    {
        return None;
    }
    let reader =
        PRICING.get_or_init(|| ModelsDevCatalogReader::new().map_err(|error| error.to_string()));
    match reader {
        Ok(reader) => reader.read().await,
        Err(_) => None,
    }
}

/// TypeScript `observeTaskLimitUsage`. `require_complete` reports no cost
/// unless every session has settled, fully priced usage.
pub(crate) async fn observed_usage(
    database: &mut SuplexDatabase,
    database_path: &Path,
    task_id: &str,
    require_complete: bool,
) -> DatabaseResult<TaskLimitUsage> {
    let (sessions, budget, max_turns, admitted_turns) = usage_scope(database, task_id)?;
    if (max_turns > 0 && admitted_turns >= max_turns) || budget == 0.0 {
        return Ok(TaskLimitUsage {
            estimated_cost_usd: None,
        });
    }
    if sessions.is_empty() {
        return Ok(TaskLimitUsage {
            estimated_cost_usd: (!require_complete).then_some(0.0),
        });
    }
    let native_database_path = database_path.to_path_buf();
    let observed = tokio::task::spawn_blocking(
        move || -> Result<Vec<(String, String, NativeTimeline)>, String> {
            let mut observed = Vec::new();
            for (session_id, native_id, role, instance) in sessions {
                let reader = task_harness_registry::native_session_reader(&native_id).ok_or(
                    "Native task usage is not available. Suplex will retry the observation.",
                )?;
                let session = ReaderSession {
                    database_path: &native_database_path,
                    session_id: &session_id,
                    native_session_id: &native_id,
                    instance_home_directory: instance.as_deref().map(Path::new),
                };
                let timeline = reader
                    .timeline(&session, None)
                    .map_err(|error| error.to_string())?;
                observed.push((native_id, role, timeline));
            }
            Ok(observed)
        },
    )
    .await??;
    // TypeScript `observeTaskLimitUsage`: a session without usage leaves the
    // observation incomplete; dispatch continues with the partial cost.
    let pricing = pricing_for_unpriced(&observed).await;
    settle_usage(
        database,
        task_id,
        observed,
        pricing.as_deref(),
        require_complete,
    )
}

/// The rest of TypeScript `observeTaskLimitUsage` once native usage and, when
/// some of it is unpriced, the pricing catalog have been read.
pub(crate) fn settle_usage(
    database: &mut SuplexDatabase,
    task_id: &str,
    mut observed: Vec<(String, String, NativeTimeline)>,
    pricing: Option<&crate::profiles::model_pricing::ModelPricingCatalog>,
    require_complete: bool,
) -> DatabaseResult<TaskLimitUsage> {
    if let Some(pricing) = pricing {
        for (_, _, timeline) in &mut observed {
            estimate_unpriced_usage(&mut timeline.usage, pricing);
        }
    }
    if require_complete
        && observed.iter().any(|(_, _, timeline)| {
            timeline.usage.is_empty()
                || timeline.live_message_id.is_some()
                || timeline.usage.iter().any(|entry| {
                    entry.completed_at_ms.is_none() || entry.model == "unknown" || unpriced(entry)
                })
        })
    {
        return Ok(TaskLimitUsage {
            estimated_cost_usd: None,
        });
    }
    Ok(TaskLimitUsage {
        estimated_cost_usd: replace_observed_usage(database, task_id, observed)?,
    })
}

/// TypeScript `usageIsUnpriced`.
fn unpriced(entry: &UsageEntry) -> bool {
    let tokens = entry.tokens;
    entry.cost_usd == 0.0
        && tokens.input + tokens.output + tokens.reasoning + tokens.cache_read + tokens.cache_write
            > 0.0
}

/// TypeScript `estimateUnpricedUsage`: listed prices estimate unpriced usage.
pub(crate) fn estimate_unpriced_usage(
    usage: &mut [UsageEntry],
    pricing: &crate::profiles::model_pricing::ModelPricingCatalog,
) {
    for entry in usage.iter_mut().filter(|entry| unpriced(entry)) {
        if let Some(price) = pricing.get(&format!("{}/{}", entry.provider, entry.model)) {
            entry.cost_usd = price.estimate(entry.tokens);
        }
    }
}

/// TypeScript `replaceNativeUsage`, keyed by native session and message.
/// Returns TypeScript `usageMetrics(usage).cost`: no cost when there is no
/// usage, or when all usage is unpriced.
pub(crate) fn replace_observed_usage(
    database: &mut SuplexDatabase,
    task_id: &str,
    observed: Vec<(String, String, NativeTimeline)>,
) -> DatabaseResult<Option<f64>> {
    let mut snapshots: Vec<(String, bool, serde_json::Value)> = Vec::new();
    for (native_id, role, timeline) in observed {
        for entry in timeline.usage {
            snapshots.retain(|(session, _, snapshot)| {
                session != &native_id || snapshot["messageId"] != entry.message_id.as_str()
            });
            snapshots.push((
                native_id.clone(),
                unpriced(&entry),
                serde_json::json!({
                    "sessionId":native_id,"messageId":entry.message_id,"turnId":entry.turn_id,
                    "role":role,"provider":entry.provider,"model":entry.model,
                    "startedAt":entry.started_at_ms,"completedAt":entry.completed_at_ms,
                    "failed":entry.failed,"summary":false,"steps":1,"cost":entry.cost_usd,
                    "subsidized":entry.cost_usd > 0.0,
                    "tokens":{"input":entry.tokens.input,"output":entry.tokens.output,
                        "reasoning":entry.tokens.reasoning,"cache":{"read":entry.tokens.cache_read,
                            "write":entry.tokens.cache_write}},"source":"message",
                }),
            ));
        }
    }
    let cost: f64 = snapshots
        .iter()
        .map(|(_, _, snapshot)| snapshot["cost"].as_f64().unwrap_or_default())
        .sum();
    let wholly_unpriced = cost <= 0.0 && snapshots.iter().any(|(_, unpriced, _)| *unpriced);
    database.transaction(false, |database| {
        for (session_id, _, _) in &snapshots {
            let belongs: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions WHERE task_id = ?1 AND native_session_id = ?2)",
                rusqlite::params![task_id, session_id], |row| row.get(0),
            )?;
            if !belongs { return Err(TaskError::internal("Native usage does not match a task session").into()); }
        }
        database.connection().execute("DELETE FROM suplex_task_usage WHERE task_id = ?1", [task_id])?;
        let time = now_millis_rfc3339();
        for (session_id, _, snapshot) in &snapshots {
            database.connection().execute(
                "INSERT INTO suplex_task_usage (task_id,session_id,message_id,snapshot,observed_at) VALUES (?1,?2,?3,?4,?5)",
                rusqlite::params![task_id, session_id, snapshot["messageId"].as_str(), snapshot.to_string(), time],
            )?;
        }
        Ok(())
    })?;
    Ok((!snapshots.is_empty() && !wholly_unpriced).then_some(cost))
}

pub(crate) fn needs_admission_usage(
    database: &SuplexDatabase,
    task_id: &str,
    kind: &str,
) -> DatabaseResult<bool> {
    Ok(database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ?1 AND s.kind = ?2 AND s.is_current = 1 AND t.status = 'pending_prompt' AND t.dispatch_attempt_json IS NULL)",
        rusqlite::params![task_id, kind], |row| row.get(0),
    )?)
}

/// TypeScript `RootController.recover`: a task paused at its limits resumes
/// once complete native usage is within the current limits. A paused task is
/// observed again in 15 seconds either way.
pub(crate) async fn reconcile_limit_pause(
    database: &mut SuplexDatabase,
    database_path: &Path,
    task_id: &str,
) -> DatabaseResult<()> {
    let question_id: Option<String> = {
        database.connection().query_row(
            "SELECT human_question_id FROM suplex_task_controls WHERE task_id = ?1 AND status = 'waiting_human' AND limit_pause_json IS NOT NULL",
            [task_id], |row| row.get(0),
        ).optional()?.flatten()
    };
    let Some(question_id) = question_id else {
        return Ok(());
    };
    let reconciled = async {
        let usage = observed_usage(database, database_path, task_id, true).await?;
        root_session_store::reconcile_task_limit_pause(
            database,
            task_id,
            &question_id,
            usage,
            Utc::now(),
        )
    }
    .await;
    let now = Utc::now();
    database.connection().execute(
        "UPDATE suplex_task_controls SET wake_at = ?1,updated_at = ?2 WHERE task_id = ?3 AND status = 'waiting_human'",
        rusqlite::params![rfc3339_millis(now + chrono::Duration::seconds(15)), rfc3339_millis(now), task_id],
    )?;
    reconciled.map(|_| ())
}
