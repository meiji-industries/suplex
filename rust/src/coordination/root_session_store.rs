//! Durable Root session and prompt intent. Native runtime evidence stays with the harness.

use crate::tasks::control::DeliveryTarget;

use super::CoordinationError;
use crate::shared::hash::sha256_hex;
use crate::shared::time::rfc3339_millis;
use crate::tasks::TaskError;
use crate::tasks::control::{
    PromptDispatchAttempt, SessionKind, SessionLifecycle, SessionRow, TaskControlRow, TaskProfile,
    TaskStatus, TurnRow, TurnStatus, WorktreeReference,
};
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use uuid::Uuid;

use crate::coordination::advisor_bridge::AdvisorRole;
use crate::coordination::root_prompts::{self, STANDARD_WORKER_RESULT_WAKE};
use crate::coordination::workflows::{
    self, AgentSelection, Completion, DeliveryWait, ReviewRecord, Workflow, WorkflowState,
};
use crate::identity::auth::js_trim;
use crate::platform::database::{DatabaseResult, SuplexDatabase};
use crate::platform::system_events;
use crate::profiles::agent_profiles::{allowed_profile, read_profile};
use crate::projects::ProjectProviderPolicy;
use crate::runtimes::process::inspect_process;
use crate::shared::js_json;
use crate::tasks::repository;

pub fn current_root(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<SessionRow>> {
    Ok(database.connection().query_row(
        "SELECT * FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1",
        [task_id], session,
    ).optional()?)
}

pub fn current_worker(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<SessionRow>> {
    current_delegate(database, task_id, "delegate")
}

/// The current delegate in one slot: `delegate`, `planner_a`, or `planner_b`.
pub fn current_delegate(
    database: &SuplexDatabase,
    task_id: &str,
    slot: &str,
) -> DatabaseResult<Option<SessionRow>> {
    Ok(database.connection().query_row(
        "SELECT * FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND delegate_slot = ?2 AND is_current = 1",
        params![task_id, slot], session,
    ).optional()?)
}

pub fn assert_current_root(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: &str,
    generation: i64,
) -> DatabaseResult<()> {
    let current = current_root(database, task_id)?;
    let active: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_task_controls WHERE task_id = ?1 AND status = 'active')",
        [task_id],
        |row| row.get(0),
    )?;
    if !active
        || !current.is_some_and(|root| {
            root.id == session_id
                && root.generation == generation
                && root.lifecycle != SessionLifecycle::Cancelled
        })
    {
        return Err(CoordinationError::refused("root_identity_mismatch").into());
    }
    Ok(())
}

/// A live bridge keeps its token. An unobservable PID is retained unless the OS
/// confirms it is gone; a reused PID may be replaced.
pub fn claim_tool_owner(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<String>> {
    let current: Option<(String, u32, String)> = database
        .connection()
        .query_row(
            "SELECT json_extract(workflow_state_json, '$.toolOwner.token'), json_extract(workflow_state_json, '$.toolOwner.pid'), json_extract(workflow_state_json, '$.toolOwner.processStartTime') FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| {
                let token: Option<String> = row.get(0)?;
                let pid: Option<u32> = row.get(1)?;
                let start: Option<String> = row.get(2)?;
                Ok(token.zip(pid).zip(start).map(|((token, pid), start)| (token, pid, start)))
            },
        )
        .optional()?
        .flatten();
    if let Some((_, pid, start)) = &current {
        if let Some(observed) = inspect_process(*pid) {
            if observed.start_time == *start {
                return Ok(None);
            }
        } else if nix::sys::signal::kill(nix::unistd::Pid::from_raw(*pid as i32), None)
            != Err(nix::errno::Errno::ESRCH)
        {
            return Ok(None);
        }
    }
    let self_pid = std::process::id();
    let Some(self_identity) = inspect_process(self_pid) else {
        return Ok(None);
    };
    let token = Uuid::new_v4().to_string();
    let owner = serde_json::json!({
        "token": token,
        "pid": self_pid,
        "processStartTime": self_identity.start_time,
    });
    let prior = current.as_ref().map(|(token, _, _)| token.as_str());
    let changed = database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.toolOwner', json(?1)), updated_at = ?2 WHERE task_id = ?3 AND json_extract(workflow_state_json, '$.toolOwner.token') IS ?4",
            params![owner.to_string(), rfc3339_millis(now), task_id, prior],
        )?)
    })?;
    Ok((changed == 1).then_some(token))
}

pub fn release_tool_owner(
    database: &mut SuplexDatabase,
    task_id: &str,
    token: &str,
) -> DatabaseResult<()> {
    database.transaction(true, |database| {
        database.connection().execute(
            "UPDATE suplex_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.toolOwner', json('null')) WHERE task_id = ?1 AND json_extract(workflow_state_json, '$.toolOwner.token') = ?2",
            params![task_id, token],
        )?;
        Ok(())
    })
}

pub fn assert_tool_owner(
    database: &SuplexDatabase,
    task_id: &str,
    token: &str,
) -> DatabaseResult<()> {
    let actual: Option<String> = database.connection().query_row(
        "SELECT json_extract(workflow_state_json, '$.toolOwner.token') FROM suplex_task_controls WHERE task_id = ?1",
        [task_id],
        |row| row.get(0),
    ).optional()?.flatten();
    if actual.as_deref() != Some(token) {
        return Err(CoordinationError::refused("task_tool_owner_lost").into());
    }
    Ok(())
}

pub fn ask_human_for_root(
    database: &mut SuplexDatabase,
    task_id: &str,
    session_id: &str,
    generation: i64,
    question: &str,
    options: &Value,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let question = question.trim();
    if question.is_empty() {
        return Err(CoordinationError::refused("question_is_empty").into());
    }
    let options = serde_json::to_string(options)?;
    let changed = database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = ?1, human_question_options_json = ?2, human_question_id = ?3, limit_pause_json = NULL, wake_at = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?4 WHERE task_id = ?5 AND status = 'active' AND root_session_id = ?6 AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.id = ?6 AND s.task_id = suplex_task_controls.task_id AND s.kind = 'root' AND s.generation = ?7 AND s.is_current = 1 AND s.lifecycle <> 'cancelled')",
            params![question, options, Uuid::new_v4().to_string(), rfc3339_millis(now), task_id, session_id, generation],
        )? == 1)
    })?;
    if changed {
        observe_lifecycle(database, task_id)?;
    }
    Ok(changed)
}

