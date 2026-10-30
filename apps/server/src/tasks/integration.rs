//! TypeScript `tasks/integration.ts`: derive a task's integration state and
//! next required action from its public task shape and a GitHub observation.
//! The agent API routes (W8) call these.

#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

use serde::Serialize;
use ts_rs::TS;

use crate::http::contracts::typed::tasks::TaskSource;
use crate::integrations::github_delivery::{Observation, review_blocks_merge};
use crate::tasks::control::TaskStatus;
use crate::tasks::response::TaskResponse;

crate::shared::wire_enum! {
    pub enum IntegrationPullRequestState {
        Absent = "absent",
        Merged = "merged",
        Closed = "closed",
        Conflicting = "conflicting",
        Draft = "draft",
        Ready = "ready",
        Open = "open",
    }
}

crate::shared::wire_enum! {
    pub enum ObservationStatus {
        Observed = "observed",
        Unavailable = "unavailable",
    }
}

crate::shared::wire_enum! {
    pub enum ActionOwner {
        Human = "human",
        Suplex = "suplex",
        Agent = "agent",
        Upstream = "upstream",
    }
}

crate::shared::wire_enum! {
    pub enum ActionReason {
        WaitingHuman = "waiting_human",
        ObservationUnavailable = "observation_unavailable",
        ConflictingPullRequest = "conflicting_pull_request",
        FailedChecks = "failed_checks",
        StaleDelivery = "stale_delivery",
        PullRequestMissing = "pull_request_missing",
        BlockedByDependency = "blocked_by_dependency",
        PendingChecks = "pending_checks",
        PendingReview = "pending_review",
    }
}

/// TypeScript `TaskIntegration`.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskIntegration {
    pub integrated: bool,
    pub pull_request: IntegrationPullRequest,
    pub observed_at: String,
    pub observation: ObservationStatus,
    pub observation_reason: Option<String>,
    pub deployed: Deployed,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPullRequest {
    pub state: IntegrationPullRequestState,
    pub number: Option<u64>,
    pub url: Option<String>,
    pub target_branch: String,
    pub head_sha: Option<String>,
    pub base_sha: Option<String>,
    pub mergeable: Option<String>,
    pub merge_state_status: Option<String>,
    pub review_decision: Option<String>,
    pub checks: CheckCounts,
}

#[derive(Clone, Debug, Default, Serialize, TS)]
pub struct CheckCounts {
    pub total: u64,
    pub pending: u64,
    pub failing: u64,
    pub successful: u64,
}

/// Suplex does not observe deployed runtimes, so it never claims that a change is live.
#[derive(Clone, Debug, Serialize, TS)]
pub struct Deployed {
    included: (),
    #[ts(type = "\"not_determinable\"")]
    reason: &'static str,
}

/// TypeScript `ActionRequired`.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequired {
    pub upstream: Option<UpstreamBlocker>,
    pub human_approval_required: bool,
    pub owner: ActionOwner,
    pub reason_code: ActionReason,
    pub summary: &'static str,
    pub suggested_commands: Vec<String>,
    pub evidence_at: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamBlocker {
    pub task_id: String,
    pub pull_request_number: Option<u64>,
}

pub fn requires_pull_request(task: &TaskResponse) -> bool {
    task.delivery_target.uses_pull_request()
}

/// GitHub is only asked once a task has a pull request or delivered to a pull request target.
pub fn observable_delivery(task: &TaskResponse) -> bool {
    task.pull_request.is_some()
        || (task.status == TaskStatus::Delivered && requires_pull_request(task))
}

fn pull_request_state(observation: Option<&Observation>) -> IntegrationPullRequestState {
    use IntegrationPullRequestState as State;
    let Some(observation) = observation.filter(|observation| observation.exists) else {
        return State::Absent;
    };
    match observation.state.as_deref() {
        Some("merged") => return State::Merged,
        Some("closed") => return State::Closed,
        _ => {}
    }
    if observation.mergeable.as_deref() == Some("CONFLICTING")
        || observation.merge_state_status.as_deref() == Some("DIRTY")
    {
        return State::Conflicting;
    }
    match observation.is_draft {
        Some(true) => State::Draft,
        Some(false) => State::Ready,
        None => State::Open,
    }
}

