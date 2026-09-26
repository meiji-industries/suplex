//! TypeScript `RootController`: Root operations for every workflow.

use super::CoordinationError;
use crate::shared::hash::sha256_hex;
use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};

use crate::{
    delivery::operations::DeliveryOperations,
    http::contracts::typed::tasks::TaskWorkerReplacementBody,
    platform::{
        artifacts,
        database::{DatabaseResult, OpenMode, SuplexDatabase},
    },
    runtimes::{task_harness::ReaderSession, task_harness_registry},
    tasks::worktree,
};

use super::{
    advisor_evidence,
    root_bridge::RootIdentity,
    root_prompts::{self, WorkerAssignmentText},
    root_session_store::{self, RootObservationRows, RootSession},
    worker_evidence::{self, EvidenceQuery},
    workflows::{
        ReviewRange, advisor_label, latest_review, same_range, turn_outcome, turn_workflow_input,
        workflow_definition,
    },
};

/// TypeScript `WorkerAssignment` after the Root tool contract validated it.
pub struct WorkerAssignment {
    pub plan: Option<String>,
    pub acceptance_criteria: Vec<String>,
    pub instruction: String,
    pub mode: String,
    pub purpose: String,
    pub advisor_turn_id: Option<String>,
    pub advisor_session_id: Option<String>,
    pub candidate_turn_ids: Option<[String; 2]>,
    pub candidate_session_ids: Option<[String; 2]>,
}

const DELEGATED_NEXT: &str = "End this Coordinator turn now. Suplex will send the Worker's native result as a new turn on this same session. Do not poll or wait inside this turn.";
const REPLACED_NEXT: &str = "End this Coordinator turn. Suplex will stop the outgoing execution before starting this fresh Worker. Existing task limits remain in effect.";

/// Reserve an active Root and persist its first prompt once. Repeated host
/// recovery returns the same session without replaying a completed turn.
pub fn prepare_root(database_path: &Path, task_id: &str) -> DatabaseResult<RootSession> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let root = root_session_store::reserve_root(&mut database, task_id, chrono::Utc::now())?;
    let rows = root_session_store::root_observation_rows(&database, task_id)?;
    let prompt =
        root_prompts::initial_coordinator_prompt(&rows.control, &rows.context, &rows.dependencies)?;
    root_session_store::ensure_initial_prompt(&mut database, &root, &prompt, chrono::Utc::now())?;
    Ok(root)
}

fn invalid(message: &'static str) -> Box<dyn std::error::Error> {
    CoordinationError::refused(message).into()
}

fn completed_worker_turn<'a>(turns: &'a [Value], session_id: &str) -> Option<&'a Value> {
    turns
        .iter()
        .rev()
        .find(|turn| turn["sessionId"] == session_id && turn["status"] == "completed")
}

fn accepted_assignment(turns: &[Value], worker: &Value) -> Option<Value> {
    let id = worker["id"].as_str()?;
    let generation = worker["generation"].as_i64()?;
    let turn = turns
        .iter()
        .rev()
        .find(|turn| turn["sessionId"] == id && turn["generation"] == generation)?;
    let input = turn.get("workflowInput").filter(|value| !value.is_null());
    Some(match input {
        Some(input) if input["kind"] == "worker" => {
            json!({"kind":"workflow_input","input":input})
        }
        _ => json!({"kind":"saved_prompt","prompt":turn["promptText"]}),
    })
}

fn worker_result(turn: &Value) -> Value {
    let observation = turn["terminalObservation"]
        .as_str()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let (state, text, tools_stored, limitation, verification_range) = match observation {
        Some(value) if value.is_object() => (
            value
                .get("state")
                .filter(|item| item.is_string())
                .cloned()
                .unwrap_or(Value::Null),
            value
                .get("text")
                .filter(|item| item.is_string())
                .cloned()
                .unwrap_or(Value::Null),
            value.get("tools").is_some_and(Value::is_array),
            value.get("toolsLimit").cloned().unwrap_or(Value::Null),
            value
                .get("verificationRange")
                .cloned()
                .unwrap_or(Value::Null),
        ),
        _ => (Value::Null, Value::Null, false, Value::Null, Value::Null),
    };
    json!({
        "turnId": turn["id"], "state": state, "text": text,
        "evidence": {"operation":"read_worker_evidence", "toolsStored":tools_stored, "limitation":limitation},
        "verificationRange": verification_range,
    })
}

fn public_control(mut control: Value) -> DatabaseResult<Value> {
    let workflow_state = control
        .get_mut("workflowState")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| invalid("workflow state is missing"))?;
    workflow_state.retain(|key, _| {
        matches!(
            key.as_str(),
            "version" | "reviews" | "acceptedDelivery" | "deliveryWait" | "completion"
        )
    });
    Ok(control)
}

