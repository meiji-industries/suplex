import type { Task } from "./contracts.js";
import type { z } from "zod";
import type { TaskChecksResponseSchema, TaskDiffSummaryResponseSchema } from "../http/contracts/tasks.js";
import { runCommand } from "../platform/command-runner.js";
import { createGithubReleasePort, type GithubReleasePort } from "../integrations/github/delivery.js";

type TaskDiffGithubPort = Pick<Required<GithubReleasePort>, "getBranchHead" | "getPullRequest">;
const shaPattern = /^[a-f0-9]{40,64}$/i;

const git = (cwd: string, args: string[], expectNonZero = false, timeout = 10_000) => runCommand({ taskId: null, stepId: null, command: "git", cwd, args, timeout, ...(expectNonZero ? { expectNonZero: true } : {}) });

async function ensureCommit(cwd: string, sha: string): Promise<void> {
  const present = await git(cwd, ["cat-file", "-e", `${sha}^{commit}`], true);
  if (present.exitCode === 0) return;
  const fetched = await git(cwd, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", sha], true, 120_000);
  if (fetched.exitCode !== 0 || (await git(cwd, ["cat-file", "-e", `${sha}^{commit}`], true)).exitCode !== 0) throw new Error(`Git could not obtain published base revision ${sha.slice(0, 12)}`);
}

async function resolveTaskDiffBase(task: Task, cwd: string, github: TaskDiffGithubPort): Promise<string> {
  const pullRequestNumber = task.pullRequest?.number ?? (task.configuration.source?.kind === "pull_request" ? task.configuration.source.number : null);
  const branch = pullRequestNumber === null
    ? task.configuration.baseBranch
    : (await github.getPullRequest({ repository: task.configuration.repository, number: pullRequestNumber })).baseBranch;
  const sha = await github.getBranchHead({ repository: task.configuration.repository, branch });
  if (!sha) throw new Error(`GitHub did not return the head of ${branch}`);
  if (!shaPattern.test(sha)) throw new Error(`GitHub returned an invalid head for ${branch}`);
  await ensureCommit(cwd, sha);
  const mergeBase = await git(cwd, ["merge-base", sha, "HEAD"]);
  if (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim()) throw new Error("The worktree diff base could not be resolved");
  return mergeBase.stdout.trim();
}

export async function readTaskDiff(task: Task, github: TaskDiffGithubPort = createGithubReleasePort()) {
  if (!task.worktree) return { available: false, patch: "", truncated: false };
  const base = await resolveTaskDiffBase(task, task.worktree.path, github);
  const result = await git(task.worktree.path, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", base, "--"]);
  if (result.exitCode !== 0) throw new Error("The worktree diff could not be read");
  return { available: true, patch: result.stdout, truncated: false };
}

export async function readTaskDiffSummary(task: Task, github: TaskDiffGithubPort = createGithubReleasePort()): Promise<z.infer<typeof TaskDiffSummaryResponseSchema>> {
  if (!task.worktree) return { available: false, files: 0 };
  const base = await resolveTaskDiffBase(task, task.worktree.path, github);
  const result = await git(task.worktree.path, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--name-only", base, "--"]);
  if (result.exitCode !== 0) throw new Error("The worktree diff could not be read");
  return { available: true, files: result.stdout.split("\n").filter(line => line.length > 0).length };
}

export async function readTaskChecks(task: Task, github: Pick<Required<GithubReleasePort>, "observePullRequest"> = createGithubReleasePort()): Promise<z.infer<typeof TaskChecksResponseSchema>> {
  if (!task.pullRequest) return { available: false, runs: [] };
  const observation = await github.observePullRequest({ repository: task.configuration.repository, branch: task.configuration.branch, pullRequestNumber: task.pullRequest.number });
  const pullRequestState = observation.state === "open" ? observation.isDraft === false ? "ready" : "draft" : observation.state;
  return { available: observation.exists, runs: observation.checks.runs, pullRequestState };
}
