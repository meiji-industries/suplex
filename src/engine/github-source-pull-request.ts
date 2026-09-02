import type { IssueWorkflowInput, IssueWorkflowState } from "./issue-contracts.js";

type SourcePullRequestState = Pick<IssueWorkflowState, "releaseRepository" | "branchName" | "pullRequestNumber" | "pullRequestUrl" | "githubPullRequestExists">;
type SourcePullRequestInput = Pick<IssueWorkflowInput, "repository" | "source"> | { repository: string; source: { number: number; url: string; headBranch: string; baseBranch: string } };

export function sourcePullRequestState(input: SourcePullRequestInput | null | undefined, enabled: boolean): SourcePullRequestState | undefined {
  const source = input?.source;
  if (!enabled || !input?.repository || !source || ("kind" in source && source.kind !== "pull_request") || !("number" in source)) return undefined;
  return { releaseRepository: input.repository, branchName: source.headBranch, pullRequestNumber: source.number, pullRequestUrl: source.url, githubPullRequestExists: true };
}

export function isSourcePullRequestPreDelivery(state: IssueWorkflowState, source: SourcePullRequestState | undefined): boolean {
  return Boolean(source && ["backlog", "planning", "supplemental_review", "plan_consolidation", "approval", "ready_for_development", "development"].includes(state.step));
}
export function advanceSourcePullRequestState(state: IssueWorkflowState, patch: Partial<IssueWorkflowState>): IssueWorkflowState {
  return { ...state, ...patch, revision: state.revision + 1, lastEventId: `${state.workflowId}:${state.revision + 1}` };
}
