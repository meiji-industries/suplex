export interface ObserveGithubPullRequestActivityInput {
  repository: string;
  branch: string;
  pullRequestNumber?: number | null | undefined;
}

export interface LoadTaskSourcePullRequestActivityInput {
  taskId: string;
  companyId: string;
}

export interface TaskSourcePullRequest {
  repository: string;
  source: { number: number; url: string; headBranch: string; baseBranch: string };
}

export interface GithubPullRequestObservationResult {
  exists: boolean;
  number: number | null;
  url: string | null;
  state: "open" | "closed" | "merged" | null;
  isDraft: boolean | null;
  headSha: string | null;
  baseSha: string | null;
  mergeable: string | null;
  checks: { total: number; pending: number; failing: number; successful: number };
  author?: { login: string; avatarUrl: string } | null;
  changedFiles?: number | null;
  additions?: number | null;
  deletions?: number | null;
  autoMergeEnabled: boolean | null;
  reviewDecision: string | null;
}

export interface GithubSyncActivities {
  loadTaskSourcePullRequest(input: LoadTaskSourcePullRequestActivityInput): Promise<TaskSourcePullRequest | null>;
  observeGithubPullRequest(input: ObserveGithubPullRequestActivityInput): Promise<GithubPullRequestObservationResult>;
  applyGithubPullRequestAction(input: { repository: string; number: number; headSha: string; action: "mark_ready" | "enable_auto_merge" | "merge" }): Promise<void>;
}
