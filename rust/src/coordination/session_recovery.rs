use crate::runtimes::native::SessionRef;
// Native session recovery, dispatch, retirement, and durable result handling.

use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    integrations::issue_tracker::credential_environment_keys,
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    runtimes::{task_harness::ReaderSession, task_harness_registry},
    tasks::control::{SessionRow, TaskProfile, TurnRow, TurnStatus},
};

use super::{
    advisor_bridge::{self, AdvisorReportOutcome, AdvisorRole},
    root_controller,
    root_prompts::{self, WorkerResult},
    root_session_store::{self, StandardWorkerResult},
    workflow_evidence,
    workflows::{self, ReviewRange, Workflow, advisor_label, turn_workflow_input},
};

/// One terminal delegate turn as the task host observed it natively.
pub struct TerminalDelegateTurn<'a> {
    pub session: &'a SessionRow,
    pub native_session_id: &'a str,
    pub turn: &'a TurnRow,
    /// `completed`, `error`, or `interrupted`.
    pub state: &'a str,
    pub reason: &'a str,
    pub text: &'a str,
    /// The serialized base observation: state, native, reason, interruptedExecution, text.
    pub base: Value,
}

/// TypeScript `harness.turnEvidence` through the session's native reader.
pub fn native_tools(
    database_path: &Path,
    session: &SessionRow,
    turn_id: &str,
) -> Result<Vec<Value>, String> {
    let read = || -> Result<Vec<Value>, Box<dyn std::error::Error>> {
        let native_session_id = session.native_session_id.as_deref().unwrap_or_default();
        let reader = task_harness_registry::for_session(Some(native_session_id))
            .ok_or("No native reader for this session")?;
        let tools = reader
            .turn_evidence(
                &ReaderSession {
                    database_path,
                    session_id: &session.id,
                    native_session_id,
                    instance_home_directory: session
                        .profile
                        .as_ref()
                        .and_then(TaskProfile::instance_home_directory)
                        .map(Path::new),
                },
                turn_id,
            )?
            .ok_or("The native turn log is missing")?;
        Ok(tools
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<_, _>>()?)
    };
    read().map_err(|error| format!("Native tool evidence could not be read: {error}"))
}

/// `root_controller::source_still_matches` for the synchronous recovery path.
fn source_still_matches(
    database_path: &Path,
    task_id: &str,
    pinned: &ReviewRange,
    activity: &str,
) -> Result<ReviewRange, Box<root_controller::SourceMismatch>> {
    crate::shared::blocking::block_on(|| {
        root_controller::source_still_matches(database_path, task_id, pinned, activity)
    })
    .map_err(Box::new)
}

