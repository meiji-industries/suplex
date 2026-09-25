//! Durable Root session and prompt intent. Native runtime evidence stays with the harness.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use uuid::Uuid;

use crate::coordination::root_prompts::{self, STANDARD_WORKER_RESULT_WAKE};
use crate::http::contracts::typed::projects::ProjectProviderPolicy;
use crate::http::contracts::typed::task_answers::TaskLimitDecision;
use crate::http::contracts::typed::tasks::TaskWorkerReplacementBody;
use crate::identity::auth::js_trim;
use crate::platform::database::{DatabaseResult, SuplexDatabase};
use crate::runtimes::process::inspect_process;
use crate::shared::js_json;
use crate::tasks::commands::{allowed_profile, read_profile};
use crate::tasks::repository::{self, PullRequestOwned};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootSession {
    pub id: String,
    pub task_id: String,
    pub generation: i64,
    pub lifecycle: String,
    pub native_session_id: Option<String>,
    pub launch_owner: Option<String>,
    pub launch_owner_pid: Option<i64>,
    pub launch_owner_start_time: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchAttempt {
    pub server_generation: String,
    pub claimed_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootTurn {
    pub id: String,
    pub task_id: String,
    pub session_id: String,
    pub generation: i64,
    pub prompt_text: String,
    pub status: String,
    pub dispatch_attempt: Option<PromptDispatchAttempt>,
    pub native_turn_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TaskLimitUsage {
    pub estimated_cost_usd: Option<f64>,
}

/// Persisted Root inputs. The controller adds live Git and native observations.
pub struct RootObservationRows {
    pub control: Value,
    pub context: Value,
    pub dependencies: Vec<Value>,
    pub root: Option<Value>,
    pub worker: Option<Value>,
    pub workers: Vec<Value>,
    pub sessions: Vec<Value>,
    pub turns: Vec<Value>,
}

pub struct TaskArtifact {
    pub kind: String,
    pub filename: String,
    pub mime_type: String,
    pub company_id: String,
    pub storage_path: String,
    pub sha256: String,
}

pub fn task_artifact(
    database: &SuplexDatabase,
    task_id: &str,
    artifact_id: &str,
) -> DatabaseResult<Option<TaskArtifact>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT a.kind, a.filename, a.mime_type, a.company_id, a.storage_path, a.sha256 FROM suplex_artifacts a JOIN suplex_tasks t ON t.id = a.task_id AND t.company_id = a.company_id WHERE t.id = ?1 AND a.id = ?2",
            params![task_id, artifact_id],
            |row| Ok(TaskArtifact {
                kind: row.get(0)?,
                filename: row.get(1)?,
                mime_type: row.get(2)?,
                company_id: row.get(3)?,
                storage_path: row.get(4)?,
                sha256: row.get(5)?,
            }),
        )
        .optional()?)
}

fn json_rows(database: &SuplexDatabase, sql: &str, task_id: &str) -> DatabaseResult<Vec<Value>> {
    let mut statement = database.connection().prepare(sql)?;
    let rows = statement
        .query_map([task_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|row| serde_json::from_str(&row).map_err(Into::into))
        .collect()
}

pub fn root_observation_rows(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<RootObservationRows> {
    let control = json_rows(
        database,
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
            FROM suplex_task_controls WHERE task_id = ?1"#,
        task_id,
    )?
    .into_iter()
    .next()
    .ok_or("task_control_missing")?;
    let context = json_rows(
        database,
        r#"SELECT json_object(
            'configuration',json(configuration_json),
            'images',json(COALESCE((
                SELECT json_group_array(json_object('artifactId',id,'filename',filename))
                FROM (SELECT id,filename FROM suplex_artifacts
                      WHERE task_id = t.id AND kind IN ('task-image','delivery-image')
                      ORDER BY created_at,id)
            ),'[]')),
            'issueContext',json(issue_context_json))
            FROM suplex_tasks t WHERE id = ?1"#,
        task_id,
    )?
    .into_iter()
    .next()
    .ok_or("task_context_missing")?;
    let dependencies = json_rows(
        database,
        r#"SELECT json_object('id',t.id,'title',t.title,'status',COALESCE(c.status,'backlog'))
            FROM suplex_task_dependencies d JOIN suplex_tasks t ON t.id = d.depends_on_task_id
            LEFT JOIN suplex_task_controls c ON c.task_id = t.id
            WHERE d.task_id = ?1 ORDER BY t.id"#,
        task_id,
    )?;
    let sessions = json_rows(
        database,
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
        task_id,
    )?;
    let turns = json_rows(
        database,
        r#"SELECT json_object(
            'id',id,'taskId',task_id,'sessionId',session_id,'generation',generation,
            'assignmentHash',assignment_hash,'promptHash',prompt_hash,'promptText',prompt_text,
            'status',status,'promptedAt',prompted_at,'completedAt',completed_at,
            'resultReceiptId',result_receipt_id,'terminalObservation',terminal_observation,
            'nativeTurnId',native_turn_id,'dispatchAttempt',json(dispatch_attempt_json),
            'workflowInput',json(workflow_input_json))
            FROM suplex_task_turns WHERE task_id = ?1 ORDER BY created_at,id"#,
        task_id,
    )?;
    let root = sessions
        .iter()
        .find(|session| session["kind"] == "root" && session["current"] == true)
        .cloned();
    let mut workers = sessions
        .iter()
        .filter(|session| session["kind"] == "worker" && session["current"] == true)
        .cloned()
        .collect::<Vec<_>>();
    workers.sort_by_key(|session| match session["delegateSlot"].as_str() {
        Some("planner_a") => 0,
        Some("planner_b") => 1,
        _ => 2,
    });
    let pointed = control["workerSessionId"].as_str();
    let worker = workers
        .iter()
        .find(|session| session["id"].as_str() == pointed)
        .or_else(|| workers.first())
        .cloned();
    Ok(RootObservationRows {
        control,
        context,
        dependencies,
        root,
        worker,
        workers,
        sessions,
        turns,
    })
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

fn suggested_budget(proposed: f64, spent: f64) -> f64 {
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

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_turn_id(now: DateTime<Utc>) -> DatabaseResult<String> {
    const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    static COUNTER: Mutex<(i64, u64)> = Mutex::new((0, 0));
    let millis = now.timestamp_millis();
    let counter = {
        let mut state = COUNTER
            .lock()
            .map_err(|_| std::io::Error::other("turn ID counter poisoned"))?;
        if state.0 != millis {
            *state = (millis, 0);
        }
        state.1 += 1;
        state.1
    };
    let value = (millis as u128) * 0x1000 + u128::from(counter);
    let mut id = String::from("msg_");
    for index in 0..6 {
        let byte = ((value >> (40 - 8 * index)) & 0xff) as u8;
        id.push_str(&format!("{byte:02x}"));
    }
    let mut random = [0u8; 14];
    getrandom::fill(&mut random).map_err(|error| std::io::Error::other(error.to_string()))?;
    for byte in random {
        id.push(BASE62[usize::from(byte % 62)] as char);
    }
    Ok(id)
}

fn session(row: &Row<'_>) -> rusqlite::Result<RootSession> {
    Ok(RootSession {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        generation: row.get("generation")?,
        lifecycle: row.get("lifecycle")?,
        native_session_id: row.get("native_session_id")?,
        launch_owner: row.get("launch_owner")?,
        launch_owner_pid: row.get("launch_owner_pid")?,
        launch_owner_start_time: row.get("launch_owner_start_time")?,
    })
}

fn turn(row: &Row<'_>) -> rusqlite::Result<RootTurn> {
    let raw: Option<String> = row.get("dispatch_attempt_json")?;
    let dispatch_attempt = raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    Ok(RootTurn {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        session_id: row.get("session_id")?,
        generation: row.get("generation")?,
        prompt_text: row.get("prompt_text")?,
        status: row.get("status")?,
        dispatch_attempt,
        native_turn_id: row.get("native_turn_id")?,
    })
}

pub fn current_root(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<RootSession>> {
    Ok(database.connection().query_row(
        "SELECT * FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1",
        [task_id], session,
    ).optional()?)
}

pub fn current_worker(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Option<RootSession>> {
    Ok(database.connection().query_row(
        "SELECT * FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND delegate_slot = 'delegate' AND is_current = 1",
        [task_id], session,
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
            root.id == session_id && root.generation == generation && root.lifecycle != "cancelled"
        })
    {
        return Err(std::io::Error::other("root_identity_mismatch").into());
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
            params![owner.to_string(), timestamp(now), task_id, prior],
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
        return Err(std::io::Error::other("task_tool_owner_lost").into());
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
        return Err(std::io::Error::other("question_is_empty").into());
    }
    let options = serde_json::to_string(options)?;
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'waiting_human', human_question = ?1, human_question_options_json = ?2, human_question_id = ?3, limit_pause_json = NULL, wake_at = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?4 WHERE task_id = ?5 AND status = 'active' AND root_session_id = ?6 AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.id = ?6 AND s.task_id = suplex_task_controls.task_id AND s.kind = 'root' AND s.generation = ?7 AND s.is_current = 1 AND s.lifecycle <> 'cancelled')",
            params![question, options, Uuid::new_v4().to_string(), timestamp(now), task_id, session_id, generation],
        )? == 1)
    })
}

