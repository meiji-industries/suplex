//! TypeScript `coordination/workflows.ts`: the built-in workflow catalog and
//! the pure delivery policy over Suplex-owned review records. Sessions, turns,
//! and review records use their persisted JSON shapes.

use std::collections::BTreeMap;
use ts_rs::TS;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::advisor_bridge::AdvisorRole;
use crate::tasks::control::{SessionKind, SessionRow, TaskControlRow, TurnRow, TurnStatus};

pub const REPAIR_RATING_TARGET: i64 = 9;

pub struct WorkflowDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub advisor_roles: &'static [&'static str],
}

pub const WORKFLOWS: [WorkflowDefinition; 5] = [
    WorkflowDefinition {
        id: "standard",
        name: "Standard",
        advisor_roles: &[],
    },
    WorkflowDefinition {
        id: "direct_build",
        name: "Direct build",
        advisor_roles: &[],
    },
    WorkflowDefinition {
        id: "independent_review",
        name: "Second opinion",
        advisor_roles: &["reviewer"],
    },
    WorkflowDefinition {
        id: "competing_plans",
        name: "Combined planning",
        advisor_roles: &["planner_a", "planner_b"],
    },
    WorkflowDefinition {
        id: "refine_pull_request",
        name: "Pull request repair",
        advisor_roles: &["rater"],
    },
];

crate::shared::wire_enum! {
    /// TypeScript `WorkflowId`.
    pub enum Workflow {
        Standard = "standard",
        DirectBuild = "direct_build",
        IndependentReview = "independent_review",
        CompetingPlans = "competing_plans",
        RefinePullRequest = "refine_pull_request",
    }
}

impl Workflow {
    pub fn definition(self) -> &'static WorkflowDefinition {
        workflow_definition(self.as_str()).expect("every workflow is in the catalog")
    }
}

pub fn workflow_definition(workflow: &str) -> Option<&'static WorkflowDefinition> {
    WORKFLOWS
        .iter()
        .find(|definition| definition.id == workflow)
}

/// The Advisor roles of a workflow; an unknown workflow has none.
pub fn advisor_roles(workflow: &str) -> impl Iterator<Item = AdvisorRole> {
    workflow_definition(workflow)
        .map_or(&[][..], |definition| definition.advisor_roles)
        .iter()
        .map(|role| AdvisorRole::parse(role).expect("the catalog names Advisor roles"))
}

pub fn advisor_label(role: &str) -> &'static str {
    match role {
        "reviewer" => "Reviewer",
        "planner_a" => "Plan A",
        "planner_b" => "Plan B",
        "rater" => "Rater",
        _ => "Advisor",
    }
}

/// One label helper for native titles, panes, API labels, and UI.
pub fn role_label(kind: &str, advisor_role: Option<&str>) -> &'static str {
    if kind == "root" {
        return "Coordinator";
    }
    advisor_role.map_or("Worker", advisor_label)
}

pub use crate::delivery::inspection::{ReviewRange, range_differences, same_range};

impl ReviewRange {
    pub fn from_value(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// TypeScript `WorkflowState`: the Suplex-owned review and delivery record of
/// one task. Fields after `tool_owner` are private bookkeeping that the public
/// state omits.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub version: u8,
    pub reviews: Vec<ReviewRecord>,
    pub accepted_delivery: Option<ReviewRange>,
    pub delivery_wait: Option<DeliveryWait>,
    pub completion: Option<Completion>,
    #[serde(default)]
    pub tool_owner: Option<ToolOwner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_up: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_history: Option<Vec<DeliveryHistoryEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_selections: Option<BTreeMap<String, AgentSelection>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_root_selection_session_id: Option<String>,
}

impl Default for WorkflowState {
    fn default() -> Self {
        Self {
            version: 1,
            reviews: Vec::new(),
            accepted_delivery: None,
            delivery_wait: None,
            completion: None,
            tool_owner: None,
            follow_up: None,
            delivery_history: None,
            agent_selections: None,
            initial_root_selection_session_id: None,
        }
    }
}

/// One Reviewer or Rater outcome, pinned to the range it assessed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub session_id: String,
    pub turn_id: String,
    pub role: AdvisorRole,
    pub range: ReviewRange,
    #[ts(type = "unknown")]
    pub result: Option<Value>,
    pub invalid_reason: Option<String>,
    pub recorded_at: String,
}

