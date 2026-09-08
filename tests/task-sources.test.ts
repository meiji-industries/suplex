import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import * as isomorphicGit from "isomorphic-git";

import type { GithubPullRequest, GithubReleasePort } from "../src/integrations/github/delivery.js";
import type { Project } from "../src/projects/projects.js";
import { TaskSourceService } from "../src/tasks/sources.js";
import { TaskBodySchema } from "../src/http/contracts/tasks.js";
import { commitGitFixture, initializeGitFixture } from "./helpers/git-fixture.js";

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
async function fixture(): Promise<{ repo: string; worktrees: string; base: string; head: string }> {
  const root = mkdtempSync(join(tmpdir(), "forge-source-")); roots.push(root);
  const remote = join(root, "remote.git"); const repo = join(root, "repo"); const worktrees = join(root, "worktrees");
  mkdirSync(repo); mkdirSync(worktrees); mkdirSync(remote); await initializeGitFixture(remote, "main", true); await initializeGitFixture(repo, "main");
  writeFileSync(join(repo, "README.md"), "base\n"); const base = await commitGitFixture(repo, "base", ["README.md"]); await isomorphicGit.addRemote({ fs, dir: repo, remote: "origin", url: remote }); git(repo, "push", "-u", "origin", "main");
  await isomorphicGit.branch({ fs, dir: repo, ref: "feature" }); await isomorphicGit.checkout({ fs, dir: repo, ref: "feature" }); writeFileSync(join(repo, "feature.txt"), "source\n"); const head = await commitGitFixture(repo, "source", ["feature.txt"]); git(repo, "push", "-u", "origin", "feature"); await isomorphicGit.checkout({ fs, dir: repo, ref: "main" });
  return { repo, worktrees, base, head };
}

test("branch discovery reads remote refs without changing the repository checkout", async () => {
  const value = await fixture();
  const service = new TaskSourceService(github());
  const result = await service.discover(project(value.repo), "branch");
  expect(result).toMatchObject({ available: true, sources: [{ kind: "branch", branch: "feature", headSha: value.head }] });
  expect(git(value.repo, "branch", "--show-current")).toBe("main");
  expect(git(value.repo, "rev-parse", "HEAD")).toBe(value.base);
});

test("source capture reads the current remote branch head", async () => {
  const value = await fixture();
  const service = new TaskSourceService(github());
  expect(await service.resolve(project(value.repo), { kind: "branch", branch: "feature" })).toEqual({ kind: "branch", branch: "feature", headSha: value.head });
  git(value.repo, "push", "origin", "--delete", "feature");
  await expect(service.resolve(project(value.repo), { kind: "branch", branch: "feature" })).rejects.toMatchObject({ code: "source-provider-unavailable" });
});

test("issues resolve from GitHub without a discovery receipt and retain full context", async () => {
  const issue = { number: 42, url: "https://github.com/acme/forge/issues/42", title: "Fix search", body: "Original details", author: { login: "octo" }, state: "OPEN" as const, labels: [{ name: "bug" }], assignees: [{ login: "dev" }], milestone: { title: "Launch" }, updatedAt: "2026-09-07", comments: [{ html_url: "https://github.com/acme/forge/issues/42#issuecomment-1", body: "Use the new index", user: { login: "reviewer" }, created_at: "2026-09-07" }] };
  const service = new TaskSourceService({ ...github(), async listOpenIssues() { return [issue]; }, async getIssue() { return { ...issue, body: "Updated details" }; } });
  expect(TaskBodySchema.parse({ projectId: "p", title: "Task", description: "Do it", idempotencyKey: "issue-source-001", source: { kind: "issue", number: 42 } }).source).toEqual({ kind: "issue", number: 42 });
  const resolved = await service.resolve(project(), { kind: "issue", number: 42 });
  expect(resolved.kind).toBe("issue");
  if (resolved.kind !== "issue") throw new Error("Expected issue");
  for (const text of [issue.url, "Updated details", "octo", "bug", "dev", "Launch", "Use the new index", "reviewer", issue.comments[0]!.html_url]) expect(resolved.context).toContain(text);
  expect(await service.discover(project(), "issue")).toMatchObject({ available: true, sources: [{ kind: "issue", number: 42, author: "octo" }] });
  const offline = new TaskSourceService({ ...github(), async getIssue() { throw new Error("secret"); } });
  await expect(offline.resolve(project(), { kind: "issue", number: 42 })).rejects.toMatchObject({ message: "The issue could not be read.", statusCode: 503 });
  expect(await offline.discover(project(), "issue")).toEqual({ available: false, sources: [] });
});
