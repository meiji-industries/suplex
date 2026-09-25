//! TypeScript `tasks/integration.ts`: derive a task's integration state and
//! next required action from its public task shape and a GitHub observation.
//! The agent API routes (W8) call these; inputs are the public task JSON.

use serde_json::{Value, json};

use crate::integrations::github_delivery::Observation;

const PULL_REQUEST_TARGETS: [&str; 3] = ["pull_request_draft", "pull_request_ready", "merged"];

pub fn requires_pull_request(task: &Value) -> bool {
    PULL_REQUEST_TARGETS.contains(&task["deliveryTarget"].as_str().unwrap_or(""))
}

/// GitHub is only asked once a task has a pull request or delivered to a pull request target.
pub fn observable_delivery(task: &Value) -> bool {
    !task["pullRequest"].is_null() || (task["status"] == "delivered" && requires_pull_request(task))
}

fn pull_request_state(observation: Option<&Observation>) -> &'static str {
    let Some(observation) = observation.filter(|observation| observation.exists) else {
        return "absent";
    };
    match observation.state.as_deref() {
        Some("merged") => return "merged",
        Some("closed") => return "closed",
        _ => {}
    }
    if observation.mergeable.as_deref() == Some("CONFLICTING")
        || observation.merge_state_status.as_deref() == Some("DIRTY")
    {
        return "conflicting";
    }
    match observation.is_draft {
        Some(true) => "draft",
        Some(false) => "ready",
        None => "open",
    }
}

/// TypeScript `deriveTaskIntegration`.
pub fn derive_task_integration(
    task: &Value,
    observation: Option<&Observation>,
    failure_code: Option<&str>,
    observed_at: &str,
) -> Value {
    let state = pull_request_state(observation);
    let integrated = state == "merged"
        || (task["status"] == "delivered" && !requires_pull_request(task) && failure_code.is_none());
    let checks = observation.map(|observation| &observation.checks);
    json!({
        "integrated": integrated,
        "pullRequest": {
            "state": state,
            "number": observation.and_then(|o| o.number).map(Value::from).unwrap_or_else(|| task["pullRequest"]["number"].clone()),
            "url": observation.and_then(|o| o.url.clone()),
            "targetBranch": task["configuration"]["baseBranch"],
            "headSha": observation.and_then(|o| o.head_sha.clone()),
            "baseSha": observation.and_then(|o| o.base_sha.clone()),
            "mergeable": observation.and_then(|o| o.mergeable.clone()),
            "mergeStateStatus": observation.and_then(|o| o.merge_state_status.clone()),
            "reviewDecision": observation.and_then(|o| o.review_decision.clone()),
            "checks": {
                "total": checks.map_or(0, |c| c.total), "pending": checks.map_or(0, |c| c.pending),
                "failing": checks.map_or(0, |c| c.failing), "successful": checks.map_or(0, |c| c.successful),
            },
        },
        "observedAt": observed_at,
        "observation": if failure_code.is_none() { "observed" } else { "unavailable" },
        "observationReason": failure_code,
        // Suplex does not observe deployed runtimes, so it never claims that a change is live.
        "deployed": {"included": null, "reason": "not_determinable"},
    })
}

/// TypeScript `isUpstreamOf`: branched from the upstream head branch or pull request.
pub fn is_upstream_of(upstream: &Value, task: &Value) -> bool {
    if upstream["id"] == task["id"] {
        return false;
    }
    let lower = |value: &Value| value.as_str().map(str::to_lowercase);
    if lower(&upstream["configuration"]["repository"]) != lower(&task["configuration"]["repository"]) {
        return false;
    }
    let source = &task["configuration"]["source"];
    if source["kind"] == "branch" && source["branch"] == upstream["configuration"]["branch"] {
        return true;
    }
    if source["kind"] == "pull_request"
        && !upstream["pullRequest"]["number"].is_null()
        && upstream["pullRequest"]["number"] == source["number"]
    {
        return true;
    }
    task["configuration"]["baseBranch"] == upstream["configuration"]["branch"]
}

fn merge_commands(task: &Value) -> Vec<String> {
    let base = task["configuration"]["baseBranch"].as_str().unwrap_or("");
    vec![format!("git fetch origin {base}"), format!("git merge origin/{base}")]
}

fn action(owner: &str, reason: &str, summary: &str, commands: Vec<String>, upstream: Value, human: bool, at: &Value) -> Value {
    json!({"upstream": upstream, "humanApprovalRequired": human, "owner": owner, "reasonCode": reason, "summary": summary, "suggestedCommands": commands, "evidenceAt": at})
}