fn assemble_observation(
    rows: RootObservationRows,
    worktree: Value,
    pull_request: Value,
) -> DatabaseResult<Value> {
    let mut results = Map::new();
    for worker in &rows.workers {
        let id = worker["id"]
            .as_str()
            .ok_or_else(|| invalid("worker id is missing"))?;
        let result = completed_worker_turn(&rows.turns, id)
            .map(worker_result)
            .unwrap_or(Value::Null);
        results.insert(id.to_owned(), result);
    }
    let worker_result = rows
        .worker
        .as_ref()
        .and_then(|worker| worker["id"].as_str())
        .and_then(|id| results.get(id))
        .cloned()
        .unwrap_or(Value::Null);
    let accepted = rows
        .worker
        .as_ref()
        .filter(|worker| worker["advisorRole"].is_null())
        .and_then(|worker| accepted_assignment(&rows.turns, worker))
        .unwrap_or(Value::Null);
    Ok(json!({
        "control": public_control(rows.control)?,
        "context": rows.context,
        "dependencies": rows.dependencies,
        "root": rows.root,
        "worker": rows.worker,
        "acceptedAssignment": accepted,
        "workerResult": worker_result,
        "workers": rows.workers,
        "results": results,
        "worktree": worktree,
        "pullRequest": pull_request,
        // Reached only after `delivery::operations::observe` succeeded.
        "github": {"available":true},
    }))
}

/// Observe durable task intent and fresh local Git state for the current Root.
/// A missing Git observation is reported as unknown; it does not gate the task.
pub fn observe(database_path: &Path, root: &RootIdentity) -> DatabaseResult<Value> {
    let rows = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        root_session_store::assert_current_root(
            &database,
            &root.task_id,
            &root.session_id,
            root.generation,
        )?;
        root_session_store::root_observation_rows(&database, &root.task_id)?
    };
    let (pull_request, github) =
        crate::delivery::operations::observe_for_root(database_path, &rows.control)?;
    let worktree = match rows.control["worktree"]["path"].as_str() {
        Some(path) => match worktree::observe_worktree(Path::new(path)) {
            Ok(observed) => json!({"headSha":observed.head_sha,"dirty":observed.dirty}),
            Err(error) => json!({"state":"unknown","error":error.to_string()}),
        },
        None => Value::Null,
    };
    let mut observation = assemble_observation(rows, worktree, pull_request)?;
    observation["github"] = github;
    Ok(observation)
}

/// Return task-owned image bytes to the Root MCP tool after a fresh Root check.
/// The artifact row is scoped by both task and company; the file hash is live
/// evidence that the opaque bytes still match that row.
pub fn read_image(
    database_path: &Path,
    artifact_root: &Path,
    root: &RootIdentity,
    artifact_id: &str,
) -> DatabaseResult<Value> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    let artifact = root_session_store::task_artifact(&database, &root.task_id, artifact_id)?
        .ok_or_else(|| invalid("Task image is not available"))?;
    if !matches!(artifact.kind.as_str(), "task-image" | "delivery-image")
        || !matches!(
            artifact.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
    {
        return Err(invalid("Task image is not available"));
    }
    let bytes = artifacts::read(artifact_root, &artifact.company_id, &artifact.storage_path)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    if sha256_hex(&bytes) != artifact.sha256 {
        return Err(invalid("The task image changed in storage"));
    }
    Ok(
        json!({"kind":"image", "filename":artifact.filename, "mimeType":artifact.mime_type, "data":STANDARD.encode(bytes)}),
    )
}

pub struct WorkerEvidenceRequest {
    pub turn_id: String,
    pub query: EvidenceQuery,
}

/// Read an admitted Worker's native turn log. The log is the evidence source;
/// persisted completion metadata only identifies and describes that turn.
pub fn read_worker_evidence(
    database_path: &Path,
    root: &RootIdentity,
    request: &WorkerEvidenceRequest,
) -> DatabaseResult<Value> {
    let rows = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        root_session_store::assert_current_root(
            &database,
            &root.task_id,
            &root.session_id,
            root.generation,
        )?;
        root_session_store::root_observation_rows(&database, &root.task_id)?
    };
    let turn = rows
        .turns
        .iter()
        .find(|turn| turn["id"] == request.turn_id)
        .ok_or_else(|| invalid("Worker turn does not belong to this task"))?;
    let session = rows
        .sessions
        .iter()
        .find(|session| session["id"] == turn["sessionId"])
        .filter(|session| session["kind"] == "worker" && session["advisorRole"].is_null())
        .ok_or_else(|| invalid("Worker turn does not belong to this task"))?;
    let session_id = session["id"]
        .as_str()
        .ok_or_else(|| invalid("Worker session id is missing"))?;
    let native_session_id = session["nativeSessionId"].as_str().unwrap_or_default();
    // An unbound session is read by its profile provider.
    let provider = session["profile"]["provider"].as_str();
    let reader = Some(native_session_id)
        .filter(|id| !id.is_empty())
        .and_then(task_harness_registry::native_session_reader)
        .or_else(|| {
            task_harness_registry::for_profile(
                provider
                    .or(rows.control["workerProfile"]["provider"].as_str())
                    .unwrap_or_default(),
            )
        });
    let evidence = reader
        .ok_or_else(|| invalid("The native provider is unavailable"))?
        .turn_evidence(
            &ReaderSession {
                database_path,
                session_id,
                native_session_id,
                instance_home_directory: session["profile"]["instanceHomeDirectory"]
                    .as_str()
                    .map(Path::new),
            },
            &request.turn_id,
        )?;
    let (tools, limitation) = match evidence {
        Some(tools) => (tools, Value::Null),
        None => (Vec::new(), json!("The native turn log is missing")),
    };
    let result = worker_evidence::read(&tools, &request.query)?;
    let mut output = result
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("Worker evidence result is invalid"))?;
    output.insert("turnId".into(), json!(request.turn_id));
    output.insert("sessionId".into(), json!(session_id));
    output.insert(
        "localObservation".into(),
        json!({
            "status":turn["status"],
            "terminalObservationAvailable":!turn["terminalObservation"].is_null(),
            "nativeTurnIdAvailable":!turn["nativeTurnId"].is_null(),
        }),
    );
    output.insert("limitation".into(), limitation);
    Ok(Value::Object(output))
}

