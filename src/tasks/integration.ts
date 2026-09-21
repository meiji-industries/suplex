import type { GithubPullRequestObservation } from "../integrations/github/delivery.js";
import type { AgentApiActionRequired, AgentApiIntegration, AgentApiTaskFilter } from "../http/contracts/agent-api.js";
import type { Task } from "./contracts.js";

/** What GitHub answered for one task, or why it could not answer. A null observation with a null failure means Forge did not ask. */
export interface PullRequestObservationResult {
  observation: GithubPullRequestObservation | null;
  failureCode: string | null;
}

const PULL_REQUEST_TARGETS = ["pull_request_draft", "pull_request_ready", "merged"];

export function requiresPullRequest(task: Task): boolean {
  return PULL_REQUEST_TARGETS.includes(task.deliveryTarget);
}

/** GitHub is only worth asking once a task carries a pull request or has delivered against a pull request target. */
export function observableDelivery(task: Task): boolean {
  return Boolean(task.pullRequest) || (task.status === "delivered" && requiresPullRequest(task));
}

function pullRequestState(observation: GithubPullRequestObservation | null): AgentApiIntegration["pullRequest"]["state"] {
  if (!observation || !observation.exists) return "absent";
  if (observation.state === "merged" || observation.state === "closed") return observation.state;
  if (observation.mergeable === "CONFLICTING" || observation.mergeStateStatus === "DIRTY") return "conflicting";
  if (observation.isDraft === true) return "draft";
  if (observation.isDraft === false) return "ready";
  return "open";
}

export function deriveTaskIntegration(task: Task, observed: PullRequestObservationResult, observedAt: string): AgentApiIntegration {
  const observation = observed.observation;
  const state = pullRequestState(observation);
  const integrated = state === "merged" || (task.status === "delivered" && !requiresPullRequest(task) && observed.failureCode === null);
  return {
    integrated,
    pullRequest: {
      state,
      number: observation?.number ?? task.pullRequest?.number ?? null,
      url: observation?.url ?? null,
      targetBranch: task.configuration.baseBranch,
      headSha: observation?.headSha ?? null,
      baseSha: observation?.baseSha ?? null,
      mergeable: observation?.mergeable ?? null,
      mergeStateStatus: observation?.mergeStateStatus ?? null,
      reviewDecision: observation?.reviewDecision ?? null,
      checks: {
        total: observation?.checks.total ?? 0,
        pending: observation?.checks.pending ?? 0,
        failing: observation?.checks.failing ?? 0,
        successful: observation?.checks.successful ?? 0,
      },
    },
    observedAt,
    observation: observed.failureCode === null ? "observed" : "unavailable",
    observationReason: observed.failureCode,
    // Forge does not observe deployed runtimes, so it never claims that a change is live.
    deployed: { included: null, reason: "not_determinable" },
  };
}

/** A task depends on another when Forge branched it from that task's head branch or its pull request. */
export function isUpstreamOf(upstream: Task, task: Task): boolean {
  if (upstream.id === task.id) return false;
  if (upstream.configuration.repository.toLowerCase() !== task.configuration.repository.toLowerCase()) return false;
  const source = task.configuration.source;
  if (source?.kind === "branch" && source.branch === upstream.configuration.branch) return true;
  if (source?.kind === "pull_request" && upstream.pullRequest?.number === source.number) return true;
  return task.configuration.baseBranch === upstream.configuration.branch;
}

function mergeCommands(task: Task): string[] {
  return [`git fetch origin ${task.configuration.baseBranch}`, `git merge origin/${task.configuration.baseBranch}`];
}

function action(input: Omit<AgentApiActionRequired, "upstream" | "evidenceAt" | "humanApprovalRequired"> & { upstream?: AgentApiActionRequired["upstream"]; humanApprovalRequired?: boolean }, evidenceAt: string): AgentApiActionRequired {
  return { upstream: null, humanApprovalRequired: false, ...input, evidenceAt };
}

export function deriveActionRequired(task: Task, integration: AgentApiIntegration, upstream: AgentApiActionRequired["upstream"]): AgentApiActionRequired | null {
  const at = integration.observedAt;
  const pull = integration.pullRequest;
  const reference = pull.number === null ? task.configuration.branch : `${pull.number} --repo ${task.configuration.repository}`;
  if (task.status === "waiting_human") {
    return action({ owner: "human", reasonCode: "waiting_human", summary: "The task waits for your answer. Answer the question in Forge.", suggestedCommands: [], humanApprovalRequired: true }, at);
  }
  if (integration.observation === "unavailable") {
    return action({ owner: "forge", reasonCode: "observation_unavailable", summary: "Forge could not read the pull request from GitHub. Check the GitHub access and retry.", suggestedCommands: [`gh pr view ${reference}`] }, at);
  }
  if (integration.integrated) return null;
  if (pull.state === "conflicting") {
    return action({ owner: "agent", reasonCode: "conflicting_pull_request", summary: "GitHub reports merge conflicts on the pull request. The task owner must merge the base branch and resolve the conflicts.", suggestedCommands: mergeCommands(task) }, at);
  }
  if (pull.checks.failing > 0) {
    return action({ owner: "agent", reasonCode: "failed_checks", summary: "CI reports failed checks on the pull request. The task owner must read the checks and repair the build.", suggestedCommands: [`gh pr checks ${reference}`] }, at);
  }
  if (pull.state !== "absent" && pull.state !== "closed" && (pull.mergeStateStatus === "BEHIND" || (task.pullRequest?.headSha !== undefined && pull.headSha !== null && task.pullRequest.headSha !== pull.headSha))) {
    return action({ owner: "agent", reasonCode: "stale_delivery", summary: "The pull request is behind the base branch. The task owner must update the branch and push the result.", suggestedCommands: mergeCommands(task) }, at);
  }
  if (task.status === "delivered" && requiresPullRequest(task) && (pull.state === "absent" || pull.state === "closed")) {
    return action({ owner: "agent", reasonCode: "pull_request_missing", summary: "Forge delivered the task without an open pull request. The task owner must create the pull request for the branch.", suggestedCommands: [`gh pr create --repo ${task.configuration.repository} --head ${task.configuration.branch} --base ${task.configuration.baseBranch}`] }, at);
  }
  if (upstream) {
    return action({ owner: "upstream", reasonCode: "blocked_by_dependency", summary: "An upstream task is not integrated. Wait for the upstream pull request to merge.", suggestedCommands: [], upstream }, at);
  }
  if (pull.state === "absent") return null;
  if (pull.checks.pending > 0) {
    return action({ owner: "forge", reasonCode: "pending_checks", summary: "CI checks are not complete on the pull request. Check the pull request after the checks finish.", suggestedCommands: [`gh pr checks ${reference}`] }, at);
  }
  if (pull.reviewDecision !== "APPROVED") {
    return action({ owner: "human", reasonCode: "pending_review", summary: "The pull request waits for a review decision. Review the pull request.", suggestedCommands: [`gh pr view ${reference}`], humanApprovalRequired: true }, at);
  }
  return action({ owner: "human", reasonCode: "waiting_human", summary: "The pull request is approved and not merged. Merge the pull request.", suggestedCommands: [`gh pr view ${reference}`], humanApprovalRequired: true }, at);
}

export function matchesAgentApiFilter(projection: { integration: AgentApiIntegration; actionRequired: AgentApiActionRequired | null }, filter: AgentApiTaskFilter): boolean {
  if (filter === "not_integrated") return !projection.integration.integrated;
  return projection.actionRequired?.reasonCode === filter;
}