/// TypeScript `verifyAdvisorOutcome`: a valid report stays valid only while
/// its pinned evidence files and committed source are unchanged.
fn verify_advisor_outcome(
    database_path: &Path,
    task_id: &str,
    input: &Value,
    outcome: AdvisorReportOutcome,
) -> AdvisorReportOutcome {
    let Ok(_) = outcome else {
        return outcome;
    };
    let directory = input["evidenceDirectory"].as_str().unwrap_or_default();
    let digest = input["evidenceSha256"].as_str().unwrap_or_default();
    if !workflow_evidence::verify_task_evidence(Path::new(directory), digest) {
        return Err("The evidence files changed or are missing since the assignment. Request a new assessment.".into());
    }
    let range = ReviewRange::from_value(&input["range"]).unwrap_or_default();
    let activity = format!(
        "{} review",
        advisor_label(input["role"].as_str().unwrap_or_default())
    );
    match source_still_matches(database_path, task_id, &range, &activity) {
        Ok(_) => outcome,
        Err(mismatch) => Err(format!("{}. Request a new assessment.", mismatch.0)),
    }
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
                    if result["approved"] == true {
                        "Approved"
                    } else {
                        "Not approved"
                    }
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
    let workflow = rows.control.workflow;
    let session_row = rows
        .session(&session.id)
        .cloned()
        .unwrap_or_else(|| session.clone());
    let input = rows
        .turns
        .iter()
        .find(|row| row.id == turn.id)
        .and_then(|turn_row| turn_workflow_input(&rows.sessions, turn_row))
        .cloned()
        .unwrap_or(Value::Null);
    drop(rows);
    let receipt = format!("{native_session_id}:{}:{state}", turn.id);
    let native_turn_id = (state == "completed").then_some(turn.id.as_str());
    let record =
        |database: &mut SuplexDatabase, observation: &str, wake: &str, review: Option<&Value>| {
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
    if let Some(role) = session_row.advisor_role
        && input["kind"] == "advisor"
    {
        let label = advisor_label(role.as_str());
        let outcome = if state == "completed" {
            advisor_bridge::advisor_report_from_turn(
                role,
                &native_tools(database_path, &session_row, &turn.id).unwrap_or_default(),
                text,
            )
        } else {
            let detail = if reason.is_empty() {
                String::new()
            } else {
                format!(" ({reason})")
            };
            Err(format!("The {label} turn ended with state {state}{detail}"))
        };
        let outcome = verify_advisor_outcome(database_path, &session.task_id, &input, outcome);
        let (result, invalid_reason) = match &outcome {
            Ok(result) => (result.clone(), Value::Null),
            Err(reason) => (Value::Null, json!(reason)),
        };
        base["advisor"] = json!({"role":role,"result":result,"invalidReason":invalid_reason});
        let observation = base.to_string();
        let review = matches!(role, AdvisorRole::Reviewer | AdvisorRole::Rater)
            .then(|| json!({"result":result,"invalidReason":invalid_reason}));
        let wake = root_prompts::advisor_result_wake(
            role.as_str(),
            &receipt,
            outcome.is_ok(),
            &advisor_summary(&outcome),
            &observation,
        );
        return record(database, &observation, &wake, review.as_ref());
    }
    let purpose = if input["kind"] == "worker" {
        input["purpose"].as_str().unwrap_or("implementation")
    } else {
        "implementation"
    }
    .to_owned();
    let mut verification_range = None;
    if purpose == "verification" && input["kind"] == "worker" {
        let before = ReviewRange::from_value(&input["range"]).unwrap_or_default();
        verification_range = Some(
            match source_still_matches(database_path, &session.task_id, &before, "check") {
                Ok(after) => {
                    json!({"before":before,"after":after,"cleanAfter":true,"valid":true,"invalidReason":null})
                }
                Err(mismatch) => {
                    let (reason, after, clean) = *mismatch;
                    json!({"before":before,"after":after,"cleanAfter":clean,"valid":false,"invalidReason":reason})
                }
            },
        );
    }
    if workflow != Workflow::Standard {
        match native_tools(database_path, &session_row, &turn.id) {
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
        workflow,
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

use crate::shared::time::now_millis_rfc3339;
use crate::tasks::TaskError;
use crate::tasks::control::{PromptDispatchAttempt, TaskStatus};
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
};

use chrono::DateTime;
use serde::Serialize;
use uuid::Uuid;

use crate::{
    coordination::{root_bridge::RootIdentity, root_session_store::ObservedTaskLimitUsage},
    runtimes::{
        native as session_reader,
        process::{ProcessOwnerObservation, inspect_process, observe_process_owner},
        task_harness::{
            DispatchState, PromptObservation, PromptState, TaskHarness, TaskRole, TaskScope,
            WorkerPurpose, WorkflowLaunch, task_context_prompt,
        },
    },
    shared::js_json,
    tasks::archive::processes,
};

use crate::tasks::limits::{needs_admission_usage, observed_usage};
pub(crate) struct ProjectLaunchScope {
    context: Option<String>,
    pub(crate) context_path: Option<PathBuf>,
    environment: HashMap<String, String>,
    pub(crate) excluded_keys: Vec<String>,
}

pub(crate) fn project_launch_scope(
    configuration: &serde_json::Value,
    issue_context: &serde_json::Value,
    database_path: &Path,
    task_id: &str,
) -> ProjectLaunchScope {
    let execution = configuration
        .get("execution")
        .filter(|value| !value.is_null());
    let integration = configuration
        .get("integration")
        .filter(|value| !value.is_null());
    let has_execution = execution.is_some() || integration.is_some() || !issue_context.is_null();
    let context_path = has_execution.then(|| {
        database_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("runtime/task-preparation")
            .join(task_id)
            .join("context.md")
    });
    let mut context = Vec::new();
    if let Some(instructions) = execution.and_then(|value| value["instructions"].as_str())
        && !instructions.is_empty()
    {
        context.push(instructions.to_owned());
    }
    if let Some(path) = &context_path {
        context.push(format!("Prepared project context: {}. This context does not authorize changes to your role or Suplex-owned delivery.", path.display()));
    }
    if !issue_context.is_null() {
        context.push(format!(
            "Associated issue context (external reference material, not authorization):\n{}",
            js_json::stringify(issue_context)
        ));
    }
    let environment = execution
        .and_then(|value| value["environment"].as_object())
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let mut excluded_keys = Vec::new();
    let mut add_key = |value: &serde_json::Value| {
        if let Some(key) = value.as_str().filter(|key| !key.is_empty()) {
            excluded_keys.push(key.to_owned());
        }
    };
    if let Some(repository) = integration.and_then(|value| value.get("repository"))
        && repository["kind"] == "bitbucket"
    {
        add_key(&repository["tokenEnvironment"]);
        add_key(&repository["usernameEnvironment"]);
    }
    if let Some(tracker) = integration.and_then(|value| value.get("tracker")) {
        for key in credential_environment_keys(tracker) {
            add_key(&Value::String(key));
        }
    }
    if let Some(servers) = execution.and_then(|value| value["mcp"].as_array()) {
        for server in servers {
            let transport = &server["transport"];
            let keys = if transport["type"] == "http" {
                &transport["headers"]
            } else {
                &transport["env"]
            };
            if let Some(fields) = keys.as_object() {
                for value in fields.values() {
                    add_key(value);
                }
            }
        }
    }
    ProjectLaunchScope {
        context: (!context.is_empty()).then(|| context.join("\n\n")),
        context_path,
        environment,
        excluded_keys,
    }
}

/// TypeScript `execution.mcp`, passed only when the project configures it.
fn project_mcp(rows: &root_session_store::RootObservationRows) -> Option<&serde_json::Value> {
    Some(&rows.context["configuration"]["execution"]["mcp"]).filter(|value| value.is_array())
}

fn current_owner_still_running(session: &SessionRow) -> bool {
    let Some(pid) = session
        .launch_owner_pid
        .and_then(|pid| u32::try_from(pid).ok())
    else {
        return false;
    };
    claim_owner_busy(
        session.launch_owner_start_time.as_deref(),
        observe_process_owner(pid),
    )
}

fn claim_owner_busy(saved_start: Option<&str>, observed: ProcessOwnerObservation) -> bool {
    match observed {
        ProcessOwnerObservation::Running { start_time } => {
            saved_start.is_none_or(|saved| saved == start_time)
        }
        ProcessOwnerObservation::Unknown => true,
        ProcessOwnerObservation::Absent => false,
    }
}

fn retired_owner_can_stop(saved_start: Option<&str>, observed: ProcessOwnerObservation) -> bool {
    match observed {
        ProcessOwnerObservation::Absent => true,
        ProcessOwnerObservation::Running { start_time } => {
            saved_start.is_none_or(|saved| saved != start_time)
        }
        ProcessOwnerObservation::Unknown => false,
    }
}

fn dispatch_state(turn: &TurnRow) -> DispatchState {
    if turn.status == TurnStatus::PendingPrompt && turn.dispatch_attempt.is_none() {
        DispatchState::NotSubmitted
    } else {
        DispatchState::Ambiguous
    }
}

fn observe_or_recover_fenced(
    database: &mut SuplexDatabase,
    database_path: &Path,
    harness: &dyn TaskHarness,
    session: &SessionRow,
    native_id: &str,
    turn: &TurnRow,
    owner: &str,
) -> DatabaseResult<(PromptObservation, bool)> {
    let observed = observe_turn(database_path, harness, session, native_id, turn)?;
    if turn.status == TurnStatus::PendingPrompt && turn.dispatch_attempt.is_none() {
        let replayable = observed.retry_allowed;
        return Ok((observed, replayable));
    }
    let Some(attempt) = turn.dispatch_attempt.as_ref() else {
        return Ok((observed, false));
    };
    if turn.status != TurnStatus::Unknown || observed.admission_observed {
        return Ok((observed, false));
    }
    let claimed_at = DateTime::parse_from_rfc3339(&attempt.claimed_at)?;
    if Utc::now()
        .signed_duration_since(claimed_at)
        .num_milliseconds()
        < 30_000
    {
        return Ok((observed, false));
    }
    let directory = session_reader::session_directory(database_path, &session.id)?;
    let recovered = harness.recover_dispatch(
        SessionRef {
            directory: &directory,
            native_session_id: native_id,
        },
        &turn.id,
        &attempt.server_generation,
    )?;
    if recovered.retry_allowed {
        root_session_store::requeue_fenced_prompt(database, turn, attempt, owner, Utc::now())?;
    }
    // A requeued turn is admitted on the next host sweep, after native usage
    // has been observed again. This call's usage was computed before recovery.
    Ok((recovered, false))
}

fn observe_turn(
    database_path: &Path,
    harness: &dyn TaskHarness,
    session: &SessionRow,
    native_id: &str,
    turn: &TurnRow,
) -> DatabaseResult<PromptObservation> {
    let directory = session_reader::session_directory(database_path, &session.id)?;
    let attempt = turn
        .dispatch_attempt
        .as_ref()
        .map(|attempt: &PromptDispatchAttempt| attempt.server_generation.as_str());
    Ok(harness.observe(
        SessionRef {
            directory: &directory,
            native_session_id: native_id,
        },
        &turn.id,
        dispatch_state(turn),
        attempt,
    )?)
}

/// TypeScript `dependencyBlockers`: native work waits until every
/// prerequisite is delivered. `claim_prompt` rechecks this atomically.
fn dependency_blocked(rows: &root_session_store::RootObservationRows) -> bool {
    rows.control.workflow_state.manual_start != Some(true)
        && rows
            .dependencies
            .iter()
            .any(|dependency| dependency.status != TaskStatus::Delivered)
}

/// Record native admission. An execution Suplex cannot identify
/// (TypeScript `executionUncertain`) asks a human to stop its commands.
fn persist_native_admission(
    database: &mut SuplexDatabase,
    turn: &TurnRow,
    observation: &PromptObservation,
) -> DatabaseResult<()> {
    if observation.admission_observed {
        root_session_store::mark_prompted(database, turn, None, Utc::now())?;
    }
    if observation.execution_uncertain {
        root_session_store::require_execution_cleanup(database, turn, Utc::now())?;
    }
    Ok(())
}

fn terminal(state: PromptState) -> bool {
    matches!(
        state,
        PromptState::Completed | PromptState::Error | PromptState::Interrupted
    )
}

fn terminal_state(state: PromptState) -> &'static str {
    match state {
        PromptState::Completed => "completed",
        PromptState::Error => "error",
        PromptState::Interrupted => "interrupted",
        PromptState::Running => "running",
        PromptState::Unknown => "unknown",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalObservation<'a> {
    state: &'static str,
    native: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interrupted_execution: Option<InterruptedExecution>,
    text: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InterruptedExecution {
    stopped_server_generation: String,
}

fn stopped_generation(directory: &Path, turn: &TurnRow) -> DatabaseResult<String> {
    let record_path = turn.dispatch_attempt.as_ref().map_or_else(
        || directory.join("turn.json"),
        |attempt| directory.join(format!("dispatch-{}.json", attempt.server_generation)),
    );
    let record = crate::runtimes::headless::read_record(&record_path)?
        .ok_or_else(|| TaskError::internal("Interrupted native dispatch record is missing"))?;
    if record.turn_id != turn.id {
        return Err(TaskError::internal("Interrupted native dispatch record changed").into());
    }
    Ok(record.generation)
}

fn terminal_observation<'a>(
    observation: &PromptObservation,
    native: serde_json::Value,
    text: &'a str,
    directory: &Path,
    turn: &TurnRow,
) -> DatabaseResult<TerminalObservation<'a>> {
    let interrupted_execution = (observation.state == PromptState::Interrupted)
        .then(|| stopped_generation(directory, turn))
        .transpose()?
        .map(|stopped_server_generation| InterruptedExecution {
            stopped_server_generation,
        });
    Ok(TerminalObservation {
        state: terminal_state(observation.state),
        native,
        reason: (observation.state != PromptState::Completed).then_some(observation.reason),
        interrupted_execution,
        text,
    })
}

/// TypeScript `observation.native`, completed by the harness.
fn native_observation(
    harness: &dyn TaskHarness,
    directory: &Path,
    rows: &root_session_store::RootObservationRows,
    kind: &str,
    turn: &TurnRow,
) -> DatabaseResult<serde_json::Value> {
    let profile = selected_profile(rows, kind);
    let provider = task_harness_registry::profile_harness(profile.provider.as_str());
    let agent = format!("suplex-{kind}");
    Ok(harness.native(
        directory,
        &turn.id,
        serde_json::json!({
            "messageID":turn.id,"parentID":turn.id,"providerID":provider,
            "modelID":profile.model,"mode":agent,
            "agent":agent,"cwd":rows.control.worktree_path(),
            "root":rows.control.worktree_path(),
        }),
    )?)
}

/// TypeScript `session.profile ?? control.<role>Profile`.
fn selected_profile<'a>(
    rows: &'a root_session_store::RootObservationRows,
    kind: &str,
) -> &'a TaskProfile {
    let (session, fallback) = if kind == "root" {
        (rows.root.as_ref(), &rows.control.root_profile)
    } else {
        (rows.worker.as_ref(), &rows.control.worker_profile)
    };
    session
        .and_then(|session| session.profile.as_ref())
        .unwrap_or(fallback)
}

