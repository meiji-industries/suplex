//! TypeScript `coordination/session-recovery.ts` result handling for delegate
//! turns. The task host owns native dispatch and observation; this module
//! turns one terminal Worker or Advisor turn into durable workflow intent.

use std::path::Path;

use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    runtimes::codex::{session_reader, tool_evidence},
};

use super::{
    advisor_bridge::{self, AdvisorReportOutcome},
    root_controller,
    root_prompts::{self, WorkerResult},
    root_session_store::{self, RootSession, RootTurn, StandardWorkerResult},
    workflow_evidence,
    workflows::{ReviewRange, advisor_label, turn_workflow_input},
};

/// One terminal delegate turn as the task host observed it natively.
pub struct TerminalDelegateTurn<'a> {
    pub session: &'a RootSession,
    pub native_session_id: &'a str,
    pub turn: &'a RootTurn,
    /// `completed`, `error`, or `interrupted`.
    pub state: &'a str,
    pub reason: &'a str,
    pub text: &'a str,
    /// The serialized base observation: state, native, reason, interruptedExecution, text.
    pub base: Value,
}

/// TypeScript `harness.turnEvidence` for the Codex turn log.
pub fn native_tools(database_path: &Path, session_id: &str, turn_id: &str) -> Result<Vec<Value>, String> {
    let read = || -> Result<Vec<Value>, Box<dyn std::error::Error>> {
        let directory = session_reader::session_directory(database_path, session_id)?;
        let events = session_reader::turn_evidence(&directory, turn_id)?
            .ok_or("The native turn log is missing")?;
        Ok(tool_evidence::codex_tools(&events)
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<_, _>>()?)
    };
    read().map_err(|error| format!("Native tool evidence could not be read: {error}"))
}

/// Callers run on a blocking thread, as the task host's recovery does.
fn block_on<T>(future: impl std::future::Future<Output = T>) -> DatabaseResult<T> {
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| std::io::Error::other("Task source observation needs the async runtime"))?;
    Ok(handle.block_on(future))
}

/// TypeScript `verifyAdvisorOutcome`: a valid report stays valid only while
/// its pinned evidence files and committed source are unchanged.
fn verify_advisor_outcome(
    database_path: &Path,
    task_id: &str,
    input: &Value,
    outcome: AdvisorReportOutcome,
) -> DatabaseResult<AdvisorReportOutcome> {
    if outcome.is_err() {
        return Ok(outcome);
    }
    let directory = input["evidenceDirectory"].as_str().unwrap_or_default();
    let digest = input["evidenceSha256"].as_str().unwrap_or_default();
    if !workflow_evidence::verify_task_evidence(Path::new(directory), digest) {
        return Ok(Err("The evidence files changed or are missing since the assignment. Request a new assessment.".into()));
    }
    let range = ReviewRange::from_value(&input["range"]).unwrap_or_default();
    let activity = format!("{} review", advisor_label(input["role"].as_str().unwrap_or_default()));
    Ok(match block_on(root_controller::source_still_matches(database_path, task_id, &range, &activity))? {
        Ok(_) => outcome,
        Err((reason, _, _)) => Err(format!("{reason}. Request a new assessment.")),
    })
}

fn advisor_summary(outcome: &AdvisorReportOutcome) -> String {
    match outcome {
        Err(reason) => reason.clone(),
        Ok(result) => {
            let findings = result["blockingFindings"].as_array().map_or(0, Vec::len);
            let verification = result["verification"].as_str().unwrap_or_default();
            match result["role"].as_str() {
                Some("rater") => format!(
                    "Rating {}/10 with {findings} blocking finding(s); verification {verification}.",
                    result["rating"]
                ),
                Some("reviewer") => format!(
                    "{} with {findings} blocking finding(s); verification {verification}.",
                    if result["approved"] == true { "Approved" } else { "Not approved" }
                ),
                _ => result["summary"].as_str().unwrap_or_default().to_owned(),
            }
        }
    }
}