crate::shared::wire_enum! {
    pub enum DeliveryWaitReason {
        Checks = "checks",
        Mergeability = "mergeability",
        MergeQueue = "merge_queue",
        Observation = "observation",
    }
}

crate::shared::wire_enum! {
    pub enum CompletionKind {
        Workflow = "workflow",
        ExternalMerge = "external_merge",
    }
}

/// TypeScript `DeliveryWait`: one persisted wait on GitHub delivery state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryWait {
    pub head_sha: String,
    pub fingerprint: String,
    pub since: String,
    pub reason: DeliveryWaitReason,
}

/// TypeScript `WorkflowCompletion`: the recorded end of delivery.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub kind: CompletionKind,
    pub reviewed_head: Option<String>,
    pub pull_request_number: Option<u64>,
    pub observed_at: String,
}

/// The Root MCP bridge process that owns the task's delivery tools.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOwner {
    pub token: String,
    pub pid: u32,
    pub process_start_time: String,
}

/// The delivery a follow-up replaced when a delivered task resumed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryHistoryEntry {
    pub resumed_at: String,
    pub accepted_delivery: Option<ReviewRange>,
    pub completion: Option<Completion>,
}

/// TypeScript `AgentSelectionIntent`: a user's agent choice, kept so a retry
/// of the same choice is idempotent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSelection {
    pub role: String,
    pub expected_profile_id: String,
    pub expected_session_id: Option<String>,
    pub profile_id: String,
    pub direction: String,
    pub resume: bool,
    pub question_id: Option<String>,
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

fn verified(verification: &Value) -> bool {
    matches!(verification.as_str(), Some("passed" | "not_applicable"))
}

#[derive(Debug, Default, PartialEq)]
pub struct TurnOutcome {
    pub state: Option<String>,
    /// The stored `{ role, result, invalidReason }` Advisor outcome.
    pub advisor: Option<Value>,
    pub text: Option<String>,
}

/// TypeScript `turnOutcome`: any malformed field makes the whole outcome unknown.
pub fn turn_outcome(observation: Option<&str>) -> TurnOutcome {
    let Some(value) = observation.and_then(|raw| serde_json::from_str::<Value>(raw).ok()) else {
        return TurnOutcome::default();
    };
    let Some(fields) = value.as_object() else {
        return TurnOutcome::default();
    };
    let optional_text = |name: &str| match fields.get(name) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(()),
    };
    let (Ok(state), Ok(text)) = (optional_text("state"), optional_text("text")) else {
        return TurnOutcome::default();
    };
    let advisor = match fields.get("advisor") {
        None => None,
        Some(advisor) => {
            let valid = advisor["role"].as_str().is_some_and(|role| {
                ["reviewer", "planner_a", "planner_b", "rater"].contains(&role)
            }) && (advisor["result"].is_null() || advisor["result"].is_object())
                && advisor.get("result").is_some()
                && (advisor["invalidReason"].is_null() || advisor["invalidReason"].is_string())
                && advisor.get("invalidReason").is_some();
            if !valid {
                return TurnOutcome::default();
            }
            Some(advisor.clone())
        }
    };
    TurnOutcome {
        state,
        advisor,
        text,
    }
}

fn advisor_has_result(outcome: &TurnOutcome, role: &str) -> bool {
    outcome
        .advisor
        .as_ref()
        .is_some_and(|advisor| !advisor["result"].is_null() && advisor["role"] == role)
}

/// The latest Reviewer or Rater record of one role.
pub fn latest_review(reviews: &[ReviewRecord], role: AdvisorRole) -> Option<&ReviewRecord> {
    reviews.iter().rev().find(|record| record.role == role)
}