/// Cancel durable task intent and request native cleanup in one transaction.
/// Display metadata is not consulted; the host rediscovers owned processes.
pub fn cancel_task(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        let time = timestamp(now);
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
        database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'cancelled', updated_at = ?1 WHERE task_id = ?2 AND status IN ('pending_prompt','prompted','unknown')",
            params![time, task_id],
        )?;
        Ok(true)
    })
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
        return Err(std::io::Error::other("answer_is_empty").into());
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
            return Err(std::io::Error::other("question_identity_mismatch").into());
        };
        if limit_pause.is_some() {
            return Err(std::io::Error::other("task_limit_decision_required").into());
        }
        let root = database
            .connection()
            .query_row(
                "SELECT * FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root' AND is_current = 1 AND lifecycle <> 'cancelled'",
                [task_id],
                session,
            )
            .optional()?
            .ok_or_else(|| std::io::Error::other("root_notification_unavailable"))?;
        if recovery_turn_id.is_some() && !confirm_commands_stopped {
            return Err(std::io::Error::other("command_cleanup_confirmation_required").into());
        }
        if let Some(recovery_turn_id) = recovery_turn_id {
            let recovered: (String, i64, String) = database.connection().query_row(
                "SELECT t.session_id,t.generation,s.kind FROM suplex_task_turns t JOIN suplex_task_sessions s ON s.id = t.session_id WHERE t.id = ?1 AND t.task_id = ?2",
                params![recovery_turn_id, task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let evidence = js_json::stringify(&serde_json::json!({
                "state":"interrupted", "reason":"operator_confirmed_commands_stopped",
                "questionId":question_id, "answer":answer, "turnId":recovery_turn_id
            }));
            if recovered.2 == "worker" {
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
                    },
                    now,
                )?;
            } else {
                complete_root_turn(database, &recovery_turn_id, &evidence, None, now)?;
            }
        }
        let prompt = js_json::stringify(&serde_json::json!({"question":question,"answer":answer}));
        let id = new_turn_id(now)?;
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        let time = timestamp(now);
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'pending_prompt',?7,?7)",
            params![id, task_id, root.id, root.generation, hash, prompt, time],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'active', human_question = NULL, human_question_id = NULL, recovery_turn_id = NULL, wake_at = ?1, updated_at = ?1 WHERE task_id = ?2",
            params![time, task_id],
        )?;
        Ok(())
    })
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
            return Err(std::io::Error::other("question_identity_mismatch").into());
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
            return Err(std::io::Error::other("invalid_task_limit_pause").into());
        }
        let time = timestamp(now);
        if matches!(decision, TaskLimitDecision::CancelTask) {
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'cancelled', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, workflow_state_json = json_set(workflow_state_json, '$.deliveryWait', json('null')), updated_at = ?1 WHERE task_id = ?2",
                params![time, task_id],
            )?;
            database.connection().execute(
                "UPDATE suplex_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = COALESCE(stop_requested_at, ?1), updated_at = ?1 WHERE task_id = ?2 AND stopped_at IS NULL",
                params![time, task_id],
            )?;
            database.connection().execute(
                "UPDATE suplex_task_turns SET status = 'cancelled', updated_at = ?1 WHERE task_id = ?2 AND status IN ('pending_prompt','prompted','unknown')",
                params![time, task_id],
            )?;
            return Ok(());
        }
        let root_id = root_id.ok_or_else(|| std::io::Error::other("root_notification_unavailable"))?;
        let root = database
            .connection()
            .query_row(
                "SELECT * FROM suplex_task_sessions WHERE id = ?1 AND task_id = ?2 AND kind = 'root' AND is_current = 1 AND lifecycle <> 'cancelled'",
                params![root_id, task_id],
                session,
            )
            .optional()?
            .ok_or_else(|| std::io::Error::other("root_notification_unavailable"))?;
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
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'pending_prompt',?7,?7)",
            params![id, task_id, root.id, root.generation, hash, prompt, time],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET status = 'active', budget_usd = ?1, max_turns = ?2, limit_pause_json = NULL, human_question = NULL, human_question_id = NULL, human_question_options_json = '[]', wake_at = ?3, updated_at = ?3 WHERE task_id = ?4",
            params![limits.budget_usd, limits.max_turns, time, task_id],
        )?;
        Ok(())
    })
}