static OBSERVED_STATUSES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static OBSERVED_WAITS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Report a task status change once the transaction that wrote it commits.
pub(crate) fn observe_lifecycle(
    database: &mut SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<()> {
    // TypeScript records the analytics lifecycle event in the same write; a failure only warns.
    if let Err(error) = crate::tasks::analytics::observe_lifecycle(database, task_id) {
        eprintln!("Analytics lifecycle observation failed for {task_id}: {error}");
    }
    if !system_events::enabled() {
        return Ok(());
    }
    let status: String = database.connection().query_row(
        "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    let observed = OBSERVED_STATUSES
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if observed.as_ref().and_then(|map| map.get(task_id)) == Some(&status) {
        return Ok(());
    }
    drop(observed);
    let task_id = task_id.to_owned();
    database.after_commit(move || {
        let mut observed = OBSERVED_STATUSES
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let previous = observed
            .get_or_insert_default()
            .insert(task_id.clone(), status.clone());
        if previous.as_ref() == Some(&status) {
            return;
        }
        let mut event = json!({"type": "task_status", "taskId": task_id, "status": status});
        if let Some(previous) = previous {
            event["previousStatus"] = previous.into();
        }
        system_events::emit(event);
    });
    Ok(())
}

pub(crate) fn observe_admission(
    database: &mut SuplexDatabase,
    task_id: &str,
    trigger: &str,
    prerequisite_task_id: Option<&str>,
) {
    let mut event = json!({"type": "task_admitted", "taskId": task_id, "trigger": trigger});
    if let Some(prerequisite) = prerequisite_task_id {
        event["prerequisiteTaskId"] = prerequisite.into();
    }
    database.after_commit(move || system_events::emit(event));
}

/// A diagnostic read never changes queue admission.
pub(crate) fn observe_queue_wait(database: &mut SuplexDatabase, task_id: &str) {
    if !system_events::enabled() {
        return;
    }
    let Ok((_, _, waiting_on)) = crate::tasks::response::task_dependencies(database, task_id)
    else {
        return;
    };
    let mut waits = waiting_on
        .iter()
        .map(|wait| json!({"id": wait["id"], "reason": wait["reason"]}))
        .collect::<Vec<_>>();
    waits.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    let signature = Value::from(waits.clone()).to_string();
    let observed = OBSERVED_WAITS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if observed.as_ref().and_then(|map| map.get(task_id)) == Some(&signature) {
        return;
    }
    drop(observed);
    let task_id = task_id.to_owned();
    database.after_commit(move || {
        let mut observed = OBSERVED_WAITS
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if observed
            .get_or_insert_default()
            .insert(task_id.clone(), signature.clone())
            == Some(signature)
        {
            return;
        }
        system_events::emit(json!({"type": "queue_wait", "taskId": task_id, "waits": waits}));
    });
}

/// Cancel durable task intent and request native cleanup in one transaction.
/// Display metadata is not consulted; the host rediscovers owned processes.
pub fn cancel_task(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let cancelled = database.transaction(true, |database| {
        let time = rfc3339_millis(now);
        let changed = database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'cancelled', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?1 WHERE task_id = ?2 AND status <> 'delivered'",
            params![time, task_id],
        )?;
        if changed != 1 {
            return Ok(false);
        }
        database.connection().execute(
            "UPDATE suplex_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = COALESCE(stop_requested_at, ?1), updated_at = ?1 WHERE task_id = ?2 AND stopped_at IS NULL",
            params![time, task_id],
        )?;
        cancel_open_turns(database, task_id, None, &time)?;
        Ok(true)
    })?;
    if cancelled {
        observe_lifecycle(database, task_id)?;
    }
    Ok(cancelled)
}

/// Answer only the current human question. Confirmed interrupted native work
/// is recorded before the answer prompt, all in the same durable transaction.
pub fn answer_human(
    database: &mut SuplexDatabase,
    task_id: &str,
    question_id: &str,
    answer: &str,
    confirm_commands_stopped: bool,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let answer =
        answer.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    if answer.is_empty() {
        return Err(CoordinationError::refused("answer_is_empty").into());
    }
    database.transaction(true, |database| {
        let control: Option<(Option<String>, Option<String>, Option<String>)> = database
            .connection()
            .query_row(
                "SELECT human_question,limit_pause_json,recovery_turn_id FROM suplex_task_controls WHERE task_id = ?1 AND status = 'waiting_human' AND human_question_id = ?2",
                params![task_id, question_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((question, limit_pause, recovery_turn_id)) = control else {
            return Err(CoordinationError::refused("question_identity_mismatch").into());
        };
        if limit_pause.is_some() {
            return Err(CoordinationError::refused("task_limit_decision_required").into());
        }
        let root = database
            .connection()
            .query_row(
                "SELECT * FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1 AND lifecycle <> 'cancelled'",
                [task_id],
                session,
            )
            .optional()?
            .ok_or_else(|| CoordinationError::refused("root_notification_unavailable"))?;
        if recovery_turn_id.is_some() && !confirm_commands_stopped {
            return Err(CoordinationError::refused("command_cleanup_confirmation_required").into());
        }
        if let Some(recovery_turn_id) = recovery_turn_id {
            let recovered: (String, i64, SessionKind) = database.connection().query_row(
                "SELECT t.session_id,t.generation,s.kind FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.id = ?1 AND t.task_id = ?2",
                params![recovery_turn_id, task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let evidence = js_json::stringify(&serde_json::json!({
                "state":"interrupted", "reason":"operator_confirmed_commands_stopped",
                "questionId":question_id, "answer":answer, "turnId":recovery_turn_id
            }));
            if recovered.2 == SessionKind::Worker {
                let receipt = format!("cleanup:{question_id}");
                let wake_prompt = format!(
                    "Worker result receipt {receipt}. {STANDARD_WORKER_RESULT_WAKE}\n\n{evidence}"
                );
                record_standard_worker_result_and_wake(
                    database,
                    &StandardWorkerResult {
                        task_id,
                        session_id: &recovered.0,
                        generation: recovered.1,
                        receipt_id: &receipt,
                        observation: &evidence,
                        native_turn_id: None,
                        wake_prompt: &wake_prompt,
                        review: None,
                    },
                    now,
                )?;
            } else {
                complete_root_turn(database, &recovery_turn_id, &evidence, None, now)?;
            }
        }
        let prompt = js_json::stringify(&serde_json::json!({"question":question,"answer":answer}));
        let id = new_turn_id(now)?;
        let time = rfc3339_millis(now);
        insert_pending_turn(database, &id, task_id, &root.id, root.generation, None, &prompt, None, &time)?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'active', human_question = NULL, human_question_id = NULL, recovery_turn_id = NULL, wake_at = ?1, updated_at = ?1 WHERE task_id = ?2",
            params![time, task_id],
        )?;
        Ok(())
    })?;
    observe_lifecycle(database, task_id)
}

/// Reserve the next Worker turn atomically with Root identity and
/// serial-delegate checks. Native dispatch is a separate after-commit step.
pub fn launch_standard_worker(
    database: &mut SuplexDatabase,
    root: &SessionRow,
    assignment_text: &str,
    prompt_text: &str,
    workflow_input: Option<&Value>,
    now: DateTime<Utc>,
) -> DatabaseResult<SessionRow> {
    launch_delegate(
        database,
        root,
        None,
        assignment_text,
        prompt_text,
        workflow_input,
        now,
    )
}

/// TypeScript `launchWorker` with an Advisor: Suplex composed the prompt, and
/// the Advisor uses its captured profile in its own delegate slot.
pub fn launch_advisor(
    database: &mut SuplexDatabase,
    root: &SessionRow,
    role: &str,
    prompt: &str,
    input: &Value,
    now: DateTime<Utc>,
) -> DatabaseResult<SessionRow> {
    launch_delegate(database, root, Some(role), prompt, prompt, Some(input), now)
}

fn delegate_profile(
    database: &SuplexDatabase,
    task_id: &str,
    role: Option<&str>,
) -> DatabaseResult<String> {
    let (root, worker, advisors): (String, String, String) = database.connection().query_row(
        "SELECT root_profile_json,worker_profile_json,advisor_profiles_json FROM suplex_task_controls WHERE task_id = ?1",
        [task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let Some(role) = role else {
        return Ok(worker);
    };
    let advisors: Value = serde_json::from_str(&advisors)?;
    Ok(advisors
        .get(role)
        .filter(|profile| profile.is_object())
        .map_or(root, Value::to_string))
}

fn launch_delegate(
    database: &mut SuplexDatabase,
    root: &SessionRow,
    advisor_role: Option<&str>,
    assignment_text: &str,
    prompt_text: &str,
    workflow_input: Option<&Value>,
    now: DateTime<Utc>,
) -> DatabaseResult<SessionRow> {
    let task_id = root.task_id.as_str();
    let root_session_id = root.id.as_str();
    let root_generation = root.generation;
    let assignment_hash = sha256_hex(assignment_text.as_bytes());
    let workflow_json = workflow_input.map(serde_json::to_string).transpose()?;
    let slot = advisor_role
        .filter(|role| matches!(*role, "planner_a" | "planner_b"))
        .unwrap_or("delegate");
    let time = rfc3339_millis(now);
    database.transaction(true, |database| {
        assert_current_root(database, task_id, root_session_id, root_generation)?;
        let active_turn: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ?1 AND s.kind = 'worker' AND s.is_current = 1 AND t.status IN ('pending_prompt','prompted','unknown'))",
            [task_id],
            |row| row.get(0),
        )?;
        if active_turn {
            return Err(CoordinationError::refused("worker_already_assigned").into());
        }
        let current: Option<(String, i64, bool, bool)> = database.connection().query_row(
            "SELECT id,generation,stop_requested_at IS NOT NULL AND stopped_at IS NULL,launch_owner IS NOT NULL AND stopped_at IS NULL FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND delegate_slot = ?2 AND is_current = 1",
            params![task_id, slot],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional()?;
        if current.as_ref().is_some_and(|(_, _, stopping, launching)| *stopping || *launching) {
            return Err(CoordinationError::refused("worker_already_assigned").into());
        }
        let generation: i64 = database.connection().query_row(
            "SELECT COALESCE(MAX(generation),0)+1 FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker'",
            [task_id], |row| row.get(0),
        )?;
        let profile = delegate_profile(database, task_id, advisor_role)?;
        let compatible: Option<(String, bool)> = database.connection().query_row(
            "SELECT id,stop_requested_at IS NOT NULL AND stopped_at IS NULL FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND advisor_role IS ?3 AND lifecycle <> 'cancelled' AND (profile_json IS NULL OR json(profile_json) = json(?2)) ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1",
            params![task_id, profile, advisor_role],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        if compatible.as_ref().is_some_and(|(_, stopping)| *stopping) {
            return Err(CoordinationError::refused("worker_already_assigned").into());
        }
        let id = compatible
            .as_ref()
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if let Some((current_id, _, _, _)) = &current
            && current_id != &id
        {
            database.connection().execute(
                "UPDATE suplex_task_sessions SET is_current = 0,updated_at = ?1 WHERE id = ?2 AND is_current = 1",
                params![time, current_id],
            )?;
        }
        if compatible.is_some() {
            let changed = database.connection().execute(
                "UPDATE suplex_task_sessions SET generation = ?1,is_current = 1,lifecycle = CASE WHEN lifecycle = 'stopped' THEN 'reserved' ELSE lifecycle END,assignment_hash = ?2,profile_json = COALESCE(profile_json,?3),launch_owner = NULL,launch_owner_pid = NULL,launch_owner_start_time = NULL,launch_claimed_at = NULL,stop_requested_at = NULL,stopped_at = NULL,updated_at = ?4 WHERE id = ?5 AND lifecycle IN ('reserved','live','stopped') AND (launch_owner IS NULL OR stopped_at IS NOT NULL) AND (stop_requested_at IS NULL OR stopped_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM suplex_task_turns t WHERE t.session_id = suplex_task_sessions.id AND t.generation = suplex_task_sessions.generation AND t.status IN ('pending_prompt','prompted','unknown'))",
                params![generation, assignment_hash, profile, time, id],
            )?;
            if changed != 1 {
                return Err(CoordinationError::refused("worker_already_assigned").into());
            }
        } else {
            if let Some((current_id, current_generation, _, _)) = &current {
                database.connection().execute(
                    "UPDATE suplex_task_sessions SET is_current = 0,updated_at = ?1 WHERE id = ?2 AND generation = ?3 AND is_current = 1",
                    params![time, current_id, current_generation],
                )?;
            }
            database.connection().execute(
                "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,assignment_hash,advisor_role,delegate_slot,workflow_input_json,profile_json,created_at,updated_at) VALUES (?1,?2,'worker',?3,1,'reserved',?4,?8,?9,?5,?6,?7,?7)",
                params![id, task_id, generation, assignment_hash, workflow_json, profile, time, advisor_role, slot],
            )?;
        }
        database.connection().execute(
            "UPDATE suplex_task_controls SET worker_session_id = ?1,updated_at = ?2 WHERE task_id = ?3 AND status = 'active'",
            params![id, time, task_id],
        )?;
        insert_pending_turn(database, &new_turn_id(now)?, task_id, &id, generation, Some(&assignment_hash), prompt_text, workflow_json.as_deref(), &time)?;
        Ok(())
    })?;
    root_observation_rows(database, task_id)?
        .worker
        .ok_or_else(|| CoordinationError::refused("worker_session_missing").into())
}

/// TypeScript `launchPlannerPair`: Plan A and Plan B are reserved together
/// on one pinned input, each in its own delegate slot.
pub fn launch_planner_pair(
    database: &mut SuplexDatabase,
    root: &SessionRow,
    pair_id: &str,
    planners: [(&str, &Value); 2],
    now: DateTime<Utc>,
) -> DatabaseResult<[SessionRow; 2]> {
    let task_id = root.task_id.as_str();
    let [(prompt_a, input_a), (prompt_b, input_b)] = planners;
    let same_input = |left: &Value, right: &Value| {
        let (Some(a), Some(b)) = (
            super::workflows::ReviewRange::from_value(&left["range"]),
            super::workflows::ReviewRange::from_value(&right["range"]),
        ) else {
            return false;
        };
        super::workflows::same_range(&a, &b)
            && left["evidenceDirectory"] == right["evidenceDirectory"]
            && left["evidenceSha256"] == right["evidenceSha256"]
    };
    if input_a["role"] != "planner_a"
        || input_b["role"] != "planner_b"
        || input_a["plannerPairId"] != pair_id
        || input_b["plannerPairId"] != pair_id
        || !same_input(input_a, input_b)
    {
        return Err(CoordinationError::refused("invalid_planner_pair").into());
    }
    let time = rfc3339_millis(now);
    let ids = database.transaction(true, |database| {
        assert_current_root(database, task_id, &root.id, root.generation)?;
        let workflow: Workflow = database.connection().query_row(
            "SELECT workflow FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        if workflow != Workflow::CompetingPlans {
            return Err(CoordinationError::refused("planner_pair_requires_combined_workflow").into());
        }
        let busy: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = ?1 AND s.kind = 'worker' AND s.is_current = 1 AND (s.launch_owner IS NOT NULL AND s.stopped_at IS NULL OR s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL OR EXISTS (SELECT 1 FROM suplex_task_turns t WHERE t.session_id = s.id AND t.generation = s.generation AND t.status IN ('pending_prompt','prompted','unknown'))))",
            [task_id],
            |row| row.get(0),
        )?;
        if busy {
            return Err(CoordinationError::refused("worker_already_assigned").into());
        }
        database.connection().execute(
            "UPDATE suplex_task_sessions SET is_current = 0,updated_at = ?1 WHERE task_id = ?2 AND kind = 'worker' AND is_current = 1 AND delegate_slot IN ('planner_a','planner_b')",
            params![time, task_id],
        )?;
        let latest: i64 = database.connection().query_row(
            "SELECT COALESCE(MAX(generation),0) FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker'",
            [task_id],
            |row| row.get(0),
        )?;
        let mut ids = Vec::new();
        for (index, (role, prompt, input)) in [("planner_a", prompt_a, input_a), ("planner_b", prompt_b, input_b)].into_iter().enumerate() {
            let id = Uuid::new_v4().to_string();
            let generation = latest + index as i64 + 1;
            let hash = sha256_hex(prompt.as_bytes());
            let profile = delegate_profile(database, task_id, Some(role))?;
            database.connection().execute(
                "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,assignment_hash,advisor_role,delegate_slot,workflow_input_json,profile_json,created_at,updated_at) VALUES (?1,?2,'worker',?3,1,'reserved',?4,?5,?5,?6,?7,?8,?8)",
                params![id, task_id, generation, hash, role, input.to_string(), profile, time],
            )?;
            insert_pending_turn(database, &new_turn_id(now)?, task_id, &id, generation, Some(&hash), prompt, None, &time)?;
            ids.push(id);
        }
        database.connection().execute(
            "UPDATE suplex_task_controls SET worker_session_id = ?1,updated_at = ?2 WHERE task_id = ?3 AND status = 'active'",
            params![ids[0], time, task_id],
        )?;
        Ok(ids)
    })?;
    let sessions = root_observation_rows(database, task_id)?.sessions;
    let find = |id: &str| {
        sessions
            .iter()
            .find(|session| session.id == id)
            .cloned()
            .ok_or_else(|| Box::<dyn std::error::Error>::from("planner_session_missing"))
    };
    Ok([find(&ids[0])?, find(&ids[1])?])
}

/// Reserve one Root generation for an active task; a repeated admission returns it.
pub fn reserve_root(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<SessionRow> {
    database.transaction(true, |database| {
        let active: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_controls WHERE task_id = ?1 AND status = 'active')",
            [task_id], |row| row.get(0),
        )?;
        if !active {
            return Err(CoordinationError::refused("task_not_active").into());
        }
        if let Some(existing) = current_root(database, task_id)? {
            return Ok(existing);
        }
        let generation: i64 = database.connection().query_row(
            "SELECT COALESCE(MAX(generation), 0) + 1 FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root'",
            [task_id], |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let time = rfc3339_millis(now);
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, lifecycle, created_at, updated_at) VALUES (?1, ?2, 'root', ?3, 1, 'reserved', ?4, ?4)",
            params![id, task_id, generation, time],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET root_session_id = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![id, time, task_id],
        )?;
        current_root(database, task_id)?.ok_or_else(|| CoordinationError::refused("root_session_missing").into())
    })
}

pub fn ensure_initial_prompt(
    database: &mut SuplexDatabase,
    root: &SessionRow,
    prompt: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<TurnRow>> {
    database.transaction(true, |database| {
        let existing: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_turns WHERE session_id = ?1)",
            [&root.id],
            |row| row.get(0),
        )?;
        if existing {
            return Ok(None);
        }
        let id = new_turn_id(now)?;
        let time = rfc3339_millis(now);
        insert_pending_turn(
            database,
            &id,
            &root.task_id,
            &root.id,
            root.generation,
            None,
            prompt,
            None,
            &time,
        )?;
        Ok(Some(database.connection().query_row(
            "SELECT * FROM suplex_task_turns WHERE id = ?1",
            [&id],
            turn,
        )?))
    })
}

/// Append a human note to the current Root. A delivered task resumes its saved
/// Root and delivery history in the same transaction as the new prompt.
pub fn send_note(
    database: &mut SuplexDatabase,
    task_id: &str,
    note: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<TurnRow> {
    send_labeled_note(database, task_id, note, "Human note", now)
}

/// A paired agent's note carries its own label, `Agent note (<agentId>)`.
pub fn send_labeled_note(
    database: &mut SuplexDatabase,
    task_id: &str,
    note: &str,
    label: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<TurnRow> {
    let note = js_trim(note);
    if note.is_empty() || note.encode_utf16().count() > 20_000 {
        return Err(CoordinationError::refused("note_invalid").into());
    }
    let turn = database.transaction(true, |database| {
        let (status, archived, root_session_id, workflow_state): (TaskStatus, bool, Option<String>, String) = database.connection().query_row(
            "SELECT c.status,t.archived_at IS NOT NULL,c.root_session_id,c.workflow_state_json FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        if archived || !matches!(status, TaskStatus::Active | TaskStatus::Delivered) {
            return Err(CoordinationError::refused("task_note_unavailable").into());
        }
        let resuming = status == TaskStatus::Delivered;
        let time = rfc3339_millis(now);
        if resuming {
            repository::assert_task_pull_requests_available(database, task_id)?;
            reopen_delivered(database, task_id, root_session_id.as_deref(), &serde_json::from_str(&workflow_state)?, &time)?;
        }
        let existing = current_root(database, task_id)?;
        let root = match existing {
            Some(root) => root,
            None => {
                let root = reserve_root(database, task_id, now)?;
                let rows = root_observation_rows(database, task_id)?;
                let initial = root_prompts::initial_coordinator_prompt(&rows.control, &rows.context, &[]);
                ensure_initial_prompt(database, &root, &initial, now)?;
                root
            }
        };
        assert_current_root(database, task_id, &root.id, root.generation)?;
        let prompt = if resuming {
            js_json::stringify(&serde_json::json!({
                "question": "The user has resumed this delivered task. Handle the follow-up below before completing delivery again. Preserve existing work and inspect current GitHub state. Earlier delivery is history, not completion of this request. For failing checks, read the logs, reproduce and repair the failure, verify locally, push, and observe checks on the current head. Keep the delivery target unchanged. Request delivery explicitly only when the follow-up is satisfied.",
                "answer": note,
            }))
        } else {
            format!("{label}:\n{note}")
        };
        let id = new_turn_id(now)?;
        insert_pending_turn(database, &id, task_id, &root.id, root.generation, None, &prompt, None, &time)?;
        database.connection().query_row("SELECT * FROM suplex_task_turns WHERE id = ?1", [&id], turn).map_err(Into::into)
    })?;
    observe_lifecycle(database, task_id)?;
    Ok(turn)
}

pub fn pending_turns(database: &SuplexDatabase, session_id: &str) -> DatabaseResult<Vec<TurnRow>> {
    let mut statement = database.connection().prepare(
        "SELECT * FROM suplex_task_turns WHERE session_id = ?1 AND status IN ('pending_prompt', 'unknown', 'prompted') ORDER BY created_at, id",
    )?;
    Ok(statement
        .query_map([session_id], turn)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The caller observes the prior owner from the native process system before replacing it.
pub fn claim_session_operation(
    database: &mut SuplexDatabase,
    root: &SessionRow,
    owner: &str,
    owner_pid: i64,
    owner_start_time: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_sessions SET launch_owner = ?1, launch_owner_pid = ?2, launch_owner_start_time = ?3, launch_claimed_at = ?4, updated_at = ?4 WHERE id = ?5 AND generation = ?6 AND is_current = 1 AND lifecycle <> 'cancelled' AND launch_owner IS ?7",
            params![owner, owner_pid, owner_start_time, rfc3339_millis(now), root.id, root.generation, root.launch_owner],
        )? == 1)
    })
}

pub fn release_session_operation(
    database: &mut SuplexDatabase,
    session_id: &str,
    owner: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        database.connection().execute(
            "UPDATE suplex_task_sessions SET launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL, updated_at = ?1 WHERE id = ?2 AND launch_owner = ?3",
            params![rfc3339_millis(now), session_id, owner],
        )?;
        Ok(())
    })
}

pub fn bind_native_session(
    database: &mut SuplexDatabase,
    root: &SessionRow,
    native_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_sessions SET native_session_id = ?1, lifecycle = 'live', updated_at = ?2 WHERE id = ?3 AND generation = ?4 AND is_current = 1 AND lifecycle <> 'cancelled' AND (native_session_id IS NULL OR native_session_id = ?1)",
            params![native_id, rfc3339_millis(now), root.id, root.generation],
        )? == 1)
    })
}