/// Pure gate over the latest Reviewer or Rater record; a newer invalid or
/// negative record supersedes an earlier positive one.
pub fn review_gate(
    workflow: Workflow,
    reviews: &[ReviewRecord],
    actual: &ReviewRange,
) -> Result<(), String> {
    let Some(role) = review_role(workflow) else {
        return Ok(());
    };
    let label = advisor_label(role.as_str());
    let Some(latest) = latest_review(reviews, role) else {
        return Err(format!(
            "No {label} result exists yet. Request {label} for the current range."
        ));
    };
    let Some(result) = &latest.result else {
        return Err(format!(
            "The latest {label} result is invalid: {}. Request a new {label} assessment.",
            latest.invalid_reason.as_deref().unwrap_or("unknown")
        ));
    };
    let range = &latest.range;
    if !same_range(range, actual) {
        return Err(format!(
            "The latest {label} result reviewed {}..{}, not the current range. Request a new {label} assessment.",
            short(&range.base_sha),
            short(&range.head_sha)
        ));
    }
    if result["role"] == "reviewer" {
        return if result["approved"] == true {
            Ok(())
        } else {
            Err("Reviewer did not approve the current range. Repair every blocking finding and request a new Reviewer assessment.".into())
        };
    }
    let rating = result["rating"].as_i64().unwrap_or(0);
    if rating < REPAIR_RATING_TARGET {
        return Err(format!(
            "Rater scored the current range {rating}/10. Repair the findings and request a new Rater assessment."
        ));
    }
    if result["blockingFindings"]
        .as_array()
        .is_some_and(|findings| !findings.is_empty())
        || !verified(&result["verification"])
    {
        return Err("The Rater result carries blocking findings or missing verification.".into());
    }
    Ok(())
}

/// TypeScript `turnWorkflowInput`: the immutable turn input, else the session's.
pub fn turn_workflow_input<'a>(sessions: &'a [SessionRow], turn: &'a TurnRow) -> Option<&'a Value> {
    turn.workflow_input
        .as_ref()
        .filter(|input| !input.is_null())
        .or_else(|| {
            sessions
                .iter()
                .find(|session| session.id == turn.session_id)
                .and_then(|session| session.workflow_input.as_ref())
                .filter(|input| !input.is_null())
        })
}

fn succeeded(turn: &TurnRow) -> bool {
    turn.status == TurnStatus::Completed
        && turn_outcome(turn.terminal_observation.as_deref())
            .state
            .as_deref()
            == Some("completed")
}

/// A completed turn whose stored Advisor outcome carries a result of `role`.
fn advisor_report(turn: &TurnRow, role: AdvisorRole) -> bool {
    turn.status == TurnStatus::Completed
        && advisor_has_result(
            &turn_outcome(turn.terminal_observation.as_deref()),
            role.as_str(),
        )
}

fn advisor_session(session: &SessionRow, role: AdvisorRole) -> bool {
    session.kind == SessionKind::Worker && session.advisor_role == Some(role)
}

pub fn valid_advisor_session(
    sessions: &[SessionRow],
    turns: &[TurnRow],
    session_id: &str,
    role: AdvisorRole,
) -> bool {
    sessions
        .iter()
        .find(|session| session.id == session_id)
        .is_some_and(|session| advisor_session(session, role))
        && turns
            .iter()
            .any(|turn| turn.session_id == session_id && advisor_report(turn, role))
}

fn valid_advisor_reference(
    sessions: &[SessionRow],
    turns: &[TurnRow],
    reference: &Value,
    role: AdvisorRole,
    exact: bool,
) -> bool {
    let Some(session_id) = reference["sessionId"].as_str() else {
        return false;
    };
    if !exact {
        return valid_advisor_session(sessions, turns, session_id, role);
    }
    let session = sessions.iter().find(|session| session.id == session_id);
    let turn = turns
        .iter()
        .find(|turn| reference["turnId"] == turn.id.as_str() && turn.session_id == session_id);
    session.is_some_and(|session| advisor_session(session, role))
        && turn.is_some_and(|turn| advisor_report(turn, role))
}

/// TypeScript `workerCandidateReports`: version 2 references, or legacy session IDs.
pub fn worker_candidate_reports(input: &Value) -> Option<[Value; 2]> {
    if input.get("version").is_some() {
        let reports = input["candidateReports"].as_array()?;
        return Some([reports.first()?.clone(), reports.get(1)?.clone()]);
    }
    let ids = input["candidateSessionIds"].as_array()?;
    let (first, second) = (ids.first()?, ids.get(1)?);
    Some([
        json!({"sessionId":first,"turnId":first}),
        json!({"sessionId":second,"turnId":second}),
    ])
}

