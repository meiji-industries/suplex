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
    coordination::{
        advisor_bridge::AdvisorRole,
        root_prompts::{self, PendingQuestion, without_current_dependency_status},
    },
    profiles::agent_profiles::{allowed_profile, read_profile},
    projects::ProjectProviderPolicy,
};
use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

fn refuse<T>(message: &str) -> DatabaseResult<T> {
    Err(CoordinationError::refused(message).into())
}

/// Refuse a replacement profile that the project's provider policy does not allow.
fn require_allowed_profile(configuration_json: &str, profile: &TaskProfile) -> DatabaseResult<()> {
    let configuration: Value = serde_json::from_str(configuration_json)?;
    let policy: Option<ProjectProviderPolicy> =
        serde_json::from_value(configuration["providerPolicy"].clone())?;
    if !allowed_profile(policy.as_ref(), profile) {
        return refuse("Select an agent with a provider and login allowed by this project");
    }
    Ok(())
}

/// The session an earlier replacement created, returned on an idempotent retry.
fn replacement_session(
    database: &SuplexDatabase,
    task_id: &str,
    id: &str,
) -> DatabaseResult<SessionRow> {
    root_observation_rows(database, task_id)?
        .sessions
        .into_iter()
        .find(|session| session.id == id)
        .ok_or_else(|| CoordinationError::refused("replacement_session_missing").into())
}

fn is_open(status: TaskStatus, archived_at: &Option<String>) -> bool {
    archived_at.is_none() && matches!(status, TaskStatus::Active | TaskStatus::WaitingHuman)
}

struct WorkerControlRow {
    status: TaskStatus,
    archived_at: Option<String>,
    configuration_json: String,
    control_profile: String,
}

struct PreviousWorker {
    is_current: i64,
    profile_json: Option<String>,
    handoff: Option<String>,
}

