import type { IssueWorkflowInput, IssueWorkflowState } from "./issue-contracts.js";

type SourcePullRequestState = Pick<IssueWorkflowState, "releaseRepository" | "branchName" | "pullRequestNumber" | "pullRequestUrl" | "githubPullRequestExists">;

export function sourcePullRequestState(input: IssueWorkflowInput, enabled: boolean): SourcePullRequestState | undefined {
  return enabled && input.repository && input.source?.kind === "pull_request" ? { releaseRepository: input.repository, branchName: input.source.headBranch, pullRequestNumber: input.source.number, pullRequestUrl: input.source.url, githubPullRequestExists: true } : undefined;
}

export function isSourcePullRequestPreDelivery(state: IssueWorkflowState, source: SourcePullRequestState | undefined): boolean {
  return Boolean(source && ["backlog", "planning", "supplemental_review", "plan_consolidation", "approval", "ready_for_development", "development", "delivery_blocked"].includes(state.phase));
}
export function advanceSourcePullRequestState(state: IssueWorkflowState, patch: Partial<IssueWorkflowState>): IssueWorkflowState {
  return { ...state, ...patch, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` };
}