/// Whether the workflow's obligations for the actual range are complete.
pub fn workflow_ready_for_delivery(
    workflow: Workflow,
    reviews: &[ReviewRecord],
    sessions: &[SessionRow],
    turns: &[TurnRow],
    actual: &ReviewRange,
) -> Result<(), String> {
    let worker_turn = |turn: &TurnRow| {
        sessions
            .iter()
            .any(|session| session.id == turn.session_id && session.is_plain_worker())
    };
    match workflow {
        Workflow::Standard => Ok(()),
        Workflow::DirectBuild => {
            let built = turns.iter().any(|turn| {
                let input = turn_workflow_input(sessions, turn);
                worker_turn(turn)
                    && input.is_some_and(|input| {
                        input["kind"] == "worker"
                            && input["mode"] == "direct"
                            && input["purpose"] == "implementation"
                    })
                    && succeeded(turn)
            });
            if built {
                Ok(())
            } else {
                Err("Direct build requires a completed Worker assignment in direct mode before delivery.".into())
            }
        }
        Workflow::CompetingPlans => {
            let build = turns.iter().find(|turn| {
                let input = turn_workflow_input(sessions, turn);
                worker_turn(turn)
                    && input.is_some_and(|input| {
                        input["kind"] == "worker"
                            && input["plan"].as_str().is_some_and(|plan| !plan.is_empty())
                            && worker_candidate_reports(input).is_some()
                    })
                    && succeeded(turn)
            });
            let valid = build.and_then(|build| {
                let input = turn_workflow_input(sessions, build)?;
                let candidates = worker_candidate_reports(input)?;
                let exact = input.get("version").is_some();
                Some(
                    valid_advisor_reference(
                        sessions,
                        turns,
                        &candidates[0],
                        AdvisorRole::PlannerA,
                        exact,
                    ) && valid_advisor_reference(
                        sessions,
                        turns,
                        &candidates[1],
                        AdvisorRole::PlannerB,
                        exact,
                    ),
                )
            });
            if valid == Some(true) {
                Ok(())
            } else {
                Err("Combined planning requires two valid plan reports and a completed Worker build of the combined plan before delivery.".into())
            }
        }
        Workflow::IndependentReview | Workflow::RefinePullRequest => {
            review_gate(workflow, reviews, actual)
        }
    }
}

pub struct LocalSourceFacts<'a> {
    pub branch: Option<&'a str>,
    pub head_sha: Option<&'a str>,
    pub clean: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DeliveryRefusal {
    pub code: &'static str,
    pub reason: String,
}

pub fn review_role(workflow: Workflow) -> Option<AdvisorRole> {
    match workflow {
        Workflow::RefinePullRequest => Some(AdvisorRole::Rater),
        Workflow::IndependentReview => Some(AdvisorRole::Reviewer),
        Workflow::Standard | Workflow::DirectBuild | Workflow::CompetingPlans => None,
    }
}

pub fn fresh_review_hint(workflow: Workflow) -> String {
    match review_role(workflow) {
        Some(role) => format!(
            " Inspect the new range and request a new {} assessment.",
            advisor_label(role.as_str())
        ),
        None => " Inspect the new range and review it again.".into(),
    }
}