fn complete_root_if_terminal(
    database: &mut SuplexDatabase,
    database_path: &Path,
    harness: &dyn TaskHarness,
    session: &SessionRow,
    turn: &TurnRow,
    observation: &PromptObservation,
) -> DatabaseResult<bool> {
    if !terminal(observation.state) || !observation.admission_observed {
        return Ok(false);
    }
    let rows = root_session_store::root_observation_rows(database, &session.task_id)?;
    let directory = session_reader::session_directory(database_path, &session.id)?;
    let text = harness.result_text(&directory, &turn.id)?;
    let native = native_observation(harness, &directory, &rows, "root", turn)?;
    let terminal_observation = terminal_observation(observation, native, &text, &directory, turn)?;
    let continuation = (observation.state == PromptState::Interrupted).then_some("The previous execution stopped before a final response. Its admitted message will not be replayed. Observe current task, worktree and GitHub state, preserve any partial work, and continue from that evidence.");
    let completed = root_session_store::complete_root_turn(
        database,
        &turn.id,
        &serde_json::to_string(&terminal_observation)?,
        continuation,
        Utc::now(),
    )?;
    if completed && observation.state == PromptState::Error {
        let reason = if observation.reason.is_empty()
            || observation.reason == "native_startup_failed" && !text.is_empty()
        {
            text.as_str()
        } else {
            observation.reason
        };
        let question = if observation.reason == "native_startup_failed" {
            format!(
                "Suplex could not start the Coordinator. {reason}. Resolve the problem, then answer to retry."
            )
        } else {
            format!(
                "The agent stopped the Coordinator turn (error). {reason} Can you resolve the failure and continue?"
            )
        };
        root_session_store::ask_human_for_root(
            database,
            &session.task_id,
            &session.id,
            session.generation,
            &question,
            &serde_json::json!([]),
            Utc::now(),
        )?;
    }
    Ok(completed)
}

/// TypeScript `finishTurn` for a Worker or Advisor: the native evidence is read
/// here, and `session_recovery` records the workflow result and Coordinator wake.
fn complete_worker_if_terminal(
    database: &mut SuplexDatabase,
    bound: &BoundSession<'_>,
    turn: &TurnRow,
    observation: &PromptObservation,
    launch: &DelegateLaunch,
) -> DatabaseResult<bool> {
    let (database_path, harness, session, native_id) = (
        bound.host.database_path,
        bound.launch.harness,
        bound.launch.session,
        bound.native_id,
    );
    if !terminal(observation.state) || !observation.admission_observed {
        return Ok(false);
    }
    let rows = root_session_store::root_observation_rows(database, &session.task_id)?;
    let directory = session_reader::session_directory(database_path, &session.id)?;
    let text = harness.result_text(&directory, &turn.id)?;
    let agent = if launch.workflow.advisor.is_some() {
        "suplex-advisor"
    } else {
        "suplex-worker"
    };
    let provider = launch.profile.provider.as_str();
    let native = harness.native(
        &directory,
        &turn.id,
        serde_json::json!({
            "messageID":turn.id,"parentID":turn.id,
            "providerID":task_harness_registry::profile_harness(provider),
            "modelID":launch.profile.model,"mode":agent,
            "agent":agent,"cwd":rows.control.worktree_path(),
            "root":rows.control.worktree_path(),
        }),
    )?;
    let terminal_observation = terminal_observation(observation, native, &text, &directory, turn)?;
    let completed = finish_delegate_turn(
        database,
        database_path,
        TerminalDelegateTurn {
            session,
            native_session_id: native_id,
            turn,
            state: terminal_state(observation.state),
            reason: observation.reason,
            text: &text,
            base: serde_json::to_value(&terminal_observation)?,
        },
    )?;
    if completed && observation.reason == "native_startup_failed" {
        let agent = if launch.workflow.advisor.is_some() {
            "Advisor"
        } else {
            "Worker"
        };
        let reason = if text.is_empty() {
            observation.reason
        } else {
            &text
        };
        root_session_store::ask_human(
            database,
            &session.task_id,
            &format!(
                "Suplex could not start the {agent}. {reason}. Resolve the problem, then answer to retry."
            ),
            &serde_json::json!([]),
            Utc::now(),
        )?;
    }
    Ok(completed)
}

