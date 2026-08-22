import type { GithubSyncActivities } from "../contracts/activities/github-sync.js";
import type { ActivityContext } from "./context.js";
import { Context } from "@temporalio/activity";

/** Reads GitHub only. Workflow code decides how an observed external change is adopted. */
export function createGithubSyncActivities(ctx: ActivityContext): GithubSyncActivities {
  return {
    async observeGithubPullRequest(input) {
      Context.current().heartbeat({ repository: input.repository, branch: input.branch });
      const github = ctx.options.githubRelease ?? ctx.githubRelease;
      if (!github.observePullRequest) throw new Error("GitHub pull-request observation is unavailable");
      const result = await github.observePullRequest({ repository: input.repository, branch: input.branch, ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}) });
      Context.current().heartbeat({ repository: input.repository, branch: input.branch, observed: true });
      return result;
    },
  };
}