/// Reserve the next Standard Worker turn atomically with Root identity and
/// serial-delegate checks. Native dispatch is a separate after-commit step.
pub fn launch_standard_worker(
    database: &mut SuplexDatabase,
    root: &RootSession,
    assignment_text: &str,
    prompt_text: &str,
    workflow_input: Option<&Value>,
    now: DateTime<Utc>,
) -> DatabaseResult<Value> {
    let task_id = root.task_id.as_str();
    let root_session_id = root.id.as_str();
    let root_generation = root.generation;
    let assignment_hash = format!("{:x}", Sha256::digest(assignment_text.as_bytes()));
    let prompt_hash = format!("{:x}", Sha256::digest(prompt_text.as_bytes()));
    let workflow_json = workflow_input.map(serde_json::to_string).transpose()?;
    let time = timestamp(now);
    database.transaction(true, |database| {
        assert_current_root(database, task_id, root_session_id, root_generation)?;
        let workflow: String = database.connection().query_row(
            "SELECT workflow FROM suplex_task_controls WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        if workflow != "standard" {
            return Err(std::io::Error::other("standard_worker_requires_standard_workflow").into());
        }
        let active_turn: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_turns t ON t.session_id = s.id AND t.generation = s.generation WHERE s.task_id = ?1 AND s.kind = 'worker' AND s.is_current = 1 AND t.status IN ('pending_prompt','prompted','unknown'))",
            [task_id],
            |row| row.get(0),
        )?;
        if active_turn {
            return Err(std::io::Error::other("worker_already_assigned").into());
        }
        let current: Option<(String, i64, bool, bool)> = database.connection().query_row(
            "SELECT id,generation,stop_requested_at IS NOT NULL AND stopped_at IS NULL,launch_owner IS NOT NULL AND stopped_at IS NULL FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND delegate_slot = 'delegate' AND is_current = 1",
            [task_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional()?;
        if current.as_ref().is_some_and(|(_, _, stopping, launching)| *stopping || *launching) {
            return Err(std::io::Error::other("worker_already_assigned").into());
        }
        let generation: i64 = database.connection().query_row(
            "SELECT COALESCE(MAX(generation),0)+1 FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker'",
            [task_id], |row| row.get(0),
        )?;
        let profile: String = database.connection().query_row(
            "SELECT worker_profile_json FROM suplex_task_controls WHERE task_id = ?1",
            [task_id], |row| row.get(0),
        )?;
        let compatible: Option<(String, bool)> = database.connection().query_row(
            "SELECT id,stop_requested_at IS NOT NULL AND stopped_at IS NULL FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'worker' AND advisor_role IS NULL AND lifecycle <> 'cancelled' AND (profile_json IS NULL OR json(profile_json) = json(?2)) ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1",
            params![task_id, profile],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        if compatible.as_ref().is_some_and(|(_, stopping)| *stopping) {
            return Err(std::io::Error::other("worker_already_assigned").into());
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
                return Err(std::io::Error::other("worker_already_assigned").into());
            }
        } else {
            if let Some((current_id, current_generation, _, _)) = &current {
                database.connection().execute(
                    "UPDATE suplex_task_sessions SET is_current = 0,updated_at = ?1 WHERE id = ?2 AND generation = ?3 AND is_current = 1",
                    params![time, current_id, current_generation],
                )?;
            }
            database.connection().execute(
                "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,assignment_hash,delegate_slot,workflow_input_json,profile_json,created_at,updated_at) VALUES (?1,?2,'worker',?3,1,'reserved',?4,'delegate',?5,?6,?7,?7)",
                params![id, task_id, generation, assignment_hash, workflow_json, profile, time],
            )?;
        }
        database.connection().execute(
            "UPDATE suplex_task_controls SET worker_session_id = ?1,updated_at = ?2 WHERE task_id = ?3 AND status = 'active'",
            params![id, time, task_id],
        )?;
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,assignment_hash,prompt_hash,prompt_text,status,workflow_input_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending_prompt',?8,?9,?9)",
            params![new_turn_id(now)?, task_id, id, generation, assignment_hash, prompt_hash, prompt_text, workflow_json, time],
        )?;
        Ok(())
    })?;
    root_observation_rows(database, task_id)?
        .worker
        .ok_or_else(|| std::io::Error::other("worker_session_missing").into())
}

