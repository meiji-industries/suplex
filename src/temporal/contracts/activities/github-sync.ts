export interface ObserveGithubPullRequestActivityInput {
  repository: string;
  branch: string;
  pullRequestNumber?: number | null | undefined;
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
  autoMergeEnabled: boolean | null;
  reviewDecision: string | null;
}

export interface GithubSyncActivities {
  observeGithubPullRequest(input: ObserveGithubPullRequestActivityInput): Promise<GithubPullRequestObservationResult>;
}