/// TypeScript `deriveActionRequired`.
pub fn derive_action_required(task: &Value, integration: &Value, upstream: &Value) -> Value {
    let at = &integration["observedAt"];
    let pull = &integration["pullRequest"];
    let repository = task["configuration"]["repository"].as_str().unwrap_or("");
    let reference = match pull["number"].as_u64() {
        None => task["configuration"]["branch"].as_str().unwrap_or("").to_owned(),
        Some(number) => format!("{number} --repo {repository}"),
    };
    let state = pull["state"].as_str().unwrap_or("");
    if task["status"] == "waiting_human" {
        return action("human", "waiting_human", "The task waits for your answer. Answer the question in Suplex.", vec![], Value::Null, true, at);
    }
    if integration["observation"] == "unavailable" {
        return action("suplex", "observation_unavailable", "Suplex could not read the pull request from GitHub. Check the GitHub access and retry.", vec![format!("gh pr view {reference}")], Value::Null, false, at);
    }
    if integration["integrated"] == true {
        return Value::Null;
    }
    if state == "conflicting" {
        return action("agent", "conflicting_pull_request", "GitHub reports merge conflicts on the pull request. The task owner must merge the base branch and resolve the conflicts.", merge_commands(task), Value::Null, false, at);
    }
    if pull["checks"]["failing"].as_u64().unwrap_or(0) > 0 {
        return action("agent", "failed_checks", "CI reports failed checks on the pull request. The task owner must read the checks and repair the build.", vec![format!("gh pr checks {reference}")], Value::Null, false, at);
    }
    let stale_head = !task["pullRequest"]["headSha"].is_null()
        && !pull["headSha"].is_null()
        && task["pullRequest"]["headSha"] != pull["headSha"];
    if state != "absent" && state != "closed" && (pull["mergeStateStatus"] == "BEHIND" || stale_head) {
        return action("agent", "stale_delivery", "The pull request is behind the base branch. The task owner must update the branch and push the result.", merge_commands(task), Value::Null, false, at);
    }
    if task["status"] == "delivered" && requires_pull_request(task) && (state == "absent" || state == "closed") {
        let command = format!(
            "gh pr create --repo {repository} --head {} --base {}",
            task["configuration"]["branch"].as_str().unwrap_or(""),
            task["configuration"]["baseBranch"].as_str().unwrap_or("")
        );
        return action("agent", "pull_request_missing", "Suplex delivered the task without an open pull request. The task owner must create the pull request for the branch.", vec![command], Value::Null, false, at);
    }
    if !upstream.is_null() {
        return action("upstream", "blocked_by_dependency", "An upstream task is not integrated. Wait for the upstream pull request to merge.", vec![], upstream.clone(), false, at);
    }
    if state == "absent" {
        return Value::Null;
    }
    if pull["checks"]["pending"].as_u64().unwrap_or(0) > 0 {
        return action("suplex", "pending_checks", "CI checks are not complete on the pull request. Check the pull request after the checks finish.", vec![format!("gh pr checks {reference}")], Value::Null, false, at);
    }
    if pull["reviewDecision"] != "APPROVED" {
        return action("human", "pending_review", "The pull request waits for a review decision. Review the pull request.", vec![format!("gh pr view {reference}")], Value::Null, true, at);
    }
    action("human", "waiting_human", "The pull request is approved and not merged. Merge the pull request.", vec![format!("gh pr view {reference}")], Value::Null, true, at)
}

/// TypeScript `matchesAgentApiFilter`.
pub fn matches_agent_api_filter(integration: &Value, action_required: &Value, filter: &str) -> bool {
    if filter == "not_integrated" {
        return integration["integrated"] != true;
    }
    action_required["reasonCode"] == filter
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(status: &str, target: &str) -> Value {
        json!({"id":"t1","status":status,"deliveryTarget":target,"pullRequest":null,
            "configuration":{"repository":"o/r","branch":"task","baseBranch":"main","source":null}})
    }

    #[test]
    fn delivered_local_work_is_integrated_and_needs_no_action() {
        let task = task("delivered", "local_worktree");
        let integration = derive_task_integration(&task, None, None, "2026-09-25T00:00:00.000Z");
        assert_eq!(integration["integrated"], true);
        assert_eq!(integration["pullRequest"]["state"], "absent");
        assert!(derive_action_required(&task, &integration, &Value::Null).is_null());
        assert!(!matches_agent_api_filter(&integration, &Value::Null, "failed_checks"));
    }

    #[test]
    fn conflicts_failures_and_missing_pull_requests_name_the_owner() {
        let task = task("delivered", "pull_request_draft");
        let missing = derive_task_integration(&task, None, None, "now");
        assert_eq!(derive_action_required(&task, &missing, &Value::Null)["reasonCode"], "pull_request_missing");
        let mut observed = Observation { exists: true, number: Some(7), state: Some("open".into()), is_draft: Some(false), mergeable: Some("CONFLICTING".into()), ..Observation::default() };
        let conflicting = derive_task_integration(&task, Some(&observed), None, "now");
        assert_eq!(conflicting["pullRequest"]["state"], "conflicting");
        assert_eq!(derive_action_required(&task, &conflicting, &Value::Null)["owner"], "agent");
        observed.mergeable = None;
        observed.checks.failing = 1;
        let failing = derive_task_integration(&task, Some(&observed), None, "now");
        assert_eq!(derive_action_required(&task, &failing, &Value::Null)["suggestedCommands"], json!(["gh pr checks 7 --repo o/r"]));
        let unavailable = derive_task_integration(&task, None, Some("provider-unavailable"), "now");
        assert_eq!(derive_action_required(&task, &unavailable, &Value::Null)["reasonCode"], "observation_unavailable");
    }

    #[test]
    fn upstream_follows_branch_source_and_base_branch() {
        let upstream = json!({"id":"up","pullRequest":{"number":3},"configuration":{"repository":"O/R","branch":"feature"}});
        let mut child = task("active", "merged");
        assert!(!is_upstream_of(&upstream, &child));
        child["configuration"]["source"] = json!({"kind":"pull_request","number":3});
        assert!(is_upstream_of(&upstream, &child));
        child["configuration"]["source"] = Value::Null;
        child["configuration"]["baseBranch"] = json!("feature");
        assert!(is_upstream_of(&upstream, &child));
    }
}