enum LaunchPlan<'a> {
    Root,
    Delegate(&'a str),
}

/// The host inputs for recovering one task's native sessions.
struct RecoveryHost<'a> {
    database_path: &'a Path,
    artifact_root: &'a Path,
    task_id: &'a str,
    executable: Option<&'a Path>,
    inherited_environment: &'a HashMap<String, String>,
    usage: ObservedTaskLimitUsage,
}

/// One session whose operation this host claimed, with its launch profile.
struct SessionLaunch<'a> {
    rows: &'a root_session_store::RootObservationRows,
    session: &'a SessionRow,
    delegate: Option<&'a DelegateLaunch>,
    profile: &'a TaskProfile,
    harness: &'a dyn TaskHarness,
    owner: &'a str,
}

/// A claimed session bound to its native session.
struct BoundSession<'a> {
    host: &'a RecoveryHost<'a>,
    launch: &'a SessionLaunch<'a>,
    native_id: &'a str,
}

/// A pending turn after native observation.
enum PendingTurn {
    /// Native evidence settled the turn; nothing is dispatched.
    Settled(PromptObservation),
    /// Native evidence proves the turn was not admitted; it may be dispatched.
    Dispatchable(PromptObservation, Box<TurnRow>),
}

/// The current session of the plan and its first pending turn, when the host
/// may recover it now.
fn recoverable_session(
    database: &SuplexDatabase,
    task_id: &str,
    plan: &LaunchPlan<'_>,
) -> DatabaseResult<Option<(SessionRow, TurnRow)>> {
    let root = matches!(plan, LaunchPlan::Root);
    let session = match plan {
        LaunchPlan::Root => root_session_store::current_root(database, task_id)?,
        LaunchPlan::Delegate(slot) => {
            root_session_store::current_delegate(database, task_id, slot)?
        }
    };
    let Some(session) = session else {
        return Ok(None);
    };
    if root {
        root_session_store::assert_current_root(
            database,
            task_id,
            &session.id,
            session.generation,
        )?;
        if !root_session_store::worker_replacement_ready(database, &session.id)? {
            return Ok(None);
        }
    }
    let Some(turn) = root_session_store::pending_turns(database, &session.id)?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    if !root && !root_session_store::worker_replacement_ready(database, &session.id)? {
        return Ok(None);
    }
    Ok(Some((session, turn)))
}

/// Claim the session operation for this process. None when another live
/// owner runs it or this process cannot identify itself.
fn claim_operation(
    database: &mut SuplexDatabase,
    session: &SessionRow,
) -> DatabaseResult<Option<String>> {
    if current_owner_still_running(session) {
        return Ok(None);
    }
    let Some(self_identity) = inspect_process(std::process::id()) else {
        return Ok(None);
    };
    let owner = Uuid::new_v4().to_string();
    let claimed = root_session_store::claim_session_operation(
        database,
        session,
        &owner,
        i64::from(self_identity.pid),
        &self_identity.start_time,
        Utc::now(),
    )?;
    Ok(claimed.then_some(owner))
}

impl BoundSession<'_> {
    fn complete(
        &self,
        database: &mut SuplexDatabase,
        turn: &TurnRow,
        observation: &PromptObservation,
    ) -> DatabaseResult<bool> {
        let launch = self.launch;
        match launch.delegate {
            Some(delegate) => {
                complete_worker_if_terminal(database, self, turn, observation, delegate)
            }
            None => complete_root_if_terminal(
                database,
                self.host.database_path,
                launch.harness,
                launch.session,
                turn,
                observation,
            ),
        }
    }

    /// Record native admission and a terminal result.
    fn record(
        &self,
        database: &mut SuplexDatabase,
        turn: &TurnRow,
        observation: PromptObservation,
    ) -> DatabaseResult<PromptObservation> {
        persist_native_admission(database, turn, &observation)?;
        self.complete(database, turn, &observation)?;
        Ok(observation)
    }

    /// Observe the pending turn. An unadmitted idle Root turn coalesces into
    /// the next pending turn, which is observed in its place.
    fn observe_pending(
        &self,
        database: &mut SuplexDatabase,
        mut turn: TurnRow,
    ) -> DatabaseResult<PendingTurn> {
        let launch = self.launch;
        loop {
            let (before, replayable) = observe_or_recover_fenced(
                database,
                self.host.database_path,
                launch.harness,
                launch.session,
                self.native_id,
                &turn,
                launch.owner,
            )?;
            if !before.retry_allowed || !replayable {
                return Ok(PendingTurn::Settled(self.record(database, &turn, before)?));
            }
            if launch.delegate.is_some()
                || !root_session_store::coalesce_unadmitted_idle_root_turn(
                    database,
                    &turn.id,
                    Utc::now(),
                )?
            {
                return Ok(PendingTurn::Dispatchable(before, Box::new(turn)));
            }
            let Some(next) = root_session_store::pending_turns(database, &launch.session.id)?
                .into_iter()
                .next()
            else {
                return Ok(PendingTurn::Settled(before));
            };
            turn = next;
        }
    }
}