fn worker_control(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<WorkerControlRow> {
    let task = database.connection().query_row(
        "SELECT c.status,t.archived_at,t.configuration_json,c.worker_profile_json FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?1",
        [task_id],
        |row| Ok(WorkerControlRow { status: row.get(0)?, archived_at: row.get(1)?, configuration_json: row.get(2)?, control_profile: row.get(3)? }),
    ).optional()?;
    match task {
        Some(task) if is_open(task.status, &task.archived_at) => Ok(task),
        _ => refuse("Only active or paused tasks can replace a Worker."),
    }
}

fn previous_worker(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: &str,
) -> DatabaseResult<PreviousWorker> {
    let previous = database.connection().query_row(
        "SELECT is_current,profile_json,replacement_handoff FROM suplex_task_sessions WHERE task_id = ?1 AND id = ?2 AND kind = 'worker' AND advisor_role IS NULL",
        params![task_id, session_id],
        |row| Ok(PreviousWorker { is_current: row.get(0)?, profile_json: row.get(1)?, handoff: row.get(2)? }),
    ).optional()?;
    previous.map_or_else(|| refuse("The Worker does not belong to this task."), Ok)
}

/// The Worker's latest saved assignment prompt and workflow input.
fn worker_assignment(
    database: &SuplexDatabase,
    session_id: &str,
) -> DatabaseResult<(String, Option<String>)> {
    let assignment = database.connection().query_row(
        "SELECT prompt_text,workflow_input_json FROM suplex_task_turns WHERE session_id = ?1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    assignment.map_or_else(|| refuse("The Worker has no saved assignment."), Ok)
}

fn latest_worker_result(
    database: &SuplexDatabase,
    session_id: &str,
) -> DatabaseResult<Option<String>> {
    Ok(database.connection().query_row(
        "SELECT terminal_observation FROM suplex_task_turns WHERE session_id = ?1 AND terminal_observation IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1",
        [session_id], |row| row.get(0),
    ).optional()?)
}

/// The selected Worker profile, or the retired Worker's own profile.
fn worker_profile(
    database: &SuplexDatabase,
    request: &TaskWorkerReplacementBody,
    previous_profile_json: &str,
    configuration_json: &str,
) -> DatabaseResult<TaskProfile> {
    let previous_profile: TaskProfile = serde_json::from_str(previous_profile_json)?;
    let profile = match request.worker_profile_id.as_deref() {
        Some(id) => read_profile(database, id, "worker")?.ok_or_else(|| {
            CoordinationError::refused("The selected Worker profile does not exist.")
        })?,
        None => previous_profile,
    };
    require_allowed_profile(configuration_json, &profile)?;
    Ok(profile)
}

/// Pin the retired profile on earlier Workers, fence the retired session, and
/// cancel its open turns.
fn retire_worker(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: &str,
    previous_profile_json: &str,
    time: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "UPDATE suplex_task_sessions SET profile_json = ?1 WHERE task_id = ?2 AND kind = 'worker' AND advisor_role IS NULL AND profile_json IS NULL",
        params![previous_profile_json, task_id],
    )?;
    database.connection().execute(
        "UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'cancelled',stopped_at = NULL,stop_requested_at = ?1,profile_json = COALESCE(profile_json,?2),updated_at = ?1 WHERE id = ?3",
        params![time, previous_profile_json, session_id],
    )?;
    cancel_open_turns(database, task_id, Some(session_id), time)
}

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
        let task = worker_control(database, task_id)?;
        let previous = previous_worker(database, task_id, &request.session_id)?;
        let existing: Option<String> = database.connection().query_row(
            "SELECT id FROM suplex_task_sessions WHERE replaces_session_id = ?1",
            [&request.session_id], |row| row.get(0),
        ).optional()?;
        if let Some(existing) = existing {
            return replacement_session(database, task_id, &existing);
        }
        if previous.is_current != 1 {
            return refuse("The Worker changed. Read the current Worker before replacing it.");
        }
        let (assignment_prompt, workflow_input) = worker_assignment(database, &request.session_id)?;
        let previous_profile_json = previous.profile_json.unwrap_or(task.control_profile);
        let profile = worker_profile(database, request, &previous_profile_json, &task.configuration_json)?;
        let latest_result = latest_worker_result(database, &request.session_id)?;
        let (handoff, prompt) = root_prompts::worker_replacement_prompt(&request.reason, request.handoff.as_ref(), latest_result.as_deref(), previous.handoff.as_deref(), &assignment_prompt);
        let hash = sha256_hex(prompt.as_bytes());
        let generation = next_generation(database, task_id, "worker")?;
        let id = Uuid::new_v4().to_string();
        let profile_json = serde_json::to_string(&profile)?;
        retire_worker(database, task_id, &request.session_id, &previous_profile_json, &time)?;
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,assignment_hash,delegate_slot,workflow_input_json,profile_json,replaces_session_id,replacement_reason,replacement_handoff,created_at,updated_at) VALUES (?1,?2,'worker',?3,1,'reserved',?4,'delegate',?5,?6,?7,?8,?9,?10,?10)",
            params![id, task_id, generation, hash, workflow_input, profile_json, request.session_id, request.reason, handoff, time],
        )?;
        insert_pending_turn(database, &NewTurn { id: &new_turn_id(now)?, task_id, session_id: &id, generation, assignment_hash: Some(&hash), prompt: &prompt, workflow_input: workflow_input.as_deref() }, &time)?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET worker_session_id = ?1,worker_profile_json = ?2,wake_at = NULL,updated_at = ?3 WHERE task_id = ?4",
            params![id, profile_json, time, task_id],
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