/// TypeScript `deriveTaskIntegration`.
pub fn derive_task_integration(
    task: &TaskResponse,
    observation: Option<&Observation>,
    failure_code: Option<&str>,
    observed_at: &str,
) -> TaskIntegration {
    let state = pull_request_state(observation);
    let integrated = state == IntegrationPullRequestState::Merged
        || (task.status == TaskStatus::Delivered
            && !requires_pull_request(task)
            && failure_code.is_none());
    let checks = observation.map_or_else(CheckCounts::default, |observation| CheckCounts {
        total: observation.checks.total,
        pending: observation.checks.pending,
        failing: observation.checks.failing,
        successful: observation.checks.successful,
    });
    TaskIntegration {
        integrated,
        pull_request: IntegrationPullRequest {
            state,
            number: observation
                .and_then(|o| o.number)
                .or(task.pull_request.as_ref().map(|pull| pull.number)),
            url: observation.and_then(|o| o.url.clone()),
            target_branch: task.configuration.base_branch.clone(),
            head_sha: observation.and_then(|o| o.head_sha.clone()),
            base_sha: observation.and_then(|o| o.base_sha.clone()),
            mergeable: observation.and_then(|o| o.mergeable.clone()),
            merge_state_status: observation.and_then(|o| o.merge_state_status.clone()),
            review_decision: observation.and_then(|o| o.review_decision.clone()),
            checks,
        },
        observed_at: observed_at.to_owned(),
        observation: if failure_code.is_none() {
            ObservationStatus::Observed
        } else {
            ObservationStatus::Unavailable
        },
        observation_reason: failure_code.map(str::to_owned),
        deployed: Deployed {
            included: (),
            reason: "not_determinable",
        },
    }
}

/// TypeScript `isUpstreamOf`: branched from the upstream head branch or pull request.
pub fn is_upstream_of(upstream: &TaskResponse, task: &TaskResponse) -> bool {
    if upstream.id == task.id {
        return false;
    }
    if upstream.configuration.repository.to_lowercase()
        != task.configuration.repository.to_lowercase()
    {
        return false;
    }
    match &task.configuration.source {
        Some(TaskSource::Branch { branch }) if *branch == upstream.configuration.branch => {
            return true;
        }
        Some(TaskSource::PullRequest { number })
            if upstream.pull_request.as_ref().map(|pull| pull.number) == Some(*number) =>
        {
            return true;
        }
        _ => {}
    }
    task.configuration.base_branch == upstream.configuration.branch
}

fn merge_commands(task: &TaskResponse) -> Vec<String> {
    let base = &task.configuration.base_branch;
    vec![
        format!("git fetch origin {base}"),
        format!("git merge origin/{base}"),
    ]
}

