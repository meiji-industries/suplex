import type { Task } from "./task-contracts.js";
import { runCommand } from "./command-runner.js";
import { createGithubReleasePort, type GithubReleasePort } from "./github-delivery.js";

export async function readTaskDiff(task: Task) {
  if (!task.worktree) return { available: false, patch: "", truncated: false };
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", task.worktree.path, "diff", "--no-ext-diff", "--no-textconv", "--no-color", task.configuration.baselineSha, "--"], timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error("The worktree diff could not be read");
  return { available: true, patch: result.stdout, truncated: false };
}

export async function readTaskChecks(task: Task, github: Pick<Required<GithubReleasePort>, "observePullRequest"> = createGithubReleasePort()) {
  if (!task.pullRequest) return { available: false, runs: [] };
  const observation = await github.observePullRequest({ repository: task.configuration.repository, branch: task.configuration.branch, pullRequestNumber: task.pullRequest.number });
  return { available: observation.exists, runs: observation.checks.runs };
}