/// Replace one current Worker without reusing its native session or replaying
/// its pending turn. The retired session stays durable until the host observes
/// its native owner stopped; the new session waits for that observation.
pub fn replace_worker(
    database: &mut SuplexDatabase,
    task_id: &str,
    request: &TaskWorkerReplacementBody,
    now: DateTime<Utc>,
) -> DatabaseResult<Value> {
    let time = timestamp(now);
    database.transaction(true, |database| {
        let task: Option<(String, Option<String>, String, String)> = database.connection().query_row(
            "SELECT c.status,t.archived_at,t.configuration_json,c.worker_profile_json FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        let Some((status, archived_at, configuration_json, control_profile)) = task else {
            return Err(std::io::Error::other("Only active or paused tasks can replace a Worker.").into());
        };
        if archived_at.is_some() || !matches!(status.as_str(), "active" | "waiting_human") {
            return Err(std::io::Error::other("Only active or paused tasks can replace a Worker.").into());
        }
        let previous: Option<(i64, Option<String>, Option<String>)> = database.connection().query_row(
            "SELECT is_current,profile_json,replacement_handoff FROM suplex_task_sessions WHERE task_id = ?1 AND id = ?2 AND kind = 'worker' AND advisor_role IS NULL",
            params![task_id, request.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((is_current, previous_profile_json, previous_handoff)) = previous else {
            return Err(std::io::Error::other("The Worker does not belong to this task.").into());
        };
        let existing: Option<String> = database.connection().query_row(
            "SELECT id FROM suplex_task_sessions WHERE replaces_session_id = ?1",
            [&request.session_id], |row| row.get(0),
        ).optional()?;
        if let Some(existing) = existing {
            return root_observation_rows(database, task_id)?.sessions.into_iter()
                .find(|session| session["id"] == existing)
                .ok_or_else(|| std::io::Error::other("replacement_session_missing").into());
        }
        if is_current != 1 {
            return Err(std::io::Error::other("The Worker changed. Read the current Worker before replacing it.").into());
        }
        let assignment: Option<(String, Option<String>, Option<String>)> = database.connection().query_row(
            "SELECT prompt_text,workflow_input_json,terminal_observation FROM suplex_task_turns WHERE session_id = ?1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [&request.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((assignment_prompt, workflow_input, _)) = assignment else {
            return Err(std::io::Error::other("The Worker has no saved assignment.").into());
        };
        let previous_profile_json = previous_profile_json.unwrap_or(control_profile);
        let previous_profile: Value = serde_json::from_str(&previous_profile_json)?;
        let profile = match request.worker_profile_id.as_deref() {
            Some(id) => read_profile(database, id, "worker")?
                .ok_or_else(|| std::io::Error::other("The selected Worker profile does not exist."))?,
            None => previous_profile.clone(),
        };
        let configuration: Value = serde_json::from_str(&configuration_json)?;
        let policy: Option<ProjectProviderPolicy> = serde_json::from_value(configuration["providerPolicy"].clone())?;
        if !allowed_profile(policy.as_ref(), &profile) {
            return Err(std::io::Error::other("Select an agent with a provider and login allowed by this project").into());
        }
        let (workflow, delivery_target): (String, String) = database.connection().query_row(
            "SELECT workflow,delivery_target FROM suplex_task_controls WHERE task_id = ?1",
            [task_id], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if workflow != "standard" || delivery_target != "local_worktree" || profile["provider"] != "codex" {
            return Err(std::io::Error::other("experimental_not_ported: Only Codex Standard local-worktree Worker replacement is implemented").into());
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
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
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
        database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'cancelled',updated_at = ?1 WHERE session_id = ?2 AND status IN ('pending_prompt','prompted','unknown')",
            params![time, request.session_id],
        )?;
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,assignment_hash,delegate_slot,workflow_input_json,profile_json,replaces_session_id,replacement_reason,replacement_handoff,created_at,updated_at) VALUES (?1,?2,'worker',?3,1,'reserved',?4,'delegate',?5,?6,?7,?8,?9,?10,?10)",
            params![id, task_id, generation, hash, workflow_input, serde_json::to_string(&profile)?, request.session_id, request.reason, handoff, time],
        )?;
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,assignment_hash,prompt_hash,prompt_text,status,workflow_input_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5,?6,'pending_prompt',?7,?8,?8)",
            params![new_turn_id(now)?, task_id, id, generation, hash, prompt, workflow_input, time],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET worker_session_id = ?1,worker_profile_json = ?2,wake_at = NULL,updated_at = ?3 WHERE task_id = ?4",
            params![id, serde_json::to_string(&profile)?, time, task_id],
        )?;
        root_observation_rows(database, task_id)?.worker
            .ok_or_else(|| std::io::Error::other("replacement_session_missing").into())
    })
}

pub fn worker_replacement_ready(
    database: &SuplexDatabase,
    session_id: &str,
) -> DatabaseResult<bool> {
    let outstanding: bool = database.connection().query_row(
        "WITH RECURSIVE ancestors(id) AS (SELECT replaces_session_id FROM suplex_task_sessions WHERE id = ?1 UNION ALL SELECT s.replaces_session_id FROM suplex_task_sessions s JOIN ancestors a ON s.id = a.id) SELECT EXISTS(SELECT 1 FROM suplex_task_sessions s JOIN ancestors a ON s.id = a.id WHERE s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL)",
        [session_id], |row| row.get(0),
    )?;
    Ok(!outstanding)
}

/// Reserve one Root generation for an active task; a repeated admission returns it.
pub fn reserve_root(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<RootSession> {
    database.transaction(true, |database| {
        let active: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_controls WHERE task_id = ?1 AND status = 'active')",
            [task_id], |row| row.get(0),
        )?;
        if !active {
            return Err(std::io::Error::other("task_not_active").into());
        }
        if let Some(existing) = current_root(database, task_id)? {
            return Ok(existing);
        }
        let generation: i64 = database.connection().query_row(
            "SELECT COALESCE(MAX(generation), 0) + 1 FROM suplex_task_sessions WHERE task_id = ?1 AND kind = 'root'",
            [task_id], |row| row.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let time = timestamp(now);
        database.connection().execute(
            "INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, lifecycle, created_at, updated_at) VALUES (?1, ?2, 'root', ?3, 1, 'reserved', ?4, ?4)",
            params![id, task_id, generation, time],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET root_session_id = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![id, time, task_id],
        )?;
        current_root(database, task_id)?.ok_or_else(|| std::io::Error::other("root_session_missing").into())
    })
}

