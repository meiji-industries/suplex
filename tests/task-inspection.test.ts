import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { GithubPullRequest, GithubReleasePort } from "../src/integrations/github/delivery.js";
import { runCommand } from "../src/platform/command-runner.js";
import { readTaskChecks, readTaskDiff, readTaskDiffSummary } from "../src/tasks/inspection.js";
import { nativeApp } from "./helpers/native-app.js";
import { commitGitFixture, initializeGitFixture } from "./helpers/git-fixture.js";

const git = (cwd: string, args: string[], expectNonZero = false) => runCommand({ taskId: null, stepId: null, command: "git", cwd, args, ...(expectNonZero ? { expectNonZero: true } : {}) });
const github = (heads: Record<string, string | null>, pull?: GithubPullRequest): Pick<Required<GithubReleasePort>, "getBranchHead" | "getPullRequest"> => ({
  async getBranchHead({ branch }) { return heads[branch] ?? null; },
  async getPullRequest() { if (!pull) throw new Error("Unexpected pull request observation"); return pull; },
});

test("task diffs read actual Git changes without changing worktree state", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Inspect changes", description: "Read local changes", idempotencyKey: "inspect-diff" });
    expect(await readTaskDiff(task)).toMatchObject({ available: false });
    const cwd = value.project.repositoryPath;
    await initializeGitFixture(cwd, "main");
    await writeFile(join(cwd, "README.md"), "Before\n");
    const head = await commitGitFixture(cwd, "Initial", ["README.md"]);
    await writeFile(join(cwd, "README.md"), "After\n");
    const current = { ...task, configuration: { ...task.configuration, baselineSha: head }, worktree: { path: cwd, branch: "main", baseSha: head, headSha: head, dirty: true } };
    const before = (await git(cwd, ["status", "--porcelain"])).stdout;
    const diff = await readTaskDiff(current, github({ main: head }));
    expect(diff).toMatchObject({ available: true, truncated: false });
    expect(diff.patch).toContain("-Before\n+After");
    expect((await git(cwd, ["status", "--porcelain"])).stdout).toBe(before);
    expect((await git(cwd, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    await writeFile(join(cwd, "README.md"), "Large diff é\n".repeat(2000));
    const large = await readTaskDiff(current, github({ main: head }));
    expect(large.truncated).toBe(false);
    expect(Buffer.byteLength(large.patch)).toBeGreaterThan(8192);
    expect(large.patch).toContain("diff --git a/README.md b/README.md");
    expect(large.patch.match(/\+Large diff é/g)).toHaveLength(2000);
    expect(large.patch).not.toContain("�");
    const missing = await value.app.inject({ url: "/api/tasks/missing/diff", headers: value.headers });
    expect(missing.statusCode).toBe(404);
    expect((await value.app.inject({ url: `/api/tasks/${task.id}/checks`, headers: value.headers })).json()).toEqual({ available: false, runs: [] });
  } finally { await value.close(); }
});

test("the diff summary counts changed files without reading the patch", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Count changes", description: "Count changed files", idempotencyKey: "inspect-diff-summary" });
    expect(await readTaskDiffSummary(task)).toEqual({ available: false, files: 0 });
    const route = await value.app.inject({ url: `/api/tasks/${task.id}/diff/summary`, headers: value.headers });
    expect(route.statusCode).toBe(200);
    expect(route.json()).toEqual({ available: false, files: 0 });
    expect((await value.app.inject({ url: "/api/tasks/missing/diff/summary", headers: value.headers })).statusCode).toBe(404);

    const cwd = value.project.repositoryPath;
    await initializeGitFixture(cwd, "main");
    await writeFile(join(cwd, "README.md"), "Before\n");
    await writeFile(join(cwd, "NOTES.md"), "Keep\n");
    const head = await commitGitFixture(cwd, "Initial", ["README.md", "NOTES.md"]);
    await writeFile(join(cwd, "README.md"), "After\n");
    await writeFile(join(cwd, "NOTES.md"), "Changed\n");
    const current = { ...task, configuration: { ...task.configuration, baselineSha: head }, worktree: { path: cwd, branch: "main", baseSha: head, headSha: head, dirty: true } };
    const provider = github({ main: head });
    expect(await readTaskDiffSummary(current, provider)).toEqual({ available: true, files: 2 });
    await writeFile(join(cwd, "NEW.md"), "Added\n");
    expect(await readTaskDiffSummary(current, provider)).toEqual({ available: true, files: 2 });
    await runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", cwd, "add", "NEW.md"] });
    expect(await readTaskDiffSummary(current, provider)).toEqual({ available: true, files: 3 });
  } finally { await value.close(); }
});