/// TypeScript `deriveActionRequired`.
pub fn derive_action_required(
    task: &TaskResponse,
    integration: &TaskIntegration,
    upstream: Option<UpstreamBlocker>,
) -> Option<ActionRequired> {
    use ActionOwner::{Agent, Human, Suplex};
    use IntegrationPullRequestState as State;
    let action = |owner, reason_code, summary, suggested_commands, human_approval_required| {
        Some(ActionRequired {
            upstream: None,
            human_approval_required,
            owner,
            reason_code,
            summary,
            suggested_commands,
            evidence_at: integration.observed_at.clone(),
        })
    };
    let pull = &integration.pull_request;
    let repository = &task.configuration.repository;
    let reference = match pull.number {
        None => task.configuration.branch.clone(),
        Some(number) => format!("{number} --repo {repository}"),
    };
    let state = pull.state;
    if task.status == TaskStatus::WaitingHuman {
        return action(
            Human,
            ActionReason::WaitingHuman,
            "The task waits for your answer. Answer the question in Suplex.",
            vec![],
            true,
        );
    }
    if integration.observation == ObservationStatus::Unavailable {
        return action(
            Suplex,
            ActionReason::ObservationUnavailable,
            "Suplex could not read the pull request from GitHub. Check the GitHub access and retry.",
            vec![format!("gh pr view {reference}")],
            false,
        );
    }
    if integration.integrated {
        return None;
    }
    if state == State::Conflicting {
        return action(
            Agent,
            ActionReason::ConflictingPullRequest,
            "GitHub reports merge conflicts on the pull request. The task owner must merge the base branch and resolve the conflicts.",
            merge_commands(task),
            false,
        );
    }
    if pull.checks.failing > 0 {
        return action(
            Agent,
            ActionReason::FailedChecks,
            "CI reports failed checks on the pull request. The task owner must read the checks and repair the build.",
            vec![format!("gh pr checks {reference}")],
            false,
        );
    }
    let stale_head = match (&task.pull_request, &pull.head_sha) {
        (Some(stored), Some(observed)) => stored.head_sha != *observed,
        _ => false,
    };
    if state != State::Absent
        && state != State::Closed
        && (pull.merge_state_status.as_deref() == Some("BEHIND") || stale_head)
    {
        return action(
            Agent,
            ActionReason::StaleDelivery,
            "The pull request is behind the base branch. The task owner must update the branch and push the result.",
            merge_commands(task),
            false,
        );
    }
    if task.status == TaskStatus::Delivered
        && requires_pull_request(task)
        && (state == State::Absent || state == State::Closed)
    {
        let command = format!(
            "gh pr create --repo {repository} --head {} --base {}",
            task.configuration.branch, task.configuration.base_branch
        );
        return action(
            Agent,
            ActionReason::PullRequestMissing,
            "Suplex delivered the task without an open pull request. The task owner must create the pull request for the branch.",
            vec![command],
            false,
        );
    }
    if let Some(upstream) = upstream {
        return Some(ActionRequired {
            upstream: Some(upstream),
            human_approval_required: false,
            owner: ActionOwner::Upstream,
            reason_code: ActionReason::BlockedByDependency,
            summary: "An upstream task is not integrated. Wait for the upstream pull request to merge.",
            suggested_commands: vec![],
            evidence_at: integration.observed_at.clone(),
        });
    }
    if state == State::Absent {
        return None;
    }
    if pull.checks.pending > 0 {
        return action(
            Suplex,
            ActionReason::PendingChecks,
            "CI checks are not complete on the pull request. Check the pull request after the checks finish.",
            vec![format!("gh pr checks {reference}")],
            false,
        );
    }
    if review_blocks_merge(pull.review_decision.as_deref()) {
        return action(
            Human,
            ActionReason::PendingReview,
            "The pull request waits for a review decision. Review the pull request.",
            vec![format!("gh pr view {reference}")],
            true,
        );
    }
    action(
        Human,
        ActionReason::WaitingHuman,
        "The pull request is ready and not merged. Merge the pull request.",
        vec![format!("gh pr view {reference}")],
        true,
    )
}