pub fn ensure_initial_prompt(
    database: &mut SuplexDatabase,
    root: &RootSession,
    prompt: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<RootTurn>> {
    database.transaction(true, |database| {
        let existing: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_turns WHERE session_id = ?1)",
            [&root.id], |row| row.get(0),
        )?;
        if existing { return Ok(None); }
        let id = new_turn_id(now)?;
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        let time = timestamp(now);
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending_prompt', ?7, ?7)",
            params![id, root.task_id, root.id, root.generation, hash, prompt, time],
        )?;
        Ok(Some(database.connection().query_row(
            "SELECT * FROM suplex_task_turns WHERE id = ?1", [&id], turn,
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
) -> DatabaseResult<RootTurn> {
    let note = js_trim(note);
    if note.is_empty() || note.encode_utf16().count() > 20_000 {
        return Err(std::io::Error::other("note_invalid").into());
    }
    database.transaction(true, |database| {
        let (status, archived, root_session_id, workflow_state): (String, bool, Option<String>, String) = database.connection().query_row(
            "SELECT c.status,t.archived_at IS NOT NULL,c.root_session_id,c.workflow_state_json FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        if archived || !matches!(status.as_str(), "active" | "delivered") {
            return Err(std::io::Error::other("task_note_unavailable").into());
        }
        let resuming = status == "delivered";
        let time = timestamp(now);
        if resuming {
            repository::assert_task_pull_requests_available(database, task_id)?;
            let mut state: Value = serde_json::from_str(&workflow_state)?;
            let prior_accepted = state.get("acceptedDelivery").cloned().unwrap_or(Value::Null);
            let prior_completion = state.get("completion").cloned().unwrap_or(Value::Null);
            let mut history = state.get("deliveryHistory").and_then(Value::as_array).cloned().unwrap_or_default();
            history.push(serde_json::json!({
                "resumedAt": time,
                "acceptedDelivery": prior_accepted,
                "completion": prior_completion,
            }));
            let fields = state.as_object_mut().ok_or("workflow_state_invalid")?;
            fields.insert("acceptedDelivery".into(), Value::Null);
            fields.insert("completion".into(), Value::Null);
            fields.insert("deliveryWait".into(), Value::Null);
            fields.insert("followUp".into(), Value::Bool(true));
            fields.insert("deliveryHistory".into(), Value::Array(history));
            database.connection().execute(
                "UPDATE suplex_task_controls SET workflow_state_json = ?1,status = 'active',wake_at = ?2,updated_at = ?2 WHERE task_id = ?3 AND status = 'delivered'",
                params![js_json::stringify(&state), time, task_id],
            )?;
            if let Some(root_session_id) = root_session_id {
                database.connection().execute(
                    "UPDATE suplex_task_sessions SET is_current = 1,lifecycle = 'reserved',stop_requested_at = NULL,stopped_at = NULL,updated_at = ?1 WHERE id = ?2 AND kind = 'root'",
                    params![time, root_session_id],
                )?;
            }
        }
        let existing = current_root(database, task_id)?;
        let root = match existing {
            Some(root) => root,
            None => {
                let root = reserve_root(database, task_id, now)?;
                let rows = root_observation_rows(database, task_id)?;
                let initial = root_prompts::initial_coordinator_prompt(&rows.control, &rows.context, &[])
                    .map_err(std::io::Error::other)?;
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
            format!("Human note:\n{note}")
        };
        let id = new_turn_id(now)?;
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'pending_prompt',?7,?7)",
            params![id, task_id, root.id, root.generation, hash, prompt, time],
        )?;
        database.connection().query_row("SELECT * FROM suplex_task_turns WHERE id = ?1", [&id], turn).map_err(Into::into)
    })
}

pub fn pending_turns(database: &SuplexDatabase, session_id: &str) -> DatabaseResult<Vec<RootTurn>> {
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
    root: &RootSession,
    owner: &str,
    owner_pid: i64,
    owner_start_time: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_sessions SET launch_owner = ?1, launch_owner_pid = ?2, launch_owner_start_time = ?3, launch_claimed_at = ?4, updated_at = ?4 WHERE id = ?5 AND generation = ?6 AND is_current = 1 AND lifecycle <> 'cancelled' AND launch_owner IS ?7",
            params![owner, owner_pid, owner_start_time, timestamp(now), root.id, root.generation, root.launch_owner],
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
            params![timestamp(now), session_id, owner],
        )?;
        Ok(())
    })
}

pub fn bind_native_session(
    database: &mut SuplexDatabase,
    root: &RootSession,
    native_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_sessions SET native_session_id = ?1, lifecycle = 'live', updated_at = ?2 WHERE id = ?3 AND generation = ?4 AND is_current = 1 AND lifecycle <> 'cancelled' AND (native_session_id IS NULL OR native_session_id = ?1)",
            params![native_id, timestamp(now), root.id, root.generation],
        )? == 1)
    })
}

/// This CAS is the durable admission boundary used inside the harness dispatch callback.
pub fn claim_prompt(
    database: &mut SuplexDatabase,
    turn: &RootTurn,
    owner: &str,
    server_generation: &str,
    usage: TaskLimitUsage,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        let control = database.connection().query_row(
            "SELECT status, budget_usd, max_turns FROM suplex_task_controls WHERE task_id = ?1",
            [&turn.task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<f64>>(1)?, row.get::<_, Option<i64>>(2)?)),
        ).optional()?;
        let Some((status, budget_usd, max_turns)) = control else { return Ok(false); };
        if status != "active" { return Ok(false); }
        let dependency_blocked: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_dependencies d JOIN suplex_tasks t ON t.id = d.depends_on_task_id LEFT JOIN suplex_task_controls c ON c.task_id = t.id WHERE d.task_id = ?1 AND COALESCE(c.status, 'backlog') <> 'delivered')",
            [&turn.task_id], |row| row.get(0),
        )?;
        if dependency_blocked { return Ok(false); }
        let defaults = database.connection().query_row(
            "SELECT default_budget_usd, default_max_turns FROM suplex_environment_settings WHERE id = 'host'",
            [], |row| Ok(TaskLimits { budget_usd: row.get(0)?, max_turns: row.get(1)? }),
        ).optional()?.unwrap_or(TaskLimits { budget_usd: 15.0, max_turns: 40 });
        let limits = TaskLimits { budget_usd: budget_usd.unwrap_or(defaults.budget_usd), max_turns: max_turns.unwrap_or(defaults.max_turns) };
        let admitted_turns: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND prompted_at IS NOT NULL",
            [&turn.task_id], |row| row.get(0),
        )?;
        let reservations: i64 = database.connection().query_row(
            "SELECT COUNT(*) FROM suplex_task_turns WHERE task_id = ?1 AND status = 'unknown' AND prompted_at IS NULL",
            [&turn.task_id], |row| row.get(0),
        )?;
        let hit_budget = limits.budget_usd > 0.0 && usage.estimated_cost_usd.is_some_and(|cost| cost >= limits.budget_usd);
        let hit_turns = limits.max_turns > 0 && admitted_turns >= limits.max_turns;
        if hit_budget || hit_turns {
            let reason = match (hit_budget, hit_turns) { (true, true) => "budget_and_turns", (true, false) => "budget", _ => "turns" };
            let budget_allowance = if defaults.budget_usd > 0.0 { defaults.budget_usd } else { limits.budget_usd };
            let turn_allowance = if defaults.max_turns > 0 { defaults.max_turns } else { limits.max_turns };
            let proposed = TaskLimits {
                budget_usd: if hit_budget { suggested_budget(usage.estimated_cost_usd.unwrap_or(0.0) + budget_allowance, usage.estimated_cost_usd.unwrap_or(0.0)) } else { limits.budget_usd },
                max_turns: if hit_turns { admitted_turns + turn_allowance } else { limits.max_turns },
            };
            let observed = PersistedLimitUsage { estimated_cost_usd: usage.estimated_cost_usd, admitted_turns };
            let pause = serde_json::json!({ "kind": "task_limit", "reason": reason, "limits": limits, "usage": observed, "proposedLimits": proposed });
            let time = timestamp(now);
            database.connection().execute(
                "UPDATE suplex_task_controls SET status = 'waiting_human', limit_pause_json = ?1, human_question = ?2, human_question_options_json = '[]', human_question_id = ?3, wake_at = NULL, updated_at = ?4 WHERE task_id = ?5 AND status = 'active'",
                params![pause.to_string(), task_limit_question(reason, limits, proposed, observed), Uuid::new_v4().to_string(), time, turn.task_id],
            )?;
            return Ok(false);
        }
        if limits.max_turns > 0 && admitted_turns + reservations >= limits.max_turns { return Ok(false); }
        let attempt = PromptDispatchAttempt { server_generation: server_generation.to_owned(), claimed_at: timestamp(now) };
        let raw = serde_json::to_string(&attempt)?;
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'unknown', dispatch_attempt_json = ?1, updated_at = ?2 WHERE id = ?3 AND task_id = ?4 AND status = 'pending_prompt' AND EXISTS (SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_controls c ON c.task_id = s.task_id WHERE s.id = suplex_task_turns.session_id AND s.generation = suplex_task_turns.generation AND s.launch_owner = ?5 AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')",
            params![raw, attempt.claimed_at, turn.id, turn.task_id, owner],
        )? == 1)
    })
}

