//! TypeScript `coordination/workflows.ts`: the built-in workflow catalog and
//! the pure delivery policy over Suplex-owned review records. Sessions, turns,
//! and review records use their persisted JSON shapes.

use serde_json::{Value, json};

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

pub fn workflow_definition(workflow: &str) -> Option<&'static WorkflowDefinition> {
    WORKFLOWS
        .iter()
        .find(|definition| definition.id == workflow)
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

pub fn latest_review<'a>(reviews: &'a [Value], role: &str) -> Option<&'a Value> {
    reviews.iter().rev().find(|record| record["role"] == role)
}

/// Pure gate over the latest Reviewer or Rater record; a newer invalid or
/// negative record supersedes an earlier positive one.
pub fn review_gate(workflow: &str, reviews: &[Value], actual: &ReviewRange) -> Result<(), String> {
    let role = match workflow {
        "independent_review" => "reviewer",
        "refine_pull_request" => "rater",
        _ => return Ok(()),
    };
    let label = advisor_label(role);
    let Some(latest) = latest_review(reviews, role) else {
        return Err(format!(
            "No {label} result exists yet. Request {label} for the current range."
        ));
    };
    let result = &latest["result"];
    if result.is_null() {
        return Err(format!(
            "The latest {label} result is invalid: {}. Request a new {label} assessment.",
            latest["invalidReason"].as_str().unwrap_or("unknown")
        ));
    }
    let range = ReviewRange::from_value(&latest["range"]).unwrap_or_default();
    if !same_range(&range, actual) {
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
pub fn turn_workflow_input<'a>(sessions: &'a [Value], turn: &'a Value) -> Option<&'a Value> {
    turn.get("workflowInput")
        .filter(|input| !input.is_null())
        .or_else(|| {
            sessions
                .iter()
                .find(|session| session["id"] == turn["sessionId"])
                .and_then(|session| session.get("workflowInput"))
                .filter(|input| !input.is_null())
        })
}

fn succeeded(turn: &Value) -> bool {
    turn["status"] == "completed"
        && turn_outcome(turn["terminalObservation"].as_str())
            .state
            .as_deref()
            == Some("completed")
}

fn plain_worker(session: &Value) -> bool {
    session["kind"] == "worker" && session["advisorRole"].is_null()
}

pub fn valid_advisor_session(
    sessions: &[Value],
    turns: &[Value],
    session_id: &str,
    role: &str,
) -> bool {
    let Some(session) = sessions.iter().find(|session| session["id"] == session_id) else {
        return false;
    };
    if session["kind"] != "worker" || session["advisorRole"] != role {
        return false;
    }
    turns.iter().any(|turn| {
        turn["sessionId"] == session_id
            && turn["status"] == "completed"
            && advisor_has_result(&turn_outcome(turn["terminalObservation"].as_str()), role)
    })
}

fn valid_advisor_reference(
    sessions: &[Value],
    turns: &[Value],
    reference: &Value,
    role: &str,
    exact: bool,
) -> bool {
    let Some(session_id) = reference["sessionId"].as_str() else {
        return false;
    };
    if !exact {
        return valid_advisor_session(sessions, turns, session_id, role);
    }
    let session = sessions.iter().find(|session| session["id"] == session_id);
    let turn = turns
        .iter()
        .find(|turn| turn["id"] == reference["turnId"] && turn["sessionId"] == session_id);
    session.is_some_and(|session| session["kind"] == "worker" && session["advisorRole"] == role)
        && turn.is_some_and(|turn| {
            turn["status"] == "completed"
                && advisor_has_result(&turn_outcome(turn["terminalObservation"].as_str()), role)
        })
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
    workflow: &str,
    reviews: &[Value],
    sessions: &[Value],
    turns: &[Value],
    actual: &ReviewRange,
) -> Result<(), String> {
    let worker_turn = |turn: &Value| {
        sessions
            .iter()
            .any(|session| session["id"] == turn["sessionId"] && plain_worker(session))
    };
    match workflow {
        "standard" => Ok(()),
        "direct_build" => {
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
        "competing_plans" => {
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
                    valid_advisor_reference(sessions, turns, &candidates[0], "planner_a", exact)
                        && valid_advisor_reference(
                            sessions,
                            turns,
                            &candidates[1],
                            "planner_b",
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
        _ => review_gate(workflow, reviews, actual),
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

pub fn review_role(workflow: &str) -> Option<&'static str> {
    match workflow {
        "refine_pull_request" => Some("rater"),
        "independent_review" => Some("reviewer"),
        _ => None,
    }
}

pub fn fresh_review_hint(workflow: &str) -> String {
    match review_role(workflow) {
        Some(role) => format!(
            " Inspect the new range and request a new {} assessment.",
            advisor_label(role)
        ),
        None => " Inspect the new range and review it again.".into(),
    }
}

/// The one delivery policy for non-Standard workflows, applied to one exact
/// range: the source is on the task branch at the reviewed head and clean, no
/// delegate is reserved, live, or unknown, and the workflow's own obligations hold.
pub fn delivery_decision(
    control: &Value,
    sessions: &[Value],
    turns: &[Value],
    range: &ReviewRange,
    local: &LocalSourceFacts<'_>,
    require_review: bool,
) -> Result<(), DeliveryRefusal> {
    let workflow = control["workflow"].as_str().unwrap_or("standard");
    if workflow == "standard" {
        return Ok(());
    }
    let head_branch = control["deliveryIntent"]["headBranch"]
        .as_str()
        .unwrap_or_default();
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
        session["kind"] == "worker"
            && session["current"] == true
            && (session["launchOwner"]
                .as_str()
                .is_some_and(|owner| !owner.is_empty())
                || turns.iter().any(|turn| {
                    turn["sessionId"] == session["id"]
                        && (turn["generation"].is_null()
                            || session["generation"].is_null()
                            || turn["generation"] == session["generation"])
                        && matches!(
                            turn["status"].as_str(),
                            Some("pending_prompt" | "prompted" | "unknown")
                        )
                }))
    });
    if let Some(delegate) = delegate {
        return Err(DeliveryRefusal {
            code: "delegate_active",
            reason: format!(
                "{} is still active. Wait for its result before requesting delivery.",
                delegate["advisorRole"]
                    .as_str()
                    .map_or("Worker", advisor_label)
            ),
        });
    }
    if !require_review {
        return Ok(());
    }
    let reviews = control["workflowState"]["reviews"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
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

    fn record(role: &str, result: Value, range: &ReviewRange) -> Value {
        json!({"sessionId":"s","turnId":"t","role":role,"range":range,"result":result,
            "invalidReason": if result.is_null() { json!("malformed") } else { Value::Null },
            "recordedAt":"2026-09-06T00:00:00.000Z"})
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
        assert_eq!(review_gate("standard", &[], &range), Ok(()));
        assert!(review_gate("refine_pull_request", &[], &range).is_err());
        assert_eq!(
            review_gate(
                "refine_pull_request",
                &[record("rater", pass.clone(), &range)],
                &range
            ),
            Ok(())
        );
        assert!(
            review_gate(
                "refine_pull_request",
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
                "refine_pull_request",
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
                "refine_pull_request",
                &[record("rater", pass, &moved)],
                &range
            )
            .unwrap_err()
            .contains("not the current range")
        );
        let approved = json!({"role":"reviewer","approved":true,"blockingFindings":[],"verification":"not_applicable","verificationSummary":"docs only","summary":"ok"});
        assert_eq!(
            review_gate(
                "independent_review",
                &[record("reviewer", approved, &range)],
                &range
            ),
            Ok(())
        );
        let rejected = json!({"role":"reviewer","approved":false,"blockingFindings":["x"],"verification":"passed","verificationSummary":"ok","summary":"no"});
        assert!(
            review_gate(
                "independent_review",
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
        let control = json!({"workflow":"independent_review","deliveryIntent":{"headBranch":"task"},"workflowState":{"reviews":[]}});
        let clean = LocalSourceFacts {
            branch: Some("task"),
            head_sha: Some(&range.head_sha),
            clean: true,
        };
        assert_eq!(
            delivery_decision(
                &json!({"workflow":"standard"}),
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
        let sessions = [
            json!({"id":"r1","kind":"worker","current":true,"advisorRole":"reviewer","generation":2,"launchOwner":null}),
        ];
        let turns = [json!({"id":"t1","sessionId":"r1","generation":2,"status":"prompted"})];
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
        let direct_worker =
            json!({"id":"w","kind":"worker","advisorRole":null,"workflowInput":null});
        let completed = |id: &str, session: &str, input: Value, observation: Value| json!({"id":id,"sessionId":session,"status":"completed","workflowInput":input,"terminalObservation":observation.to_string()});
        let direct = completed(
            "t",
            "w",
            json!({"kind":"worker","mode":"direct","purpose":"implementation"}),
            json!({"state":"completed","text":"done"}),
        );
        assert_eq!(
            workflow_ready_for_delivery(
                "direct_build",
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
                "direct_build",
                &[],
                std::slice::from_ref(&direct_worker),
                &[planned],
                &range
            )
            .is_err()
        );
        let plan_a = json!({"id":"a","kind":"worker","advisorRole":"planner_a"});
        let plan_b = json!({"id":"b","kind":"worker","advisorRole":"planner_b"});
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
                "competing_plans",
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
                "competing_plans",
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
