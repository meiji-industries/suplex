import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCommand } from "../src/command-runner.js";
import { readTaskChecks, readTaskDiff } from "../src/task-inspection.js";
import { nativeApp } from "./helpers/native-app.js";

test("task diffs read actual Git changes without changing worktree state", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Inspect changes", description: "Read local changes", idempotencyKey: "inspect-diff" });
    expect(await readTaskDiff(task)).toMatchObject({ available: false });
    const cwd = value.project.repositoryPath;
    const git = (args: string[]) => runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", cwd, ...args] });
    for (const args of [["init"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) expect((await git(args)).exitCode).toBe(0);
    await writeFile(join(cwd, "README.md"), "Before\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "Initial"]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(cwd, "README.md"), "After\n");
    const current = { ...task, configuration: { ...task.configuration, baselineSha: head }, worktree: { path: cwd, branch: "main", baseSha: head, headSha: head, dirty: true } };
    const before = (await git(["status", "--porcelain"])).stdout;
    const diff = await readTaskDiff(current);
    expect(diff).toMatchObject({ available: true, truncated: false });
    expect(diff.patch).toContain("-Before\n+After");
    expect((await git(["status", "--porcelain"])).stdout).toBe(before);
    expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    await writeFile(join(cwd, "README.md"), "Large diff é\n".repeat(2000));
    const large = await readTaskDiff(current);
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

test("provider observation failures stay errors rather than successful checks", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Inspect checks", description: "Read remote checks", idempotencyKey: "inspect-checks" });
    await expect(readTaskChecks({ ...task, pullRequest: { repository: "owner/repo", number: 3, url: "https://github.com/owner/repo/pull/3", headSha: "a".repeat(40), state: "open", mergedAt: null } }, { async observePullRequest() { throw new Error("GitHub did not answer"); } })).rejects.toThrow("GitHub did not answer");
  } finally { await value.close(); }
});