/// The one delivery policy for non-Standard workflows, applied to one exact
/// range: the source is on the task branch at the reviewed head and clean, no
/// delegate is reserved, live, or unknown, and the workflow's own obligations hold.
pub fn delivery_decision(
    control: &TaskControlRow,
    sessions: &[SessionRow],
    turns: &[TurnRow],
    range: &ReviewRange,
    local: &LocalSourceFacts<'_>,
    require_review: bool,
) -> Result<(), DeliveryRefusal> {
    let workflow = control.workflow;
    if workflow == Workflow::Standard {
        return Ok(());
    }
    let head_branch = control.delivery_intent.head_branch.as_str();
    if let Some(branch) = local.branch
        && branch != head_branch
    {
        return Err(DeliveryRefusal {
            code: "head_diverged",
            reason: format!("The worktree is on {branch}, not the task branch {head_branch}."),
        });
    }
    if let Some(head) = local.head_sha
        && head != range.head_sha
    {
        return Err(DeliveryRefusal {
            code: "head_diverged",
            reason: format!(
                "The worktree head {} is not the reviewed head {}.{}",
                short(head),
                short(&range.head_sha),
                fresh_review_hint(workflow)
            ),
        });
    }
    if !local.clean {
        return Err(DeliveryRefusal {
            code: "worktree_dirty",
            reason: "The worktree has uncommitted changes. Commit or discard them, inspect delivery again, and review the committed range.".into(),
        });
    }
    let delegate = sessions.iter().find(|session| {
        session.kind == SessionKind::Worker
            && session.current
            && (session
                .launch_owner
                .as_deref()
                .is_some_and(|owner| !owner.is_empty())
                || turns.iter().any(|turn| {
                    turn.session_id == session.id
                        && turn.generation == session.generation
                        && turn.status.is_open()
                }))
    });
    if let Some(delegate) = delegate {
        return Err(DeliveryRefusal {
            code: "delegate_active",
            reason: format!(
                "{} is still active. Wait for its result before requesting delivery.",
                delegate
                    .advisor_role
                    .map_or("Worker", |role| advisor_label(role.as_str()))
            ),
        });
    }
    if !require_review {
        return Ok(());
    }
    let reviews = &control.workflow_state.reviews;
    workflow_ready_for_delivery(workflow, reviews, sessions, turns, range).map_err(|reason| {
        DeliveryRefusal {
            code: "workflow_review_required",
            reason,
        }
    })
}

