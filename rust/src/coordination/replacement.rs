//! Durable Coordinator and Worker replacement.
use super::persistence::new_turn_id;
use super::root_session_store::*;
use crate::{
    coordination::CoordinationError,
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::{hash::sha256_hex, js_json, time::rfc3339_millis},
    tasks::control::*,
};
use crate::{
    coordination::{advisor_bridge::AdvisorRole, root_prompts::without_current_dependency_status},
    profiles::agent_profiles::{allowed_profile, read_profile},
    projects::ProjectProviderPolicy,
};
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
/// Replace one current Worker without reusing its native session or replaying
/// its pending turn. The retired session stays durable until the host observes
/// its native owner stopped; the new session waits for that observation.
pub fn replace_worker(
    database: &mut SuplexDatabase,
    task_id: &str,
    request: &TaskWorkerReplacementBody,
    now: DateTime<Utc>,
) -> DatabaseResult<SessionRow> {
    let time = rfc3339_millis(now);
    database.transaction(true, |database| {
        let task: Option<(TaskStatus, Option<String>, String, String)> = database.connection().query_row(
            "SELECT c.status,t.archived_at,t.configuration_json,c.worker_profile_json FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        let Some((status, archived_at, configuration_json, control_profile)) = task else {
            return Err(CoordinationError::refused("Only active or paused tasks can replace a Worker.").into());
        };
        if archived_at.is_some() || !matches!(status, TaskStatus::Active | TaskStatus::WaitingHuman) {
            return Err(CoordinationError::refused("Only active or paused tasks can replace a Worker.").into());
        }
        let previous: Option<(i64, Option<String>, Option<String>)> = database.connection().query_row(
            "SELECT is_current,profile_json,replacement_handoff FROM suplex_task_sessions WHERE task_id = ?1 AND id = ?2 AND kind = 'worker' AND advisor_role IS NULL",
            params![task_id, request.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((is_current, previous_profile_json, previous_handoff)) = previous else {
            return Err(CoordinationError::refused("The Worker does not belong to this task.").into());
        };
        let existing: Option<String> = database.connection().query_row(
            "SELECT id FROM suplex_task_sessions WHERE replaces_session_id = ?1",
            [&request.session_id], |row| row.get(0),
        ).optional()?;
        if let Some(existing) = existing {
            return root_observation_rows(database, task_id)?.sessions.into_iter()
                .find(|session| session.id == existing)
                .ok_or_else(|| CoordinationError::refused("replacement_session_missing").into());
        }
        if is_current != 1 {
            return Err(CoordinationError::refused("The Worker changed. Read the current Worker before replacing it.").into());
        }
        let assignment: Option<(String, Option<String>, Option<String>)> = database.connection().query_row(
            "SELECT prompt_text,workflow_input_json,terminal_observation FROM suplex_task_turns WHERE session_id = ?1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [&request.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((assignment_prompt, workflow_input, _)) = assignment else {
            return Err(CoordinationError::refused("The Worker has no saved assignment.").into());
        };
        let previous_profile_json = previous_profile_json.unwrap_or(control_profile);
        let previous_profile: TaskProfile = serde_json::from_str(&previous_profile_json)?;
        let profile = match request.worker_profile_id.as_deref() {
            Some(id) => read_profile(database, id, "worker")?
                .ok_or_else(|| CoordinationError::refused("The selected Worker profile does not exist."))?,
            None => previous_profile.clone(),
        };
        let configuration: Value = serde_json::from_str(&configuration_json)?;
        let policy: Option<ProjectProviderPolicy> = serde_json::from_value(configuration["providerPolicy"].clone())?;
        if !allowed_profile(policy.as_ref(), &profile) {
            return Err(CoordinationError::refused("Select an agent with a provider and login allowed by this project").into());
        }
        let latest_result: Option<String> = database.connection().query_row(
            "SELECT terminal_observation FROM suplex_task_turns WHERE session_id = ?1 AND terminal_observation IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1",
            [&request.session_id], |row| row.get(0),
        ).optional()?;
        let result = latest_result.as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| value["text"].as_str().map(ToOwned::to_owned))
            .unwrap_or_else(|| if latest_result.is_some() { String::new() } else { "No completed Worker result exists.".into() });
        let result_units = result.encode_utf16().collect::<Vec<_>>();
        let excerpt = String::from_utf16_lossy(&result_units[result_units.len().saturating_sub(12_000)..]);
        let handoff = [
            format!("Reason for replacement: {}", request.reason),
            request.handoff.as_ref().filter(|text| !text.is_empty()).map(|text| format!("Additional direction:\n{text}")).unwrap_or_default(),
            format!("Latest Worker result (verify its claims against source and command evidence):\n{excerpt}"),
            "Inspect the preserved worktree, branch, and current Git status. Preserve existing commits and uncommitted work. Finish the remaining assignment and its checks. Report exact verification and the resulting commit. Use a different approach if the previous attempts did not advance the assignment.".into(),
        ].into_iter().filter(|text| !text.is_empty()).collect::<Vec<_>>().join("\n\n");
        let previous_suffix = previous_handoff.map(|text| format!("\n\nFresh Worker handoff:\n{text}"));
        let saved_assignment = previous_suffix.as_deref()
            .and_then(|suffix| assignment_prompt.strip_suffix(suffix))
            .unwrap_or(&assignment_prompt);
        let prompt = format!("{saved_assignment}\n\nFresh Worker handoff:\n{handoff}");
        let hash = sha256_hex(prompt.as_bytes());
        let generation: i64 = database.connection().query_row(
            "SELECT COALESCE(MAX(generation),0)+1 FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker'",
            [task_id], |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        database.connection().execute(
            "UPDATE suplex_task_sessions SET profile_json = ?1 WHERE task_id = ?2 AND kind = 'worker' AND advisor_role IS NULL AND profile_json IS NULL",
            params![previous_profile_json, task_id],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'cancelled',stopped_at = NULL,stop_requested_at = ?1,profile_json = COALESCE(profile_json,?2),updated_at = ?1 WHERE id = ?3",
            params![time, previous_profile_json, request.session_id],
        )?;
        cancel_open_turns(database, task_id, Some(&request.session_id), &time)?;
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,assignment_hash,delegate_slot,workflow_input_json,profile_json,replaces_session_id,replacement_reason,replacement_handoff,created_at,updated_at) VALUES (?1,?2,'worker',?3,1,'reserved',?4,'delegate',?5,?6,?7,?8,?9,?10,?10)",
            params![id, task_id, generation, hash, workflow_input, serde_json::to_string(&profile)?, request.session_id, request.reason, handoff, time],
        )?;
        insert_pending_turn(database, &new_turn_id(now)?, task_id, &id, generation, Some(&hash), &prompt, workflow_input.as_deref(), &time)?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET worker_session_id = ?1,worker_profile_json = ?2,wake_at = NULL,updated_at = ?3 WHERE task_id = ?4",
            params![id, serde_json::to_string(&profile)?, time, task_id],
        )?;
        root_observation_rows(database, task_id)?.worker
            .ok_or_else(|| CoordinationError::refused("replacement_session_missing").into())
    })
}