/// TypeScript `matchesAgentApiFilter`.
pub fn matches_agent_api_filter(
    integration: &TaskIntegration,
    action_required: Option<&ActionRequired>,
    filter: &str,
) -> bool {
    if filter == "not_integrated" {
        return !integration.integrated;
    }
    action_required.is_some_and(|action| action.reason_code.as_str() == filter)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::control::{DeliveryTarget, PullRequestReference, PullRequestState};
    use serde_json::json;

    fn task(status: TaskStatus, target: DeliveryTarget) -> TaskResponse {
        let mut task = TaskResponse::fixture();
        task.id = "t1".into();
        task.status = status;
        task.delivery_target = target;
        task.configuration.repository = "o/r".into();
        task.configuration.branch = "task".into();
        task.configuration.base_branch = "main".into();
        task
    }

    #[test]
    fn delivered_local_work_is_integrated_and_needs_no_action() {
        let task = task(TaskStatus::Delivered, DeliveryTarget::LocalWorktree);
        let integration = derive_task_integration(&task, None, None, "2026-09-25T00:00:00.000Z");
        assert!(integration.integrated);
        assert_eq!(
            integration.pull_request.state,
            IntegrationPullRequestState::Absent
        );
        assert!(derive_action_required(&task, &integration, None).is_none());
        assert!(!matches_agent_api_filter(
            &integration,
            None,
            "failed_checks"
        ));
        assert_eq!(
            serde_json::to_value(&integration).unwrap(),
            json!({
                "integrated": true,
                "pullRequest": {"state": "absent", "number": null, "url": null, "targetBranch": "main",
                    "headSha": null, "baseSha": null, "mergeable": null, "mergeStateStatus": null,
                    "reviewDecision": null, "checks": {"total": 0, "pending": 0, "failing": 0, "successful": 0}},
                "observedAt": "2026-09-25T00:00:00.000Z",
                "observation": "observed",
                "observationReason": null,
                "deployed": {"included": null, "reason": "not_determinable"},
            })
        );
    }

    #[test]
    fn conflicts_failures_and_missing_pull_requests_name_the_owner() {
        let task = task(TaskStatus::Delivered, DeliveryTarget::PullRequestDraft);
        let missing = derive_task_integration(&task, None, None, "now");
        assert_eq!(
            derive_action_required(&task, &missing, None)
                .unwrap()
                .reason_code,
            ActionReason::PullRequestMissing
        );
        let mut observed = Observation {
            exists: true,
            number: Some(7),
            state: Some("open".into()),
            is_draft: Some(false),
            mergeable: Some("CONFLICTING".into()),
            ..Observation::default()
        };
        let conflicting = derive_task_integration(&task, Some(&observed), None, "now");
        assert_eq!(
            conflicting.pull_request.state,
            IntegrationPullRequestState::Conflicting
        );
        assert_eq!(
            derive_action_required(&task, &conflicting, None)
                .unwrap()
                .owner,
            ActionOwner::Agent
        );
        observed.mergeable = None;
        observed.checks.failing = 1;
        let failing = derive_task_integration(&task, Some(&observed), None, "now");
        assert_eq!(
            serde_json::to_value(derive_action_required(&task, &failing, None)).unwrap(),
            json!({"upstream": null, "humanApprovalRequired": false, "owner": "agent",
                "reasonCode": "failed_checks",
                "summary": "CI reports failed checks on the pull request. The task owner must read the checks and repair the build.",
                "suggestedCommands": ["gh pr checks 7 --repo o/r"], "evidenceAt": "now"})
        );
        observed.checks.failing = 0;
        let unreviewed = derive_task_integration(&task, Some(&observed), None, "now");
        assert_eq!(
            derive_action_required(&task, &unreviewed, None)
                .unwrap()
                .reason_code,
            ActionReason::WaitingHuman,
            "a null review decision means GitHub requires no review"
        );
        observed.review_decision = Some("REVIEW_REQUIRED".into());
        let pending = derive_task_integration(&task, Some(&observed), None, "now");
        let pending = derive_action_required(&task, &pending, None).unwrap();
        assert_eq!(pending.reason_code, ActionReason::PendingReview);
        assert!(pending.human_approval_required);
        let unavailable = derive_task_integration(&task, None, Some("provider-unavailable"), "now");
        assert_eq!(
            derive_action_required(&task, &unavailable, None)
                .unwrap()
                .reason_code,
            ActionReason::ObservationUnavailable
        );
    }

    #[test]
    fn upstream_follows_branch_source_and_base_branch() {
        let mut upstream = task(TaskStatus::Active, DeliveryTarget::Merged);
        upstream.id = "up".into();
        upstream.configuration.repository = "O/R".into();
        upstream.configuration.branch = "feature".into();
        upstream.pull_request = Some(PullRequestReference {
            repository: "O/R".into(),
            number: 3,
            url: "https://github.com/O/R/pull/3".into(),
            head_sha: "abc".into(),
            state: PullRequestState::Open,
            merged_at: None,
        });
        let mut child = task(TaskStatus::Active, DeliveryTarget::Merged);
        assert!(!is_upstream_of(&upstream, &child));
        child.configuration.source = Some(TaskSource::PullRequest { number: 3 });
        assert!(is_upstream_of(&upstream, &child));
        child.configuration.source = None;
        child.configuration.base_branch = "feature".into();
        assert!(is_upstream_of(&upstream, &child));
    }
}