/// TypeScript `finishTurn` for a Worker or Advisor session: records the result,
/// any Reviewer or Rater verdict, and the Coordinator wake in one transaction.
pub fn finish_delegate_turn(
    database: &mut SuplexDatabase,
    database_path: &Path,
    finished: TerminalDelegateTurn<'_>,
) -> DatabaseResult<bool> {
    let TerminalDelegateTurn {
        session,
        native_session_id,
        turn,
        state,
        reason,
        text,
        mut base,
    } = finished;
    let rows = root_session_store::root_observation_rows(database, &session.task_id)?;
    let workflow = rows.control["workflow"].as_str().unwrap_or("standard").to_owned();
    let session_row = rows.sessions.iter().find(|row| row["id"] == session.id.as_str()).cloned().unwrap_or(Value::Null);
    let turn_row = rows.turns.iter().find(|row| row["id"] == turn.id.as_str()).cloned().unwrap_or(Value::Null);
    let input = turn_workflow_input(&rows.sessions, &turn_row).cloned().unwrap_or(Value::Null);
    drop(rows);
    let receipt = format!("{native_session_id}:{}:{state}", turn.id);
    let native_turn_id = (state == "completed").then_some(turn.id.as_str());
    let record = |database: &mut SuplexDatabase, observation: &str, wake: &str, review: Option<&Value>| {
        root_session_store::record_standard_worker_result_and_wake(
            database,
            &StandardWorkerResult {
                task_id: &session.task_id,
                session_id: &session.id,
                generation: session.generation,
                receipt_id: &receipt,
                observation,
                native_turn_id,
                wake_prompt: wake,
                review,
            },
            Utc::now(),
        )
        .map(|wake| wake.is_some())
    };
    if let Some(role) = session_row["advisorRole"].as_str()
        && input["kind"] == "advisor"
    {
        let label = advisor_label(role);
        let assigned = advisor_bridge::advisor_role(role).ok_or("Advisor role is invalid")?;
        let outcome = if state == "completed" {
            advisor_bridge::advisor_report_from_turn(
                assigned,
                &native_tools(database_path, &session.id, &turn.id).unwrap_or_default(),
                text,
            )
        } else {
            let detail = if reason.is_empty() { String::new() } else { format!(" ({reason})") };
            Err(format!("The {label} turn ended with state {state}{detail}"))
        };
        let outcome = verify_advisor_outcome(database_path, &session.task_id, &input, outcome)?;
        let (result, invalid_reason) = match &outcome {
            Ok(result) => (result.clone(), Value::Null),
            Err(reason) => (Value::Null, json!(reason)),
        };
        base["advisor"] = json!({"role":role,"result":result,"invalidReason":invalid_reason});
        let observation = base.to_string();
        let review = matches!(role, "reviewer" | "rater").then(|| json!({"result":result,"invalidReason":invalid_reason}));
        let wake = root_prompts::advisor_result_wake(role, &receipt, outcome.is_ok(), &advisor_summary(&outcome), &observation);
        return record(database, &observation, &wake, review.as_ref());
    }
    let purpose = if input["kind"] == "worker" { input["purpose"].as_str().unwrap_or("implementation") } else { "implementation" }.to_owned();
    let mut verification_range = None;
    if purpose == "verification" && input["kind"] == "worker" {
        let before = ReviewRange::from_value(&input["range"]).unwrap_or_default();
        verification_range = Some(match block_on(root_controller::source_still_matches(database_path, &session.task_id, &before, "check"))? {
            Ok(after) => json!({"before":before,"after":after,"cleanAfter":true,"valid":true,"invalidReason":null}),
            Err((reason, after, clean)) => json!({"before":before,"after":after,"cleanAfter":clean,"valid":false,"invalidReason":reason}),
        });
    }
    if workflow != "standard" {
        match native_tools(database_path, &session.id, &turn.id) {
            Ok(tools) => {
                base["tools"] = json!(tools);
                base["toolsLimit"] = Value::Null;
            }
            Err(limit) => {
                base["tools"] = json!([]);
                base["toolsLimit"] = json!(limit);
            }
        }
    }
    if let Some(range) = &verification_range {
        base["verificationRange"] = range.clone();
    }
    let wake = root_prompts::worker_result_wake(
        &workflow,
        &receipt,
        &WorkerResult {
            turn_id: &turn.id,
            state,
            text,
            verification_range: verification_range
                .as_ref()
                .map(|range| (range["valid"] == true, range["invalidReason"].as_str())),
        },
        &purpose,
    );
    record(database, &base.to_string(), &wake, None)
}

/// TypeScript `reconcileCompletedAdvisorReport`: revalidates one retained
/// invalid Advisor turn without launching or resuming an agent.
pub async fn reconcile_completed_advisor_report(
    database_path: &Path,
    task_id: &str,
    turn_id: &str,
) -> DatabaseResult<AdvisorReportOutcome> {
    let rows = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        root_session_store::root_observation_rows(&database, task_id)?
    };
    let turn = rows.turns.iter().find(|turn| turn["id"] == turn_id);
    let session = turn.and_then(|turn| rows.sessions.iter().find(|session| session["id"] == turn["sessionId"]));
    let (Some(turn), Some(session), Some(role)) = (
        turn.filter(|turn| turn["status"] == "completed"),
        session.filter(|session| session["kind"] == "worker"),
        session.and_then(|session| session["advisorRole"].as_str()),
    ) else {
        return Ok(Err("The retained Advisor turn does not exist or is not complete".into()));
    };
    let input = turn_workflow_input(&rows.sessions, turn).cloned().unwrap_or(Value::Null);
    if input["kind"] != "advisor" || input["role"] != role {
        return Ok(Err("The retained Advisor turn has no matching assignment".into()));
    }
    let stored = turn["terminalObservation"]
        .as_str()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(|value| value.is_object() && (value.get("text").is_none() || value["text"].is_string()));
    let Some(stored) = stored else {
        return Ok(Err("The retained Advisor observation is invalid".into()));
    };
    let session_id = session["id"].as_str().unwrap_or_default();
    let tools = native_tools(database_path, session_id, turn_id).unwrap_or_default();
    let assigned = advisor_bridge::advisor_role(role).ok_or("Advisor role is invalid")?;
    let outcome = advisor_bridge::advisor_report_from_turn(assigned, &tools, stored["text"].as_str().unwrap_or_default());
    let outcome = {
        let input = input.clone();
        let database_path = database_path.to_owned();
        let task_id = task_id.to_owned();
        tokio::task::spawn_blocking(move || verify_advisor_outcome(&database_path, &task_id, &input, outcome).map_err(|error| error.to_string()))
            .await?
            .map_err(std::io::Error::other)?
    };
    if let Ok(result) = &outcome {
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        root_session_store::reconcile_advisor_result(&mut database, task_id, session_id, turn_id, result, Utc::now())?;
    }
    Ok(outcome)
}