/// Bind the native session, observe the pending turn, and dispatch it only
/// when native evidence proves it was not admitted.
fn dispatch_claimed(
    database: &mut SuplexDatabase,
    host: &RecoveryHost<'_>,
    launch: &SessionLaunch<'_>,
    turn: TurnRow,
) -> DatabaseResult<PromptObservation> {
    let (rows, session, profile, harness) =
        (launch.rows, launch.session, launch.profile, launch.harness);
    let (database_path, task_id) = (host.database_path, host.task_id);
    let native_id = session
        .native_session_id
        .clone()
        .unwrap_or_else(|| harness.new_session_id());
    if !root_session_store::bind_native_session(database, session, &native_id, Utc::now())? {
        return Err(TaskError::internal(if launch.delegate.is_none() {
            "Native Root session changed before dispatch"
        } else {
            "Native Worker session changed before dispatch"
        })
        .into());
    }
    let bound = BoundSession {
        host,
        launch,
        native_id: &native_id,
    };
    let worktree = rows.control.worktree_path();
    let project_scope = project_launch_scope(
        &rows.context["configuration"],
        &rows.context["issueContext"],
        database_path,
        task_id,
    );
    let identity = RootIdentity {
        task_id: task_id.to_owned(),
        session_id: session.id.clone(),
        generation: session.generation,
    };
    let scope = worktree.map(|worktree| TaskScope {
        database_path,
        artifact_root: host.artifact_root,
        task_id,
        session_id: &session.id,
        native_session_id: &native_id,
        workflow: launch.delegate.map_or(
            WorkflowLaunch {
                workflow_root: rows.control.workflow != Workflow::Standard,
                ..WorkflowLaunch::default()
            },
            |delegate| delegate.workflow,
        ),
        role: launch
            .delegate
            .map_or(TaskRole::Root(&identity), |delegate| {
                TaskRole::Worker(delegate.purpose)
            }),
        worktree: Path::new(worktree),
        model: profile.model.as_str(),
        reasoning_effort: profile.reasoning_level.as_str(),
        instance_home_directory: profile.instance_home_directory().map(Path::new),
        project_mcp: project_mcp(rows),
        project_context_path: project_scope.context_path.as_deref(),
        project_environment: &project_scope.environment,
        excluded_environment_keys: &project_scope.excluded_keys,
        executable: host.executable,
        inherited_environment: host.inherited_environment,
    });
    // TypeScript `ensureSession`: a runtime restarts what it needs, such as a lost OpenCode server, before observation.
    if let Some(scope) = &scope {
        harness.ensure_session(scope)?;
    }
    let (before, turn) = match bound.observe_pending(database, turn)? {
        PendingTurn::Settled(observation) => return Ok(observation),
        PendingTurn::Dispatchable(before, turn) => (before, *turn),
    };
    if dependency_blocked(rows) {
        return Ok(before);
    }
    let turn = match launch.delegate {
        None => root_session_store::refresh_pending_root_dependency_context(
            database,
            &turn.id,
            Utc::now(),
        )?,
        Some(_) => turn,
    };
    let scope = scope.ok_or_else(|| TaskError::Failure {
        status: 409,
        code: "worktree_missing",
        message: "The task has no worktree".into(),
    })?;
    let prompt = task_context_prompt(
        &turn.prompt_text,
        project_scope.context.as_deref(),
        project_scope.context_path.as_deref(),
    );
    // A refused claim is not a failure: another dispatcher admitted the prompt,
    // or the task stopped being dispatchable. The next sweep observes the result.
    let mut refused = false;
    let dispatched = harness.dispatch(&scope, &turn.id, &prompt, &mut |server_generation| {
        let claimed = root_session_store::claim_prompt(
            database,
            &turn,
            launch.owner,
            server_generation,
            host.usage,
            Utc::now(),
        )?;
        refused = !claimed;
        Ok(claimed)
    });
    if refused {
        return Ok(before);
    }
    bound.record(database, &turn, dispatched?)
}

fn recover_session_blocking(
    database: &mut SuplexDatabase,
    host: &RecoveryHost<'_>,
    plan: LaunchPlan<'_>,
) -> DatabaseResult<Option<PromptObservation>> {
    let task_id = host.task_id;
    let Some((session, turn)) = recoverable_session(database, task_id, &plan)? else {
        return Ok(None);
    };
    let rows = root_session_store::root_observation_rows(database, task_id)?;
    let delegate = matches!(plan, LaunchPlan::Delegate(_))
        .then(|| delegate_launch(&rows, &session.id, &turn.id));
    let profile = delegate.as_ref().map_or_else(
        || selected_profile(&rows, "root"),
        |delegate| &delegate.profile,
    );
    let provider = profile.provider.as_str();
    // TypeScript `HarnessRouter.forScope`.
    let harness = task_harness_registry::for_profile(provider)
        .ok_or_else(|| TaskError::internal(format!("No task harness for {provider}")))?;
    let Some(owner) = claim_operation(database, &session)? else {
        return Ok(None);
    };
    let launch = SessionLaunch {
        rows: &rows,
        session: &session,
        delegate: delegate.as_ref(),
        profile,
        harness,
        owner: &owner,
    };
    let result = dispatch_claimed(database, host, &launch, turn);
    root_session_store::release_session_operation(database, &session.id, &owner, Utc::now())?;
    result.map(Some)
}

/// Observe native evidence first, then dispatch only a turn whose absence is
/// proven. A claimed ambiguous turn is never replayed after restart.
pub async fn recover_prepared_root(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<Option<PromptObservation>> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let usage = if needs_admission_usage(&database, task_id, "root")? {
        observed_usage(&mut database, database_path, task_id, false).await?
    } else {
        ObservedTaskLimitUsage {
            estimated_cost_usd: None,
        }
    };
    let database_path = database_path.to_path_buf();
    let artifact_root = artifact_root.to_path_buf();
    let task_id = task_id.to_owned();
    let executable: Option<PathBuf> = executable.map(Path::to_path_buf);
    let inherited_environment = inherited_environment.clone();
    tokio::task::spawn_blocking(move || {
        let host = RecoveryHost {
            database_path: &database_path,
            artifact_root: &artifact_root,
            task_id: &task_id,
            executable: executable.as_deref(),
            inherited_environment: &inherited_environment,
            usage,
        };
        recover_session_blocking(&mut database, &host, LaunchPlan::Root)
            .map_err(|error| error.to_string())
    })
    .await?
    .map_err(|error| TaskError::internal(error).into())
}

/// TypeScript `scope` for one delegate session: its captured profile, and the
/// Advisor role or Worker mode and purpose of its pending turn.
struct DelegateLaunch {
    profile: TaskProfile,
    purpose: WorkerPurpose,
    workflow: WorkflowLaunch,
}

fn delegate_launch(
    rows: &root_session_store::RootObservationRows,
    session_id: &str,
    turn_id: &str,
) -> DelegateLaunch {
    let session = rows.session(session_id);
    let profile = session.map_or(&rows.control.worker_profile, |session| {
        rows.profile_of(session)
    });
    let input = rows
        .turns
        .iter()
        .find(|turn| turn.id == turn_id)
        .and_then(|turn| workflows::turn_workflow_input(&rows.sessions, turn))
        .filter(|input| input["kind"] == "worker");
    DelegateLaunch {
        profile: profile.clone(),
        purpose: if input.is_some_and(|input| input["purpose"] == "verification") {
            WorkerPurpose::Verification
        } else {
            WorkerPurpose::Implementation
        },
        workflow: WorkflowLaunch {
            workflow_root: false,
            direct: input.is_some_and(|input| input["mode"] == "direct"),
            advisor: session.and_then(|session| session.advisor_role),
        },
    }
}

