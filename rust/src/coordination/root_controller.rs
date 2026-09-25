//! Root operations for the Standard local-worktree flow.

use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{
    http::contracts::typed::tasks::TaskWorkerReplacementBody,
    platform::{
        artifacts,
        database::{DatabaseResult, OpenMode, SuplexDatabase},
    },
    runtimes::{task_harness::ReaderSession, task_harness_registry},
    tasks::{commands::TaskFailure, worktree},
};

use super::{
    root_bridge::RootIdentity,
    root_prompts::{self, WorkerAssignmentText},
    root_session_store::{self, RootObservationRows, RootSession},
    worker_evidence::{self, EvidenceQuery},
};

pub struct StandardWorkerAssignment {
    pub plan: String,
    pub acceptance_criteria: Vec<String>,
    pub instruction: String,
    pub purpose: String,
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
        root_prompts::initial_coordinator_prompt(&rows.control, &rows.context, &rows.dependencies)
            .map_err(std::io::Error::other)?;
    root_session_store::ensure_initial_prompt(&mut database, &root, &prompt, chrono::Utc::now())?;
    Ok(root)
}

fn invalid(message: &'static str) -> Box<dyn std::error::Error> {
    std::io::Error::other(message).into()
}

fn not_ported(message: &'static str) -> Box<dyn std::error::Error> {
    Box::new(TaskFailure::not_ported(message))
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
    if rows.control["workflow"] != "standard" || rows.control["deliveryTarget"] != "local_worktree"
    {
        return Err(not_ported(
            "Only Standard local-worktree Root observation is ported",
        ));
    }
    let pull_request = crate::delivery::operations::observe(&rows.control)?;
    let worktree = match rows.control["worktree"]["path"].as_str() {
        Some(path) => match worktree::observe_worktree(Path::new(path)) {
            Ok(observed) => json!({"headSha":observed.head_sha,"dirty":observed.dirty}),
            Err(error) => json!({"state":"unknown","error":error.to_string()}),
        },
        None => Value::Null,
    };
    assemble_observation(rows, worktree, pull_request)
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
    if format!("{:x}", Sha256::digest(&bytes)) != artifact.sha256 {
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
    let reader = task_harness_registry::native_session_reader(native_session_id).or_else(|| {
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
    let result = worker_evidence::read(&tools, &request.query).map_err(std::io::Error::other)?;
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

/// TypeScript `delegateWorker` (Standard path) checks no tool owner.
pub fn delegate_worker(
    database_path: &Path,
    root: &RootIdentity,
    assignment: &StandardWorkerAssignment,
) -> DatabaseResult<Value> {
    if assignment.purpose != "implementation" {
        return Err(not_ported(
            "Only Standard implementation Worker delegation is ported",
        ));
    }
    if assignment.plan.is_empty()
        || assignment.acceptance_criteria.is_empty()
        || assignment.instruction.is_empty()
    {
        return Err(invalid(
            "A planned Worker assignment requires a plan, acceptance criteria, and instruction",
        ));
    }
    let mut database = SuplexDatabase::open(database_path, OpenMode::ReadWrite)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    let before = root_session_store::root_observation_rows(&database, &root.task_id)?;
    if before.control["workflow"] != "standard"
        || before.control["deliveryTarget"] != "local_worktree"
    {
        return Err(not_ported(
            "Only Standard local-worktree Worker delegation is ported",
        ));
    }
    let visual_evidence = before.context["configuration"]["visualEvidence"]
        .as_str()
        .unwrap_or("required");
    let assignment_text = root_prompts::compose_worker_assignment(&WorkerAssignmentText {
        mode: "planned",
        purpose: &assignment.purpose,
        plan: Some(&assignment.plan),
        acceptance_criteria: &assignment.acceptance_criteria,
        instruction: &assignment.instruction,
        visual_evidence,
        verification_range: None,
    })
    .map_err(std::io::Error::other)?;
    let prompt_text = root_prompts::standard_worker_prompt(&assignment_text, &assignment.purpose)
        .map_err(std::io::Error::other)?;
    root_session_store::assert_current_root(
        &database,
        &root.task_id,
        &root.session_id,
        root.generation,
    )?;
    let current_root = root_session_store::current_root(&database, &root.task_id)?
        .ok_or_else(|| invalid("current Root session is missing"))?;
    let worker = root_session_store::launch_standard_worker(
        &mut database,
        &current_root,
        &assignment_text,
        &prompt_text,
        None,
        chrono::Utc::now(),
    )?;
    let after = root_session_store::root_observation_rows(&database, &root.task_id)?;
    let accepted = accepted_assignment(&after.turns, &worker).unwrap_or(Value::Null);
    Ok(json!({"worker":worker,"acceptedAssignment":accepted,"next":DELEGATED_NEXT}))
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
        let pull_request = crate::delivery::operations::observe(&rows.control).unwrap();
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
            copied_from_task_id: None, depends_on: vec![],
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