test("task diffs use the current published pull request base after the base is merged into the task", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Current PR base", description: "Ignore captured baseline metadata", idempotencyKey: "inspect-current-pr-base" });
    const cwd = value.project.repositoryPath;
    await initializeGitFixture(cwd, "main");
    await writeFile(join(cwd, "README.md"), "base\n");
    const capturedBaseline = await commitGitFixture(cwd, "Captured base", ["README.md"]);
    await git(cwd, ["checkout", "-b", "task-branch"]);
    await writeFile(join(cwd, "task.txt"), "task change\n");
    await commitGitFixture(cwd, "Task change", ["task.txt"]);
    await git(cwd, ["checkout", "main"]);
    await writeFile(join(cwd, "published.txt"), "published base change\n");
    const publishedBase = await commitGitFixture(cwd, "Advance published base", ["published.txt"]);
    await git(cwd, ["branch", "release", publishedBase]);
    await git(cwd, ["checkout", "task-branch"]);
    await git(cwd, ["merge", "--no-edit", "release"]);
    const actualHead = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(cwd, "README.md"), "staged tracked change\n");
    await git(cwd, ["add", "README.md"]);
    await writeFile(join(cwd, "README.md"), "staged tracked change\nunstaged tracked change\n");
    const current = {
      ...task,
      configuration: { ...task.configuration, branch: "task-branch", baseBranch: "captured-base", baselineSha: capturedBaseline, source: { kind: "pull_request" as const, number: 41 } },
      worktree: { path: cwd, branch: "task-branch", baseSha: "b".repeat(40), headSha: "c".repeat(40), dirty: false },
    };
    const pull = { number: 41, url: "https://github.com/acme/repo/pull/41", repository: current.configuration.repository, headBranch: "task-branch", baseBranch: "release", headSha: actualHead, baseSha: capturedBaseline, isDraft: false, state: "open" as const, mergedAt: null };
    const calls: string[] = [];
    const provider = github({ release: publishedBase }, pull);
    const observed = {
      async getPullRequest(input: { repository: string; number: number }) { calls.push(`pull:${input.number}`); return provider.getPullRequest(input); },
      async getBranchHead(input: { repository: string; branch: string }) { calls.push(`head:${input.branch}`); return provider.getBranchHead(input); },
    };

    const diff = await readTaskDiff(current, observed);
    expect(diff.patch).toContain("task change");
    expect(diff.patch).toContain("staged tracked change");
    expect(diff.patch).toContain("unstaged tracked change");
    expect(diff.patch).not.toContain("published base change");
    expect(await readTaskDiffSummary(current, observed)).toEqual({ available: true, files: 2 });
    const recordedPullRequest = { ...current, configuration: { ...current.configuration, source: null }, pullRequest: { repository: current.configuration.repository, number: 41, url: pull.url, headSha: actualHead, state: "open", mergedAt: null } };
    expect(await readTaskDiffSummary(recordedPullRequest, observed)).toEqual({ available: true, files: 2 });
    expect(calls).toEqual(["pull:41", "head:release", "pull:41", "head:release", "pull:41", "head:release"]);
  } finally { await value.close(); }
});