pub fn mark_prompted(
    database: &mut SuplexDatabase,
    turn: &RootTurn,
    native_turn_id: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'prompted', native_turn_id = COALESCE(?1, native_turn_id), prompted_at = ?2, updated_at = ?2 WHERE id = ?3 AND generation = ?4 AND status IN ('pending_prompt', 'unknown') AND EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.id = suplex_task_turns.session_id AND s.is_current = 1 AND s.generation = suplex_task_turns.generation)",
            params![native_turn_id, timestamp(now), turn.id, turn.generation],
        )? == 1)
    })
}

/// Clear a dispatch claim only after the native runtime proves the attempted
/// turn absent. Match the exact attempt and current operation owner so an old
/// observer cannot requeue a newer admitted prompt.
pub fn requeue_fenced_prompt(
    database: &mut SuplexDatabase,
    turn: &RootTurn,
    attempt: &PromptDispatchAttempt,
    owner: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<bool> {
    let attempt_json = serde_json::to_string(attempt)?;
    database.transaction(true, |database| {
        Ok(database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'pending_prompt', dispatch_attempt_json = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'unknown' AND dispatch_attempt_json = ?3 AND EXISTS (SELECT 1 FROM suplex_task_sessions s JOIN suplex_task_controls c ON c.task_id = s.task_id WHERE s.id = suplex_task_turns.session_id AND s.generation = suplex_task_turns.generation AND s.launch_owner = ?4 AND s.is_current = 1 AND s.lifecycle <> 'cancelled' AND c.status = 'active')",
            params![timestamp(now), turn.id, attempt_json, owner],
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
        let time = timestamp(now);
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
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'pending_prompt',?7,?7)",
            params![id, task_id, session_id, generation, hash, prompt, time],
        )?;
        Ok(true)
    })
}

/// Complete one current Standard Worker result and wake Root in the same
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
}

pub fn record_standard_worker_result_and_wake(
    database: &mut SuplexDatabase,
    input: &StandardWorkerResult<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<RootTurn>> {
    let StandardWorkerResult {
        task_id,
        session_id,
        generation,
        receipt_id,
        observation,
        native_turn_id,
        wake_prompt,
    } = *input;
    database.transaction(false, |database| {
        let worker_turn: Option<(String, String, Option<String>)> = database.connection().query_row(
            "SELECT id,status,result_receipt_id FROM suplex_task_turns WHERE task_id = ?1 AND session_id = ?2 AND generation = ?3 ORDER BY created_at DESC LIMIT 1",
            params![task_id, session_id, generation],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((worker_turn_id, status, prior_receipt)) = worker_turn else {
            return Err(std::io::Error::other("stale_generation").into());
        };
        let current: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_sessions WHERE id = ?1 AND task_id = ?2 AND kind = 'worker' AND is_current = 1 AND generation = ?3 AND lifecycle <> 'cancelled')",
            params![session_id, task_id, generation],
            |row| row.get(0),
        )?;
        if !current || status == "cancelled" {
            return Err(std::io::Error::other("stale_generation").into());
        }
        if status == "completed" {
            if prior_receipt.as_deref() == Some(receipt_id) {
                return Ok(None);
            }
            return Err(std::io::Error::other("stale_receipt").into());
        }
        let root = current_root(database, task_id)?
            .ok_or_else(|| std::io::Error::other("root_notification_unavailable"))?;
        let time = timestamp(now);
        database.connection().execute(
            "UPDATE suplex_task_turns SET status = 'completed', result_receipt_id = ?1, terminal_observation = ?2, native_turn_id = ?3, completed_at = ?4, updated_at = ?4 WHERE id = ?5",
            params![receipt_id, observation, native_turn_id, time, worker_turn_id],
        )?;
        let wake_id = new_turn_id(now)?;
        let hash = format!("{:x}", Sha256::digest(wake_prompt.as_bytes()));
        database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'pending_prompt',?7,?7)",
            params![wake_id, task_id, root.id, root.generation, hash, wake_prompt, time],
        )?;
        database.connection().execute(
            "UPDATE suplex_task_controls SET wake_at = ?1, updated_at = ?1 WHERE task_id = ?2",
            params![time, task_id],
        )?;
        Ok(Some(database.connection().query_row(
            "SELECT * FROM suplex_task_turns WHERE id = ?1", [&wake_id], turn,
        )?))
    })
}