/// Before an external mutation: the Root is still current and this bridge
/// still owns the task's tool token.
fn recheck(
    database: &SuplexDatabase,
    root: &RootIdentity,
    owner_token: &str,
) -> DatabaseResult<()> {
    root_session_store::assert_current_root(
        database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    root_session_store::assert_tool_owner(database, &root.task_id, owner_token)
}

fn delivery_failure(code: &'static str, message: &'static str) -> Box<dyn std::error::Error> {
    crate::delivery::DeliveryError::operation(code, message).into()
}

pub struct ObservedRange {
    pub range: ReviewRange,
    pub base_branch: String,
    pub clean: bool,
}

/// TypeScript `currentRange`: the published-base-to-local-head range with the
/// tree state. Delegation pins Advisor and Worker inputs to it.
pub async fn current_range(database_path: &Path, task_id: &str) -> DatabaseResult<ObservedRange> {
    // The range read uses Git and GitHub only; it reads no stored artifacts.
    let observed = DeliveryOperations::new(database_path, Path::new(""))
        .current_range(task_id)
        .await?;
    Ok(ObservedRange {
        range: ReviewRange::from_value(&observed)
            .ok_or_else(|| invalid("The delivery range observation is invalid"))?,
        base_branch: observed["baseBranch"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        clean: observed["clean"] == true,
    })
}

/// Compares the live committed source with a pinned range; any observation
/// failure is a concrete reason, never an approval.
pub async fn source_still_matches(
    database_path: &Path,
    task_id: &str,
    pinned: &ReviewRange,
    activity: &str,
) -> Result<ReviewRange, (String, Option<ReviewRange>, Option<bool>)> {
    let observed = match current_range(database_path, task_id).await {
        Ok(observed) => observed,
        Err(error) => {
            return Err((
                format!("The source could not be observed after the {activity}: {error}"),
                None,
                None,
            ));
        }
    };
    let short = |sha: &str| sha[..sha.len().min(12)].to_owned();
    if !observed.clean {
        return Err((
            format!(
                "The worktree has uncommitted changes after the {activity}; the pinned range {}..{} cannot be confirmed",
                short(&pinned.base_sha),
                short(&pinned.head_sha)
            ),
            Some(observed.range),
            Some(false),
        ));
    }
    if !same_range(&observed.range, pinned) {
        return Err((
            format!(
                "The source range changed during the {activity}: pinned base {} head {} ({} files), observed base {} head {} ({} files)",
                short(&pinned.base_sha),
                short(&pinned.head_sha),
                pinned.files.len(),
                short(&observed.range.base_sha),
                short(&observed.range.head_sha),
                observed.range.files.len()
            ),
            Some(observed.range),
            Some(true),
        ));
    }
    Ok(observed.range)
}

fn open_root(
    database_path: &Path,
    root: &RootIdentity,
) -> DatabaseResult<(SuplexDatabase, RootObservationRows)> {
    let database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    let rows = root_session_store::root_observation_rows(&database, &root.task_id)?;
    Ok((database, rows))
}

fn launched_worker(
    database: &SuplexDatabase,
    task_id: &str,
    worker: Value,
) -> DatabaseResult<Value> {
    let after = root_session_store::root_observation_rows(database, task_id)?;
    let accepted = accepted_assignment(&after.turns, &worker).unwrap_or(Value::Null);
    Ok(json!({"worker":worker,"acceptedAssignment":accepted,"next":DELEGATED_NEXT}))
}

/// TypeScript `findAdvisorReport`: the named report turn, or the latest valid
/// report turn of the named session.
fn find_advisor_report<'a>(
    rows: &'a RootObservationRows,
    turn_id: Option<&str>,
    session_id: Option<&str>,
) -> Option<(&'a Value, &'a Value, &'a Value)> {
    let candidates: Vec<&Value> = match turn_id {
        Some(id) => rows.turns.iter().filter(|turn| turn["id"] == id).collect(),
        None => rows
            .turns
            .iter()
            .rev()
            .filter(|turn| Some(turn["sessionId"].as_str().unwrap_or_default()) == session_id)
            .collect(),
    };
    candidates.into_iter().find_map(|turn| {
        let session = rows
            .sessions
            .iter()
            .find(|session| session["id"] == turn["sessionId"])?;
        let role = session["advisorRole"].as_str()?;
        let input = turn_workflow_input(&rows.sessions, turn)?;
        let outcome = turn_outcome(turn["terminalObservation"].as_str()).advisor?;
        (turn["status"] == "completed"
            && input["kind"] == "advisor"
            && !outcome["result"].is_null()
            && outcome["role"] == role)
            .then_some((session, turn, input))
    })
}

/// TypeScript `delegateWorker`. Standard implementation keeps its unpinned
/// assignment; every other assignment is pinned to the committed live range.
pub async fn delegate_worker(
    database_path: &Path,
    root: &RootIdentity,
    owner_token: &str,
    assignment: &WorkerAssignment,
) -> DatabaseResult<Value> {
    let (_, rows) = open_root(database_path, root)?;
    let workflow = rows.control["workflow"]
        .as_str()
        .unwrap_or("standard")
        .to_owned();
    let (mode, purpose) = (assignment.mode.as_str(), assignment.purpose.as_str());
    if mode == "direct" && workflow != "direct_build" {
        return Err(invalid(
            "Direct mode is legal only for the Direct build workflow. Supply a plan in planned mode.",
        ));
    }
    if mode == "planned" && assignment.plan.as_deref().is_none_or(str::is_empty) {
        return Err(invalid(
            "A planned assignment requires the Coordinator's plan.",
        ));
    }
    let visual_evidence = rows.context["configuration"]["visualEvidence"]
        .as_str()
        .unwrap_or("required")
        .to_owned();
    let compose = |range: Option<&ReviewRange>, advisor_report: Option<(&str, &str)>| {
        root_prompts::compose_worker_assignment(&WorkerAssignmentText {
            mode,
            purpose,
            plan: assignment.plan.as_deref(),
            acceptance_criteria: &assignment.acceptance_criteria,
            instruction: &assignment.instruction,
            visual_evidence: &visual_evidence,
            verification_range: range
                .map(|range| (range.base_sha.as_str(), range.head_sha.as_str())),
            advisor_report,
        })
        .map_err(std::io::Error::other)
    };
    let input = |range: &ReviewRange, advisor_report: Value, candidate_reports: Value| {
        json!({"kind":"worker","version":2,"mode":mode,"purpose":purpose,"range":range,"plan":assignment.plan,
            "acceptanceCriteria":assignment.acceptance_criteria,"instruction":assignment.instruction,
            "advisorReport":advisor_report,"candidateReports":candidate_reports})
    };
    let launch = |text: &str, workflow_input: Option<&Value>| -> DatabaseResult<Value> {
        let prompt = root_prompts::worker_prompt(mode, purpose, text)?;
        let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
        let current_root = root_session_store::current_root(&database, &root.task_id)?
            .ok_or_else(|| invalid("root_identity_mismatch"))?;
        let worker = root_session_store::launch_standard_worker(
            &mut database,
            &current_root,
            text,
            &prompt,
            workflow_input,
            chrono::Utc::now(),
        )?;
        launched_worker(&database, &root.task_id, worker)
    };
    if workflow == "standard" {
        if purpose != "verification" {
            return launch(&compose(None, None)?, None);
        }
        recheck(
            &SuplexDatabase::open(database_path, OpenMode::ReadOnly)?,
            root,
            owner_token,
        )?;
        let observed = current_range(database_path, &root.task_id).await?;
        if !observed.clean {
            return Err(delivery_failure(
                "worktree_dirty",
                "The worktree has uncommitted changes. A check-only assignment needs a committed source; commit or discard the changes first.",
            ));
        }
        let workflow_input = input(&observed.range, Value::Null, Value::Null);
        return launch(
            &compose(Some(&observed.range), None)?,
            Some(&workflow_input),
        );
    }
    recheck(
        &SuplexDatabase::open(database_path, OpenMode::ReadOnly)?,
        root,
        owner_token,
    )?;
    let observed = current_range(database_path, &root.task_id).await?;
    if purpose == "verification" && !observed.clean {
        return Err(delivery_failure(
            "worktree_dirty",
            "The worktree has uncommitted changes. A check-only assignment needs a committed source; commit or discard the changes first.",
        ));
    }
    let range = observed.range;
    let rows = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        root_session_store::root_observation_rows(&database, &root.task_id)?
    };
    let mut candidate_reports = Value::Null;
    if workflow == "competing_plans" && purpose == "implementation" {
        let built = rows.turns.iter().any(|turn| {
            let session = rows
                .sessions
                .iter()
                .find(|session| session["id"] == turn["sessionId"]);
            let input = turn_workflow_input(&rows.sessions, turn);
            session.is_some_and(|session| {
                session["kind"] == "worker" && session["advisorRole"].is_null()
            }) && input.is_some_and(|input| {
                input["kind"] == "worker" && input["purpose"] == "implementation"
            }) && turn["status"] == "completed"
                && turn_outcome(turn["terminalObservation"].as_str())
                    .state
                    .as_deref()
                    == Some("completed")
        });
        if !built {
            let by_turn = assignment.candidate_turn_ids.is_some();
            let Some([a, b]) = assignment
                .candidate_turn_ids
                .as_ref()
                .or(assignment.candidate_session_ids.as_ref())
            else {
                return Err(invalid(
                    "Combined planning requires candidateSessionIds or candidateTurnIds [Plan A, Plan B] for the first implementation.",
                ));
            };
            if a == b {
                return Err(invalid(
                    "candidateSessionIds must name two distinct Advisor sessions.",
                ));
            }
            let mut reports = Vec::new();
            for (id, role) in [(a, "planner_a"), (b, "planner_b")] {
                let label = advisor_label(role);
                let report = if by_turn { find_advisor_report(&rows, Some(id), None) } else { find_advisor_report(&rows, None, Some(id)) }
                    .filter(|(session, _, input)| session["advisorRole"] == role && input["role"] == role)
                    .ok_or_else(|| CoordinationError::refused(format!("{label} session {id} is not a completed valid {label} report for this task.")))?;
                let planned = ReviewRange::from_value(&report.2["range"]).unwrap_or_default();
                if !same_range(&planned, &range) {
                    return Err(CoordinationError::refused(format!("{label} planned against a different source range. Request new plans for the current range.")).into());
                }
                reports.push(json!({"sessionId":report.0["id"],"turnId":report.1["id"]}));
            }
            candidate_reports = Value::Array(reports);
        }
    }
    if (assignment.candidate_turn_ids.is_some() || assignment.candidate_session_ids.is_some())
        && workflow != "competing_plans"
    {
        return Err(invalid("candidateTurnIds apply only to Combined planning."));
    }
    let mut advisor_report = None;
    let mut advisor_reference = Value::Null;
    if workflow == "refine_pull_request" && purpose == "implementation" {
        let requested = assignment.advisor_turn_id.as_deref().or(assignment.advisor_session_id.as_deref())
            .ok_or_else(|| invalid("Pull request repair implementation requires advisorSessionId or advisorTurnId for the latest valid Rater report."))?;
        let reviews = rows.control["workflowState"]["reviews"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let latest = latest_review(reviews, "rater")
            .filter(|latest| {
                let field = if assignment.advisor_turn_id.is_some() {
                    "turnId"
                } else {
                    "sessionId"
                };
                latest[field] == requested && !latest["result"].is_null()
            })
            .ok_or_else(|| {
                invalid("advisorTurnId must be the latest valid Rater report for this task.")
            })?;
        let report = rows
            .turns
            .iter()
            .find(|turn| {
                turn["id"] == latest["turnId"]
                    && turn["sessionId"] == latest["sessionId"]
                    && turn["status"] == "completed"
            })
            .ok_or_else(|| invalid("The latest Rater report turn is missing."))?;
        advisor_report = Some(
            turn_outcome(report["terminalObservation"].as_str())
                .text
                .unwrap_or_default(),
        );
        advisor_reference = json!({"sessionId":latest["sessionId"],"turnId":latest["turnId"]});
    } else if assignment.advisor_turn_id.is_some() || assignment.advisor_session_id.is_some() {
        let report = find_advisor_report(
            &rows,
            assignment.advisor_turn_id.as_deref(),
            assignment.advisor_session_id.as_deref(),
        )
        .ok_or_else(|| {
            invalid("The Advisor reference does not name a completed report for this task.")
        })?;
        advisor_reference = json!({"sessionId":report.0["id"],"turnId":report.1["id"]});
    }
    let text = compose(
        Some(&range),
        advisor_report.as_deref().map(|text| ("Rater", text)),
    )?;
    let workflow_input = input(&range, advisor_reference, candidate_reports);
    launch(&text, Some(&workflow_input))
}

const ADVISOR_NEXT: &str = "End this Coordinator turn now. Suplex will send the Advisor's native report as a new turn on this same session. Do not poll or wait inside this turn.";

/// Observe the committed live range for an Advisor request and pin its evidence.
async fn advisor_source(
    database_path: &Path,
    artifact_root: &Path,
    root: &RootIdentity,
    owner_token: &str,
    dirty: &'static str,
) -> DatabaseResult<(
    ObservedRange,
    RootObservationRows,
    advisor_evidence::AdvisorEvidence,
)> {
    let (database, rows) = open_root(database_path, root)?;
    if rows.control["worktree"]["path"].as_str().is_none() {
        return Err(invalid("The task has no worktree"));
    }
    recheck(&database, root, owner_token)?;
    drop(database);
    let observed = current_range(database_path, &root.task_id).await?;
    if !observed.clean {
        return Err(delivery_failure("worktree_dirty", dirty));
    }
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let rows = root_session_store::root_observation_rows(&database, &root.task_id)?;
    let evidence = advisor_evidence::prepare_advisor_evidence(
        &database,
        database_path,
        artifact_root,
        &rows,
        &observed.range,
    )?;
    Ok((observed, rows, evidence))
}

fn advisor_prompt(
    rows: &RootObservationRows,
    role: &str,
    observed: &ObservedRange,
    evidence: &advisor_evidence::AdvisorEvidence,
    brief: Option<&str>,
    prior_findings: Option<&[String]>,
    repair_evidence: Option<&[String]>,
) -> String {
    let intent = &rows.control["deliveryIntent"];
    let configuration = &rows.context["configuration"];
    root_prompts::compose_advisor_assignment(&root_prompts::AdvisorAssignment {
        role,
        objective: rows.control["objective"].as_str().unwrap_or_default(),
        configuration,
        visual_evidence: configuration["visualEvidence"]
            .as_str()
            .unwrap_or("required"),
        repository: intent["repository"].as_str().unwrap_or_default(),
        head_branch: intent["headBranch"].as_str().unwrap_or_default(),
        base_branch: &observed.base_branch,
        pull_request_number: intent["pullRequestNumber"].as_i64(),
        range: &observed.range,
        evidence_directory: &evidence.evidence.directory.to_string_lossy(),
        attachments: &evidence.evidence.attachments,
        brief,
        prior_findings,
        repair_evidence,
    })
}

fn advisor_input(
    role: &str,
    observed: &ObservedRange,
    evidence: &advisor_evidence::AdvisorEvidence,
    pair_id: Option<&str>,
) -> Value {
    let mut input = json!({"kind":"advisor","role":role,"range":observed.range,
        "evidenceDirectory":evidence.evidence.directory.to_string_lossy(),"evidenceSha256":evidence.evidence.sha256,
        "verificationTurnIds":evidence.worker_turn_ids});
    if let Some(pair_id) = pair_id {
        input["plannerPairId"] = json!(pair_id);
    }
    input
}

/// TypeScript `delegateAdvisor`: Suplex composes the Advisor input from the
/// committed live range, pinned evidence, and the latest same-role review.
pub async fn delegate_advisor(
    database_path: &Path,
    artifact_root: &Path,
    root: &RootIdentity,
    owner_token: &str,
    role: &str,
    brief: Option<&str>,
) -> DatabaseResult<Value> {
    let (_, rows) = open_root(database_path, root)?;
    let workflow = rows.control["workflow"].as_str().unwrap_or("standard");
    let definition =
        workflow_definition(workflow).ok_or_else(|| invalid("The task workflow is invalid"))?;
    let label = advisor_label(role);
    if !definition.advisor_roles.contains(&role) {
        return Err(CoordinationError::refused(format!(
            "The {} workflow has no {label} Advisor.",
            definition.name
        ))
        .into());
    }
    if brief.is_some() && role != "reviewer" {
        return Err(CoordinationError::refused(format!(
            "Suplex composes the {label} input; a brief is accepted only for Reviewer."
        ))
        .into());
    }
    if role == "reviewer" && brief.is_none() {
        return Err(invalid(
            "Reviewer requires a brief with your plan and acceptance criteria.",
        ));
    }
    let (observed, rows, evidence) = advisor_source(database_path, artifact_root, root, owner_token, "The worktree has uncommitted changes. Commit or discard them before requesting an Advisor; Advisors review committed source only.").await?;
    let reviews = rows.control["workflowState"]["reviews"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let previous = (role == "rater")
        .then(|| latest_review(reviews, "rater"))
        .flatten();
    let prior_findings = previous
        .and_then(|previous| previous["result"]["blockingFindings"].as_array())
        .map(|findings| {
            findings
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
    let repair_evidence = previous.map(|previous| {
        let index = rows
            .turns
            .iter()
            .position(|turn| turn["id"] == previous["turnId"]);
        advisor_evidence::completed_worker_turns(&rows)
            .into_iter()
            .filter(|(turn, _)| {
                let position = rows
                    .turns
                    .iter()
                    .position(|candidate| candidate["id"] == turn["id"]);
                index.is_none_or(|index| position.is_some_and(|position| position > index))
            })
            .map(|(turn, parsed)| {
                format!(
                    "Turn {}: {}",
                    turn["id"].as_str().unwrap_or_default(),
                    parsed["text"].as_str().unwrap_or("(no text)")
                )
            })
            .collect::<Vec<_>>()
    });
    let prompt = advisor_prompt(
        &rows,
        role,
        &observed,
        &evidence,
        brief,
        prior_findings.as_deref(),
        repair_evidence.as_deref(),
    );
    let input = advisor_input(role, &observed, &evidence, None);
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let current_root = root_session_store::current_root(&database, &root.task_id)?
        .ok_or_else(|| invalid("root_identity_mismatch"))?;
    let advisor = root_session_store::launch_advisor(
        &mut database,
        &current_root,
        role,
        &prompt,
        &input,
        chrono::Utc::now(),
    )?;
    Ok(
        json!({"advisor":advisor,"evidenceDirectory":evidence.evidence.directory,"next":ADVISOR_NEXT}),
    )
}

/// TypeScript `delegatePlanners`: Plan A and Plan B are reserved together on
/// the same pinned input. The task host dispatches both.
pub async fn delegate_planners(
    database_path: &Path,
    artifact_root: &Path,
    root: &RootIdentity,
    owner_token: &str,
) -> DatabaseResult<Value> {
    let (_, rows) = open_root(database_path, root)?;
    if rows.control["workflow"] != "competing_plans" {
        return Err(invalid(
            "delegate_planners is legal only for Combined planning.",
        ));
    }
    let (observed, rows, evidence) = advisor_source(database_path, artifact_root, root, owner_token, "The worktree has uncommitted changes. Commit or discard them before requesting planners; planners inspect committed source only.").await?;
    let pair_id = uuid::Uuid::new_v4().to_string();
    let prompt = advisor_prompt(&rows, "planner_a", &observed, &evidence, None, None, None);
    let prompt_b = advisor_prompt(&rows, "planner_b", &observed, &evidence, None, None, None);
    let input_a = advisor_input("planner_a", &observed, &evidence, Some(&pair_id));
    let input_b = advisor_input("planner_b", &observed, &evidence, Some(&pair_id));
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let current_root = root_session_store::current_root(&database, &root.task_id)?
        .ok_or_else(|| invalid("root_identity_mismatch"))?;
    let planners = root_session_store::launch_planner_pair(
        &mut database,
        &current_root,
        &pair_id,
        [(&prompt, &input_a), (&prompt_b, &input_b)],
        chrono::Utc::now(),
    )?;
    Ok(
        json!({"planners":planners,"evidenceDirectory":evidence.evidence.directory,"next":"End this Coordinator turn now. Suplex will send one combined planning result after both Plan A and Plan B have terminal reports. Do not poll or wait inside this turn."}),
    )
}

/// TypeScript `completeLocal` outside Standard: the committed live range must
/// satisfy the workflow policy at one final completion boundary.
pub async fn complete_workflow_local_work(
    database_path: &Path,
    root: &RootIdentity,
    owner_token: &str,
    expected_head: Option<&str>,
) -> DatabaseResult<Value> {
    use crate::delivery::operations::{self, WorkflowCompletion};
    let (_, rows) = open_root(database_path, root)?;
    let control = rows.control;
    let path = operations::standard_local_worktree_path(&control)?.to_owned();
    let local = worktree::observe_local_revision(Path::new(&path))?;
    operations::check_standard_local_completion(&control, expected_head, &local)?;
    let range = current_range(database_path, &root.task_id).await?.range;
    // TypeScript `commitCompletion`: one last local observation after every await.
    let local = worktree::observe_local_revision(Path::new(&path)).map_err(|error| {
        CoordinationError::refused(format!("The local source could not be observed: {error}"))
    })?;
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    let current = root_session_store::root_observation_rows(&database, &root.task_id)?.control;
    if current["status"] == "active" {
        let mut projected = current["worktree"].clone();
        projected["branch"] = json!(local.branch);
        projected["headSha"] = json!(local.head_sha);
        projected["dirty"] = json!(!local.clean);
        root_session_store::set_worktree(
            &mut database,
            &root.task_id,
            &projected,
            chrono::Utc::now(),
        )?;
    }
    let decision = operations::complete_workflow_delivery(
        &mut database,
        &root.task_id,
        &range,
        &local,
        None,
        false,
        |database| recheck(database, root, owner_token),
    )?;
    match decision {
        WorkflowCompletion::Completed | WorkflowCompletion::Already => {
            Ok(json!({"kind":"local_work_completed","headSha":range.head_sha}))
        }
        WorkflowCompletion::Cancelled => {
            recheck(&database, root, owner_token)?;
            Err(invalid(
                "The task was cancelled; Suplex recorded no workflow completion.",
            ))
        }
        WorkflowCompletion::Declined { reason, .. } => {
            Err(CoordinationError::refused(reason).into())
        }
    }
}

/// TypeScript `requestDelivery` for `inspect_delivery_diff` outside Standard:
/// the reviewed range also gets a pinned evidence directory.
pub async fn inspect_workflow_delivery_diff(
    database_path: &Path,
    artifact_root: &Path,
    root: &RootIdentity,
    owner_token: &str,
) -> DatabaseResult<Value> {
    let mut result = DeliveryOperations::new(database_path, artifact_root)
        .execute(
            root,
            Some(owner_token),
            "inspect_delivery_diff",
            None,
            None,
            None,
            None,
        )
        .await?;
    let (_, rows) = open_root(database_path, root)?;
    let range = ReviewRange::from_value(&json!({
        "baseSha": result["baseSha"], "headSha": result["headSha"], "files": result["files"],
        "commits": result["commits"], "patchDigest": result["patchDigest"],
    }))
    .ok_or_else(|| invalid("The delivery range observation is invalid"))?;
    let worktree = rows.control["worktree"]["path"]
        .as_str()
        .ok_or_else(|| invalid("The task has no worktree"))?;
    let evidence = crate::coordination::workflow_evidence::write_task_evidence(
        &crate::coordination::workflow_evidence::task_evidence_root(database_path),
        &root.task_id,
        Path::new(worktree),
        &range,
        vec![],
        &json!({"note":"Coordinator inspection; Worker evidence is attached to Advisor requests."}),
    )?;
    result["evidenceDirectory"] = json!(evidence.directory);
    Ok(result)
}

pub fn replace_worker(
    database_path: &Path,
    root: &RootIdentity,
    owner_token: &str,
    request: &TaskWorkerReplacementBody,
) -> DatabaseResult<Value> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    database.transaction(true, |database| {
        root_session_store::assert_current_root(
            database,
            &root.task_id,
            &root.session_id,
            root.generation,
        )?;
        root_session_store::assert_tool_owner(database, &root.task_id, owner_token)?;
        let worker = root_session_store::replace_worker(
            database,
            &root.task_id,
            request,
            chrono::Utc::now(),
        )?;
        let rows = root_session_store::root_observation_rows(database, &root.task_id)?;
        Ok(json!({
            "acceptedAssignment": accepted_assignment(&rows.turns, &worker),
            "worker": worker,
            "next": REPLACED_NEXT,
        }))
    })
}

/// TypeScript `askHuman` checks no tool owner.
pub fn ask_human(
    database_path: &Path,
    root: &RootIdentity,
    question: &str,
    options: &Value,
) -> DatabaseResult<Value> {
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    if !root_session_store::ask_human_for_root(
        &mut database,
        &root.task_id,
        &root.session_id,
        root.generation,
        question,
        options,
        chrono::Utc::now(),
    )? {
        return Err(invalid("The current Root could not ask this task question"));
    }
    Ok(root_session_store::root_observation_rows(&database, &root.task_id)?.control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth,
        tasks::repository::{self, PreparedTask, TaskCreator},
    };
    use chrono::Utc;
    use std::fs;

    #[test]
    fn absent_worktree_evidence_does_not_remove_task_context() {
        let rows = RootObservationRows {
            control: json!({"workflow":"standard","deliveryTarget":"local_worktree","status":"active","pullRequest":{"number":7},"workflowState":{"version":1,"reviews":[],"acceptedDelivery":null,"deliveryWait":null,"completion":null,"toolOwner":{"token":"private"}}}),
            context: json!({"configuration":{"visualEvidence":"off"},"images":[]}),
            dependencies: vec![],
            root: None,
            worker: None,
            workers: vec![],
            sessions: vec![],
            turns: vec![],
        };
        let pull_request =
            crate::delivery::operations::observe_for_root(Path::new(""), &rows.control)
                .unwrap()
                .0;
        assert_eq!(pull_request, Value::Null);
        let result = assemble_observation(
            rows,
            json!({"state":"unknown","error":"missing worktree"}),
            pull_request,
        )
        .unwrap();
        assert_eq!(result["pullRequest"], Value::Null);
        assert_eq!(result["worktree"]["state"], "unknown");
        assert!(
            result["control"]["workflowState"]
                .get("toolOwner")
                .is_none()
        );
        assert_eq!(result["context"]["configuration"]["visualEvidence"], "off");
    }

    #[test]
    fn worker_evidence_reads_only_the_admitted_native_turn() {
        let directory =
            std::env::temp_dir().join(format!("suplex-worker-evidence-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let database_path = directory.join("suplex.sqlite");
        let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let user = auth::development_sign_in(&mut database, now).unwrap().user;
        let stamp = now.to_rfc3339();
        database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_evidence','Evidence','active',?1)", [&stamp]).unwrap();
        database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('project_evidence','company_evidence','Evidence','/tmp/repo','/tmp/worktrees',NULL,'main','','','profile_root','profile_worker','{}',?1,?1)", [&stamp]).unwrap();
        let task = repository::create(&mut database, &PreparedTask {
            id: repository::new_task_id(), company_id: "company_evidence".into(), project_id: "project_evidence".into(),
            title: "Inspect the test result".into(), description: "Review Worker evidence".into(),
            configuration: json!({"branch":"task-evidence","baseBranch":"main"}),
            idempotency_key: "evidence-1".into(), request_hash: "evidence-hash".into(),
            creator: TaskCreator::User(user.id), delivery_target: "local_worktree".into(),
            delivery_intent: json!({"headBranch":"task-evidence","baseBranch":"main"}),
            root_profile: json!({"profileId":"profile_root","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            worker_profile: json!({"profileId":"profile_worker","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
            advisor_profiles: json!({}), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![], pull_request_dependencies: vec![],
        }, now).unwrap().task;
        let root = root_session_store::reserve_root(&mut database, &task.id, now).unwrap();
        let worker = root_session_store::launch_standard_worker(
            &mut database,
            &root,
            "Inspect",
            "Run test",
            None,
            now,
        )
        .unwrap();
        let turn = root_session_store::root_observation_rows(&database, &task.id)
            .unwrap()
            .turns
            .into_iter()
            .find(|value| value["sessionId"] == worker["id"])
            .unwrap();
        let turn_id = turn["id"].as_str().unwrap().to_owned();
        let native_directory = crate::runtimes::task_harness::task_session_runtime_directory(
            &database_path,
            worker["id"].as_str().unwrap(),
        )
        .unwrap();
        fs::create_dir_all(&native_directory).unwrap();
        fs::write(native_directory.join(format!("turn-{turn_id}.jsonl")), concat!(
            "{\"type\":\"item.started\",\"item\":{\"id\":\"item_0\",\"type\":\"command_execution\",\"command\":\"pnpm test\",\"status\":\"in_progress\"}}\n",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"command_execution\",\"command\":\"pnpm test\",\"aggregated_output\":\"2 passed\",\"exit_code\":0,\"status\":\"completed\"}}\n",
        )).unwrap();
        drop(database);
        let identity = RootIdentity {
            task_id: task.id,
            session_id: root.id,
            generation: root.generation,
        };
        let request = WorkerEvidenceRequest {
            turn_id: turn_id.clone(),
            query: EvidenceQuery {
                tool_id: Some("item_0".into()),
                field: None,
                position: None,
                cursor: None,
                max_characters: 1000,
            },
        };
        let result = read_worker_evidence(&database_path, &identity, &request).unwrap();
        assert_eq!(result["turnId"], turn_id);
        assert_eq!(result["tool"]["status"], "completed");
        assert_eq!(result["evidence"]["text"], "2 passed");
        assert_eq!(result["limitation"], Value::Null);
        assert!(
            read_worker_evidence(
                &database_path,
                &RootIdentity {
                    generation: identity.generation + 1,
                    ..identity.clone()
                },
                &request
            )
            .is_err()
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