impl CoordinatorControlRow {
    fn read(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Self> {
        let task = database.connection().query_row(
            "SELECT c.status,t.archived_at,t.configuration_json,c.root_session_id,c.human_question_id,c.human_question,c.human_question_options_json,c.limit_pause_json,c.recovery_turn_id,c.root_profile_json,c.worktree_json,c.pull_request_json,c.workflow_state_json FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?1",
            [task_id],
            |row| Ok(Self {
                status:row.get(0)?,archived_at:row.get(1)?,configuration_json:row.get(2)?,current_root_id:row.get(3)?,
                question_id:row.get(4)?,question:row.get(5)?,question_options:row.get(6)?,limit_pause:row.get(7)?,
                recovery_turn:row.get(8)?,control_profile:row.get(9)?,worktree:row.get(10)?,pull_request:row.get(11)?,workflow_state:row.get(12)?,
            }),
        ).optional()?;
        match task {
            Some(task) if is_open(task.status, &task.archived_at) => Ok(task),
            _ => refuse("Only active or paused tasks can select a Coordinator."),
        }
    }

    /// The question the task shows now, saved with the successor's intent.
    fn current_question(&self) -> DatabaseResult<Option<PendingQuestion>> {
        let Some(text) = self.question.clone() else {
            return Ok(None);
        };
        let options =
            serde_json::from_str::<Value>(self.question_options.as_deref().unwrap_or("[]"))?;
        Ok(Some(PendingQuestion {
            id: self.question_id.clone().unwrap_or_default(),
            text,
            options,
        }))
    }

    /// The replaced session is still the current Root. A resume answers the
    /// current question, so the question must still be current and no other
    /// task decision may be outstanding.
    fn check_replaceable(
        &self,
        request: &TaskCoordinatorReplacementBody,
        is_current: bool,
    ) -> DatabaseResult<()> {
        if !is_current || self.current_root_id.as_deref() != Some(request.session_id.as_str()) {
            return refuse(COORDINATOR_CHANGED);
        }
        if !request.resume {
            return Ok(());
        }
        if self.status != TaskStatus::WaitingHuman || self.question_id != request.question_id {
            return refuse("The current question changed. Read it before resuming.");
        }
        if self.limit_pause.is_some() || self.recovery_turn.is_some() {
            return refuse("Answer the current task decision before resuming.");
        }
        Ok(())
    }
}

const COORDINATOR_CHANGED: &str =
    "The Coordinator changed. Read the current Coordinator before selecting another.";

/// An earlier replacement of this Coordinator is an idempotent retry only when
/// it saved the same normalized intent and is still the current Root.
fn retried_coordinator(
    database: &SuplexDatabase,
    task_id: &str,
    control: &CoordinatorControlRow,
    intent: &ReplacementIntent,
    replaced_session_id: &str,
) -> DatabaseResult<Option<SessionRow>> {
    let existing: Option<(String, String)> = database.connection().query_row(
        "SELECT id,replacement_reason FROM suplex_task_sessions WHERE replaces_session_id = ?1 AND kind = 'root'",
        [replaced_session_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((id, reason)) = existing else {
        return Ok(None);
    };
    let same_intent = serde_json::from_str::<ReplacementIntent>(&reason).is_ok_and(|saved| {
        saved.root_profile_id == intent.root_profile_id
            && saved.handoff == intent.handoff
            && saved.resume == intent.resume
            && saved.question_id == intent.question_id
    });
    if !same_intent || control.current_root_id.as_deref() != Some(id.as_str()) {
        return refuse(COORDINATOR_CHANGED);
    }
    replacement_session(database, task_id, &id).map(Some)
}

fn previous_coordinator(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: &str,
) -> DatabaseResult<(i64, Option<String>)> {
    let previous = database.connection().query_row(
        "SELECT is_current,profile_json FROM suplex_task_sessions WHERE task_id = ?1 AND id = ?2 AND kind = 'root' AND advisor_role IS NULL",
        params![task_id, session_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    previous.map_or_else(
        || refuse("The Coordinator does not belong to this task."),
        Ok,
    )
}

fn coordinator_profile(
    database: &SuplexDatabase,
    request: &TaskCoordinatorReplacementBody,
    configuration_json: &str,
) -> DatabaseResult<TaskProfile> {
    let profile = read_profile(database, &request.root_profile_id, "root")?.ok_or_else(|| {
        CoordinationError::refused("The selected Coordinator profile does not exist.")
    })?;
    require_allowed_profile(configuration_json, &profile)?;
    Ok(profile)
}

/// Save the retired Coordinator's profile on every Advisor that still follows
/// the control default, so the successor does not change their provider.
fn pin_advisor_profiles(
    database: &SuplexDatabase,
    task_id: &str,
    control: &TaskControlRow,
    old_profile_json: &str,
) -> DatabaseResult<()> {
    let old_profile: &TaskProfile = &serde_json::from_str(old_profile_json)?;
    let advisors = database.connection()
        .prepare("SELECT id,advisor_role FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND advisor_role IS NOT NULL AND profile_json IS NULL")?
        .query_map([task_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, role) in advisors {
        let advisor = AdvisorRole::parse(&role)
            .and_then(|role| control.advisor_profiles.get(&role))
            .unwrap_or(old_profile);
        database.connection().execute("UPDATE suplex_task_sessions SET profile_json = ?1 WHERE id = ?2 AND profile_json IS NULL", params![serde_json::to_string(advisor)?, id])?;
    }
    Ok(())
}

struct RootTurn {
    id: String,
    prompt: String,
    observation: Option<String>,
    created_at: String,
    generation: i64,
}

fn root_turns(database: &SuplexDatabase, task_id: &str) -> DatabaseResult<Vec<RootTurn>> {
    Ok(database.connection()
        .prepare("SELECT t.id,t.prompt_text,t.terminal_observation,t.created_at,s.generation FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.task_id = ?1 AND s.kind = 'root' ORDER BY t.rowid")?
        .query_map([task_id], |row| Ok(RootTurn { id: row.get(0)?, prompt: row.get(1)?, observation: row.get(2)?, created_at: row.get(3)?, generation: row.get(4)? }))?
        .collect::<Result<Vec<_>, _>>()?)
}

/// Intents of earlier Coordinator replacements with their generation. Rows
/// whose reason is not a saved intent are skipped.
fn prior_intents(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Vec<(ReplacementIntent, i64)>> {
    let rows = database.connection()
        .prepare("SELECT replacement_reason,generation FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND replaces_session_id IS NOT NULL ORDER BY generation")?
        .query_map([task_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(reason, generation)| {
            serde_json::from_str::<ReplacementIntent>(&reason)
                .ok()
                .map(|intent| (intent, generation))
        })
        .collect())
}

/// Human notes and accepted answers from the Root turns, in order, plus each
/// accepted question with the generation that accepted it.
fn accepted_history(turns: &[RootTurn]) -> (Vec<(String, i64)>, Vec<String>) {
    let mut accepted = Vec::new();
    let mut messages = Vec::new();
    for turn in turns {
        let created_at = &turn.created_at;
        let prompt = without_current_dependency_status(&turn.prompt);
        if let Some(note) = prompt.strip_prefix("Human note:\n") {
            messages.push(format!("Human note ({created_at}):\n{note}"));
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(prompt) else {
            continue;
        };
        let Some(question) = value["question"].as_str() else {
            continue;
        };
        if let Some(answer) = value["answer"].as_str() {
            accepted.push((question.to_owned(), turn.generation));
            messages.push(format!(
                "Accepted human answer ({created_at}):\n{question}\nAnswer: {answer}"
            ));
        } else if let Some(decision) = value.get("decision") {
            messages.push(format!(
                "Accepted human task limit decision ({created_at}):\n{question}\nDecision: {}",
                js_json::stringify(decision)
            ));
        }
    }
    (accepted, messages)
}

/// Questions that earlier Coordinators left pending and no later answer
/// accepted, then the current question, each once.
fn unanswered_questions(
    prior_intents: &[(ReplacementIntent, i64)],
    accepted: &[(String, i64)],
    current: Option<&PendingQuestion>,
) -> Vec<PendingQuestion> {
    let mut unanswered = Vec::<PendingQuestion>::new();
    let candidates = prior_intents
        .iter()
        .filter_map(|(intent, generation)| {
            intent.pending_question.as_ref().filter(|pending| {
                !accepted
                    .iter()
                    .any(|(answer, at)| *answer == pending.text && at >= generation)
            })
        })
        .chain(current);
    for pending in candidates {
        if !unanswered.iter().any(|prior| prior.id == pending.id) {
            unanswered.push(pending.clone());
        }
    }
    unanswered
}

/// The last four Coordinator turn outcomes, oldest first.
fn recent_outcomes(turns: &[RootTurn]) -> String {
    let outcomes = turns
        .iter()
        .filter_map(|turn| {
            turn.observation.as_deref().map(|raw| {
                format!(
                    "Coordinator turn {}: {}",
                    turn.id,
                    root_prompts::replacement_outcome(raw)
                )
            })
        })
        .collect::<Vec<_>>();
    outcomes[outcomes.len().saturating_sub(4)..].join("\n\n")
}

/// The successor's handoff text and first prompt: task state, unanswered
/// questions, accepted human history, delegates, and recent outcomes.
fn coordinator_handoff(
    database: &SuplexDatabase,
    task_id: &str,
    control: &CoordinatorControlRow,
    rows: &RootObservationRows,
    intent: &ReplacementIntent,
    initial_prompt: &str,
) -> DatabaseResult<(String, String)> {
    let turns = root_turns(database, task_id)?;
    let prior = prior_intents(database, task_id)?;
    let (accepted, messages) = accepted_history(&turns);
    let earlier_directions = prior
        .iter()
        .map(|(intent, _)| intent.handoff.as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let unanswered = unanswered_questions(&prior, &accepted, intent.pending_question.as_ref());
    Ok(root_prompts::coordinator_replacement_prompt(
        initial_prompt,
        root_prompts::CoordinatorHandoff {
            status: control.status,
            worktree: control.worktree.as_deref(),
            pull_request: control.pull_request.as_deref(),
            workflow_state: &control.workflow_state,
            pending_question: root_prompts::pending_replacement_questions(
                &unanswered,
                intent.resume,
                control.status,
            ),
            messages: &messages,
            earlier_directions,
            delegates: root_prompts::replacement_delegates(rows),
            outcomes: recent_outcomes(&turns),
            handoff: &intent.handoff,
        },
    ))
}

/// Pin the retired profile on earlier Coordinators, fence the retired session,
/// and cancel its open turns.
fn retire_coordinator(
    database: &SuplexDatabase,
    task_id: &str,
    session_id: &str,
    old_profile_json: &str,
    time: &str,
) -> DatabaseResult<()> {
    database.connection().execute("UPDATE suplex_task_sessions SET profile_json = ?1 WHERE task_id = ?2 AND kind = 'root' AND advisor_role IS NULL AND profile_json IS NULL",params![old_profile_json,task_id])?;
    database.connection().execute("UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'cancelled',stop_requested_at = ?1,stopped_at = NULL,updated_at = ?1 WHERE id = ?2",params![time,session_id])?;
    cancel_open_turns(database, task_id, Some(session_id), time)
}

/// The new Coordinator session a replacement installs.
struct Successor {
    id: String,
    generation: i64,
    profile_json: String,
    reason: String,
    handoff: String,
    prompt: String,
}

/// Insert the successor session and its first turn, and make it the current
/// Root. A resume also clears the answered question and wakes the task.
fn install_coordinator(
    database: &SuplexDatabase,
    task_id: &str,
    request: &TaskCoordinatorReplacementBody,
    successor: &Successor,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let time = rfc3339_millis(now);
    let Successor {
        id,
        generation,
        profile_json,
        reason,
        handoff,
        prompt,
    } = successor;
    database.connection().execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,profile_json,replaces_session_id,replacement_reason,replacement_handoff,created_at,updated_at) VALUES (?1,?2,'root',?3,1,'reserved',?4,?5,?6,?7,?8,?8)",params![id,task_id,generation,profile_json,request.session_id,reason,handoff,time])?;
    insert_pending_turn(
        database,
        &NewTurn {
            id: &new_turn_id(now)?,
            task_id,
            session_id: id,
            generation: *generation,
            assignment_hash: None,
            prompt,
            workflow_input: None,
        },
        &time,
    )?;
    database.connection().execute("UPDATE suplex_task_controls SET root_session_id = ?1,root_profile_json = ?2,status = CASE WHEN ?3 THEN 'active' ELSE status END,status_changed_at = CASE WHEN ?3 THEN ?4 ELSE status_changed_at END,human_question = CASE WHEN ?3 THEN NULL ELSE human_question END,human_question_id = CASE WHEN ?3 THEN NULL ELSE human_question_id END,human_question_options_json = CASE WHEN ?3 THEN '[]' ELSE human_question_options_json END,wake_at = CASE WHEN status = 'active' OR ?3 THEN ?4 ELSE wake_at END,updated_at = ?4 WHERE task_id = ?5",params![id,profile_json,request.resume,time,task_id])?;
    Ok(())
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
        let control = CoordinatorControlRow::read(database, task_id)?;
        let (is_current, old_profile_json) =
            previous_coordinator(database, task_id, &request.session_id)?;
        let mut intent = ReplacementIntent {
            root_profile_id: request.root_profile_id.clone(),
            handoff: request.handoff.clone().unwrap_or_default(),
            resume: request.resume,
            // The saved intent keeps a question only when it resumes the task.
            question_id: request.question_id.clone().filter(|_| request.resume),
            pending_question: None,
        };
        if let Some(session) =
            retried_coordinator(database, task_id, &control, &intent, &request.session_id)?
        {
            return Ok(session);
        }
        control.check_replaceable(request, is_current == 1)?;
        let profile = coordinator_profile(database, request, &control.configuration_json)?;
        let rows = root_observation_rows(database, task_id)?;
        let old_profile_json = old_profile_json.unwrap_or_else(|| control.control_profile.clone());
        pin_advisor_profiles(database, task_id, &rows.control, &old_profile_json)?;
        intent.pending_question = control.current_question()?;
        let (handoff_text, prompt) =
            coordinator_handoff(database, task_id, &control, &rows, &intent, initial_prompt)?;
        let successor = Successor {
            id: Uuid::new_v4().to_string(),
            generation: next_generation(database, task_id, "root")?,
            profile_json: serde_json::to_string(&profile)?,
            reason: js_json::stringify(&serde_json::to_value(&intent)?),
            handoff: handoff_text,
            prompt,
        };
        retire_coordinator(
            database,
            task_id,
            &request.session_id,
            &old_profile_json,
            &time,
        )?;
        install_coordinator(database, task_id, request, &successor, now)?;
        root_observation_rows(database, task_id)?
            .root
            .ok_or_else(|| CoordinationError::refused("replacement_session_missing").into())
    })
}