/// Persist the worktree observed by Git while task execution is still active.
pub fn set_worktree(
    database: &mut SuplexDatabase,
    task_id: &str,
    worktree: &Value,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let fields = worktree
        .as_object()
        .ok_or_else(|| std::io::Error::other("Invalid task worktree"))?;
    if fields.len() != 5
        || ["path", "branch", "baseSha", "headSha"].iter().any(|key| {
            fields
                .get(*key)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        })
        || fields.get("dirty").and_then(Value::as_bool).is_none()
    {
        return Err(std::io::Error::other("Invalid task worktree").into());
    }
    database.transaction(false, |database| {
        let changed = database.connection().execute(
            "UPDATE suplex_task_controls SET worktree_json = ?1, updated_at = ?2 WHERE task_id = ?3 AND status = 'active'",
            params![worktree.to_string(), timestamp(now), task_id],
        )?;
        if changed != 1 { return Err(std::io::Error::other("task_not_active").into()); }
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
    database.transaction(false, |database| {
        let previous: Option<String> = database.connection().query_row(
            "SELECT status FROM suplex_task_controls WHERE task_id = ?1",
            [task_id], |row| row.get(0),
        ).optional()?;
        let time = timestamp(now);
        let changed = database.connection().execute(
            "UPDATE suplex_task_controls SET workflow_state_json = json_set(workflow_state_json, '$.followUp', json('false')), status = 'delivered', wake_at = NULL, human_question = NULL, human_question_id = NULL, limit_pause_json = NULL, updated_at = ?1 WHERE task_id = ?2 AND status IN ('active','waiting_human','delivered')",
            params![time, task_id],
        )?;
        if changed != 1 { return Err(std::io::Error::other("task_not_active").into()); }
        let was_delivered = previous.as_deref() == Some("delivered");
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
            let blocked: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_task_dependencies d LEFT JOIN suplex_task_controls c ON c.task_id = d.depends_on_task_id WHERE d.task_id = ?1 AND COALESCE(c.status,'backlog') <> 'delivered')",
                [&dependent], |row| row.get(0),
            )?;
            if blocked { continue; }
            match repository::admit_queued(database, &dependent, now) {
                Ok(true) => { admitted.push(dependent); continue; }
                Ok(false) => {}
                Err(error) if error.is::<PullRequestOwned>() => continue,
                Err(error) => return Err(error),
            }
            database.connection().execute(
                "UPDATE suplex_task_controls SET wake_at = ?1, updated_at = ?1 WHERE task_id = ?2 AND status = 'active'",
                params![time, dependent],
            )?;
        }
        Ok(admitted)
    })
}

