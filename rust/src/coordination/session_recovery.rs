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
        ReviewRange { base_sha: sha('a'), head_sha: sha('b'), files: vec!["a.txt".into()], commits: vec![sha('b')], patch_digest: Some("d".repeat(64)) }
    }

    /// One active task in the given workflow with a reserved Coordinator.
    fn fixture(workflow: &str) -> (PathBuf, SuplexDatabase, RootSession) {
        let directory = std::env::temp_dir().join(format!("suplex-workflow-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut database = SuplexDatabase::open(&directory.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
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
            delivery_intent: json!({"repository":"owner/repo","headBranch":"task-flow","baseBranch":"main","pullRequestNumber":null}),
            root_profile: profile.clone(), worker_profile: profile, advisor_profiles: json!({}), issue: None, start_queued: true,
            copied_from_task_id: None, depends_on: vec![],
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

    fn record(database: &mut SuplexDatabase, session: &Value, receipt: &str, observation: &Value, review: Option<&Value>) -> Option<RootTurn> {
        root_session_store::record_standard_worker_result_and_wake(database, &StandardWorkerResult {
            task_id: session["taskId"].as_str().unwrap(),
            session_id: session["id"].as_str().unwrap(),
            generation: session["generation"].as_i64().unwrap(),
            receipt_id: receipt,
            observation: &observation.to_string(),
            native_turn_id: None,
            wake_prompt: "Advisor wake",
            review,
        }, Utc::now()).unwrap()
    }

    #[test]
    fn planner_pair_reserves_both_roles_and_wakes_coordinator_once_both_settle() {
        let (directory, mut database, root) = fixture("competing_plans");
        let pair = "pair_1";
        let (a, b) = (advisor_input("planner_a", Some(pair)), advisor_input("planner_b", Some(pair)));
        let [plan_a, plan_b] = root_session_store::launch_planner_pair(&mut database, &root, pair, [("Plan A prompt", &a), ("Plan B prompt", &b)], Utc::now()).unwrap();
        assert_eq!((plan_a["advisorRole"].as_str(), plan_b["delegateSlot"].as_str()), (Some("planner_a"), Some("planner_b")));
        assert_ne!(plan_a["id"], plan_b["id"]);
        assert!(root_session_store::launch_advisor(&mut database, &root, "planner_a", "Retry", &advisor_input("planner_a", None), Utc::now()).unwrap_err().to_string().contains("worker_already_assigned"));
        let report = |role: &str| json!({"state":"completed","text":"Plan","advisor":{"role":role,"result":{"summary":"Plan","role":role},"invalidReason":null}});
        assert!(record(&mut database, &plan_a, "a:1:completed", &report("planner_a"), None).is_none());
        let wake = record(&mut database, &plan_b, "b:1:completed", &report("planner_b"), None).unwrap();
        assert!(wake.prompt_text.starts_with(&format!("Combined planning pair {pair} completed. Plan A session {} and Plan B session {}", plan_a["id"].as_str().unwrap(), plan_b["id"].as_str().unwrap())));
        assert!(wake.prompt_text.contains("Both reports are valid."));
        assert!(record(&mut database, &plan_b, "b:1:completed", &report("planner_b"), None).is_none());
        let other = root_session_store::launch_planner_pair(&mut database, &root, "pair_2", [("A", &a), ("B", &b)], Utc::now());
        assert!(other.unwrap_err().to_string().contains("invalid_planner_pair"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rater_results_keep_their_launch_range_and_duplicates_add_no_record() {
        let (directory, mut database, root) = fixture("refine_pull_request");
        let rater = root_session_store::launch_advisor(&mut database, &root, "rater", "Rate the pull request", &advisor_input("rater", None), Utc::now()).unwrap();
        assert_eq!((rater["advisorRole"].as_str(), rater["delegateSlot"].as_str()), (Some("rater"), Some("delegate")));
        assert_eq!(rater["profile"]["profileId"], "profile_root", "an Advisor defaults to the Coordinator profile");
        let invalid = json!({"result":null,"invalidReason":"The report has no JSON object"});
        let observation = json!({"state":"completed","text":"No JSON","advisor":{"role":"rater","result":null,"invalidReason":"The report has no JSON object"}});
        assert!(record(&mut database, &rater, "r:1:completed", &observation, Some(&invalid)).is_some());
        assert!(record(&mut database, &rater, "r:1:completed", &observation, Some(&invalid)).is_none());
        let state = root_session_store::workflow_state(&database, &rater["taskId"].as_str().unwrap().to_owned()).unwrap();
        let reviews = state["reviews"].as_array().unwrap();
        assert_eq!(reviews.len(), 1);
        assert_eq!((reviews[0]["range"].clone(), reviews[0]["result"].clone()), (json!(range()), Value::Null));
        let result = json!({"rating":9,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"Ready","role":"rater"});
        let task_id = rater["taskId"].as_str().unwrap();
        root_session_store::reconcile_advisor_result(&mut database, task_id, rater["id"].as_str().unwrap(), reviews[0]["turnId"].as_str().unwrap(), &result, Utc::now()).unwrap();
        let state = root_session_store::workflow_state(&database, task_id).unwrap();
        assert_eq!((state["reviews"][0]["result"]["rating"].clone(), state["reviews"][0]["invalidReason"].clone()), (json!(9), Value::Null));
        assert!(root_session_store::reconcile_advisor_result(&mut database, task_id, rater["id"].as_str().unwrap(), reviews[0]["turnId"].as_str().unwrap(), &result, Utc::now()).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_failed_reviewer_turn_records_an_invalid_review_and_wakes_coordinator() {
        let (directory, mut database, root) = fixture("independent_review");
        let reviewer = root_session_store::launch_advisor(&mut database, &root, "reviewer", "Review", &advisor_input("reviewer", None), Utc::now()).unwrap();
        let session = root_session_store::current_worker(&database, &root.task_id).unwrap().unwrap();
        let turn = root_session_store::pending_turns(&database, &session.id).unwrap().remove(0);
        let database_path = directory.join("suplex.sqlite");
        assert!(finish_delegate_turn(&mut database, &database_path, TerminalDelegateTurn {
            session: &session, native_session_id: "codex-review", turn: &turn, state: "error", reason: "native_error", text: "",
            base: json!({"state":"error","native":{},"reason":"native_error","text":""}),
        }).unwrap());
        let state = root_session_store::workflow_state(&database, &root.task_id).unwrap();
        assert_eq!(state["reviews"][0]["invalidReason"], "The Reviewer turn ended with state error (native_error)");
        let rows = root_session_store::root_observation_rows(&database, &root.task_id).unwrap();
        let wake = rows.turns.iter().rev().find(|turn| turn["sessionId"] == root.id.as_str()).unwrap();
        assert!(wake["promptText"].as_str().unwrap().starts_with(&format!("Reviewer result codex-review:{}:error. The Reviewer report was not accepted", turn.id)));
        assert_eq!(reviewer["advisorRole"], "reviewer");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_workflow_completion_requires_the_review_for_the_exact_range() {
        let (directory, mut database, root) = fixture("independent_review");
        let local = LocalRevisionObservation { branch: "task-flow".into(), head_sha: sha('b'), tree_sha: sha('c'), clean: true };
        let complete = |database: &mut SuplexDatabase| operations::complete_workflow_delivery(database, &root.task_id, &range(), &local, None, false, |_| Ok(())).unwrap();
        assert!(matches!(complete(&mut database), WorkflowCompletion::Declined { code: "workflow_review_required", .. }));
        let dirty = LocalRevisionObservation { clean: false, ..local.clone() };
        assert!(matches!(operations::complete_workflow_delivery(&mut database, &root.task_id, &range(), &dirty, None, false, |_| Ok(())).unwrap(), WorkflowCompletion::Declined { code: "worktree_dirty", .. }));
        root_session_store::update_workflow_state(&mut database, &root.task_id, Utc::now(), |state| {
            state["reviews"] = json!([{"sessionId":"s","turnId":"t","role":"reviewer","range":range(),"result":{"role":"reviewer","approved":true,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"},"invalidReason":null,"recordedAt":"2026-09-25T00:00:00.000Z"}]);
        }).unwrap();
        assert!(operations::complete_workflow_delivery(&mut database, &root.task_id, &range(), &local, None, false, |_| Err("task_tool_owner_lost".into())).is_err(), "a lost owner writes nothing");
        assert_eq!(complete(&mut database), WorkflowCompletion::Completed);
        let rows = root_session_store::root_observation_rows(&database, &root.task_id).unwrap();
        assert_eq!(rows.control["status"], "delivered");
        assert_eq!(rows.control["workflowState"]["completion"]["reviewedHead"], sha('b'));
        assert_eq!(complete(&mut database), WorkflowCompletion::Already);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
