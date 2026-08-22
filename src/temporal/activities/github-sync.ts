import type { GithubSyncActivities } from "../contracts/activities/github-sync.js";
import type { ActivityContext } from "./context.js";

/** Reads GitHub only. Workflow code decides how an observed external change is adopted. */
export function createGithubSyncActivities(ctx: ActivityContext): GithubSyncActivities {
  return {
    async observeGithubPullRequest(input) {
      const github = ctx.options.githubRelease ?? ctx.githubRelease;
      if (!github.observePullRequest) throw new Error("GitHub pull-request observation is unavailable");
      return github.observePullRequest({ repository: input.repository, branch: input.branch, ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}) });
    },
  };
}