test("task diffs fetch the observed base commit and ignore stale local refs and cached task revisions", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Fetch published base", description: "Use provider and Git truth", idempotencyKey: "inspect-fetch-base" });
    const cwd = value.project.repositoryPath;
    const bare = join(cwd, "..", "inspection-origin.git");
    const publisher = join(cwd, "..", "inspection-publisher");
    await initializeGitFixture(cwd, "main");
    await writeFile(join(cwd, "shared.txt"), "base\n");
    const capturedBaseline = await commitGitFixture(cwd, "Base", ["shared.txt"]);
    await initializeGitFixture(bare, "main", true);
    await git(cwd, ["remote", "add", "origin", bare]);
    await git(cwd, ["push", "origin", "main"]);
    await git(cwd, ["checkout", "-b", "task-branch"]);
    await writeFile(join(cwd, "task.txt"), "task only\n");
    await commitGitFixture(cwd, "Task", ["task.txt"]);
    await git(join(cwd, ".."), ["clone", bare, publisher]);
    await git(publisher, ["config", "user.name", "Forge"]);
    await git(publisher, ["config", "user.email", "forge@example.invalid"]);
    await writeFile(join(publisher, "published.txt"), "new published commit\n");
    await git(publisher, ["add", "published.txt"]);
    await git(publisher, ["commit", "-m", "Published"]);
    await git(publisher, ["push", "origin", "main"]);
    const publishedBase = (await git(publisher, ["rev-parse", "HEAD"])).stdout.trim();
    await git(cwd, ["update-ref", "-d", "refs/remotes/origin/main"]);
    expect((await git(cwd, ["cat-file", "-e", `${publishedBase}^{commit}`], true)).exitCode).not.toBe(0);
    const current = {
      ...task,
      configuration: { ...task.configuration, branch: "task-branch", baselineSha: capturedBaseline },
      worktree: { path: cwd, branch: "task-branch", baseSha: "d".repeat(40), headSha: "e".repeat(40), dirty: false },
    };

    const provider = github({ main: publishedBase });
    const missingRefDiff = await readTaskDiff(current, provider);
    const missingRefSummary = await readTaskDiffSummary(current, provider);
    expect(missingRefDiff.patch).toContain("task only");
    expect(missingRefDiff.patch).not.toContain("new published commit");
    expect((await git(cwd, ["cat-file", "-e", `${publishedBase}^{commit}`], true)).exitCode).toBe(0);
    expect((await git(cwd, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], true)).exitCode).not.toBe(0);
    await git(cwd, ["update-ref", "refs/remotes/origin/main", capturedBaseline]);
    const staleMetadata = { ...current, configuration: { ...current.configuration, baselineSha: "0".repeat(40) } };
    const staleRefDiff = await readTaskDiff(staleMetadata, provider);
    const staleRefSummary = await readTaskDiffSummary(staleMetadata, provider);
    expect(staleRefDiff).toEqual(missingRefDiff);
    expect(staleRefSummary).toEqual(missingRefSummary);
  } finally { await value.close(); }
});

test("task diffs fail when the current published base cannot be observed", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Missing published base", description: "Report missing provider evidence", idempotencyKey: "inspect-missing-base" });
    const cwd = value.project.repositoryPath;
    await initializeGitFixture(cwd, "main");
    await writeFile(join(cwd, "README.md"), "base\n");
    const head = await commitGitFixture(cwd, "Base", ["README.md"]);
    const current = { ...task, configuration: { ...task.configuration, baselineSha: head }, worktree: { path: cwd, branch: "main", baseSha: head, headSha: head, dirty: false } };
    await expect(readTaskDiff(current, github({ main: null }))).rejects.toThrow("GitHub did not return the head of main");
  } finally { await value.close(); }
});

test("provider observation failures stay errors rather than successful checks", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Inspect checks", description: "Read remote checks", idempotencyKey: "inspect-checks" });
    await expect(readTaskChecks({ ...task, pullRequest: { repository: "owner/repo", number: 3, url: "https://github.com/owner/repo/pull/3", headSha: "a".repeat(40), state: "open", mergedAt: null } }, { async observePullRequest() { throw new Error("GitHub did not answer"); } })).rejects.toThrow("GitHub did not answer");
  } finally { await value.close(); }
});