/// This CAS is the durable admission boundary used inside the harness dispatch callback.
pub fn claim_prompt(
    database: &mut SuplexDatabase,
    turn: &TurnRow,
    owner: &str,
    server_generation: &str,
    usage: TaskLimitUsage,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        if matches!(crate::tasks::limits::check_admission(database, &turn.task_id, usage, now)?, crate::tasks::limits::Admission::Blocked) { return Ok(false); }
        let attempt = PromptDispatchAttempt { server_generation: server_generation.to_owned(), claimed_at: rfc3339_millis(now) };
        let raw = serde_json::to_string(&attempt)?;
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'unknown', dispatch_attempt_json = ?1, updated_at = ?2 WHERE id = ?3 AND task_id = ?4 AND status = 'pending_prompt' AND EXISTS (SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_controls c ON c.task_id = s.task_id WHERE s.id = suplex_task_turns.session_id AND s.generation = suplex_task_turns.generation AND s.launch_owner = ?5 AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')",
            params![raw, attempt.claimed_at, turn.id, turn.task_id, owner],
        )? == 1)
    })
}

pub fn mark_prompted(
    database: &mut SuplexDatabase,
    turn: &TurnRow,
    native_turn_id: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'prompted', native_turn_id = COALESCE(?1, native_turn_id), prompted_at = ?2, updated_at = ?2 WHERE id = ?3 AND generation = ?4 AND status IN ('pending_prompt', 'unknown') AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.id = suplex_task_turns.session_id AND s.is_current = 1 AND s.generation = suplex_task_turns.generation)",
            params![native_turn_id, rfc3339_millis(now), turn.id, turn.generation],
        )? == 1)
    })
}

/// Clear a dispatch claim only after the native runtime proves the attempted
/// turn absent. Match the exact attempt and current operation owner so an old
/// observer cannot requeue a newer admitted prompt.
pub fn requeue_fenced_prompt(
    database: &mut SuplexDatabase,
    turn: &TurnRow,
    attempt: &PromptDispatchAttempt,
    owner: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let attempt_json = serde_json::to_string(attempt)?;
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'pending_prompt', dispatch_attempt_json = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'unknown' AND dispatch_attempt_json = ?3 AND EXISTS (SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_controls c ON c.task_id = s.task_id WHERE s.id = suplex_task_turns.session_id AND s.generation = suplex_task_turns.generation AND s.launch_owner = ?4 AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')",
            params![rfc3339_millis(now), turn.id, attempt_json, owner],
        )? == 1)
    })
}

/// Record a terminal Root observation once. An interrupted execution may
/// atomically enqueue a continuation so its admitted native turn is not replayed.
pub fn complete_root_turn(
    database: &mut SuplexDatabase,
    turn_id: &str,
    observation: &str,
    continuation: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(false, |database| {
        let time = rfc3339_millis(now);
        let previous: Option<(String, String, i64)> = database.connection().query_row(
            "UPDATE suplex_task_turns SET status = 'completed', terminal_observation = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3 AND status IN ('pending_prompt','unknown','prompted') RETURNING task_id,session_id,generation",
            params![observation, time, turn_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((task_id, session_id, generation)) = previous else {
            return Ok(false);
        };
        let Some(prompt) = continuation else {
            return Ok(true);
        };
        let active: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_controls WHERE task_id = ?1 AND status = 'active')",
            [&task_id], |row| row.get(0),
        )?;
        if !active {
            return Ok(true);
        }
        assert_current_root(database, &task_id, &session_id, generation)?;
        let id = new_turn_id(now)?;
        insert_pending_turn(database, &id, &task_id, &session_id, generation, None, prompt, None, &time)?;
        Ok(true)
    })
}

/// Complete one current delegate result and wake Root in the same
/// transaction. The native receipt makes recovery idempotent.
#[derive(Clone, Copy)]
pub struct StandardWorkerResult<'a> {
    pub task_id: &'a str,
    pub session_id: &'a str,
    pub generation: i64,
    pub receipt_id: &'a str,
    pub observation: &'a str,
    pub native_turn_id: Option<&'a str>,
    pub wake_prompt: &'a str,
    /// A Reviewer or Rater outcome: `{ result, invalidReason }`.
    pub review: Option<&'a Value>,
}

/// TypeScript `workflowStateRow`: a task without a control row has the empty
/// state; a stored state that does not parse is an error, never a reset.
pub fn workflow_state(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<WorkflowState> {
    let raw: Option<String> = database
        .connection()
        .query_row(
            "SELECT workflow_state_json FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()?
        .unwrap_or_default())
}

pub fn write_workflow_state(
    database: &SuplexDatabase,
    task_id: &str,
    state: &WorkflowState,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_task_controls SET workflow_state_json = ?1, updated_at = ?2 WHERE task_id = ?3",
        params![serde_json::to_string(state)?, rfc3339_millis(now), task_id],
    )?;
    Ok(())
}