pub fn worker_replacement_ready(
    database: &SuplexDatabase,
    session_id: &str,
) -> DatabaseResult<bool> {
    // Root recovery uses the same ancestor predicate for Coordinator replacement.
    let outstanding: bool = database.connection().query_row(
        "WITH RECURSIVE ancestors(id) AS (SELECT replaces_session_id FROM suplex_task_sessions WHERE id = ?1 UNION ALL SELECT s.replaces_session_id FROM suplex_task_sessions s JOIN ancestors a ON s.id = a.id) SELECT EXISTS(SELECT 1 FROM suplex_task_sessions s JOIN ancestors a ON s.id = a.id WHERE s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL)",
        [session_id], |row| row.get(0),
    )?;
    Ok(!outstanding)
}

fn js_suffix(text: &str, size: usize) -> String {
    let units = text.encode_utf16().collect::<Vec<_>>();
    String::from_utf16_lossy(&units[units.len().saturating_sub(size)..])
}

fn outcome_text_owned(observation: &str) -> String {
    serde_json::from_str::<Value>(observation)
        .ok()
        .and_then(|value| {
            value
                .get("text")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| observation.to_owned())
}

/// TypeScript `replacementIntent`: the selection a Coordinator successor saves.
/// Older intents may omit the question fields.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplacementIntent {
    root_profile_id: String,
    handoff: String,
    resume: bool,
    #[serde(default)]
    question_id: Option<String>,
    #[serde(default)]
    pending_question: Option<PendingQuestion>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PendingQuestion {
    id: String,
    text: String,
    options: Value,
}

struct CoordinatorControlRow {
    status: TaskStatus,
    archived_at: Option<String>,
    configuration_json: String,
    current_root_id: Option<String>,
    question_id: Option<String>,
    question: Option<String>,
    question_options: Option<String>,
    limit_pause: Option<String>,
    recovery_turn: Option<String>,
    control_profile: String,
    worktree: Option<String>,
    pull_request: Option<String>,
    workflow_state: String,
}

/// Keep the Root's saved handoff and accepted human history while fencing its
/// native session. A successor is admitted only after the host stops the old
/// session; its existing delegates remain current.
pub fn replace_coordinator(
    database: &mut SuplexDatabase,
    task_id: &str,
    request: &TaskCoordinatorReplacementBody,
    initial_prompt: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<SessionRow> {
    let time = rfc3339_millis(now);
    database.transaction(true, |database| {
        let task: Option<CoordinatorControlRow> = database.connection().query_row(
            "SELECT c.status,t.archived_at,t.configuration_json,c.root_session_id,c.human_question_id,c.human_question,c.human_question_options_json,c.limit_pause_json,c.recovery_turn_id,c.root_profile_json,c.worktree_json,c.pull_request_json,c.workflow_state_json FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?1",
            [task_id],
            |row| Ok(CoordinatorControlRow {
                status:row.get(0)?,archived_at:row.get(1)?,configuration_json:row.get(2)?,current_root_id:row.get(3)?,
                question_id:row.get(4)?,question:row.get(5)?,question_options:row.get(6)?,limit_pause:row.get(7)?,
                recovery_turn:row.get(8)?,control_profile:row.get(9)?,worktree:row.get(10)?,pull_request:row.get(11)?,workflow_state:row.get(12)?,
            }),
        ).optional()?;
        let Some(CoordinatorControlRow {status,archived_at,configuration_json,current_root_id,question_id,question,question_options,limit_pause,recovery_turn,control_profile,worktree,pull_request,workflow_state}) = task else {
            return Err(CoordinationError::refused("Only active or paused tasks can select a Coordinator.").into());
        };
        if archived_at.is_some() || !matches!(status, TaskStatus::Active | TaskStatus::WaitingHuman) {
            return Err(CoordinationError::refused("Only active or paused tasks can select a Coordinator.").into());
        }
        let previous: Option<(i64, Option<String>)> = database.connection().query_row(
            "SELECT is_current,profile_json FROM suplex_task_sessions WHERE task_id = ?1 AND id = ?2 AND kind = 'root' AND advisor_role IS NULL",
            params![task_id, request.session_id], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        let Some((is_current, old_profile_json)) = previous else {
            return Err(CoordinationError::refused("The Coordinator does not belong to this task.").into());
        };
        let handoff = request.handoff.as_deref().unwrap_or("");
        // The saved intent keeps a question only when it resumes the task.
        let question_intent = if request.resume { request.question_id.as_deref() } else { None };
        let existing: Option<(String,String)> = database.connection().query_row(
            "SELECT id,replacement_reason FROM suplex_task_sessions WHERE replaces_session_id = ?1 AND kind = 'root'",
            [&request.session_id], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        if let Some((id, reason)) = existing {
            let saved = serde_json::from_str::<ReplacementIntent>(&reason).ok();
            if saved.is_none_or(|saved| saved.root_profile_id != request.root_profile_id || saved.handoff != handoff
                || saved.resume != request.resume || saved.question_id.as_deref() != question_intent)
                || current_root_id.as_deref() != Some(id.as_str()) {
                return Err(CoordinationError::refused("The Coordinator changed. Read the current Coordinator before selecting another.").into());
            }
            return root_observation_rows(database, task_id)?.sessions.into_iter()
                .find(|session| session.id == id)
                .ok_or_else(|| CoordinationError::refused("replacement_session_missing").into());
        }
        if is_current != 1 || current_root_id.as_deref() != Some(request.session_id.as_str()) {
            return Err(CoordinationError::refused("The Coordinator changed. Read the current Coordinator before selecting another.").into());
        }
        if request.resume {
            if status != TaskStatus::WaitingHuman || question_id != request.question_id {
                return Err(CoordinationError::refused("The current question changed. Read it before resuming.").into());
            }
            if limit_pause.is_some() || recovery_turn.is_some() {
                return Err(CoordinationError::refused("Answer the current task decision before resuming.").into());
            }
        }
        let profile = read_profile(database, &request.root_profile_id, "root")?
            .ok_or_else(|| CoordinationError::refused("The selected Coordinator profile does not exist."))?;
        let configuration: Value = serde_json::from_str(&configuration_json)?;
        let policy: Option<ProjectProviderPolicy> = serde_json::from_value(configuration["providerPolicy"].clone())?;
        if !allowed_profile(policy.as_ref(), &profile) {
            return Err(CoordinationError::refused("Select an agent with a provider and login allowed by this project").into());
        }
        let rows = root_observation_rows(database, task_id)?;
        let old_profile_json = old_profile_json.unwrap_or(control_profile);
        let old_profile: TaskProfile = serde_json::from_str(&old_profile_json)?;
        let advisor_profiles = &rows.control.advisor_profiles;
        let mut advisor_updates = Vec::new();
        {
            let mut statement = database.connection().prepare("SELECT id,advisor_role FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND advisor_role IS NOT NULL AND profile_json IS NULL")?;
            for row in statement.query_map([task_id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?)))? {
                advisor_updates.push(row?);
            }
        }
        for (id, role) in advisor_updates {
            let advisor = AdvisorRole::parse(&role).and_then(|role| advisor_profiles.get(&role)).unwrap_or(&old_profile);
            database.connection().execute("UPDATE suplex_task_sessions SET profile_json = ?1 WHERE id = ?2 AND profile_json IS NULL", params![serde_json::to_string(advisor)?,id])?;
        }
        let mut root_turns = Vec::new();
        {
            let mut statement = database.connection().prepare("SELECT t.id,t.prompt_text,t.terminal_observation,t.created_at,s.generation FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.task_id = ?1 AND s.kind = 'root' ORDER BY t.rowid")?;
            for row in statement.query_map([task_id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, Option<String>>(2)?,row.get::<_, String>(3)?,row.get::<_, i64>(4)?)))? {
                root_turns.push(row?);
            }
        }
        let mut prior_intents = Vec::new();
        {
            let mut statement = database.connection().prepare("SELECT replacement_reason,generation FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND replaces_session_id IS NOT NULL ORDER BY generation")?;
            for row in statement.query_map([task_id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, i64>(1)?)))? {
                let (reason,generation) = row?;
                if let Ok(intent) = serde_json::from_str::<ReplacementIntent>(&reason) {
                    prior_intents.push((intent,generation));
                }
            }
        }
        let mut accepted = Vec::new();
        let mut messages = Vec::new();
        for (_,prompt,_,created_at,generation) in &root_turns {
            let prompt = without_current_dependency_status(prompt);
            if let Some(note) = prompt.strip_prefix("Human note:\n") {
                messages.push(format!("Human note ({created_at}):\n{note}"));
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(prompt) else { continue };
            if let (Some(question),Some(answer)) = (value["question"].as_str(),value["answer"].as_str()) {
                accepted.push((question.to_owned(),*generation));
                messages.push(format!("Accepted human answer ({created_at}):\n{question}\nAnswer: {answer}"));
            } else if let Some(question) = value["question"].as_str()
                && let Some(decision) = value.get("decision") {
                messages.push(format!("Accepted human task limit decision ({created_at}):\n{question}\nDecision: {}",js_json::stringify(decision)));
            }
        }
        let earlier_directions = prior_intents.iter().map(|(intent,_)| intent.handoff.as_str()).filter(|text| !text.is_empty()).collect::<Vec<_>>().join("\n\n");
        let mut unanswered = Vec::<PendingQuestion>::new();
        for (intent,generation) in &prior_intents {
            if let Some(pending) = &intent.pending_question
                && !accepted.iter().any(|(answer,at)| *answer == pending.text && at >= generation) && !unanswered.iter().any(|prior| prior.id == pending.id) {
                unanswered.push(pending.clone());
            }
        }
        let current_question = question.map(|text| -> DatabaseResult<_> {
            Ok(PendingQuestion { id: question_id.clone().unwrap_or_default(), text, options: serde_json::from_str::<Value>(question_options.as_deref().unwrap_or("[]"))? })
        }).transpose()?;
        if let Some(current) = &current_question
            && !unanswered.iter().any(|prior| prior.id == current.id) {
            unanswered.push(current.clone());
        }
        let reason = js_json::stringify(&serde_json::to_value(ReplacementIntent {
            root_profile_id: request.root_profile_id.clone(),
            handoff: handoff.to_owned(),
            resume: request.resume,
            question_id: question_intent.map(str::to_owned),
            pending_question: current_question,
        })?);
        let pending_question = if unanswered.is_empty() { String::new() } else {
            let items = unanswered.iter().map(|pending| format!("Question {}:\n{}\nOptions: {}",pending.id,pending.text,js_json::stringify(&pending.options))).collect::<Vec<_>>().join("\n\n");
            let guidance = if request.resume { "The user authorized resuming with a new Coordinator. Resolve a provider failure if possible; ask the user if a real decision is still necessary." }
                else if status == TaskStatus::WaitingHuman { "The task stays paused until the user answers its current decision." }
                else { "The task is active. Reassess these questions and ask the user if a decision is still necessary." };
            format!("Questions without an accepted answer:\n{items}\nThese questions have NOT been answered. {guidance}")
        };
        let delegates = rows.sessions.iter().filter(|session| session.kind == SessionKind::Worker && session.current).map(|session| {
            let id = &session.id;
            // TypeScript `ORDER BY created_at DESC, id DESC LIMIT 1`; the rows are in that order ascending.
            let latest = rows.turns.iter().rfind(|turn| turn.session_id == *id);
            let assignment = latest.map_or("", |turn| turn.prompt_text.as_str());
            let result = latest.and_then(|turn| turn.terminal_observation.as_deref());
            format!("Session {id}, {}, {}. Latest assignment/turn {} ({}):\n{}\nLatest result: {}",
                session.advisor_role.map_or("Worker", AdvisorRole::as_str),session.lifecycle,
                latest.map_or("none", |turn| turn.id.as_str()),latest.map_or("none", |turn| turn.status.as_str()),
                js_suffix(assignment,5000),result.map(|raw| js_suffix(&outcome_text_owned(raw),4000)).unwrap_or_else(|| "pending".into()))
        }).collect::<Vec<_>>().join("\n\n");
        let outcomes = root_turns.iter().filter_map(|(id,_,observation,_,_)| observation.as_deref().map(|raw| format!("Coordinator turn {id}: {}",js_suffix(&outcome_text_owned(raw),3000)))).rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n\n");
        let handoff_text = [
            "Fresh Coordinator handoff. Continue this task from current authoritative Git, GitHub, native session, and task state. Do not replay an admitted old turn. Continue existing delegates and do not repeat completed assignments.".into(),
            format!("Current task state: {status}. Worktree: {}. Pull request: {}. Workflow state: {}.",worktree.as_deref().unwrap_or("none"),pull_request.as_deref().unwrap_or("none"),workflow_state),
            pending_question,
            format!("Previously accepted human answers and notes, in order:\n{}",if messages.is_empty() { "None recorded.".into() } else { messages.join("\n\n") }),
            format!("Earlier additional directions from the user, in order:\n{}",if earlier_directions.is_empty() { "None recorded.".into() } else { earlier_directions }),
            format!("Current delegate assignments and results:\n{}",if delegates.is_empty() { "No current delegates.".into() } else { delegates }),
            format!("Recent Coordinator outcomes:\n{}",if outcomes.is_empty() { "None recorded.".into() } else { outcomes }),
            if handoff.is_empty() { String::new() } else { format!("Additional direction from the user:\n{handoff}") },
        ].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n");
        let prompt = format!("{initial_prompt}\n\n{handoff_text}");
        let generation: i64 = database.connection().query_row("SELECT COALESCE(MAX(generation),0)+1 FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root'",[task_id],|row| row.get(0))?;
        let id = Uuid::new_v4().to_string();
        database.connection().execute("UPDATE suplex_task_sessions SET profile_json = ?1 WHERE task_id = ?2 AND kind = 'root' AND advisor_role IS NULL AND profile_json IS NULL",params![old_profile_json,task_id])?;
        database.connection().execute("UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'cancelled',stop_requested_at = ?1,stopped_at = NULL,updated_at = ?1 WHERE id = ?2",params![time,request.session_id])?;
        cancel_open_turns(database, task_id, Some(&request.session_id), &time)?;
        database.connection().execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,profile_json,replaces_session_id,replacement_reason,replacement_handoff,created_at,updated_at) VALUES (?1,?2,'root',?3,1,'reserved',?4,?5,?6,?7,?8,?8)",params![id,task_id,generation,serde_json::to_string(&profile)?,request.session_id,reason,handoff_text,time])?;
        insert_pending_turn(database, &new_turn_id(now)?, task_id, &id, generation, None, &prompt, None, &time)?;
        database.connection().execute("UPDATE suplex_task_controls SET root_session_id = ?1,root_profile_json = ?2,status = CASE WHEN ?3 THEN 'active' ELSE status END,status_changed_at = CASE WHEN ?3 THEN ?4 ELSE status_changed_at END,human_question = CASE WHEN ?3 THEN NULL ELSE human_question END,human_question_id = CASE WHEN ?3 THEN NULL ELSE human_question_id END,human_question_options_json = CASE WHEN ?3 THEN '[]' ELSE human_question_options_json END,wake_at = CASE WHEN status = 'active' OR ?3 THEN ?4 ELSE wake_at END,updated_at = ?4 WHERE task_id = ?5",params![id,serde_json::to_string(&profile)?,request.resume,time,task_id])?;
        root_observation_rows(database, task_id)?.root.ok_or_else(|| CoordinationError::refused("replacement_session_missing").into())
    })
}