pub fn retire_delivered_sessions(
    database: &mut SuplexDatabase,
    task_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.transaction(false, |database| {
        database.connection().execute(
            "UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'stopped',stop_requested_at = COALESCE(stop_requested_at,?1),updated_at = ?1 WHERE task_id = ?2 AND stopped_at IS NULL AND EXISTS (SELECT 1 FROM suplex_task_controls c WHERE c.task_id = suplex_task_sessions.task_id AND c.status = 'delivered')",
            params![timestamp(now), task_id],
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
) -> DatabaseResult<Option<RootTurn>> {
    database.transaction(false, |database| {
        let blocked: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_task_dependencies d LEFT JOIN suplex_task_controls c ON c.task_id = d.depends_on_task_id WHERE d.task_id = ?1 AND COALESCE(c.status,'backlog') <> 'delivered')",
            [task_id], |row| row.get(0),
        )?;
        if blocked { return Ok(None); }
        let id = new_turn_id(now)?;
        let hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        let time = timestamp(now);
        let inserted = database.connection().execute(
            "INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,created_at,updated_at) SELECT ?1,c.task_id,s.id,s.generation,?2,?3,'pending_prompt',?4,?4 FROM suplex_task_controls c JOIN suplex_task_sessions s ON s.id = c.root_session_id WHERE c.task_id = ?5 AND c.status = 'active' AND json_extract(c.workflow_state_json,'$.deliveryWait') IS NULL AND s.is_current = 1 AND s.lifecycle = 'live' AND s.native_session_id IS NOT NULL AND s.launch_owner IS NULL AND NOT EXISTS (SELECT 1 FROM suplex_task_turns t WHERE t.session_id = s.id AND t.status IN ('pending_prompt','prompted','unknown')) AND NOT EXISTS (SELECT 1 FROM suplex_task_sessions w JOIN suplex_task_turns wt ON wt.session_id = w.id AND wt.generation = w.generation WHERE w.task_id = c.task_id AND w.kind = 'worker' AND w.is_current = 1 AND wt.status IN ('pending_prompt','prompted','unknown'))",
            params![id, hash, prompt, time, task_id],
        )?;
        if inserted == 0 { return Ok(None); }
        Ok(Some(database.connection().query_row(
            "SELECT * FROM suplex_task_turns WHERE id = ?1", [&id], turn,
        )?))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth,
        platform::database::OpenMode,
        runtimes::headless::{self, DispatchInput},
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use std::{collections::HashMap, path::Path};

    #[test]
    fn worker_replacement_preserves_prompt_hash_and_waits_for_retired_native_session() {
        let filename =
            std::env::temp_dir().join(format!("suplex_replace_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('replace_company','Replace','active',?1)", [timestamp(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('replace_project','replace_company','Replace','/tmp/replace-repo','/tmp/replace-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [timestamp(now)]).unwrap();
        let prepared = PreparedTask {
            id: repository::new_task_id(),
            company_id: "replace_company".into(),
            project_id: "replace_project".into(),
            title: "Replace Worker".into(),
            description: String::new(),
            configuration: serde_json::json!({"repository":"owner/repo","branch":"task-replace","baseBranch":"main","baselineSha":"head"}),
            idempotency_key: "replace-key".into(),
            request_hash: "replace-hash".into(),
            creator: TaskCreator::User(user.id),
            delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::json!({"repository":"owner/repo","headBranch":"task-replace","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
            root_profile: serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"}),
            worker_profile: serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"}),
            advisor_profiles: serde_json::json!({}),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
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
        let old_id = old["id"].as_str().unwrap().to_owned();
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
        assert_ne!(next["id"], old_id);
        assert_eq!(next["nativeSessionId"], Value::Null);
        assert_eq!(next["profile"], old["profile"]);
        let next_id = next["id"].as_str().unwrap();
        assert!(!worker_replacement_ready(&database, next_id).unwrap());
        let saved: (String, String, String) = database.connection().query_row(
            "SELECT prompt_text,prompt_hash,assignment_hash FROM suplex_task_turns WHERE session_id = ?1", [next_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert!(saved.0.starts_with("Worker assignment: build\n\nFresh Worker handoff:\nReason for replacement: Change strategy"));
        assert!(saved.0.contains("Latest Worker result (verify its claims against source and command evidence):\nMade a partial change."));
        assert_eq!(saved.1, format!("{:x}", Sha256::digest(saved.0.as_bytes())));
        assert_eq!(saved.1, saved.2);
        assert_eq!(
            replace_worker(&mut database, &task.id, &request, now).unwrap()["id"],
            next["id"]
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
                params![timestamp(now), old_id],
            )
            .unwrap();
        assert!(worker_replacement_ready(&database, next_id).unwrap());
        database.connection().execute(
            "INSERT INTO suplex_profiles (id,name,role,avatar_seed,provider,model,reasoning_level,service_tier,created_at,updated_at) VALUES ('alternate-worker','Alternate','worker','alternate','codex','gpt-6-sol','high','default',?1,?1)",
            [timestamp(now)],
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
        assert_eq!(second["profile"]["profileId"], "alternate-worker");
        assert_eq!(second["profile"]["reasoningLevel"], "high");
        assert_eq!(next["profile"], old["profile"]);
        let latest: String = database
            .connection()
            .query_row(
                "SELECT prompt_text FROM suplex_task_turns WHERE session_id = ?1",
                [second["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(latest.matches("Fresh Worker handoff:").count(), 1);
        drop(database);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn human_note_reuses_root_and_resumes_delivered_intent_without_replay() {
        let filename = std::env::temp_dir().join(format!("suplex_note_{}.sqlite", Uuid::new_v4()));
        let now = DateTime::parse_from_rfc3339("2026-09-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('note_company','Notes','active',?1)", [timestamp(now)]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('note_project','note_company','Notes','/tmp/note-repo','/tmp/note-worktrees',NULL,'main','','','root','worker','{}',?1,?1)", [timestamp(now)]).unwrap();
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
            delivery_intent: serde_json::json!({"repository":"owner/repo","headBranch":"task-note","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
            root_profile: serde_json::json!({"profileId":"root","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"}),
            worker_profile: serde_json::json!({"profileId":"worker","provider":"codex","model":"test","reasoningLevel":"medium","serviceTier":"default"}),
            advisor_profiles: serde_json::json!({}),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
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
        database.connection().execute("UPDATE suplex_task_sessions SET is_current = 0,lifecycle = 'stopped',stop_requested_at = ?1,stopped_at = ?1 WHERE id = ?2", params![timestamp(now), root_id]).unwrap();
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
        assert_eq!(rows.control["status"], "active");
        assert_eq!(rows.control["workflowState"]["followUp"], true);
        assert_eq!(
            rows.control["workflowState"]["deliveryHistory"][0]["acceptedDelivery"]["headSha"],
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert_eq!(rows.root.as_ref().unwrap()["id"], root_id);
        assert_eq!(
            rows.root.as_ref().unwrap()["nativeSessionId"],
            "codex-retained"
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
            [timestamp(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('project_task_test', 'company_task_test', 'Task project', '/tmp/suplex-task-project', '/tmp/suplex-task-worktrees', NULL, 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', ?1, ?1)",
            [timestamp(now)],
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
            delivery_intent: serde_json::json!({"repository":"owner/repo","headBranch":"task-one","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
            root_profile: serde_json::json!({"profileId":"profile_native_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            worker_profile: serde_json::json!({"profileId":"profile_native_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            advisor_profiles: serde_json::json!({}),
            issue: None,
            start_queued: true,
            copied_from_task_id: None,
            depends_on: vec![],
        };
        let created = repository::create(&mut database, &prepared, now).unwrap();
        assert!(created.created);
        assert_eq!(created.task.status, "active");
        let repeated = repository::create(&mut database, &prepared, now).unwrap();
        assert!(!repeated.created);
        assert_eq!(created.task.id, repeated.task.id);
        let blocked_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Dependent task".into(),
            idempotency_key: "dependent-key".into(),
            request_hash: "dependent-request".into(),
            depends_on: vec![created.task.id.clone()],
            ..prepared.clone()
        };
        let blocked = repository::create(&mut database, &blocked_input, now).unwrap();
        assert_eq!(blocked.task.status, "queued");
        let backlog_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Manual task".into(),
            idempotency_key: "manual-key".into(),
            request_hash: "manual-request".into(),
            start_queued: false,
            ..prepared.clone()
        };
        let backlog = repository::create(&mut database, &backlog_input, now).unwrap();
        assert_eq!(backlog.task.status, "backlog");
        assert_eq!(
            repository::start(&mut database, &backlog.task.id, now)
                .unwrap()
                .unwrap()
                .status,
            "active"
        );
        let pull_request_input = PreparedTask {
            id: repository::new_task_id(),
            title: "Pull request task".into(),
            idempotency_key: "pull-request-key".into(),
            request_hash: "pull-request-request".into(),
            configuration: serde_json::json!({"repository":"owner/repo","source":{"kind":"pull_request","number":42}}),
            delivery_intent: serde_json::json!({"repository":"owner/repo","pullRequestNumber":42}),
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
            "active"
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
        assert_eq!(observed.control["status"], "active");
        assert_eq!(observed.control["workflow"], "standard");
        assert_eq!(observed.context["configuration"]["branch"], "task-one");
        assert_eq!(observed.root.as_ref().unwrap()["id"], root.id);
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
        assert_eq!(worker["kind"], "worker");
        assert!(
            root_observation_rows(&database, &created.task.id)
                .unwrap()
                .turns[0]["id"]
                .as_str()
                .unwrap()
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
                [worker["id"].as_str().unwrap()],
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
        assert_eq!(next_worker["id"], worker["id"]);
        assert_eq!(next_worker["generation"], 2);
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
        assert_eq!(pending[0].status, "unknown");
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
            params![second_id, created.task.id, root.id, root.generation, timestamp(now)],
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
            params![created.task.id, backlog.task.id, timestamp(now)],
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
            session_id: worker["id"].as_str().unwrap(),
            generation: next_worker["generation"].as_i64().unwrap(),
            receipt_id: "native:worker:completed",
            observation: "{\"state\":\"completed\"}",
            native_turn_id: Some("native-turn"),
            wake_prompt: "Review the Worker result",
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
            ..prepared.clone()
        };
        let waiting = repository::create(&mut database, &waiting_input, now).unwrap();
        assert_eq!(waiting.task.status, "queued");
        set_worktree(
            &mut database,
            &created.task.id,
            &serde_json::json!({
                "path":"/tmp/task-one","branch":"task-one","baseSha":"base",
                "headSha":"head","dirty":true,
            }),
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
            "active"
        );
        assert!(
            mark_delivered(&mut database, &created.task.id, now)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            root_observation_rows(&database, &created.task.id)
                .unwrap()
                .control["status"],
            "delivered"
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
            [interrupted["id"].as_str().unwrap()], |row| row.get(0),
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
            "active"
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
                limits: crate::http::contracts::typed::task_answers::TaskLimits {
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
            "cancelled"
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