/// TypeScript `deliveryWaitFingerprint` over one pull request observation.
pub fn delivery_wait_fingerprint(observation: &Value) -> String {
    let checks = &observation["checks"];
    let mut failures = checks["runs"]
        .as_array()
        .map(|runs| {
            runs.iter()
                .filter(|run| run["status"] == "failing")
                .map(|run| {
                    format!(
                        "{}:{}:{}",
                        run["name"].as_str().unwrap_or_default(),
                        run["status"].as_str().unwrap_or_default(),
                        run["conclusion"].as_str().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    failures.sort();
    let pending = checks["pending"].as_f64().unwrap_or(0.0);
    let failing = checks["failing"].as_f64().unwrap_or(0.0);
    let mut summary = vec![json!(if pending > 0.0 { "pending" } else { "settled" })];
    if failing > 0.0 {
        summary.push(json!(format!(
            "failed:{}",
            crate::shared::js_json::stringify(&checks["failing"])
        )));
        summary.extend(failures.into_iter().map(Value::String));
    }
    crate::shared::js_json::stringify(&json!({
        "number": observation["number"], "head": observation["headSha"], "draft": observation["isDraft"],
        "review": observation["reviewDecision"], "mergeable": observation["mergeable"],
        "mergeState": observation["mergeStateStatus"], "state": observation["state"], "checks": summary,
    }))
}

pub fn same_delivery_wait_fingerprint(stored: &str, observation: &Value) -> bool {
    let current = delivery_wait_fingerprint(observation);
    if stored == current {
        return true;
    }
    let checks = &observation["checks"];
    if checks["pending"].as_f64().unwrap_or(0.0) == 0.0
        || checks["failing"].as_f64().unwrap_or(0.0) > 0.0
    {
        return false;
    }
    let Ok(Value::Object(mut legacy)) = serde_json::from_str::<Value>(stored) else {
        return false;
    };
    let keys = [
        "number",
        "head",
        "draft",
        "review",
        "mergeable",
        "mergeState",
        "state",
        "checks",
    ];
    if legacy.len() != keys.len() || !keys.iter().all(|key| legacy.contains_key(*key)) {
        return false;
    }
    let Some(entries) = legacy["checks"].as_array().cloned() else {
        return false;
    };
    let entries = entries
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default();
    if entries.is_empty()
        || !entries.iter().any(|check| check.ends_with(":pending:"))
        || entries.iter().any(|check| check.contains(":failing:"))
    {
        return false;
    }
    legacy.insert("checks".into(), json!(["pending"]));
    crate::shared::js_json::stringify(&Value::Object(legacy)) == current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(letter: char) -> String {
        letter.to_string().repeat(40)
    }

    fn range() -> ReviewRange {
        ReviewRange {
            base_sha: sha('a'),
            head_sha: sha('b'),
            files: vec!["src/a.ts".into()],
            commits: vec![sha('b')],
            patch_digest: None,
        }
    }

    fn record(role: &str, result: Value, range: &ReviewRange) -> ReviewRecord {
        serde_json::from_value(
            json!({"sessionId":"s","turnId":"t","role":role,"range":range,"result":result,
            "invalidReason": if result.is_null() { json!("malformed") } else { Value::Null },
            "recordedAt":"2026-09-06T00:00:00.000Z"}),
        )
        .unwrap()
    }

    #[test]
    fn the_catalog_has_five_workflows_with_fixed_roles() {
        assert_eq!(
            WORKFLOWS
                .iter()
                .map(|definition| definition.id)
                .collect::<Vec<_>>(),
            [
                "standard",
                "direct_build",
                "independent_review",
                "competing_plans",
                "refine_pull_request"
            ]
        );
        assert_eq!(
            WORKFLOWS
                .iter()
                .map(|definition| definition.name)
                .collect::<Vec<_>>(),
            [
                "Standard",
                "Direct build",
                "Second opinion",
                "Combined planning",
                "Pull request repair"
            ]
        );
        assert_eq!(
            workflow_definition("competing_plans")
                .unwrap()
                .advisor_roles,
            ["planner_a", "planner_b"]
        );
        assert_eq!(role_label("worker", Some("planner_b")), "Plan B");
        assert_eq!(role_label("worker", None), "Worker");
        assert_eq!(role_label("root", None), "Coordinator");
    }

    #[test]
    fn the_review_gate_uses_the_latest_same_role_record_for_the_actual_range() {
        let range = range();
        let pass = json!({"role":"rater","rating":9,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"});
        assert_eq!(review_gate(Workflow::Standard, &[], &range), Ok(()));
        assert!(review_gate(Workflow::RefinePullRequest, &[], &range).is_err());
        assert_eq!(
            review_gate(
                Workflow::RefinePullRequest,
                &[record("rater", pass.clone(), &range)],
                &range
            ),
            Ok(())
        );
        assert!(
            review_gate(
                Workflow::RefinePullRequest,
                &[
                    record("rater", pass.clone(), &range),
                    record("rater", Value::Null, &range)
                ],
                &range
            )
            .unwrap_err()
            .contains("invalid")
        );
        let mut eight = pass.clone();
        eight["rating"] = json!(8);
        assert!(
            review_gate(
                Workflow::RefinePullRequest,
                &[
                    record("rater", pass.clone(), &range),
                    record("rater", eight, &range)
                ],
                &range
            )
            .unwrap_err()
            .contains("8/10")
        );
        let moved = ReviewRange {
            head_sha: sha('c'),
            ..range.clone()
        };
        assert!(
            review_gate(
                Workflow::RefinePullRequest,
                &[record("rater", pass, &moved)],
                &range
            )
            .unwrap_err()
            .contains("not the current range")
        );
        let approved = json!({"role":"reviewer","approved":true,"blockingFindings":[],"verification":"not_applicable","verificationSummary":"docs only","summary":"ok"});
        assert_eq!(
            review_gate(
                Workflow::IndependentReview,
                &[record("reviewer", approved, &range)],
                &range
            ),
            Ok(())
        );
        let rejected = json!({"role":"reviewer","approved":false,"blockingFindings":["x"],"verification":"passed","verificationSummary":"ok","summary":"no"});
        assert!(
            review_gate(
                Workflow::IndependentReview,
                &[record("reviewer", rejected, &range)],
                &range
            )
            .is_err()
        );
    }

    #[test]
    fn range_equivalence_uses_the_complete_patch_digest_when_bases_differ() {
        let base = ReviewRange {
            base_sha: sha('a'),
            head_sha: sha('b'),
            files: vec!["src.ts".into()],
            commits: vec![sha('b')],
            patch_digest: Some("c".repeat(64)),
        };
        let moved = ReviewRange {
            base_sha: sha('d'),
            ..base.clone()
        };
        assert!(range_differences(&base, &base).is_empty());
        assert!(range_differences(&base, &moved).is_empty());
        assert_eq!(
            range_differences(
                &base,
                &ReviewRange {
                    patch_digest: Some("e".repeat(64)),
                    ..moved.clone()
                }
            ),
            ["patch content"]
        );
        assert_eq!(
            range_differences(
                &base,
                &ReviewRange {
                    patch_digest: None,
                    ..moved.clone()
                }
            ),
            ["patch content"]
        );
        assert_eq!(
            range_differences(
                &base,
                &ReviewRange {
                    head_sha: sha('e'),
                    ..moved.clone()
                }
            ),
            ["head"]
        );
        assert!(same_range(&base, &moved));
    }

    #[test]
    fn delivery_decision_names_the_first_unsafe_condition() {
        let range = range();
        let mut control = TaskControlRow::fixture();
        control.workflow = Workflow::IndependentReview;
        control.delivery_intent.head_branch = "task".into();
        let clean = LocalSourceFacts {
            branch: Some("task"),
            head_sha: Some(&range.head_sha),
            clean: true,
        };
        assert_eq!(
            delivery_decision(
                &TaskControlRow::fixture(),
                &[],
                &[],
                &range,
                &LocalSourceFacts {
                    branch: None,
                    head_sha: None,
                    clean: false
                },
                true
            ),
            Ok(())
        );
        assert_eq!(
            delivery_decision(
                &control,
                &[],
                &[],
                &range,
                &LocalSourceFacts {
                    branch: Some("main"),
                    ..clean
                },
                true
            )
            .unwrap_err()
            .code,
            "head_diverged"
        );
        let other = sha('c');
        let moved = delivery_decision(
            &control,
            &[],
            &[],
            &range,
            &LocalSourceFacts {
                branch: Some("task"),
                head_sha: Some(&other),
                clean: true,
            },
            true,
        )
        .unwrap_err();
        assert!(
            moved.reason.ends_with("request a new Reviewer assessment."),
            "{}",
            moved.reason
        );
        assert_eq!(
            delivery_decision(
                &control,
                &[],
                &[],
                &range,
                &LocalSourceFacts {
                    branch: Some("task"),
                    head_sha: Some(&range.head_sha),
                    clean: false
                },
                true
            )
            .unwrap_err()
            .code,
            "worktree_dirty"
        );
        let sessions = [SessionRow {
            advisor_role: Some(AdvisorRole::Reviewer),
            generation: 2,
            ..SessionRow::fixture("r1", SessionKind::Worker)
        }];
        let turns = [TurnRow {
            generation: 2,
            ..TurnRow::fixture("t1", "r1", TurnStatus::Prompted)
        }];
        let busy = delivery_decision(
            &control,
            &sessions,
            &turns,
            &range,
            &LocalSourceFacts {
                branch: Some("task"),
                head_sha: Some(&range.head_sha),
                clean: true,
            },
            true,
        )
        .unwrap_err();
        assert_eq!(
            (busy.code, busy.reason.as_str()),
            (
                "delegate_active",
                "Reviewer is still active. Wait for its result before requesting delivery."
            )
        );
        let facts = LocalSourceFacts {
            branch: Some("task"),
            head_sha: Some(&range.head_sha),
            clean: true,
        };
        assert_eq!(
            delivery_decision(&control, &[], &[], &range, &facts, false),
            Ok(())
        );
        assert_eq!(
            delivery_decision(&control, &[], &[], &range, &facts, true)
                .unwrap_err()
                .code,
            "workflow_review_required"
        );
    }

    #[test]
    fn direct_and_combined_obligations_follow_worker_turn_inputs() {
        let range = range();
        let direct_worker = SessionRow::fixture("w", SessionKind::Worker);
        let completed = |id: &str, session: &str, input: Value, observation: Value| TurnRow {
            workflow_input: Some(input).filter(|input| !input.is_null()),
            terminal_observation: Some(observation.to_string()),
            ..TurnRow::fixture(id, session, TurnStatus::Completed)
        };
        let direct = completed(
            "t",
            "w",
            json!({"kind":"worker","mode":"direct","purpose":"implementation"}),
            json!({"state":"completed","text":"done"}),
        );
        assert_eq!(
            workflow_ready_for_delivery(
                Workflow::DirectBuild,
                &[],
                std::slice::from_ref(&direct_worker),
                std::slice::from_ref(&direct),
                &range
            ),
            Ok(())
        );
        let planned = completed(
            "t",
            "w",
            json!({"kind":"worker","mode":"planned","purpose":"implementation"}),
            json!({"state":"completed"}),
        );
        assert!(
            workflow_ready_for_delivery(
                Workflow::DirectBuild,
                &[],
                std::slice::from_ref(&direct_worker),
                &[planned],
                &range
            )
            .is_err()
        );
        let plan_a = SessionRow {
            advisor_role: Some(AdvisorRole::PlannerA),
            ..SessionRow::fixture("a", SessionKind::Worker)
        };
        let plan_b = SessionRow {
            advisor_role: Some(AdvisorRole::PlannerB),
            ..SessionRow::fixture("b", SessionKind::Worker)
        };
        let report = |role: &str| json!({"state":"completed","advisor":{"role":role,"result":{"role":role,"summary":"plan"},"invalidReason":null}});
        let a = completed("ta", "a", Value::Null, report("planner_a"));
        let b = completed("tb", "b", Value::Null, report("planner_b"));
        let build = completed(
            "tw",
            "w",
            json!({"kind":"worker","version":2,"mode":"planned","purpose":"implementation","plan":"Merged","candidateReports":[{"sessionId":"a","turnId":"ta"},{"sessionId":"b","turnId":"tb"}]}),
            json!({"state":"completed"}),
        );
        let sessions = [direct_worker, plan_a, plan_b];
        assert_eq!(
            workflow_ready_for_delivery(
                Workflow::CompetingPlans,
                &[],
                &sessions,
                &[a.clone(), b.clone(), build.clone()],
                &range
            ),
            Ok(())
        );
        let invalid_b = completed(
            "tb",
            "b",
            Value::Null,
            json!({"state":"completed","advisor":{"role":"planner_b","result":null,"invalidReason":"bad"}}),
        );
        assert!(
            workflow_ready_for_delivery(
                Workflow::CompetingPlans,
                &[],
                &sessions,
                &[a, invalid_b, build],
                &range
            )
            .is_err()
        );
    }

    #[test]
    fn delivery_wait_fingerprints_ignore_passing_jobs_while_another_is_pending() {
        let observation = |pending: i64, runs: Value| json!({"number":7,"headSha":"h","baseSha":"b","isDraft":false,"reviewDecision":null,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","state":"open","checks":{"pending":pending,"failing":0,"runs":runs}});
        let first = observation(
            2,
            json!([{"name":"lint","status":"pending"},{"name":"test","status":"pending"}]),
        );
        let later = observation(
            1,
            json!([{"name":"lint","status":"passing","conclusion":"success"},{"name":"test","status":"pending"}]),
        );
        let stored = delivery_wait_fingerprint(&first);
        assert_eq!(
            stored,
            r#"{"number":7,"head":"h","draft":false,"review":null,"mergeable":"MERGEABLE","mergeState":"BLOCKED","state":"open","checks":["pending"]}"#
        );
        assert!(same_delivery_wait_fingerprint(&stored, &later));
        let legacy = r#"{"number":7,"head":"h","draft":false,"review":null,"mergeable":"MERGEABLE","mergeState":"BLOCKED","state":"open","checks":["lint:pending:","test:pending:"]}"#;
        assert!(same_delivery_wait_fingerprint(legacy, &later));
        let failed = json!({"number":7,"headSha":"h","isDraft":false,"reviewDecision":null,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","state":"open","checks":{"pending":0,"failing":1,"runs":[{"name":"test","status":"failing","conclusion":"failure"}]}});
        assert!(
            delivery_wait_fingerprint(&failed).contains("\"failed:1\",\"test:failing:failure\"")
        );
        assert!(!same_delivery_wait_fingerprint(&stored, &failed));
    }

    #[test]
    fn malformed_turn_outcomes_are_unknown() {
        assert_eq!(turn_outcome(Some(r#"{"state":1}"#)), TurnOutcome::default());
        assert_eq!(
            turn_outcome(Some(
                r#"{"state":"completed","advisor":{"role":"other","result":null,"invalidReason":null}}"#
            )),
            TurnOutcome::default()
        );
        assert_eq!(
            turn_outcome(Some(r#"{"state":"completed","text":"ok"}"#))
                .text
                .as_deref(),
            Some("ok")
        );
    }
}