pub async fn recover_prepared_worker(
    database_path: &Path,
    artifact_root: &Path,
    task_id: &str,
    executable: Option<&Path>,
    inherited_environment: &HashMap<String, String>,
) -> DatabaseResult<Option<PromptObservation>> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let usage = if needs_admission_usage(&database, task_id, "worker")? {
        observed_usage(&mut database, database_path, task_id, false).await?
    } else {
        ObservedTaskLimitUsage {
            estimated_cost_usd: None,
        }
    };
    let database_path = database_path.to_path_buf();
    let artifact_root = artifact_root.to_path_buf();
    let task_id = task_id.to_owned();
    let executable = executable.map(Path::to_path_buf);
    let inherited_environment = inherited_environment.clone();
    // TypeScript `recover` resumes every current delegate: the serial Worker or
    // Advisor slot and both Combined planning slots.
    tokio::task::spawn_blocking(move || {
        let host = RecoveryHost {
            database_path: &database_path,
            artifact_root: &artifact_root,
            task_id: &task_id,
            executable: executable.as_deref(),
            inherited_environment: &inherited_environment,
            usage,
        };
        let mut first = None;
        for slot in ["delegate", "planner_a", "planner_b"] {
            let observed =
                recover_session_blocking(&mut database, &host, LaunchPlan::Delegate(slot))
                    .map_err(|error| error.to_string())?;
            first = first.or(observed);
        }
        Ok::<_, String>(first)
    })
    .await?
    .map_err(|error| TaskError::internal(error).into())
}

/// A session whose stop was requested and not yet observed: id, native id,
/// and launch owner process id and start time.
type RetiredSession = (String, Option<String>, Option<i64>, Option<String>);

