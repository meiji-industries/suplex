import type { Task } from "./contracts.js";
import type { z } from "zod";
import type { TaskChecksResponseSchema, TaskDiffSummaryResponseSchema } from "../http/contracts/tasks.js";
import { runCommand } from "../platform/command-runner.js";
import { createGithubReleasePort, type GithubReleasePort } from "../integrations/github/delivery.js";

export async function readTaskDiff(task: Task) {
  if (!task.worktree) return { available: false, patch: "", truncated: false };
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", task.worktree.path, "diff", "--no-ext-diff", "--no-textconv", "--no-color", task.configuration.baselineSha, "--"], timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error("The worktree diff could not be read");
  return { available: true, patch: result.stdout, truncated: false };
}

export async function readTaskDiffSummary(task: Task): Promise<z.infer<typeof TaskDiffSummaryResponseSchema>> {
  if (!task.worktree) return { available: false, files: 0 };
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", task.worktree.path, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--name-only", task.configuration.baselineSha, "--"], timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error("The worktree diff could not be read");
  return { available: true, files: result.stdout.split("\n").filter(line => line.length > 0).length };
}

export async function readTaskChecks(task: Task, github: Pick<Required<GithubReleasePort>, "observePullRequest"> = createGithubReleasePort()): Promise<z.infer<typeof TaskChecksResponseSchema>> {
  if (!task.pullRequest) return { available: false, runs: [] };
  const observation = await github.observePullRequest({ repository: task.configuration.repository, branch: task.configuration.branch, pullRequestNumber: task.pullRequest.number });
  const pullRequestState = observation.state === "open" ? observation.isDraft === false ? "ready" : "draft" : observation.state;
  return { available: observation.exists, runs: observation.checks.runs, pullRequestState };
}
