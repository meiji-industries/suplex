import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import type { GithubPullRequest, GithubReleasePort } from "../src/github-delivery.js";
import type { Project } from "../src/projects.js";
import { TaskSourceService } from "../src/task-sources.js";
import { TaskBodySchema } from "../src/http/contracts/tasks.js";

const roots: string[] = [];
afterEach(() => { delete process.env.FORGE_MIN_FREE_DISK_GB; while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const sha = "a".repeat(40);
const project = (repositoryPath = "/tmp/repo"): Project => ({ id: "p", companyId: "c", name: "Forge", repositoryPath, worktreeRoot: "/tmp/worktrees", repository: "acme/forge", baseBranch: "main", setupCommand: "true", verificationCommand: "true", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const pull = (value: Partial<GithubPullRequest> = {}): GithubPullRequest => ({ number: 7, url: "https://github.com/acme/forge/pull/7", repository: "acme/forge", headBranch: "feature", baseBranch: "main", headSha: sha, baseSha: sha, isDraft: false, state: "open", mergedAt: null, title: "Feature", body: "Body", author: "octo", ...value });
const github = (row = pull()): Pick<GithubReleasePort, "listOpenPullRequests" | "getPullRequest"> => ({ async listOpenPullRequests() { return [row]; }, async getPullRequest() { return row; } });

test("pull request discovery is bounded, shaped, and filters forks", async () => {
  const service = new TaskSourceService(github(pull({ isCrossRepository: true })));
  await expect(service.discover(project(), "pull_request")).resolves.toEqual({ available: true, sources: [] });
});

test("task creation API accepts only stable source selectors", () => {
  const base = { projectId: "p", title: "Task", description: "Description", idempotencyKey: "source-api-0001", images: [] };
  expect(TaskBodySchema.parse({ ...base, source: { kind: "pull_request", number: 7 } }).source).toEqual({ kind: "pull_request", number: 7 });
  expect(TaskBodySchema.safeParse({ ...base, source: { kind: "pull_request", number: 7, headSha: sha } }).success).toBe(false);
});

test("pull request provider failure stays isolated from branch capability", async () => {
  const service = new TaskSourceService({ async listOpenPullRequests() { throw new Error("offline"); }, async getPullRequest() { throw new Error("offline"); } });
  await expect(service.discover(project(), "pull_request")).resolves.toMatchObject({ available: false, sources: [] });
});

test("source resolution rejects forks and configured base branches", async () => {
  await expect(new TaskSourceService(github(pull({ isCrossRepository: true, repository: "fork/forge" }))).resolve(project(), { kind: "pull_request", number: 7 })).rejects.toMatchObject({ code: "source-unsupported-fork" });
  const service = new TaskSourceService(github());
  await expect(service.resolve(project(), { kind: "branch", branch: "main" })).rejects.toMatchObject({ code: "source-base-branch" });
  await expect(new TaskSourceService(github(pull({ baseBranch: "bad branch" }))).resolve(project(), { kind: "pull_request", number: 7 })).rejects.toMatchObject({ code: "unsafe-branch" });
});

test("source resolution sanitizes provider failures", async () => {
  const service = new TaskSourceService({ async getPullRequest() { throw new Error("token ghp_secret leaked"); } });
  await expect(service.resolve(project(), { kind: "pull_request", number: 7 })).rejects.toMatchObject({ code: "source-provider-unavailable", statusCode: 503, message: "The pull request provider is temporarily unavailable" });
});

function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function fixture(): { repo: string; worktrees: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "forge-source-")); roots.push(root);
  const remote = join(root, "remote.git"); const repo = join(root, "repo"); const worktrees = join(root, "worktrees");
  mkdirSync(repo); mkdirSync(worktrees); git(root, "init", "--bare", remote); git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Forge"); git(repo, "config", "user.email", "forge@example.invalid");
  writeFileSync(join(repo, "README.md"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base"); const base = git(repo, "rev-parse", "HEAD"); git(repo, "remote", "add", "origin", remote); git(repo, "push", "-u", "origin", "main");
  git(repo, "switch", "-c", "feature"); writeFileSync(join(repo, "feature.txt"), "source\n"); git(repo, "add", "."); git(repo, "commit", "-m", "source"); const head = git(repo, "rev-parse", "HEAD"); git(repo, "push", "-u", "origin", "feature"); git(repo, "switch", "main");
  return { repo, worktrees, base, head };
}

test("branch discovery reads remote refs without changing the repository checkout", async () => {
  const value = fixture();
  const service = new TaskSourceService(github());
  const result = await service.discover(project(value.repo), "branch");
  expect(result).toMatchObject({ available: true, sources: [{ kind: "branch", branch: "feature", headSha: value.head }] });
  expect(git(value.repo, "branch", "--show-current")).toBe("main");
  expect(git(value.repo, "rev-parse", "HEAD")).toBe(value.base);
});

test("source capture reads the current remote branch head", async () => {
  const value = fixture();
  const service = new TaskSourceService(github());
  expect(await service.resolve(project(value.repo), { kind: "branch", branch: "feature" })).toEqual({ kind: "branch", branch: "feature", headSha: value.head });
  git(value.repo, "push", "origin", "--delete", "feature");
  await expect(service.resolve(project(value.repo), { kind: "branch", branch: "feature" })).rejects.toMatchObject({ code: "source-provider-unavailable" });
});