fn retired_sessions(
    database: &SuplexDatabase,
    task_id: &str,
) -> DatabaseResult<Vec<RetiredSession>> {
    Ok(database
        .connection()
        .prepare(
            "SELECT id,native_session_id,launch_owner_pid,launch_owner_start_time FROM suplex_task_sessions WHERE task_id = ?1 AND stop_requested_at IS NOT NULL AND stopped_at IS NULL",
        )?
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Stop one retired session's native process. None when its launch owner may
/// still own it; otherwise the native stop result.
async fn stop_retired_session(
    database_path: &Path,
    session: RetiredSession,
) -> DatabaseResult<Option<io::Result<()>>> {
    let (session_id, native_id, owner_pid, owner_start) = session;
    if let Some(pid) = owner_pid.and_then(|pid| u32::try_from(pid).ok())
        && !retired_owner_can_stop(owner_start.as_deref(), observe_process_owner(pid))
    {
        return Ok(None);
    }
    let directory = session_reader::session_directory(database_path, &session_id)?;
    let stopped = tokio::task::spawn_blocking(move || {
        match task_harness_registry::for_session(native_id.as_deref()) {
            Some(harness) => harness.stop(&directory, native_id.as_deref()),
            // An unbound session never started a native process.
            None if native_id.is_none() => Ok(()),
            None => Err(io::Error::other("No task harness for session")),
        }
    })
    .await?;
    Ok(Some(stopped))
}

/// Record every session whose native stop Suplex observed.
fn mark_sessions_stopped(database: &SuplexDatabase, stopped: Vec<String>) -> DatabaseResult<()> {
    for session_id in stopped {
        let time = now_millis_rfc3339();
        database.connection().execute(
            "UPDATE suplex_task_sessions SET stopped_at = ?1, launch_owner = NULL, launch_owner_pid = NULL, launch_owner_start_time = NULL, launch_claimed_at = NULL, updated_at = ?1 WHERE id = ?2 AND stop_requested_at IS NOT NULL AND stopped_at IS NULL",
            rusqlite::params![time, session_id],
        )?;
    }
    Ok(())
}

pub(crate) async fn stop_retired_sessions(
    database: &mut SuplexDatabase,
    database_path: &Path,
    task_id: &str,
) -> DatabaseResult<()> {
    let sessions = retired_sessions(database, task_id)?;
    let outstanding_count = sessions.len();
    let mut stopped = Vec::new();
    let mut failures = Vec::new();
    for session in sessions {
        let session_id = session.0.clone();
        match stop_retired_session(database_path, session).await? {
            Some(Ok(())) => stopped.push(session_id),
            Some(Err(error)) => failures.push(error.to_string()),
            None => {}
        }
    }
    let (status, worktree): (TaskStatus, Option<String>) = {
        database.connection().query_row(
            "SELECT status,json_extract(worktree_json,'$.path') FROM suplex_task_controls WHERE task_id = ?1",
            [task_id], |row| Ok((row.get(0)?,row.get(1)?)),
        )?
    };
    if failures.is_empty()
        && status == TaskStatus::Cancelled
        && !stopped.is_empty()
        && outstanding_count == stopped.len()
        && let Some(path) = worktree
    {
        tokio::task::spawn_blocking(move || processes::stop_worktree_processes(Path::new(&path)))
            .await??;
    }
    mark_sessions_stopped(database, stopped)?;
    if !failures.is_empty() && matches!(status, TaskStatus::Cancelled | TaskStatus::Delivered) {
        return Err(TaskError::internal(format!(
            "Some agent sessions could not be stopped: {}",
            failures.join("; ")
        ))
        .into());
    }
    Ok(())
}

#[cfg(test)]
include!("../../tests/coordination/host.rs");

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        delivery::operations::{self, WorkflowCompletion},
        identity::auth,
        tasks::{
            repository::{self, PreparedTask, TaskCreator},
            worktree::LocalRevisionObservation,
        },
    };
    use std::path::PathBuf;

    const PROFILE: &str = r#"{"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}"#;

    fn sha(letter: char) -> String {
        letter.to_string().repeat(40)
    }

    fn range() -> ReviewRange {
        ReviewRange {
            base_sha: sha('a'),
            head_sha: sha('b'),
            files: vec!["a.txt".into()],
            commits: vec![sha('b')],
            patch_digest: Some("d".repeat(64)),
        }
    }

    /// One active task in the given workflow with a reserved Coordinator.
    fn fixture(workflow: &str) -> (PathBuf, SuplexDatabase, SessionRow) {
        let directory =
            std::env::temp_dir().join(format!("suplex-workflow-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut database =
            SuplexDatabase::open(&directory.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_flow','Flow','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('project_flow','company_flow','Flow','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker','{}',?1,?1)", [&stamp]).unwrap();
        let profile: Value = serde_json::from_str(PROFILE).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "company_flow".into(), project_id: "project_flow".into(),
            title: "Workflow task".into(), description: "Exercise the workflow".into(),
            configuration: json!({"branch":"task-flow","baseBranch":"main","visualEvidence":"off"}),
            idempotency_key: "workflow-1".into(), request_hash: "workflow-hash".into(),
            creator: TaskCreator::User(user.id), delivery_target: "local_worktree".into(),
            delivery_intent: serde_json::from_value(json!({"repository":"owner/repo","headBranch":"task-flow","baseBranch":"main","baselineSha":"head","pullRequestNumber":null})).unwrap(),
            root_profile: serde_json::from_value(profile.clone()).unwrap(), worker_profile: serde_json::from_value(profile).unwrap(), advisor_profiles: serde_json::from_value(json!({})).unwrap(), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![], workflow: crate::coordination::workflows::Workflow::Standard,
        }, now).unwrap().task;
        database.connection().execute("UPDATE suplex_task_controls SET workflow = ?1, worktree_json = ?2 WHERE task_id = ?3", params(workflow, &task.id)).unwrap();
        let root = root_session_store::reserve_root(&mut database, &task.id, now).unwrap();
        (directory, database, root)
    }

    fn params<'a>(workflow: &'a str, task_id: &'a str) -> (&'a str, String, &'a str) {
        (workflow, json!({"path":"/tmp/task-flow","branch":"task-flow","baseSha":sha('a'),"headSha":sha('b'),"dirty":false}).to_string(), task_id)
    }

    fn advisor_input(role: &str, pair: Option<&str>) -> Value {
        let mut input = json!({"kind":"advisor","role":role,"range":range(),"evidenceDirectory":"/tmp/evidence_1","evidenceSha256":"e".repeat(64),"verificationTurnIds":[]});
        if let Some(pair) = pair {
            input["plannerPairId"] = json!(pair);
        }
        input
    }

    fn record(
        database: &mut SuplexDatabase,
        session: &SessionRow,
        receipt: &str,
        observation: &Value,
        review: Option<&Value>,
    ) -> Option<TurnRow> {
        root_session_store::record_standard_worker_result_and_wake(
            database,
            &StandardWorkerResult {
                task_id: &session.task_id,
                session_id: &session.id,
                generation: session.generation,
                receipt_id: receipt,
                observation: &observation.to_string(),
                native_turn_id: None,
                wake_prompt: "Advisor wake",
                review,
            },
            Utc::now(),
        )
        .unwrap()
    }

    #[test]
    fn planner_pair_reserves_both_roles_and_wakes_coordinator_once_both_settle() {
        let (directory, mut database, root) = fixture("competing_plans");
        let pair = "pair_1";
        let (a, b) = (
            advisor_input("planner_a", Some(pair)),
            advisor_input("planner_b", Some(pair)),
        );
        let [plan_a, plan_b] = root_session_store::launch_planner_pair(
            &mut database,
            &root,
            pair,
            [("Plan A prompt", &a), ("Plan B prompt", &b)],
            Utc::now(),
        )
        .unwrap();
        assert_eq!(
            (plan_a.advisor_role, plan_b.delegate_slot.as_deref()),
            (Some(AdvisorRole::PlannerA), Some("planner_b"))
        );
        assert_ne!(plan_a.id, plan_b.id);
        assert!(
            root_session_store::launch_advisor(
                &mut database,
                &root,
                "planner_a",
                "Retry",
                &advisor_input("planner_a", None),
                Utc::now()
            )
            .unwrap_err()
            .to_string()
            .contains("worker_already_assigned")
        );
        let report = |role: &str| json!({"state":"completed","text":"Plan","advisor":{"role":role,"result":{"summary":"Plan","role":role},"invalidReason":null}});
        assert!(
            record(
                &mut database,
                &plan_a,
                "a:1:completed",
                &report("planner_a"),
                None
            )
            .is_none()
        );
        let wake = record(
            &mut database,
            &plan_b,
            "b:1:completed",
            &report("planner_b"),
            None,
        )
        .unwrap();
        assert!(wake.prompt_text.starts_with(&format!(
            "Combined planning pair {pair} completed. Plan A session {} and Plan B session {}",
            plan_a.id.as_str(),
            plan_b.id.as_str()
        )));
        assert!(wake.prompt_text.contains("Both reports are valid."));
        assert!(
            record(
                &mut database,
                &plan_b,
                "b:1:completed",
                &report("planner_b"),
                None
            )
            .is_none()
        );
        let other = root_session_store::launch_planner_pair(
            &mut database,
            &root,
            "pair_2",
            [("A", &a), ("B", &b)],
            Utc::now(),
        );
        assert!(
            other
                .unwrap_err()
                .to_string()
                .contains("invalid_planner_pair")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn approve_then_build_gates_the_first_build_on_the_durable_approved_plan() {
        use crate::coordination::root_controller::{WorkerAssignment, check_plan_approval};
        let (directory, mut database, root) = fixture("approve_then_build");
        let task_id = root.task_id.clone();
        let assignment = |plan: &str, purpose: &str| WorkerAssignment {
            plan: Some(plan.into()),
            acceptance_criteria: vec!["Done".into()],
            instruction: "Build".into(),
            mode: "planned".into(),
            purpose: purpose.into(),
            advisor_turn_id: None,
            advisor_session_id: None,
            candidate_turn_ids: None,
            candidate_session_ids: None,
        };
        // Every read reopens the database, so the decision uses only durable rows.
        let path = directory.join("suplex.sqlite");
        let rows = || {
            let database = SuplexDatabase::open(&path, OpenMode::ReadWrite).unwrap();
            root_session_store::root_observation_rows(&database, &task_id).unwrap()
        };
        let gate = |plan: &str, purpose: &str| {
            check_plan_approval(
                &rows(),
                Workflow::ApproveThenBuild,
                &assignment(plan, purpose),
            )
            .map_err(|error| error.to_string())
        };
        let ask = |database: &mut SuplexDatabase, plan: &str| {
            assert!(
                root_session_store::request_plan_approval_for_root(
                    database,
                    &root.task_id,
                    &root.id,
                    root.generation,
                    plan,
                    Utc::now()
                )
                .unwrap()
            );
            rows().control.human_question_id.unwrap()
        };
        let answer = |database: &mut SuplexDatabase, question: &str, text: &str| {
            root_session_store::answer_human(
                database,
                &root.task_id,
                question,
                text,
                false,
                None,
                Utc::now(),
            )
            .unwrap();
            rows().turns.last().unwrap().prompt_text.clone()
        };
        assert!(
            gate("Plan A", "implementation")
                .unwrap_err()
                .contains("request_plan_approval")
        );
        assert_eq!(gate("Check", "verification"), Ok(()));

        let question = ask(&mut database, "  Plan A  ");
        let waiting = rows().control;
        assert_eq!(waiting.status, TaskStatus::WaitingHuman);
        assert!(waiting.human_question.unwrap().ends_with("\n\nPlan A"));
        let prompt = answer(&mut database, &question, "Add a migration test.");
        assert!(
            prompt.contains("\"planApproval\":\"changes_requested\""),
            "{prompt}"
        );
        assert!(prompt.contains("Add a migration test."));
        assert!(
            gate("Plan A", "implementation")
                .unwrap_err()
                .contains("request_plan_approval")
        );

        let question = ask(&mut database, "Plan B");
        let prompt = answer(
            &mut database,
            &question,
            "Approve the plan: Worker starts the build with this plan.",
        );
        assert!(prompt.contains("\"planApproval\":\"approved\""), "{prompt}");
        assert_eq!(gate("Plan B", "implementation"), Ok(()));
        assert!(
            gate("Plan C", "implementation")
                .unwrap_err()
                .contains("not the plan the user approved")
        );

        // A newer request replaces only the proposed plan; the approved plan stays.
        let question = ask(&mut database, "Plan C");
        let approval = rows().control.workflow_state.plan_approval.unwrap();
        assert_eq!(
            (approval.proposed.as_str(), approval.approved.as_deref()),
            ("Plan C", Some("Plan B"))
        );
        assert!(gate("Plan C", "implementation").is_err());
        answer(&mut database, &question, "Keep plan B.");

        let input = json!({"kind":"worker","version":2,"mode":"planned","purpose":"implementation","range":range(),"plan":"Plan B"});
        let worker = root_session_store::launch_standard_worker(
            &mut database,
            &root,
            "Build",
            "Build",
            Some(&input),
            Utc::now(),
        )
        .unwrap();
        assert!(
            workflows::workflow_ready_for_delivery(
                Workflow::ApproveThenBuild,
                &rows().control.workflow_state,
                &rows().sessions,
                &rows().turns,
                &range()
            )
            .is_err()
        );
        record(
            &mut database,
            &worker,
            "w:1:completed",
            &json!({"state":"completed","text":"Built"}),
            None,
        )
        .unwrap();
        assert_eq!(gate("Repair the test", "implementation"), Ok(()));
        let after = rows();
        assert_eq!(
            workflows::workflow_ready_for_delivery(
                Workflow::ApproveThenBuild,
                &after.control.workflow_state,
                &after.sessions,
                &after.turns,
                &range()
            ),
            Ok(())
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rater_results_keep_their_launch_range_and_duplicates_add_no_record() {
        let (directory, mut database, root) = fixture("refine_pull_request");
        let rater = root_session_store::launch_advisor(
            &mut database,
            &root,
            "rater",
            "Rate the pull request",
            &advisor_input("rater", None),
            Utc::now(),
        )
        .unwrap();
        assert_eq!(
            (rater.advisor_role, rater.delegate_slot.as_deref()),
            (Some(AdvisorRole::Rater), Some("delegate"))
        );
        assert_eq!(
            rater.profile.as_ref().unwrap().profile_id,
            "profile_root",
            "an Advisor defaults to the Coordinator profile"
        );
        let invalid = json!({"result":null,"invalidReason":"The report has no JSON object"});
        let observation = json!({"state":"completed","text":"No JSON","advisor":{"role":"rater","result":null,"invalidReason":"The report has no JSON object"}});
        assert!(
            record(
                &mut database,
                &rater,
                "r:1:completed",
                &observation,
                Some(&invalid)
            )
            .is_some()
        );
        assert!(
            record(
                &mut database,
                &rater,
                "r:1:completed",
                &observation,
                Some(&invalid)
            )
            .is_none()
        );
        let state = serde_json::to_value(
            root_session_store::workflow_state(&database, rater.task_id.as_str()).unwrap(),
        )
        .unwrap();
        let reviews = state["reviews"].as_array().unwrap();
        assert_eq!(reviews.len(), 1);
        assert_eq!(
            (reviews[0]["range"].clone(), reviews[0]["result"].clone()),
            (json!(range()), Value::Null)
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_failed_reviewer_turn_records_an_invalid_review_and_wakes_coordinator() {
        let (directory, mut database, root) = fixture("independent_review");
        let reviewer = root_session_store::launch_advisor(
            &mut database,
            &root,
            "reviewer",
            "Review",
            &advisor_input("reviewer", None),
            Utc::now(),
        )
        .unwrap();
        let session = root_session_store::current_worker(&database, &root.task_id)
            .unwrap()
            .unwrap();
        let turn = root_session_store::pending_turns(&database, &session.id)
            .unwrap()
            .remove(0);
        let database_path = directory.join("suplex.sqlite");
        assert!(
            finish_delegate_turn(
                &mut database,
                &database_path,
                TerminalDelegateTurn {
                    session: &session,
                    native_session_id: "codex-review",
                    turn: &turn,
                    state: "error",
                    reason: "native_error",
                    text: "",
                    base: json!({"state":"error","native":{},"reason":"native_error","text":""}),
                }
            )
            .unwrap()
        );
        let state = serde_json::to_value(
            root_session_store::workflow_state(&database, &root.task_id).unwrap(),
        )
        .unwrap();
        assert_eq!(
            state["reviews"][0]["invalidReason"],
            "The Reviewer turn ended with state error (native_error)"
        );
        let rows = root_session_store::root_observation_rows(&database, &root.task_id).unwrap();
        let wake = rows
            .turns
            .iter()
            .rev()
            .find(|turn| turn.session_id == root.id.as_str())
            .unwrap();
        assert!(wake.prompt_text.as_str().starts_with(&format!(
            "Reviewer result codex-review:{}:error. The Reviewer report was not accepted",
            turn.id
        )));
        assert_eq!(
            reviewer
                .advisor_role
                .map(super::super::advisor_bridge::AdvisorRole::as_str),
            Some("reviewer")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_workflow_completion_requires_the_review_for_the_exact_range() {
        let (directory, mut database, root) = fixture("independent_review");
        let local = LocalRevisionObservation {
            branch: "task-flow".into(),
            head_sha: sha('b'),
            tree_sha: sha('c'),
            clean: true,
        };
        let complete = |database: &mut SuplexDatabase| {
            operations::complete_workflow_delivery(
                database,
                &root.task_id,
                &range(),
                &local,
                None,
                false,
                |_| Ok(()),
            )
            .unwrap()
        };
        assert!(matches!(
            complete(&mut database),
            WorkflowCompletion::Declined {
                code: "workflow_review_required",
                ..
            }
        ));
        let dirty = LocalRevisionObservation {
            clean: false,
            ..local.clone()
        };
        assert!(matches!(
            operations::complete_workflow_delivery(
                &mut database,
                &root.task_id,
                &range(),
                &dirty,
                None,
                false,
                |_| Ok(())
            )
            .unwrap(),
            WorkflowCompletion::Declined {
                code: "worktree_dirty",
                ..
            }
        ));
        root_session_store::update_workflow_state(&mut database, &root.task_id, Utc::now(), |state| {
            state.reviews = serde_json::from_value(json!([{"sessionId":"s","turnId":"t","role":"reviewer","range":range(),"result":{"role":"reviewer","approved":true,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"},"invalidReason":null,"recordedAt":"2026-09-25T00:00:00.000Z"}])).unwrap();
        }).unwrap();
        assert!(
            operations::complete_workflow_delivery(
                &mut database,
                &root.task_id,
                &range(),
                &local,
                None,
                false,
                |_| Err("task_tool_owner_lost".into())
            )
            .is_err(),
            "a lost owner writes nothing"
        );
        assert_eq!(complete(&mut database), WorkflowCompletion::Completed);
        let rows = root_session_store::root_observation_rows(&database, &root.task_id).unwrap();
        assert_eq!(
            rows.control.status,
            crate::tasks::control::TaskStatus::Delivered
        );
        assert_eq!(
            serde_json::json!(rows.control.workflow_state)["completion"]["reviewedHead"],
            sha('b')
        );
        assert_eq!(complete(&mut database), WorkflowCompletion::Already);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
