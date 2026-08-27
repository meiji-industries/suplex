import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GithubReleasePort } from "./github-release.js";
import type { Project } from "./projects.js";

const execFileAsync = promisify(execFile);
const branchPattern = /^(?![-.])(?!.*(?:\.\.|@\{|\\|\s|~|\^|:|\?|\*|\[))[A-Za-z0-9._/-]{1,240}$/;

export type TaskSourceSelector = { kind: "pull_request"; number: number } | { kind: "branch"; branch: string };
export type PinnedTaskSource =
  | { kind: "pull_request"; number: number; url: string; headBranch: string; baseBranch: string; headSha: string; baseSha: string }
  | { kind: "branch"; branch: string; headSha: string };
export type DiscoveredTaskSource =
  | { kind: "pull_request"; number: number; url: string; title: string; body: string; author: string; headBranch: string; baseBranch: string; headSha: string; updatedAt?: string; isDraft: boolean }
  | { kind: "branch"; branch: string; headSha: string; subject: string; author: string; updatedAt: string };

export class TaskSourceFailure extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 422) { super(message); this.name = "TaskSourceFailure"; }
}

async function git(project: Project, args: string[], timeout = 30_000): Promise<string> {
  try { return (await execFileAsync("git", args, { cwd: project.repositoryPath, timeout, maxBuffer: 512 * 1024 })).stdout.trim(); }
  catch { throw new TaskSourceFailure("source-provider-unavailable", "The repository source could not be read", 503); }
}

function safeBranch(project: Project, branch: string): void {
  if (!branchPattern.test(branch) || branch.includes("..")) throw new TaskSourceFailure("unsafe-branch", "The source branch name is unsafe");
  if (branch === project.baseBranch || branch === project.targetBranch) throw new TaskSourceFailure("source-base-branch", "The configured base or target branch cannot be used as a task source");
}

export class TaskSourceService {
  constructor(private readonly github: Pick<GithubReleasePort, "listOpenPullRequests" | "getPullRequest">) {}

  async discover(project: Project, kind: TaskSourceSelector["kind"]): Promise<{ available: boolean; reason?: string; sources: DiscoveredTaskSource[] }> {
    if (kind === "pull_request") {
      if (!project.repository || !this.github.listOpenPullRequests) return { available: false, reason: "Pull request provider unavailable", sources: [] };
      try {
        const pulls = await this.github.listOpenPullRequests({ repository: project.repository, limit: 100 });
        return { available: true, sources: pulls.filter((pull) => !pull.isCrossRepository && pull.state === "open" && pull.headBranch !== project.baseBranch && pull.headBranch !== project.targetBranch).map((pull) => ({ kind: "pull_request", number: pull.number, url: pull.url, title: pull.title ?? `Pull request #${pull.number}`, body: pull.body ?? "", author: pull.author ?? "", headBranch: pull.headBranch, baseBranch: pull.baseBranch, headSha: pull.headSha, ...(pull.updatedAt ? { updatedAt: pull.updatedAt } : {}), isDraft: pull.isDraft })) };
      } catch { return { available: false, reason: "Pull requests are temporarily unavailable", sources: [] }; }
    }
    await git(project, ["fetch", "--no-tags", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
    const output = await git(project, ["for-each-ref", "--sort=-committerdate", "--count=200", "--format=%(refname:strip=3)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)%00%(authorname)", "refs/remotes/origin"]);
    const sources = output ? output.split("\n").flatMap((line) => {
      const [branch, headSha, updatedAt, subject, author] = line.split("\0");
      if (!branch || !headSha || !updatedAt || branch === project.baseBranch || branch === project.targetBranch || !branchPattern.test(branch)) return [];
      return [{ kind: "branch" as const, branch, headSha, updatedAt, subject: subject ?? "", author: author ?? "" }];
    }) : [];
    return { available: true, sources };
  }

  async resolve(project: Project, selector: TaskSourceSelector): Promise<PinnedTaskSource> {
    if (selector.kind === "pull_request") {
      if (!project.repository) throw new TaskSourceFailure("source-provider-unavailable", "Pull requests are unavailable", 503);
      const pull = await this.github.getPullRequest({ repository: project.repository, number: selector.number });
      if (pull.state !== "open") throw new TaskSourceFailure("source-pull-request-closed", "The pull request is not open");
      if (pull.isCrossRepository || pull.repository.toLowerCase() !== project.repository.toLowerCase()) throw new TaskSourceFailure("source-unsupported-fork", "Fork pull requests cannot be used as task sources");
      safeBranch(project, pull.headBranch);
      return { kind: "pull_request", number: pull.number, url: pull.url, headBranch: pull.headBranch, baseBranch: pull.baseBranch, headSha: pull.headSha, baseSha: pull.baseSha };
    }
    safeBranch(project, selector.branch);
    await git(project, ["fetch", "--no-tags", "origin", `refs/heads/${selector.branch}:refs/remotes/origin/${selector.branch}`]);
    const headSha = await git(project, ["rev-parse", "--verify", `refs/remotes/origin/${selector.branch}^{commit}`]);
    return { kind: "branch", branch: selector.branch, headSha };
  }
}
