import type { GithubPullRequestObservationResult, GithubSyncActivities } from "../contracts/activities/github-sync.js";
import type { ActivityContext } from "./context.js";
import { Context } from "../activity-context.js";
import { runCommand } from "../../command-runner.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import { json } from "../../task-utils.js";

/** Author and change stats are presentation-only; a failure here never blocks the observation. */
async function pullRequestPresentation(ctx: ActivityContext, repository: string, number: number): Promise<Pick<GithubPullRequestObservationResult, "author" | "changedFiles" | "additions" | "deletions">> {
  try {
    const { stdout, exitCode } = await runCommand({ taskId: null, stepId: null, command: "gh", args: ["pr", "view", String(number), "--repo", repository, "--json", "author,changedFiles,additions,deletions"], timeout: 20_000 });
    if (exitCode !== 0) throw new Error(`gh exited with ${exitCode}`);
    const raw = json<{ author?: { login?: string; avatarUrl?: string | null } | null; changedFiles?: number; additions?: number; deletions?: number }>(stdout, {});
    const login = raw.author?.login;
    return {
      author: login ? { login, avatarUrl: raw.author?.avatarUrl || `https://avatars.githubusercontent.com/${login}` } : null,
      changedFiles: raw.changedFiles ?? null,
      additions: raw.additions ?? null,
      deletions: raw.deletions ?? null,
    };
  } catch (error) {
    ctx.logger.warn("Pull request author/stats unavailable", {}, { repository, number, error: error instanceof Error ? error.message : String(error) });
    return { author: null, changedFiles: null, additions: null, deletions: null };
  }
}

/** Reads GitHub only. Workflow code decides how an observed external change is adopted. */
export function createGithubSyncActivities(ctx: ActivityContext): GithubSyncActivities {
  return {
    async loadTaskSourcePullRequest(input) {
      const configuration = ctx.database.authQuery((db) => loadTaskConfiguration(db, ctx.artifacts, input));
      if (configuration.source?.kind !== "pull_request") return null;
      const { number, url, headBranch, baseBranch } = configuration.source;
      return { repository: configuration.repository, source: { number, url, headBranch, baseBranch } };
    },
    async observeGithubPullRequest(input) {
      Context.current().heartbeat({ repository: input.repository, branch: input.branch });
      const github = ctx.options.githubRelease ?? ctx.githubRelease;
      if (!github.observePullRequest) throw new Error("GitHub pull-request observation is unavailable");
      const result = await github.observePullRequest({ repository: input.repository, branch: input.branch, ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}) });
      Context.current().heartbeat({ repository: input.repository, branch: input.branch, observed: true });
      if (!result.exists || result.number === null) return result;
      return { ...result, ...(await pullRequestPresentation(ctx, input.repository, result.number)) };
    },
    async applyGithubPullRequestAction(input) {
      const github = ctx.options.githubRelease ?? ctx.githubRelease;
      if (input.action === "mark_ready") await github.markReadyForReview({ repository: input.repository, number: input.number });
      else if (input.action === "enable_auto_merge") {
        if (!github.enableAutoMerge) throw new Error("GitHub auto-merge is unavailable");
        await github.enableAutoMerge({ repository: input.repository, number: input.number, headSha: input.headSha });
      } else {
        if (!github.mergePullRequest) throw new Error("GitHub pull-request merging is unavailable");
        await github.mergePullRequest({ repository: input.repository, number: input.number, headSha: input.headSha });
      }
    },
  };
}