fn insert_root_wake(
    database: &SuplexDatabase,
    task_id: &str,
    root: &SessionRow,
    prompt: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<TurnRow> {
    let time = rfc3339_millis(now);
    let wake_id = new_turn_id(now)?;
    insert_pending_turn(
        database,
        &wake_id,
        task_id,
        &root.id,
        root.generation,
        None,
        prompt,
        None,
        &time,
    )?;
    database.connection().execute(
        "UPDATE suplex_task_controls SET wake_at = ?1, updated_at = ?1 WHERE task_id = ?2",
        params![time, task_id],
    )?;
    Ok(database.connection().query_row(
        "SELECT * FROM suplex_task_turns WHERE id = ?1",
        [&wake_id],
        turn,
    )?)
}

/// TypeScript `recordWorkerResultAndWake`: completes the delegate turn, appends
/// a Reviewer or Rater record from its immutable turn input, and wakes
/// Coordinator once. A planner pair wakes Coordinator only when both settle.
pub fn record_standard_worker_result_and_wake(
    database: &mut SuplexDatabase,
    input: &StandardWorkerResult<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<TurnRow>> {
    let StandardWorkerResult {
        task_id,
        session_id,
        generation,
        receipt_id,
        observation,
        native_turn_id,
        wake_prompt,
        review,
    } = *input;
    database.transaction(false, |database| {
        let worker_turn: Option<(String, TurnStatus, Option<String>, Option<String>)> = database.connection().query_row(
            "SELECT id,status,result_receipt_id,workflow_input_json FROM suplex_task_turns WHERE task_id = ?1 AND session_id = ?2 AND generation = ?3 ORDER BY created_at DESC LIMIT 1",
            params![task_id, session_id, generation],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        let Some((worker_turn_id, status, prior_receipt, turn_input)) = worker_turn else {
            return Err(CoordinationError::refused("stale_generation").into());
        };
        let current: Option<(Option<AdvisorRole>, Option<String>)> = database.connection().query_row(
            "SELECT advisor_role,workflow_input_json FROM suplex_task_sessions WHERE id = ?1 AND task_id = ?2 AND kind = 'worker' AND is_current = 1 AND generation = ?3 AND lifecycle <> 'cancelled'",
            params![session_id, task_id, generation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((advisor_role, session_input)) = current.filter(|_| status != TurnStatus::Cancelled) else {
            return Err(CoordinationError::refused("stale_generation").into());
        };
        if status == TurnStatus::Completed {
            if prior_receipt.as_deref() == Some(receipt_id) {
                return Ok(None);
            }
            return Err(CoordinationError::refused("stale_receipt").into());
        }
        let root = current_root(database, task_id)?
            .ok_or_else(|| CoordinationError::refused("root_notification_unavailable"))?;
        let time = rfc3339_millis(now);
        database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'completed', result_receipt_id = ?1, terminal_observation = ?2, native_turn_id = ?3, completed_at = ?4, updated_at = ?4 WHERE id = ?5",
            params![receipt_id, observation, native_turn_id, time, worker_turn_id],
        )?;
        let workflow_input = turn_input
            .or(session_input)
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Null);
        if let Some(role @ (AdvisorRole::Reviewer | AdvisorRole::Rater)) = advisor_role
            && workflow_input["kind"] == "advisor"
        {
            let incomplete = json!({"result":null,"invalidReason":"The Advisor turn did not complete"});
            let review = review.unwrap_or(&incomplete);
            let result = Some(review["result"].clone()).filter(|result| result["role"] == role.as_str());
            let invalid_reason = result.is_none().then(|| {
                review["invalidReason"]
                    .as_str()
                    .unwrap_or("The Advisor result does not match its role")
                    .to_owned()
            });
            let mut state = workflow_state(database, task_id)?;
            state.reviews.push(ReviewRecord {
                session_id: session_id.to_owned(),
                turn_id: worker_turn_id.clone(),
                role,
                range: serde_json::from_value(workflow_input["range"].clone())?,
                result,
                invalid_reason,
                recorded_at: time.clone(),
            });
            write_workflow_state(database, task_id, &state, now)?;
        }
        if let Some(pair_id) = workflow_input["plannerPairId"].as_str() {
            database.connection().execute(
                "UPDATE suplex_task_sessions SET lifecycle = 'stopped', stop_requested_at = ?1, updated_at = ?1 WHERE id = ?2 AND generation = ?3 AND is_current = 1",
                params![time, session_id, generation],
            )?;
            let mut statement = database.connection().prepare(
                "SELECT s.id,(SELECT t.terminal_observation FROM suplex_task_turns t WHERE t.session_id = s.id AND t.generation = s.generation AND t.status = 'completed' LIMIT 1),EXISTS(SELECT 1 FROM suplex_task_turns t WHERE t.session_id = s.id AND t.generation = s.generation AND t.status = 'completed') FROM suplex_task_sessions s WHERE s.task_id = ?1 AND s.kind = 'worker' AND s.is_current = 1 AND json_extract(s.workflow_input_json,'$.plannerPairId') = ?2 ORDER BY CASE s.advisor_role WHEN 'planner_a' THEN 0 ELSE 1 END",
            )?;
            let pair = statement
                .query_map(params![task_id, pair_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, bool>(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            if pair.len() != 2 || !pair.iter().all(|(_, _, completed)| *completed) {
                return Ok(None);
            }
            let valid = pair.iter().all(|(_, observation, _)| {
                super::workflows::turn_outcome(observation.as_deref())
                    .advisor
                    .is_some_and(|advisor| !advisor["result"].is_null())
            });
            let next = if valid {
                "Both reports are valid. Reconcile them into one plan, then delegate Worker with those IDs."
            } else {
                "One or both reports are invalid. Retry only each invalid planner role with delegate_advisor, then reconcile a valid Plan A and Plan B. Do not delegate Worker until both reports are valid."
            };
            let text = |index: usize| pair[index].1.clone().unwrap_or_else(|| "null".into());
            let prompt = format!(
                "Combined planning pair {pair_id} completed. Plan A session {} and Plan B session {} are ordered candidateSessionIds. Read both full observations and their validation outcomes. {next}\n\nPlan A:\n{}\n\nPlan B:\n{}",
                pair[0].0, pair[1].0, text(0), text(1)
            );
            return insert_root_wake(database, task_id, &root, &prompt, now).map(Some);
        }
        insert_root_wake(database, task_id, &root, wake_prompt, now).map(Some)
    })
}

/// TypeScript `reconcileAdvisorResult`: replaces one invalid retained Advisor
/// outcome after its native evidence, task evidence, and source were revalidated.
pub fn reconcile_advisor_result(
    database: &mut SuplexDatabase,
    task_id: &str,
    session_id: &str,
    turn_id: &str,
    result: &Value,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(true, |database| {
        let row: Option<(Option<String>, Option<String>, Option<String>)> = database.connection().query_row(
            "SELECT s.advisor_role,COALESCE(t.workflow_input_json,s.workflow_input_json),t.terminal_observation FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id WHERE s.id = ?1 AND s.task_id = ?2 AND s.kind = 'worker' AND t.id = ?3 AND t.task_id = ?2 AND t.status = 'completed'",
            params![session_id, task_id, turn_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((role, input, observation)) = row else {
            return Err(CoordinationError::refused("advisor_turn_not_found").into());
        };
        let input = input
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Null);
        let Some(role) = role.filter(|role| input["kind"] == "advisor" && input["role"] == role.as_str() && result["role"] == role.as_str()) else {
            return Err(CoordinationError::refused("advisor_role_mismatch").into());
        };
        if super::workflows::turn_outcome(observation.as_deref())
            .advisor
            .is_some_and(|advisor| !advisor["result"].is_null())
        {
            return Err(CoordinationError::refused("advisor_result_already_valid").into());
        }
        let Some(Value::Object(mut base)) = observation.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
            return Err(CoordinationError::refused("advisor_observation_invalid").into());
        };
        base.insert("advisor".into(), json!({"role":role,"result":result,"invalidReason":null}));
        database.connection().execute(
            "UPDATE suplex_task_turns SET terminal_observation = ?1, updated_at = ?2 WHERE id = ?3",
            params![Value::Object(base).to_string(), rfc3339_millis(now), turn_id],
        )?;
        if let Some(role @ (AdvisorRole::Reviewer | AdvisorRole::Rater)) = AdvisorRole::parse(&role) {
            let mut state = workflow_state(database, task_id)?;
            let review = state
                .reviews
                .iter_mut()
                .find(|review| review.session_id == session_id && review.turn_id == turn_id && review.role == role)
                .filter(|review| review.result.is_none())
                .ok_or_else(|| CoordinationError::refused("advisor_review_not_reconcilable"))?;
            review.result = Some(result.clone());
            review.invalid_reason = None;
            write_workflow_state(database, task_id, &state, now)?;
        }
        Ok(())
    })
}

/// TypeScript `recordWorkflowOutcome`: records a terminal outcome that carries
/// no workflow proof. An existing completion is preserved.
pub fn record_workflow_outcome(
    database: &mut SuplexDatabase,
    task_id: &str,
    completion: &Completion,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let recorded = database.transaction(true, |database| {
        let mut state = workflow_state(database, task_id)?;
        if state.completion.is_some() {
            return Ok(false);
        }
        state.delivery_wait = None;
        state.completion = Some(completion.clone());
        write_workflow_state(database, task_id, &state, now)?;
        let status: TaskStatus = database.connection().query_row(
            "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        if matches!(status, TaskStatus::Active | TaskStatus::WaitingHuman) {
            mark_delivered(database, task_id, now)?;
        }
        Ok(true)
    })?;
    Ok(recorded)
}

/// TypeScript `updateWorkflowState`: one change in its own short transaction.
pub fn update_workflow_state(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
    mutate: impl FnOnce(&mut WorkflowState),
) -> DatabaseResult<WorkflowState> {
    database.transaction(true, |database| {
        let mut state = workflow_state(database, task_id)?;
        mutate(&mut state);
        write_workflow_state(database, task_id, &state, now)?;
        Ok(state)
    })
}

/// TypeScript `resumeDeliveryWait`: consumes exactly the expected wait and
/// inserts one Coordinator continuation in the same transaction.
pub fn resume_delivery_wait(
    database: &mut SuplexDatabase,
    task_id: &str,
    expected: &DeliveryWait,
    prompt: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        let status: TaskStatus = database.connection().query_row(
            "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        let root = current_root(database, task_id)?;
        let mut state = workflow_state(database, task_id)?;
        let Some(root) = root.filter(|root| {
            status == TaskStatus::Active
                && root.lifecycle != SessionLifecycle::Cancelled
                && state.delivery_wait.as_ref() == Some(expected)
        }) else {
            return Ok(false);
        };
        state.delivery_wait = None;
        write_workflow_state(database, task_id, &state, now)?;
        insert_root_wake(database, task_id, &root, prompt, now)?;
        Ok(true)
    })
}

/// TypeScript `clearDeliveryWait`: clears exactly the expected wait.
pub fn clear_delivery_wait(
    database: &mut SuplexDatabase,
    task_id: &str,
    expected: &DeliveryWait,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        let mut state = workflow_state(database, task_id)?;
        if state.delivery_wait.as_ref() != Some(expected) {
            return Ok(false);
        }
        state.delivery_wait = None;
        write_workflow_state(database, task_id, &state, now)?;
        Ok(true)
    })
}

/// TypeScript `failDeliveryWait`: turns exactly the expected wait into one
/// human question; overlapping failures cannot ask twice.
pub fn fail_delivery_wait(
    database: &mut SuplexDatabase,
    task_id: &str,
    expected: &DeliveryWait,
    question: &str,
    options: &Value,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let question = question.trim();
    if question.is_empty() {
        return Err(CoordinationError::refused("question_is_empty").into());
    }
    let asked = database.transaction(true, |database| {
        let state = workflow_state(database, task_id)?;
        if state.delivery_wait.as_ref() != Some(expected) {
            return Ok(false);
        }
        ask_human(database, task_id, question, options, now)
    })?;
    Ok(asked)
}

pub fn ask_human(
    database: &mut SuplexDatabase,
    task_id: &str,
    question: &str,
    options: &Value,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let question = question.trim();
    if question.is_empty() {
        return Err(CoordinationError::refused("question_is_empty").into());
    }
    let asked = database.transaction(true, |database| {
        let changed = database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = ?1, human_question_options_json = ?2, human_question_id = ?3, limit_pause_json = NULL, wake_at = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?4 WHERE task_id = ?5 AND status = 'active'",
            params![question, options.to_string(), Uuid::new_v4().to_string(), rfc3339_millis(now), task_id],
        )?;
        Ok(changed == 1)
    })?;
    if asked {
        observe_lifecycle(database, task_id)?;
    }
    Ok(asked)
}

/// Persist the worktree observed by Git while task execution is still active.
pub fn set_worktree(
    database: &mut SuplexDatabase,
    task_id: &str,
    worktree: &WorktreeReference,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    if worktree.path.as_os_str().is_empty()
        || [&worktree.branch, &worktree.base_sha, &worktree.head_sha]
            .iter()
            .any(|field| field.is_empty())
    {
        return Err(CoordinationError::refused("Invalid task worktree").into());
    }
    database.transaction(false, |database| {
        let changed = database.connection().execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1, updated_at = ?2 WHERE task_id = ?3 AND status = 'active'",
            params![serde_json::to_string(worktree)?, rfc3339_millis(now), task_id],
        )?;
        if changed != 1 { return Err(CoordinationError::refused("task_not_active").into()); }
        Ok(())
    })
}

/// Complete a local task and release its queued dependents inside the same
/// transaction. Pull-request ownership conflicts leave a dependent queued.
pub fn mark_delivered(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Vec<String>> {
    let admitted = database.transaction(false, |database| {
        let previous: Option<TaskStatus> = database.connection().query_row(
            "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
            [task_id], |row| row.get(0),
        ).optional()?;
        let time = rfc3339_millis(now);
        let changed = database.connection().execute(
            "UPDATE suplex_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.followUp', json('false')), status = 'delivered', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, updated_at = ?1 WHERE task_id = ?2 AND status IN ('active','waiting_human','delivered')",
            params![time, task_id],
        )?;
        if changed != 1 { return Err(CoordinationError::refused("task_not_active").into()); }
        let was_delivered = previous == Some(TaskStatus::Delivered);
        let mut statement = database.connection().prepare(
            "SELECT d.task_id FROM suplex_task_dependencies d WHERE d.depends_on_task_id = ?1 ORDER BY d.task_id"
        )?;
        let dependent_ids = statement.query_map([task_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let mut admitted = Vec::new();
        for dependent in dependent_ids {
            if was_delivered {
                let queued: bool = database.connection().query_row(
                    "SELECT EXISTS(SELECT 1 FROM suplex_task_controls WHERE task_id = ?1 AND status = 'queued')",
                    [&dependent], |row| row.get(0),
                )?;
                if !queued { continue; }
            }
            if repository::reconcile_dependency_release(database, &dependent, now)? {
                admitted.push(dependent);
            }
        }
        Ok(admitted)
    })?;
    observe_lifecycle(database, task_id)?;
    for id in &admitted {
        observe_lifecycle(database, id)?;
        observe_admission(database, id, "prerequisite completion", Some(task_id));
    }
    Ok(admitted)
}

pub fn retire_delivered_sessions(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        database.connection().execute(
            "UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'stopped',stop_requested_at = COALESCE(stop_requested_at,?1),updated_at = ?1 WHERE task_id = ?2 AND stopped_at IS NULL AND EXISTS (SELECT 1 FROM suplex_task_controls c WHERE c.task_id = suplex_task_sessions.task_id AND c.status = 'delivered')",
            params![rfc3339_millis(now), task_id],
        )?;
        Ok(())
    })
}

/// Wake an idle live Root only when no current Worker or Root turn owns prompt
/// work. Dependency state is checked in the same transaction.
pub fn wake_idle_root(
    database: &mut SuplexDatabase,
    task_id: &str,
    prompt: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<TurnRow>> {
    database.transaction(true, |database| {
        let blocked: bool = crate::tasks::dependencies::blocked(database, task_id)?;
        if blocked { return Ok(None); }
        let id = new_turn_id(now)?;
        let time = rfc3339_millis(now);
        let eligible: Option<(String, i64)> = database.connection().query_row(
            "SELECT s.id,s.generation FROM suplex_task_controls c JOIN suplex_task_sessions s ON s.id = c.root_session_id WHERE c.task_id = ?1 AND c.status = 'active' AND json_extract(c.workflow_state_json,'$.deliveryWait') IS NULL AND s.is_current = 1 AND s.lifecycle = 'live' AND s.native_session_id IS NOT NULL AND s.launch_owner IS NULL AND NOT EXISTS (SELECT 1 FROM suplex_task_turns t WHERE t.session_id = s.id AND t.status IN ('pending_prompt','prompted','unknown')) AND NOT EXISTS (SELECT 1 FROM suplex_task_sessions w JOIN suplex_task_turns wt ON wt.session_id = w.id AND wt.generation = w.generation WHERE w.task_id = c.task_id AND w.kind = 'worker' AND w.is_current = 1 AND wt.status IN ('pending_prompt','prompted','unknown'))",
            [task_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((session_id, generation)) = eligible else { return Ok(None); };
        insert_pending_turn(database, &id, task_id, &session_id, generation, None, prompt, None, &time)?;
        Ok(Some(database.connection().query_row(
            "SELECT * FROM suplex_task_turns WHERE id = ?1", [&id], turn,
        )?))
    })
}

// WP3a admission sweep

/// TypeScript `TaskControlStore.admitQueued()` without ids: the sweep over
/// every ready queued task that runs from host startup on. A task whose pull
/// request another task owns stays queued and the next sweep retries.
pub fn admit_queued(
    database: &mut SuplexDatabase,
    now: DateTime<Utc>,
) -> DatabaseResult<Vec<String>> {
    if ready_queued_task_ids(database)?.is_empty() {
        return Ok(Vec::new());
    }
    let admitted = database.transaction(true, |database| {
        let mut admitted = Vec::new();
        for task_id in ready_queued_task_ids(database)? {
            match repository::admit_queued(database, &task_id, now) {
                Ok(true) => admitted.push(task_id),
                Ok(false) => {}
                Err(error) if TaskError::is_pull_request_owned(&*error) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(admitted)
    })?;
    for id in &admitted {
        observe_lifecycle(database, id)?;
        observe_admission(database, id, "scheduler sweep", None);
    }
    Ok(admitted)
}

/// TypeScript `readyQueuedTaskIds` without a prerequisite filter.
fn ready_queued_task_ids(database: &SuplexDatabase) -> DatabaseResult<Vec<String>> {
    let mut statement = database.connection().prepare(
        "SELECT t.id FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE c.status = 'queued' AND t.archived_at IS NULL ORDER BY t.created_at, t.id",
    )?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut ready = Vec::new();
    for id in ids {
        if repository::prerequisites_complete(database, &id)? {
            ready.push(id);
        }
    }
    Ok(ready)
}

/// TypeScript `TaskControlStore.requireExecutionCleanup`: a current session
/// whose execution Suplex cannot identify asks a human to stop its commands.
pub fn require_execution_cleanup(
    database: &mut SuplexDatabase,
    turn: &TurnRow,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        let current: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_controls c ON c.task_id = s.task_id WHERE s.id = ?1 AND s.generation = ?2 AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active' AND (s.kind = 'worker' OR c.root_session_id = s.id))",
            params![turn.session_id, turn.generation], |row| row.get(0),
        )?;
        if !current { return Ok(()); }
        let changed = database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = ?1, human_question_options_json = '[]', human_question_id = ?2, limit_pause_json = NULL, wake_at = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?3 WHERE task_id = ?4 AND status = 'active'",
            params!["The agent stopped during a tool call. A command can still be active in the worktree. Stop those commands before you continue. Describe what you checked, then confirm that all commands from this session have stopped.", Uuid::new_v4().to_string(), rfc3339_millis(now), turn.task_id],
        )?;
        if changed != 1 { return Err(CoordinationError::refused("task_not_active").into()); }
        database.connection().execute(
            "UPDATE suplex_task_controls SET recovery_turn_id = ?1 WHERE task_id = ?2",
            params![turn.id, turn.task_id],
        )?;
        Ok(())
    })
}

/// TypeScript `TaskControlStore.coalesceUnadmittedIdleRootTurn`: an idle
/// Root wake is dropped when real Root work is also pending.
pub fn coalesce_unadmitted_idle_root_turn(
    database: &mut SuplexDatabase,
    turn_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let idle = |prompt: &str| without_current_dependency_status(prompt) == IDLE_ROOT_PROMPT;
    database.transaction(false, |database| {
        let candidate: Option<(String, String, String)> = database.connection().query_row(
            "SELECT t.task_id, t.session_id, t.prompt_text FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.id = ?1 AND t.status = 'pending_prompt' AND s.kind = 'root'",
            [turn_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((task_id, session_id, prompt)) = candidate else { return Ok(false); };
        if !idle(&prompt) { return Ok(false); }
        let mut statement = database.connection().prepare(
            "SELECT prompt_text FROM suplex_task_turns WHERE task_id = ?1 AND session_id = ?2 AND id <> ?3 AND status = 'pending_prompt'",
        )?;
        let others = statement
            .query_map(params![task_id, session_id, turn_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if !others.iter().any(|other| !idle(other)) { return Ok(false); }
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'cancelled', updated_at = ?1 WHERE id = ?2 AND status = 'pending_prompt'",
            params![rfc3339_millis(now), turn_id],
        )? == 1)
    })
}

/// TypeScript `TaskControlStore.refreshPendingRootDependencyContext`: an
/// unsent Root prompt carries the current prerequisite status.
pub fn refresh_pending_root_dependency_context(
    database: &mut SuplexDatabase,
    turn_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<TurnRow> {
    database.transaction(false, |database| {
        let current = database.connection().query_row(
            "SELECT t.* FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.id = ?1 AND t.status = 'pending_prompt' AND s.kind = 'root'",
            [turn_id], turn,
        ).optional()?;
        if let Some(current) = current {
            let dependencies = root_observation_rows(database, &current.task_id)?.dependencies;
            let prompt = with_current_dependency_status(&current.prompt_text, &dependencies);
            if prompt != current.prompt_text {
                        let hash = sha256_hex(prompt.as_bytes());
                database.connection().execute(
                    "UPDATE suplex_task_turns SET prompt_text = ?1, prompt_hash = ?2, updated_at = ?3 WHERE id = ?4 AND status = 'pending_prompt'",
                    params![prompt, hash, rfc3339_millis(now), turn_id],
                )?;
            }
        }
        Ok(database.connection().query_row(
            "SELECT * FROM suplex_task_turns WHERE id = ?1", [turn_id], turn,
        )?)
    })
}

fn selection_available(
    database: &SuplexDatabase,
    task_id: &str,
    control: &TaskControlRow,
    message: &str,
) -> DatabaseResult<()> {
    let archived: bool = database.connection().query_row(
        "SELECT archived_at IS NOT NULL FROM suplex_tasks WHERE id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    if archived
        || !matches!(
            control.status,
            TaskStatus::Active | TaskStatus::WaitingHuman
        )
    {
        return Err(TaskError::new(message, 409).into());
    }
    Ok(())
}
fn selection_profile(
    database: &SuplexDatabase,
    rows: &RootObservationRows,
    request: &AgentSelection,
    missing: &str,
) -> DatabaseResult<TaskProfile> {
    let control = &rows.control;
    if request.resume
        && (control.status != TaskStatus::WaitingHuman
            || control.human_question_id != request.question_id
            || control.limit_pause.is_some()
            || control.recovery_turn_id.is_some())
    {
        return Err(
            TaskError::new("Answer the current task decision before resuming.", 409).into(),
        );
    }
    let profile = read_profile(
        database,
        &request.profile_id,
        if request.role == "worker" {
            "worker"
        } else {
            "root"
        },
    )?
    .ok_or_else(|| TaskError::new(missing, 409))?;
    let policy: Option<ProjectProviderPolicy> =
        serde_json::from_value(rows.context["configuration"]["providerPolicy"].clone())?;
    if !allowed_profile(policy.as_ref(), &profile) {
        return Err(TaskError::new(
            "Select an agent with a provider and login allowed by this project",
            409,
        )
        .into());
    }
    Ok(profile)
}
fn selection_question(control: &TaskControlRow) -> Option<String> {
    control.human_question.as_ref().map(|text| {
        format!(
            "Question {} remains unanswered: {text}\nOptions: {}",
            control.human_question_id.as_deref().unwrap_or(""),
            control.human_question_options
        )
    })
}
fn next_generation(database: &SuplexDatabase, task_id: &str, kind: &str) -> DatabaseResult<i64> {
    Ok(database.connection().query_row("SELECT COALESCE(MAX(generation), 0) + 1 FROM suplex_task_sessions WHERE task_id = ?1 AND kind = ?2", params![task_id, kind], |row| row.get(0))?)
}
fn insert_selection_turn(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: &str,
    generation: i64,
    prompt: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    insert_pending_turn(
        database,
        &new_turn_id(now)?,
        task_id,
        session_id,
        generation,
        None,
        prompt,
        None,
        &rfc3339_millis(now),
    )
}
fn finish_selection(
    database: &SuplexDatabase,
    task_id: &str,
    request: &AgentSelection,
    mut state: WorkflowState,
    time: &str,
) -> DatabaseResult<()> {
    state
        .agent_selections
        .get_or_insert_default()
        .insert(request.role.clone(), request.clone());
    database.connection().execute(
            "UPDATE suplex_task_controls SET workflow_state_json = ?1, status = CASE WHEN ?2 THEN 'active' ELSE status END, status_changed_at = CASE WHEN ?2 THEN ?3 ELSE status_changed_at END, human_question = CASE WHEN ?2 THEN NULL ELSE human_question END, human_question_id = CASE WHEN ?2 THEN NULL ELSE human_question_id END, human_question_options_json = CASE WHEN ?2 THEN '[]' ELSE human_question_options_json END, wake_at = CASE WHEN ?2 OR status = 'active' THEN ?3 ELSE wake_at END, updated_at = ?3 WHERE task_id = ?4",
            params![crate::shared::js_json::stringify(&serde_json::to_value(&state)?), request.resume, time, task_id],
        )?;
    Ok(())
}
pub fn select_initial_root(
    database: &mut SuplexDatabase,
    task_id: &str,
    request: &AgentSelection,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let rows = root_observation_rows(database, task_id)?;
    let initial =
        root_prompts::initial_coordinator_prompt(&rows.control, &rows.context, &rows.dependencies);
    database.transaction(true, |database| {
        let rows = root_observation_rows(database, task_id)?;
        let control = &rows.control;
        let changed = "The Coordinator changed. Read the current Coordinator before selecting another.";
        selection_available(database, task_id, control, changed)?;
        let mut state = control.workflow_state.clone();
        if state.agent_selections.as_ref().and_then(|selections| selections.get(&request.role)) == Some(request)
            && control.root_session_id.is_some() && state.initial_root_selection_session_id == control.root_session_id {
            return Ok(());
        }
        if control.root_session_id.is_some() || control.root_profile.profile_id != request.expected_profile_id {
            return Err(TaskError::new(changed, 409).into());
        }
        let profile = selection_profile(database, &rows, request, "The selected Coordinator profile does not exist.")?;
        let profile_json = serde_json::to_string(&profile)?;
        let time = rfc3339_millis(now);
        let direction = (!request.direction.is_empty()).then(|| format!("Additional direction from the user:\n{}", request.direction));
        let pending_question = selection_question(control);
        let id = Uuid::new_v4().to_string();
        let generation = next_generation(database, task_id, "root")?;
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, lifecycle, profile_json, created_at, updated_at) VALUES (?1, ?2, 'root', ?3, 1, 'reserved', ?4, ?5, ?5)",
            params![id, task_id, generation, profile_json, time],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET root_session_id = ?1, root_profile_json = ?2 WHERE task_id = ?3",
            params![id, profile_json, task_id],
        )?;
        state.initial_root_selection_session_id = Some(id.clone());
        let prompt = match &direction {
            Some(direction) => format!("{initial}\n\n{direction}"),
            None => initial.clone(),
        };
        insert_selection_turn(database, task_id, &id, generation, &prompt, now)?;
        if direction.is_some() || pending_question.is_some() {
            let note = format!("Human note:\n{}", [direction.clone(), pending_question.clone()].into_iter().flatten().collect::<Vec<_>>().join("\n\n"));
            insert_selection_turn(database, task_id, &id, generation, &note, now)?;
        }
        finish_selection(database, task_id, request, state, &time)
    })
}
pub fn select_delegate(
    database: &mut SuplexDatabase,
    task_id: &str,
    request: &AgentSelection,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let rows = root_observation_rows(database, task_id)?;
    let initial =
        root_prompts::initial_coordinator_prompt(&rows.control, &rows.context, &rows.dependencies);
    database.transaction(true, |database| {
        let rows = root_observation_rows(database, task_id)?;
        let control = &rows.control;
        selection_available(database, task_id, control, "Only active or paused tasks can select an agent.")?;
        let advisor_role = (request.role != "worker").then_some(request.role.as_str());
        if advisor_role.is_some_and(|role| !workflows::workflow_definition(control.workflow.as_str()).is_some_and(|definition| definition.advisor_roles.contains(&role))) {
            return Err(TaskError::new("The selected role is not in this workflow.", 409).into());
        }
        let state = control.workflow_state.clone();
        let mut advisors = serde_json::to_value(&control.advisor_profiles)?;
        let previous_profile = match advisor_role {
            Some(role) => control.advisor_profiles.get(&AdvisorRole::parse(role).expect("validated role")).unwrap_or(&control.root_profile),
            None => &control.worker_profile,
        };
        let current = database.connection().query_row(
            "SELECT id, generation, delegate_slot, workflow_input_json, replacement_handoff FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND advisor_role IS ?2 AND is_current = 1 ORDER BY generation DESC LIMIT 1",
            params![task_id, advisor_role],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?)),
        ).optional()?;
        if state.agent_selections.as_ref().and_then(|selections| selections.get(&request.role)) == Some(request) && previous_profile.profile_id == request.profile_id { return Ok(()); }
        if previous_profile.profile_id != request.expected_profile_id || current.as_ref().map(|current| &current.0) != request.expected_session_id.as_ref() {
            return Err(TaskError::new("The agent changed. Read the current agent before selecting another.", 409).into());
        }
        let profile = selection_profile(database, &rows, request, "The selected agent profile does not exist.")?;
        let profile_json = serde_json::to_string(&profile)?;
        let root_profile = serde_json::to_string(&control.root_profile)?;
        let root_session_id = &control.root_session_id;
        let worker_session_id = &control.worker_session_id;
        let time = rfc3339_millis(now);
        let hash = |text: &str| sha256_hex(text.as_bytes());
        let direction = (!request.direction.is_empty()).then(|| format!("Additional direction from the user:\n{}", request.direction));
        let pending_question = selection_question(control);
        let mut replacement = None;
        database.connection().execute(
            "UPDATE suplex_task_sessions SET profile_json = ?1 WHERE task_id = ?2 AND kind = 'worker' AND advisor_role IS ?3 AND profile_json IS NULL",
            params![serde_json::to_string(&previous_profile)?, task_id, advisor_role],
        )?;
        if let Some((current_id, current_generation, slot, session_input, inherited)) = &current {
            let latest = database.connection().query_row(
                "SELECT status, terminal_observation, prompt_text, workflow_input_json FROM suplex_task_turns WHERE session_id = ?1 AND generation = ?2 ORDER BY created_at DESC, id DESC LIMIT 1",
                params![current_id, current_generation],
                |row| Ok((row.get::<_, TurnStatus>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
            ).optional()?;
            if let Some((turn_status, observation, assignment, turn_input)) = latest {
                let outcome = observation.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                let successful = turn_status == TurnStatus::Completed && outcome.as_ref().is_some_and(|outcome| {
                    outcome["state"] == "completed"
                        && advisor_role.is_none_or(|role| outcome["advisor"]["role"] == role && !outcome["advisor"]["result"].is_null())
                });
                if !successful {
                    let inherited = inherited.clone().unwrap_or_default();
                    let suffix = format!("\n\nFresh Worker handoff:\n{inherited}");
                    let base = if !inherited.is_empty() { assignment.strip_suffix(&suffix).unwrap_or(&assignment) } else { &assignment };
                    let handoff = [Some(inherited.clone()).filter(|text| !text.is_empty()), direction.clone(), Some("Continue the preserved assignment. Inspect current work and evidence before changing it.".to_owned())].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
                    let prompt = format!("{base}\n\nFresh Worker handoff:\n{handoff}");
                    let id = Uuid::new_v4().to_string();
                    let generation = next_generation(database, task_id, "worker")?;
                    let input = turn_input.or_else(|| session_input.clone());
                    database.connection().execute(
                        "UPDATE suplex_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = ?1, stopped_at = NULL, updated_at = ?1 WHERE id = ?2",
                        params![time, current_id],
                    )?;
                    cancel_open_turns(database, task_id, Some(current_id), &time)?;
                    database.connection().execute(
                        "INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, lifecycle, assignment_hash, advisor_role, delegate_slot, workflow_input_json, profile_json, replaces_session_id, replacement_reason, replacement_handoff, created_at, updated_at) VALUES (?1, ?2, 'worker', ?3, 1, 'reserved', ?4, ?11, ?5, ?6, ?7, ?8, 'User selected a new agent', ?9, ?10, ?10)",
                        params![id, task_id, generation, hash(&prompt), slot.as_deref().unwrap_or("delegate"), input, profile_json, current_id, handoff, time, advisor_role],
                    )?;
                    insert_pending_turn(database, &new_turn_id(now)?, task_id, &id, generation, Some(&hash(&prompt)), &prompt, input.as_deref(), &time)?;
                    if advisor_role.is_none() || worker_session_id.as_ref() == Some(current_id) {
                        database.connection().execute(
                            "UPDATE suplex_task_controls SET worker_session_id = ?1 WHERE task_id = ?2",
                            params![id, task_id],
                        )?;
                    }
                    replacement = Some(id);
                }
            }
        }
        match advisor_role {
            None => database.connection().execute(
                "UPDATE suplex_task_controls SET worker_profile_json = ?1 WHERE task_id = ?2",
                params![profile_json, task_id],
            )?,
            Some(role) => {
                advisors[role] = serde_json::to_value(&profile)?;
                database.connection().execute(
                    "UPDATE suplex_task_controls SET advisor_profiles_json = ?1 WHERE task_id = ?2",
                    params![crate::shared::js_json::stringify(&advisors), task_id],
                )?
            }
        };
        let live_root = database.connection().query_row(
            "SELECT id, generation FROM suplex_task_sessions WHERE id = ?1 AND task_id = ?2 AND kind = 'root' AND is_current = 1",
            params![root_session_id, task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).optional()?;
        let (root_id, root_generation) = match live_root {
            Some(root) => root,
            None => {
                let id = Uuid::new_v4().to_string();
                let generation = next_generation(database, task_id, "root")?;
                database.connection().execute(
                    "INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, lifecycle, profile_json, created_at, updated_at) VALUES (?1, ?2, 'root', ?3, 1, 'reserved', ?4, ?5, ?5)",
                    params![id, task_id, generation, root_profile, time],
                )?;
                database.connection().execute(
                    "UPDATE suplex_task_controls SET root_session_id = ?1 WHERE task_id = ?2",
                    params![id, task_id],
                )?;
                insert_selection_turn(database, task_id, &id, generation, &initial, now)?;
                (id, generation)
            }
        };
        let note = [
            Some(format!("The user selected {} profile {}.", advisor_role.map_or("Worker", workflows::advisor_label), request.profile_id)),
            direction.clone(),
            pending_question.clone(),
            Some(match &replacement {
                Some(id) => format!("Continue with replacement session {id} and the preserved assignment."),
                None => "Use this selection for future assignments. Do not repeat completed work.".to_owned(),
            }),
        ].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
        insert_selection_turn(database, task_id, &root_id, root_generation, &format!("Human note:\n{note}"), now)?;
        finish_selection(database, task_id, request, state, &time)
    })
}
pub fn continue_delivery(
    database: &mut SuplexDatabase,
    task_id: &str,
    delivery_target: DeliveryTarget,
) -> DatabaseResult<()> {
    database.transaction(true, |database| {
        let task = repository::task_by_id(database, task_id)?.ok_or_else(TaskError::not_found)?;
        let (archived, repository_kind, previous_target): (bool, Option<String>, String) =
            database.connection().query_row(
                "SELECT t.archived_at IS NOT NULL, json_extract(t.configuration_json, '$.integration.repository.kind'), c.delivery_target FROM suplex_tasks t JOIN suplex_task_controls c ON c.task_id = t.id WHERE t.id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        let conflict = |message: &str| TaskError::new(message, 409).into();
        if archived {
            return Err(conflict(
                "Open the archived task before you continue delivery.",
            ));
        }
        if repository_kind.as_deref() == Some("bitbucket") {
            return Err(TaskError::new(
                "Bitbucket supports draft pull requests. Select a supported delivery target.",
                422,
            ).into());
        }
        let order = |target: &str| {
            DeliveryTarget::parse(target).ok_or_else(|| conflict("Invalid delivery target"))
        };
        let (next, previous) = (delivery_target, order(&previous_target)?);
        if next < previous {
            return Err(conflict("The delivery target cannot move backward."));
        }
        if next == previous && matches!(task.status, TaskStatus::Active | TaskStatus::Delivered) {
            return Ok(());
        }
        if task.status != TaskStatus::Delivered || !previous.uses_pull_request() {
            return Err(conflict(
                "Only delivered pull request tasks can continue delivery.",
            ));
        }
        repository::assert_task_pull_requests_available(database, task_id)
            .map_err(|error| conflict(&error.to_string()))?;
        let time = crate::shared::time::now_millis_rfc3339();
        let rows = root_observation_rows(database, task_id)?;
        reopen_delivered(database, task_id, rows.control.root_session_id.as_deref(), &rows.control.workflow_state, &time)?;
        database.connection().execute("UPDATE suplex_task_controls SET delivery_target = ?1 WHERE task_id = ?2", params![delivery_target, task_id])?;
        let existing = current_root(database, task_id)?;
        let root = match existing {
            Some(root) => root,
            None => {
                let root = reserve_root(database, task_id, Utc::now())?;
                let rows = root_observation_rows(database, task_id)?;
                let initial = root_prompts::initial_coordinator_prompt(&rows.control, &rows.context, &rows.dependencies);
                ensure_initial_prompt(database, &root, &initial, Utc::now())?;
                root
            }
        };
        let prompt = crate::shared::js_json::stringify(&json!({
            "question": format!("The user changed the delivery target from {previous_target} to {}. Continue this task toward the NEW target {}. Preserve the existing branch, pull request, sessions, and useful review evidence. Inspect current Git and GitHub facts, repair conflicts and failing checks, and request delivery explicitly when the new target is satisfied. Earlier completion is history.", delivery_target, delivery_target),
            "answer": format!("Continue delivery to {}.", delivery_target),
        }));
        insert_pending_turn(database, &new_turn_id(Utc::now())?, task_id, &root.id, root.generation, None, &prompt, None, &time)?;
        observe_lifecycle(database, task_id)?;
        Ok(())
    })
}

pub fn reopen_delivered(
    database: &SuplexDatabase,
    task_id: &str,
    root_session_id: Option<&str>,
    state: &WorkflowState,
    time: &str,
) -> DatabaseResult<()> {
    let mut state = state.clone();
    let resumed = crate::coordination::workflows::DeliveryHistoryEntry {
        resumed_at: time.to_owned(),
        accepted_delivery: state.accepted_delivery.take(),
        completion: state.completion.take(),
    };
    state.delivery_wait = None;
    state.follow_up = Some(true);
    state.delivery_history.get_or_insert_default().push(resumed);
    database.connection().execute(
        "UPDATE suplex_task_controls SET workflow_state_json = ?1,status = 'active',wake_at = ?2,updated_at = ?2 WHERE task_id = ?3 AND status = 'delivered'",
        params![js_json::stringify(&serde_json::to_value(&state)?), time, task_id],
    )?;
    if let Some(root_session_id) = root_session_id {
        database.connection().execute(
            "UPDATE suplex_task_sessions SET is_current = 1,lifecycle = 'reserved',stop_requested_at = NULL,stopped_at = NULL,updated_at = ?1 WHERE id = ?2 AND kind = 'root'",
            params![time, root_session_id],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::control::{
        TaskCoordinatorReplacementBody, TaskLimitDecision, TaskWorkerReplacementBody,
    };
    use crate::{
        identity::auth,
        platform::database::OpenMode,
        runtimes::headless::{self, DispatchInput},
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use std::{collections::HashMap, path::Path, process::Command};

    #[test]
    fn worker_and_coordinator_replacement_preserve_handoffs_and_native_readiness() {
        let filename =
            std::env::temp_dir().join(format!("suplex_replace_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('replace_company','Replace','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('replace_project','replace_company','Replace','/tmp/replace-repo','/tmp/replace-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "replace_company".into(),
            project_id: "replace_project".into(),
            title: "Replace Worker".into(),
            description: String::new(),
            configuration: serde_json::json!({"repository":"owner/repo","repositoryPath":"/tmp/replace-repo","worktreeRoot":"/tmp/replace-worktrees","branch":"task-replace","baseBranch":"main","baselineSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","startingSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","setupCommand":"","verificationCommand":"","runProjectTests":false,"visualEvidence":"off","source":null,"capturedAt":"2026-09-25T12:00:00.000Z"}),
            idempotency_key: "replace-key".into(),
            request_hash: "replace-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-replace","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![],
        };
        let task = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task;
        let root = reserve_root(&mut database, &task.id, now).unwrap();
        let old = launch_standard_worker(
            &mut database,
            &root,
            "Assignment: build",
            "Worker assignment: build",
            None,
            now,
        )
        .unwrap();
        let old_id = old.id.as_str().to_owned();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET native_session_id = 'codex-old' WHERE id = ?1",
                [&old_id],
            )
            .unwrap();
        database.connection().execute("UPDATE suplex_task_turns SET status = 'completed',terminal_observation = ?1 WHERE session_id = ?2", params![r#"{"state":"completed","text":"Made a partial change."}"#, old_id]).unwrap();
        let request = TaskWorkerReplacementBody {
            session_id: old_id.clone(),
            reason: "Change strategy".into(),
            handoff: Some("Finish the test".into()),
            worker_profile_id: None,
        };
        let next = replace_worker(&mut database, &task.id, &request, now).unwrap();
        assert_ne!(next.id, old_id);
        assert_eq!(next.native_session_id, None);
        assert_eq!(next.profile, old.profile);
        let next_id = next.id.as_str();
        assert!(!worker_replacement_ready(&database, next_id).unwrap());
        let saved: (String, String, String) = database.connection().query_row(
            "SELECT prompt_text,prompt_hash,assignment_hash FROM suplex_task_turns WHERE session_id = ?1", [next_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert!(saved.0.starts_with("Worker assignment: build\n\nFresh Worker handoff:\nReason for replacement: Change strategy"));
        assert!(saved.0.contains("Latest Worker result (verify its claims against source and command evidence):\nMade a partial change."));
        assert_eq!(saved.1, sha256_hex(saved.0.as_bytes()));
        assert_eq!(saved.1, saved.2);
        assert_eq!(
            replace_worker(&mut database, &task.id, &request, now)
                .unwrap()
                .id,
            next.id
        );
        drop(database);
        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        assert_eq!(
            current_worker(&database, &task.id).unwrap().unwrap().id,
            next_id
        );
        assert!(!worker_replacement_ready(&database, next_id).unwrap());
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET stopped_at = ?1 WHERE id = ?2",
                params![rfc3339_millis(now), old_id],
            )
            .unwrap();
        assert!(worker_replacement_ready(&database, next_id).unwrap());
        database.connection().execute(
            "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('alternate-worker','Alternate','worker','alternate','codex','gpt-6-sol','high','default',?1,?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let second = replace_worker(
            &mut database,
            &task.id,
            &TaskWorkerReplacementBody {
                session_id: next_id.into(),
                reason: "Try another approach".into(),
                handoff: None,
                worker_profile_id: Some("alternate-worker".into()),
            },
            now,
        )
        .unwrap();
        assert_eq!(
            second.profile.as_ref().unwrap().profile_id,
            "alternate-worker"
        );
        assert_eq!(second.profile.as_ref().unwrap().reasoning_level, "high");
        assert_eq!(next.profile, old.profile);
        let latest: String = database
            .connection()
            .query_row(
                "SELECT prompt_text FROM suplex_task_turns WHERE session_id = ?1",
                [second.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(latest.matches("Fresh Worker handoff:").count(), 1);
        database.connection().execute(
            "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('alternate-root','Alternate Root','root','alternate-root','codex','gpt-6-sol','medium','default',?1,?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let rows = root_observation_rows(&database, &task.id).unwrap();
        let initial = root_prompts::initial_coordinator_prompt(
            &rows.control,
            &rows.context,
            &rows.dependencies,
        );
        ensure_initial_prompt(&mut database, &root, &initial, now).unwrap();
        for prompt in [
            "Human note:\nKeep the release notes intact.".to_owned(),
            r#"{"question":"Which branch?","answer":"Maintenance"}"#.to_owned(),
            r#"{"question":"More budget?","decision":{"kind":"add_budget","amount":9.0}}"#
                .to_owned(),
        ] {
            database.connection().execute(
                "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'completed',?7,?7)",
                params![new_turn_id(now).unwrap(),task.id,root.id,root.generation,sha256_hex(prompt.as_bytes()),prompt,rfc3339_millis(now)],
            ).unwrap();
        }
        for text in ["Checked the branch", "Compared the failed provider"] {
            let prompt = "Continue the task";
            database.connection().execute(
                "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,terminal_observation,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'completed',?7,?8,?8)",
                params![new_turn_id(now).unwrap(),task.id,root.id,root.generation,sha256_hex(prompt.as_bytes()),prompt,js_json::stringify(&serde_json::json!({"state":"completed","text":text})),rfc3339_millis(now)],
            ).unwrap();
        }
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human',human_question = 'Resolve provider failure?',human_question_id = 'question-current',human_question_options_json = '[]' WHERE task_id = ?1",
            [&task.id],
        ).unwrap();
        let source_oracle = if std::env::var_os("SUPLEX_COORDINATOR_TS_ORACLE").is_some() {
            let snapshot = filename.with_extension("oracle.sqlite");
            database
                .connection()
                .execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])
                .unwrap();
            let output = Command::new("node")
                .args([
                    "node_modules/tsx/dist/cli.mjs",
                    "tests/support/coordinator-replacement-interop.ts",
                ])
                .arg(&snapshot)
                .arg(&task.id)
                .arg(&root.id)
                .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let _ = std::fs::remove_file(snapshot);
            Some(serde_json::from_slice::<Value>(&output.stdout).unwrap())
        } else {
            None
        };
        let coordinator_request = TaskCoordinatorReplacementBody {
            session_id: root.id.clone(),
            root_profile_id: "alternate-root".into(),
            handoff: Some("Check the failed provider.".into()),
            resume: true,
            question_id: Some("question-current".into()),
        };
        let first =
            replace_coordinator(&mut database, &task.id, &coordinator_request, &initial, now)
                .unwrap();
        let first_id = first.id.as_str().to_owned();
        assert_ne!(first_id, root.id);
        assert_eq!(first.profile.as_ref().unwrap().profile_id, "alternate-root");
        assert_eq!(first.native_session_id, None);
        let retained_profile: String = database
            .connection()
            .query_row(
                "SELECT profile_json FROM suplex_task_sessions WHERE id = ?1",
                [&root.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&retained_profile).unwrap()["profileId"],
            "root"
        );
        assert!(!worker_replacement_ready(&database, &first_id).unwrap());
        assert_eq!(
            replace_coordinator(&mut database, &task.id, &coordinator_request, &initial, now)
                .unwrap()
                .id,
            first_id
        );
        let first_prompt: (String, String) = database
            .connection()
            .query_row(
                "SELECT prompt_text,prompt_hash FROM suplex_task_turns WHERE session_id = ?1",
                [&first_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(first_prompt.0.contains("Keep the release notes intact."));
        assert!(
            first_prompt
                .0
                .contains("Accepted human task limit decision")
        );
        assert!(first_prompt.0.contains("\"amount\":9}"));
        assert!(
            first_prompt
                .0
                .contains("Checked the branch\n\nCoordinator turn")
        );
        assert!(
            first_prompt
                .0
                .contains("Question question-current:\nResolve provider failure?")
        );
        assert!(
            first_prompt
                .0
                .contains("Additional direction from the user:\nCheck the failed provider.")
        );
        assert_eq!(first_prompt.1, sha256_hex(first_prompt.0.as_bytes()));
        if let Some(source) = &source_oracle {
            assert_eq!(first_prompt.0, source["firstPrompt"]);
            assert_eq!(first_prompt.1, source["firstHash"]);
        }
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET stopped_at = ?1 WHERE id = ?2",
                params![rfc3339_millis(now), root.id],
            )
            .unwrap();
        assert!(worker_replacement_ready(&database, &first_id).unwrap());
        let second_root = replace_coordinator(
            &mut database,
            &task.id,
            &TaskCoordinatorReplacementBody {
                session_id: first_id.clone(),
                root_profile_id: "alternate-root".into(),
                handoff: None,
                resume: false,
                question_id: None,
            },
            &initial,
            now,
        )
        .unwrap();
        // A retry that also names a question without resuming is the same intent.
        assert_eq!(
            replace_coordinator(
                &mut database,
                &task.id,
                &TaskCoordinatorReplacementBody {
                    session_id: first_id.clone(),
                    root_profile_id: "alternate-root".into(),
                    handoff: None,
                    resume: false,
                    question_id: Some("question-current".into()),
                },
                &initial,
                now,
            )
            .unwrap()
            .id,
            second_root.id
        );
        let second_prompt: String = database
            .connection()
            .query_row(
                "SELECT prompt_text FROM suplex_task_turns WHERE session_id = ?1",
                [second_root.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(second_prompt.contains(
            "Earlier additional directions from the user, in order:\nCheck the failed provider."
        ));
        assert!(second_prompt.contains("The task is active. Reassess these questions"));
        if let Some(source) = &source_oracle {
            assert_eq!(second_prompt, source["secondPrompt"]);
            assert_eq!(sha256_hex(second_prompt.as_bytes()), source["secondHash"]);
        }
        assert_eq!(
            current_worker(&database, &task.id).unwrap().unwrap().id,
            second.id.as_str()
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn lifecycle_events_follow_start_queue_wait_and_prerequisite_release() {
        let filename =
            std::env::temp_dir().join(format!("suplex_events_{}.sqlite", Uuid::new_v4()));
        let logs = crate::platform::system_events::install_for_test();
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('event_company','Events','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('event_project','event_company','Events','/tmp/event-repo','/tmp/event-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let first = PreparedTask {
            id: repository::new_task_id(),
            company_id: "event_company".into(),
            project_id: "event_project".into(),
            title: "First".into(),
            description: "".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-first","baseBranch":"main","baselineSha":"head"}),
            idempotency_key: "event-first".into(),
            request_hash: "event-first-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-first","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![],
        };
        let a = repository::create(&mut database, &first, now)
            .unwrap()
            .task
            .id;
        let second = PreparedTask {
            id: repository::new_task_id(),
            idempotency_key: "event-second".into(),
            request_hash: "event-second-hash".into(),
            start_queued: false,
            depends_on: vec![a.clone()],
            pull_request_dependencies: vec![],
            ..first.clone()
        };
        let b = repository::create(&mut database, &second, now)
            .unwrap()
            .task
            .id;
        repository::start(&mut database, &b, now).unwrap();
        assert_eq!(
            mark_delivered(&mut database, &a, now).unwrap(),
            vec![b.clone()]
        );
        let events = std::fs::read_to_string(logs.join("system.log"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|event| event["taskId"] == a.as_str() || event["taskId"] == b.as_str())
            .map(|mut event| {
                let fields = event.as_object_mut().unwrap();
                for key in [
                    "schemaVersion",
                    "time",
                    "eventId",
                    "bootId",
                    "sequence",
                    "pid",
                    "bootElapsedMs",
                ] {
                    assert!(fields.remove(key).is_some());
                }
                event
            })
            .collect::<Vec<_>>();
        assert_eq!(
            events,
            vec![
                json!({"type":"task_status","taskId":a,"status":"queued"}),
                json!({"type":"task_status","taskId":a,"status":"active","previousStatus":"queued"}),
                json!({"type":"task_admitted","taskId":a,"trigger":"scheduler sweep"}),
                json!({"type":"task_status","taskId":b,"status":"backlog"}),
                json!({"type":"task_status","taskId":b,"status":"queued","previousStatus":"backlog"}),
                json!({"type":"queue_wait","taskId":b,"waits":[{"id":a,"reason":"prerequisite_running"}]}),
                json!({"type":"task_status","taskId":a,"status":"delivered","previousStatus":"active"}),
                json!({"type":"task_status","taskId":b,"status":"active","previousStatus":"queued"}),
                json!({"type":"task_admitted","taskId":b,"trigger":"prerequisite completion","prerequisiteTaskId":a}),
            ]
        );
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    /// The typed rows keep the JSON of the json_object projection they replaced.
    #[test]
    fn typed_rows_serialize_like_the_persisted_json_projection() {
        let filename = std::env::temp_dir().join(format!("suplex_rows_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('rows_company','Rows','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('rows_project','rows_company','Rows','/tmp/rows-repo','/tmp/rows-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let profile = serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default","providerInstanceId":null,"instanceHomeDirectory":"/home/rows"});
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "rows_company".into(),
            project_id: "rows_project".into(),
            title: "Rows".into(),
            description: "Keep \"quotes\" and é".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-rows","baseBranch":"main","baselineSha":"head","runProjectTests":false,"visualEvidence":"off"}),
            idempotency_key: "rows-key".into(),
            request_hash: "rows-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "pull_request_draft".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-rows","baseBranch":"main","baselineSha":"head","pullRequestNumber":7})).unwrap(),
            root_profile: serde_json::from_value(profile.clone()).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({"reviewer":profile})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![],
        };
        let task = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task;
        let root = reserve_root(&mut database, &task.id, now).unwrap();
        let worker = launch_standard_worker(
            &mut database,
            &root,
            "Assignment",
            "Worker assignment",
            Some(&serde_json::json!({"kind":"worker","mode":"direct"})),
            now,
        )
        .unwrap();
        replace_worker(
            &mut database,
            &task.id,
            &TaskWorkerReplacementBody {
                session_id: worker.id,
                reason: "Retry".into(),
                handoff: None,
                worker_profile_id: None,
            },
            now,
        )
        .unwrap();
        database.connection().execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1, pull_request_json = ?2, limit_pause_json = '{\"kind\":\"task_limit\"}', workflow_state_json = ?3 WHERE task_id = ?4",
            params![
                r#"{"path":"/tmp/rows","branch":"task-rows","baseSha":"base","headSha":"head","dirty":false}"#,
                r#"{"repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","headSha":"head","state":"open","mergedAt":null}"#,
                r#"{"version":1,"reviews":[{"sessionId":"s","turnId":"t","role":"reviewer","range":{"baseSha":"b","headSha":"h","files":["a"],"commits":["h"],"patchDigest":"d"},"result":{"role":"reviewer","approved":true},"invalidReason":null,"recordedAt":"now"}],"acceptedDelivery":null,"deliveryWait":{"headSha":"h","fingerprint":"f","since":"now","reason":"checks"},"completion":null,"toolOwner":{"token":"x","pid":7,"processStartTime":"start"},"followUp":true}"#,
                task.id,
            ],
        ).unwrap();
        database.connection().execute(
            "UPDATE suplex_task_turns SET dispatch_attempt_json = '{\"serverGeneration\":\"g\",\"claimedAt\":\"now\"}' WHERE session_id = ?1",
            [&root.id],
        ).unwrap();
        let projected = |sql: &str| -> Vec<String> {
            let mut statement = database.connection().prepare(sql).unwrap();
            statement
                .query_map([&task.id], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<String>>>()
                .unwrap()
        };
        let rows = root_observation_rows(&database, &task.id).unwrap();
        assert_eq!(
            vec![serde_json::to_string(&rows.control).unwrap()],
            projected(
                r#"SELECT json_object(
                'taskId',task_id,'objective',objective,'deliveryTarget',delivery_target,
                'deliveryIntent',json(delivery_intent_json),'status',status,'wakeAt',wake_at,
                'humanQuestion',human_question,
                'humanQuestionOptions',json(COALESCE(human_question_options_json,'[]')),
                'humanQuestionId',human_question_id,'recoveryTurnId',recovery_turn_id,
                'limitPause',json(limit_pause_json),'worktree',json(worktree_json),
                'pullRequest',json(pull_request_json),'rootSessionId',root_session_id,
                'workerSessionId',worker_session_id,'shellPaneId',shell_pane_id,
                'rootProfile',json(root_profile_json),'workerProfile',json(worker_profile_json),
                'workflow',workflow,'advisorProfiles',json(advisor_profiles_json),
                'workflowState',json(workflow_state_json))
                FROM suplex_task_controls WHERE task_id = ?1"#
            )
        );
        let sessions = projected(
            r#"SELECT json_object(
            'profile',json(profile_json),
            'replacement',CASE WHEN replaces_session_id IS NULL THEN NULL ELSE json_object(
                'sessionId',replaces_session_id,'reason',replacement_reason,'handoff',replacement_handoff) END,
            'id',id,'taskId',task_id,'kind',kind,'generation',generation,
            'current',json(CASE is_current WHEN 1 THEN 'true' ELSE 'false' END),
            'paneId',pane_id,'nativeSessionId',native_session_id,'lifecycle',lifecycle,
            'assignmentHash',assignment_hash,'launchOwner',launch_owner,
            'launchOwnerPid',launch_owner_pid,'launchOwnerStartTime',launch_owner_start_time,
            'stopRequestedAt',stop_requested_at,'stoppedAt',stopped_at,
            'advisorRole',advisor_role,'delegateSlot',delegate_slot,
            'workflowInput',json(workflow_input_json))
            FROM suplex_task_sessions WHERE task_id = ?1 ORDER BY created_at,id"#,
        );
        assert_eq!(sessions.len(), 3);
        assert_eq!(
            rows.sessions
                .iter()
                .map(|session| serde_json::to_string(session).unwrap())
                .collect::<Vec<_>>(),
            sessions
        );
        let turns = projected(
            r#"SELECT json_object(
            'id',id,'taskId',task_id,'sessionId',session_id,'generation',generation,
            'assignmentHash',assignment_hash,'promptHash',prompt_hash,'promptText',prompt_text,
            'status',status,'promptedAt',prompted_at,'completedAt',completed_at,
            'resultReceiptId',result_receipt_id,'terminalObservation',terminal_observation,
            'nativeTurnId',native_turn_id,'dispatchAttempt',json(dispatch_attempt_json),
            'workflowInput',json(workflow_input_json))
            FROM suplex_task_turns WHERE task_id = ?1 ORDER BY created_at,id"#,
        );
        assert_eq!(
            rows.turns
                .iter()
                .map(|turn| serde_json::to_string(turn).unwrap())
                .collect::<Vec<_>>(),
            turns
        );
        drop(database);
        let _ = std::fs::remove_file(filename);
    }

    #[test]
    fn human_note_reuses_root_and_resumes_delivered_intent_without_replay() {
        let filename = std::env::temp_dir().join(format!("suplex_note_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('note_company','Notes','active',?1)", [rfc3339_millis(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('note_project','note_company','Notes','/tmp/note-repo','/tmp/note-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [rfc3339_millis(now)]).unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "note_company".into(),
            project_id: "note_project".into(),
            title: "Note task".into(),
            description: "".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-note","baseBranch":"main","baselineSha":"head","runProjectTests":false,"visualEvidence":"off"}),
            idempotency_key: "note-key".into(),
            request_hash: "note-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-note","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![],
        };
        let task = repository::create(&mut database, &prepared, now)
            .unwrap()
            .task;
        let note = send_note(&mut database, &task.id, " \u{feff}First  ", now).unwrap();
        assert_eq!(note.prompt_text, "Human note:\nFirst");
        let (root_id, note_hash): (String, String) = database
            .connection()
            .query_row(
                "SELECT session_id,prompt_hash FROM suplex_task_turns WHERE id = ?1",
                [&note.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            note_hash,
            "a3d575167f0d45878ed9616d0c2a95a2c62b01365bfc7e5be52dc38a33e118d9"
        );
        assert_eq!(pending_turns(&database, &root_id).unwrap().len(), 2);
        database.connection().execute(
            "UPDATE suplex_task_sessions SET native_session_id = 'codex-retained' WHERE id = ?1",
            [&root_id],
        ).unwrap();
        drop(database);
        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        assert_eq!(pending_turns(&database, &root_id).unwrap().len(), 2);
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'delivered',workflow_state_json = json_set(workflow_state_json,'$.acceptedDelivery',json(?1),'$.completion',json(?2)) WHERE task_id = ?3",
            params![r#"{"baseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","files":["file.txt"],"commits":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]}"#, r#"{"kind":"workflow","reviewedHead":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pullRequestNumber":1597,"observedAt":"2026-09-25T12:00:00.000Z"}"#, task.id],
        ).unwrap();
        database.connection().execute("UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'stopped',stop_requested_at = ?1,stopped_at = ?1 WHERE id = ?2", params![rfc3339_millis(now), root_id]).unwrap();
        let resumed = send_note(&mut database, &task.id, " Follow up ", now).unwrap();
        assert_eq!(resumed.session_id, root_id);
        assert_eq!(
            resumed.prompt_text,
            "{\"question\":\"The user has resumed this delivered task. Handle the follow-up below before completing delivery again. Preserve existing work and inspect current GitHub state. Earlier delivery is history, not completion of this request. For failing checks, read the logs, reproduce and repair the failure, verify locally, push, and observe checks on the current head. Keep the delivery target unchanged. Request delivery explicitly only when the follow-up is satisfied.\",\"answer\":\"Follow up\"}"
        );
        let resumed_hash: String = database
            .connection()
            .query_row(
                "SELECT prompt_hash FROM suplex_task_turns WHERE id = ?1",
                [&resumed.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            resumed_hash,
            "6b9a237b2658b9659363286f8a54845684e413b60d9e3decf4d3006beb066b8b"
        );
        let rows = root_observation_rows(&database, &task.id).unwrap();
        assert_eq!(
            rows.control.status,
            crate::tasks::control::TaskStatus::Active
        );
        assert_eq!(
            serde_json::json!(rows.control.workflow_state)["followUp"],
            true
        );
        assert_eq!(
            serde_json::json!(rows.control.workflow_state)["deliveryHistory"][0]["acceptedDelivery"]
                ["headSha"],
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert_eq!(rows.root.as_ref().unwrap().id, root_id);
        assert_eq!(
            rows.root.as_ref().unwrap().native_session_id.as_deref(),
            Some("codex-retained")
        );
        assert_eq!(pending_turns(&database, &root_id).unwrap().len(), 3);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn committed_claim_survives_reopen_and_budget_pause_never_dispatches() {
        let filename =
            std::env::temp_dir().join(format!("suplex_task_store_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let message_id = new_turn_id(now).unwrap();
        assert_eq!(message_id.len(), 30);
        assert!(message_id.starts_with("msg_0d86fca"));
        assert!(
            message_id[16..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric())
        );
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_task_test', 'Task test', 'active', ?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('project_task_test', 'company_task_test', 'Task project', '/tmp/suplex-task-project', '/tmp/suplex-task-worktrees', NULL, 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', ?1, ?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "company_task_test".into(),
            project_id: "project_task_test".into(),
            title: "One task".into(),
            description: "Run Codex".into(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-one","baseBranch":"main","baselineSha":"head"}),
            idempotency_key: "task-key".into(),
            request_hash: "same-request".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task-one","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(serde_json::json!({"profileId":"profile_native_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            worker_profile: serde_json::from_value(serde_json::json!({"profileId":"profile_native_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"})).unwrap(),
            advisor_profiles: serde_json::from_value(serde_json::json!({})).unwrap(),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
            pull_request_dependencies: vec![],
        };
        let created = repository::create(&mut database, &prepared, now).unwrap();
        assert!(created.created);
        assert_eq!(created.task.status, TaskStatus::Active);
        let repeated = repository::create(&mut database, &prepared, now).unwrap();
        assert!(!repeated.created);
        assert_eq!(created.task.id, repeated.task.id);
        let blocked_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Dependent task".into(),
            idempotency_key: "dependent-key".into(),
            request_hash: "dependent-request".into(),
            depends_on: vec![created.task.id.clone()],
            pull_request_dependencies: vec![],
            ..prepared.clone()
        };
        let blocked = repository::create(&mut database, &blocked_input, now).unwrap();
        assert_eq!(blocked.task.status, TaskStatus::Queued);
        let backlog_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Manual task".into(),
            idempotency_key: "manual-key".into(),
            request_hash: "manual-request".into(),
            start_queued: false,
            ..prepared.clone()
        };
        let backlog = repository::create(&mut database, &backlog_input, now).unwrap();
        assert_eq!(backlog.task.status, TaskStatus::Backlog);
        assert_eq!(
            repository::start(&mut database, &backlog.task.id, now)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Active
        );
        let pull_request_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Pull request task".into(),
            idempotency_key: "pull-request-key".into(),
            request_hash: "pull-request-request".into(),
            configuration: serde_json::json!({"repository":"owner/repo","source":{"kind":"pull_request","number":42}}),
            delivery_intent: serde_json::from_value(serde_json::json!({"repository":"owner/repo","headBranch":"task","baseBranch":"main","baselineSha":"head","pullRequestNumber":42})).unwrap(),
            start_queued: false,
            ..prepared.clone()
        };
        let pull_request = repository::create(&mut database, &pull_request_input, now).unwrap();
        assert!(pull_request.created);
        let conflicting_pull_request = PreparedTask {
            id: repository::new_task_id(),
            idempotency_key: "another-pull-request-key".into(),
            request_hash: "another-pull-request-request".into(),
            ..pull_request_input
        };
        assert!(repository::create(&mut database, &conflicting_pull_request, now).is_err());
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'delivered' WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        assert_eq!(
            repository::start(&mut database, &blocked.task.id, now)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Active
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        let root = reserve_root(&mut database, &created.task.id, now).unwrap();
        assert!(Uuid::parse_str(&root.id).is_ok());
        let observed = root_observation_rows(&database, &created.task.id).unwrap();
        assert_eq!(
            observed.control.status,
            crate::tasks::control::TaskStatus::Active
        );
        assert_eq!(serde_json::json!(observed.control)["workflow"], "standard");
        assert_eq!(observed.context["configuration"]["branch"], "task-one");
        assert_eq!(observed.root.as_ref().unwrap().id, root.id);
        assert!(observed.worker.is_none());
        assert!(observed.workers.is_empty());
        assert!(observed.turns.is_empty());
        assert_current_root(&database, &created.task.id, &root.id, root.generation).unwrap();
        assert!(
            assert_current_root(&database, &created.task.id, &root.id, root.generation + 1)
                .is_err()
        );
        let tool_token = claim_tool_owner(&mut database, &created.task.id, now)
            .unwrap()
            .unwrap();
        assert!(
            claim_tool_owner(&mut database, &created.task.id, now)
                .unwrap()
                .is_none()
        );
        assert_tool_owner(&database, &created.task.id, &tool_token).unwrap();
        release_tool_owner(&mut database, &created.task.id, "wrong-token").unwrap();
        assert_tool_owner(&database, &created.task.id, &tool_token).unwrap();
        release_tool_owner(&mut database, &created.task.id, &tool_token).unwrap();
        assert!(assert_tool_owner(&database, &created.task.id, &tool_token).is_err());
        let worker = launch_standard_worker(
            &mut database,
            &root,
            "Implement",
            "Worker assignment: Implement",
            None,
            now,
        )
        .unwrap();
        assert_eq!(worker.kind, crate::tasks::control::SessionKind::Worker);
        assert!(
            root_observation_rows(&database, &created.task.id)
                .unwrap()
                .turns[0]
                .id
                .starts_with("msg_")
        );
        assert!(
            launch_standard_worker(
                &mut database,
                &root,
                "Duplicate",
                "Worker assignment: Duplicate",
                None,
                now,
            )
            .is_err()
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_turns SET status = 'completed' WHERE session_id = ?1",
                [worker.id.as_str()],
            )
            .unwrap();
        let next_worker = launch_standard_worker(
            &mut database,
            &root,
            "Verify",
            "Worker assignment: Verify",
            None,
            now,
        )
        .unwrap();
        assert_eq!(next_worker.id, worker.id);
        assert_eq!(next_worker.generation, 2);
        let turn = ensure_initial_prompt(&mut database, &root, "Begin", now)
            .unwrap()
            .unwrap();
        assert!(turn.id.starts_with("msg_"));
        assert!(
            claim_session_operation(&mut database, &root, "owner-one", 123, "process-start", now)
                .unwrap()
        );
        let session_directory = filename.with_extension("session");
        std::fs::create_dir_all(&session_directory).unwrap();
        let args = vec!["-c".to_owned(), "sleep 1; cat >/dev/null".to_owned()];
        let environment = HashMap::new();
        let dispatch_input = || DispatchInput {
            directory: &session_directory,
            worktree: session_directory.parent().unwrap(),
            session_id: &root.id,
            turn_id: &turn.id,
            executable: Path::new("/bin/sh"),
            args: &args,
            prompt: "Begin",
            environment: &environment,
        };
        let native = headless::dispatch(dispatch_input(), |generation| {
            claim_prompt(
                &mut database,
                &turn,
                "owner-one",
                generation,
                TaskLimitUsage {
                    estimated_cost_usd: None,
                },
                now,
            )
        })
        .unwrap();
        assert!(
            headless::dispatch(dispatch_input(), |generation| {
                claim_prompt(
                    &mut database,
                    &turn,
                    "owner-one",
                    generation,
                    TaskLimitUsage {
                        estimated_cost_usd: None,
                    },
                    now,
                )
            })
            .is_err()
        );
        drop(database);

        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        let recovered = headless::read_record(&session_directory.join("turn.json"))
            .unwrap()
            .unwrap();
        assert_eq!(recovered.generation, native.generation);
        assert_eq!(recovered.turn_id, turn.id);
        let exit_file = headless::turn_file(&session_directory, &turn.id, "exit");
        for _ in 0..30 {
            if exit_file.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert_eq!(std::fs::read_to_string(&exit_file).unwrap().trim(), "0");
        let pending = pending_turns(&database, &root.id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].status, TurnStatus::Unknown);
        assert_eq!(
            pending[0]
                .dispatch_attempt
                .as_ref()
                .unwrap()
                .server_generation,
            native.generation
        );
        assert!(mark_prompted(&mut database, &pending[0], Some("native-turn"), now).unwrap());
        let second_id = Uuid::new_v4().to_string();
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'hash', 'Continue', 'pending_prompt', ?5, ?5)",
            params![second_id, created.task.id, root.id, root.generation, rfc3339_millis(now)],
        ).unwrap();
        let second = pending_turns(&database, &root.id)
            .unwrap()
            .into_iter()
            .find(|turn| turn.id == second_id)
            .unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'backlog' WHERE task_id = ?1",
                [&backlog.task.id],
            )
            .unwrap();
        database.connection().execute(
            "INSERT INTO suplex_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?1, ?2, ?3)",
            params![created.task.id, backlog.task.id, rfc3339_millis(now)],
        ).unwrap();
        assert!(
            !claim_prompt(
                &mut database,
                &second,
                "owner-one",
                "dependency-regressed",
                TaskLimitUsage {
                    estimated_cost_usd: None
                },
                now,
            )
            .unwrap()
        );
        let still_active: String = database
            .connection()
            .query_row(
                "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                [&created.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_active, "active");
        database.connection().execute(
            "DELETE FROM suplex_task_dependencies WHERE task_id = ?1 AND depends_on_task_id = ?2",
            params![created.task.id, backlog.task.id],
        ).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET budget_usd = 1 WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        assert!(
            !claim_prompt(
                &mut database,
                &second,
                "owner-one",
                "runtime-generation-three",
                TaskLimitUsage {
                    estimated_cost_usd: Some(1.0)
                },
                now
            )
            .unwrap()
        );
        let status: String = database
            .connection()
            .query_row(
                "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
                [&created.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "waiting_human");
        let attempt: Option<String> = database
            .connection()
            .query_row(
                "SELECT dispatch_attempt_json FROM suplex_task_turns WHERE id = ?1",
                [&second_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(attempt.is_none());
        database
            .connection()
            .execute(
                "UPDATE suplex_task_controls SET status = 'active', human_question = NULL, human_question_id = NULL, limit_pause_json = NULL WHERE task_id = ?1",
                [&created.task.id],
            )
            .unwrap();
        let result = StandardWorkerResult {
            task_id: &created.task.id,
            session_id: worker.id.as_str(),
            generation: next_worker.generation,
            receipt_id: "native:worker:completed",
            observation: "{\"state\":\"completed\"}",
            native_turn_id: Some("native-turn"),
            wake_prompt: "Review the Worker result",
            review: None,
        };
        let wake = record_standard_worker_result_and_wake(&mut database, &result, now)
            .unwrap()
            .unwrap();
        assert_eq!(wake.prompt_text, "Review the Worker result");
        assert!(
            record_standard_worker_result_and_wake(&mut database, &result, now)
                .unwrap()
                .is_none()
        );
        assert!(
            complete_root_turn(
                &mut database,
                &turn.id,
                "{\"state\":\"completed\"}",
                Some("Continue from native state"),
                now
            )
            .unwrap()
        );
        assert!(!complete_root_turn(&mut database, &turn.id, "{}", None, now).unwrap());
        assert!(
            pending_turns(&database, &root.id)
                .unwrap()
                .iter()
                .any(|candidate| candidate.prompt_text == "Continue from native state")
        );
        let waiting_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Release after local delivery".into(),
            idempotency_key: "delivery-dependent-key".into(),
            request_hash: "delivery-dependent-request".into(),
            depends_on: vec![created.task.id.clone()],
            pull_request_dependencies: vec![],
            ..prepared.clone()
        };
        let waiting = repository::create(&mut database, &waiting_input, now).unwrap();
        assert_eq!(waiting.task.status, TaskStatus::Queued);
        set_worktree(
            &mut database,
            &created.task.id,
            &serde_json::from_value(serde_json::json!({
                "path":"/tmp/task-one","branch":"task-one","baseSha":"base",
                "headSha":"head","dirty":true,
            }))
            .unwrap(),
            now,
        )
        .unwrap();
        assert_eq!(
            mark_delivered(&mut database, &created.task.id, now).unwrap(),
            vec![waiting.task.id.clone()]
        );
        assert_eq!(
            repository::task_by_id(&database, &waiting.task.id)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Active
        );
        // As in TypeScript, the released dependent is woken by its committed
        // wake_at; the host's scheduled scan admits it without a notification.
        let due: bool = database
            .connection()
            .query_row(
                "SELECT wake_at <= ?1 FROM suplex_task_controls WHERE task_id = ?2",
                params![rfc3339_millis(now), waiting.task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(due);
        assert!(
            mark_delivered(&mut database, &created.task.id, now)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            root_observation_rows(&database, &created.task.id)
                .unwrap()
                .control
                .status,
            crate::tasks::control::TaskStatus::Delivered
        );
        let answer_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Human answer".into(),
            idempotency_key: "answer-key".into(),
            request_hash: "answer-request".into(),
            ..prepared.clone()
        };
        let answer_task = repository::create(&mut database, &answer_input, now)
            .unwrap()
            .task;
        let answer_root = reserve_root(&mut database, &answer_task.id, now).unwrap();
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Use main?', human_question_id = 'question-normal' WHERE task_id = ?1",
            [&answer_task.id],
        ).unwrap();
        assert!(
            answer_human(
                &mut database,
                &answer_task.id,
                "stale",
                "Proceed",
                false,
                now
            )
            .is_err()
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET lifecycle = 'cancelled' WHERE id = ?1",
                [&answer_root.id],
            )
            .unwrap();
        assert!(
            answer_human(
                &mut database,
                &answer_task.id,
                "question-normal",
                "Proceed",
                false,
                now
            )
            .is_err()
        );
        database
            .connection()
            .execute(
                "UPDATE suplex_task_sessions SET lifecycle = 'reserved' WHERE id = ?1",
                [&answer_root.id],
            )
            .unwrap();
        answer_human(
            &mut database,
            &answer_task.id,
            "question-normal",
            "  Proceed 🌍  ",
            false,
            now,
        )
        .unwrap();
        let first_answer: (String, String) = database.connection().query_row(
            "SELECT prompt_text,prompt_hash FROM suplex_task_turns WHERE task_id = ?1 ORDER BY rowid DESC LIMIT 1",
            [&answer_task.id], |row| Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(
            first_answer.0,
            "{\"question\":\"Use main?\",\"answer\":\"Proceed 🌍\"}"
        );
        assert_eq!(
            first_answer.1,
            "348686453066142f49a913b2c8803025cc80ee4fbabcc7dd4914317df08b3181"
        );
        assert!(
            answer_human(
                &mut database,
                &answer_task.id,
                "question-normal",
                "Again",
                false,
                now
            )
            .is_err()
        );
        let interrupted = launch_standard_worker(
            &mut database,
            &answer_root,
            "Implement",
            "Worker assignment: Implement",
            None,
            now,
        )
        .unwrap();
        let worker_turn_id: String = database.connection().query_row(
            "SELECT id FROM suplex_task_turns WHERE session_id = ?1 ORDER BY rowid DESC LIMIT 1",
            [interrupted.id.as_str()], |row| row.get(0),
        ).unwrap();
        database
            .connection()
            .execute(
                "UPDATE suplex_task_turns SET status = 'prompted' WHERE id = ?1",
                [&worker_turn_id],
            )
            .unwrap();
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Commands interrupted?', human_question_id = 'question-worker', recovery_turn_id = ?1 WHERE task_id = ?2",
            params![worker_turn_id, answer_task.id],
        ).unwrap();
        assert!(
            answer_human(
                &mut database,
                &answer_task.id,
                "question-worker",
                "I stopped commands.",
                false,
                now
            )
            .is_err()
        );
        answer_human(
            &mut database,
            &answer_task.id,
            "question-worker",
            "I stopped commands.",
            true,
            now,
        )
        .unwrap();
        let recovered: (String, String, String) = database.connection().query_row(
            "SELECT status,result_receipt_id,terminal_observation FROM suplex_task_turns WHERE id = ?1",
            [&worker_turn_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(recovered.0, "completed");
        assert_eq!(recovered.1, "cleanup:question-worker");
        assert_eq!(
            recovered.2,
            format!(
                "{{\"state\":\"interrupted\",\"reason\":\"operator_confirmed_commands_stopped\",\"questionId\":\"question-worker\",\"answer\":\"I stopped commands.\",\"turnId\":\"{worker_turn_id}\"}}"
            )
        );
        let answer_turns = pending_turns(&database, &answer_root.id).unwrap();
        assert!(answer_turns.iter().any(|turn| {
            turn.prompt_text
                .starts_with("Worker result receipt cleanup:question-worker.")
        }));
        let last_answer: (String, String) = database.connection().query_row(
            "SELECT prompt_text,prompt_hash FROM suplex_task_turns WHERE task_id = ?1 ORDER BY rowid DESC LIMIT 1",
            [&answer_task.id], |row| Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(
            last_answer.0,
            "{\"question\":\"Commands interrupted?\",\"answer\":\"I stopped commands.\"}"
        );
        assert_eq!(
            last_answer.1,
            "02c119667a01036370d700c8a8600a2e588b12556bb4c5b27eece15ad330a9b3"
        );
        assert_eq!(
            repository::task_by_id(&database, &answer_task.id)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Active
        );
        let pause = serde_json::json!({
            "kind":"task_limit", "reason":"budget",
            "limits":{"budgetUsd":15,"maxTurns":40},
            "usage":{"estimatedCostUsd":15,"admittedTurns":3},
            "proposedLimits":{"budgetUsd":25,"maxTurns":40}
        });
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Limit?', human_question_id = 'limit-add', limit_pause_json = ?1 WHERE task_id = ?2",
            params![pause.to_string(), answer_task.id],
        ).unwrap();
        answer_task_limit(
            &mut database,
            &answer_task.id,
            "limit-add",
            &TaskLimitDecision::AddAllowance,
            now,
        )
        .unwrap();
        let added: (String, String, f64, i64) = database.connection().query_row(
            "SELECT t.prompt_text,t.prompt_hash,c.budget_usd,c.max_turns FROM suplex_task_turns t JOIN suplex_task_controls c ON c.task_id = t.task_id WHERE t.task_id = ?1 ORDER BY t.rowid DESC LIMIT 1",
            [&answer_task.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        assert_eq!(
            added.0,
            "{\"question\":\"Limit?\",\"decision\":{\"kind\":\"add_allowance\"}}"
        );
        assert_eq!(
            added.1,
            "d683387a6c26a52e950010d766bcd7195c6b8324c699b32a20993b71ffef84ff"
        );
        assert_eq!((added.2, added.3), (25.0, 40));
        assert!(
            answer_task_limit(
                &mut database,
                &answer_task.id,
                "limit-add",
                &TaskLimitDecision::AddAllowance,
                now
            )
            .is_err()
        );
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Limit again?', human_question_id = 'limit-change', limit_pause_json = ?1 WHERE task_id = ?2",
            params![pause.to_string(), answer_task.id],
        ).unwrap();
        answer_task_limit(
            &mut database,
            &answer_task.id,
            "limit-change",
            &TaskLimitDecision::ChangeLimits {
                limits: crate::tasks::control::TaskLimits {
                    budget_usd: 30.0,
                    max_turns: 60,
                },
            },
            now,
        )
        .unwrap();
        let changed: (String, String, f64, i64) = database.connection().query_row(
            "SELECT t.prompt_text,t.prompt_hash,c.budget_usd,c.max_turns FROM suplex_task_turns t JOIN suplex_task_controls c ON c.task_id = t.task_id WHERE t.task_id = ?1 ORDER BY t.rowid DESC LIMIT 1",
            [&answer_task.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        assert_eq!(
            changed.0,
            "{\"question\":\"Limit again?\",\"decision\":{\"kind\":\"change_limits\",\"limits\":{\"budgetUsd\":30,\"maxTurns\":60}}}"
        );
        assert_eq!(
            changed.1,
            "01bccddaaae04b2b221a6ae690313c8054b2d22cddfd8bbcca7ef3a6ac5a5578"
        );
        assert_eq!((changed.2, changed.3), (30.0, 60));
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = 'Cancel?', human_question_id = 'limit-cancel', limit_pause_json = ?1 WHERE task_id = ?2",
            params![pause.to_string(), answer_task.id],
        ).unwrap();
        answer_task_limit(
            &mut database,
            &answer_task.id,
            "limit-cancel",
            &TaskLimitDecision::CancelTask,
            now,
        )
        .unwrap();
        assert_eq!(
            repository::task_by_id(&database, &answer_task.id)
                .unwrap()
                .unwrap()
                .status,
            TaskStatus::Cancelled
        );
        let outstanding: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status IN ('pending_prompt','prompted','unknown')",
            [&answer_task.id], |row| row.get(0),
        ).unwrap();
        assert_eq!(outstanding, 0);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
        let _ = std::fs::remove_dir_all(&session_directory);
    }
}

pub(crate) use super::persistence::new_turn_id;
pub use super::persistence::{
    RootObservationRows, TaskArtifact, cancel_open_turns, insert_pending_turn,
    root_observation_rows, task_artifact, task_control,
};
use super::persistence::{session, turn};
pub use super::replacement::{replace_coordinator, replace_worker, worker_replacement_ready};
use super::root_prompts::without_current_dependency_status;
pub use super::root_prompts::{IDLE_ROOT_PROMPT, with_current_dependency_status};
pub use crate::tasks::limits::{TaskLimitUsage, answer_task_limit, reconcile_task_limit_pause};
