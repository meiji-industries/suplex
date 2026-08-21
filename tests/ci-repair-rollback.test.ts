import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";

import { rollbackUnpushedRepairCommits } from "../src/codex-developer.js";

const execFileAsync = promisify(execFile);
const git = async (args: string[], cwd: string): Promise<string> => (await execFileAsync("git", args, { cwd })).stdout.trim();
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A remote plus a clone on `work` whose HEAD is the pushed prior commit. */
async function fixture(): Promise<{ worktree: string; priorCommit: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-ci-repair-rollback-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const worktree = join(root, "work");
  await execFileAsync("git", ["init", "--bare", "-b", "work", origin]);
  await execFileAsync("git", ["clone", origin, worktree]);
  for (const [key, value] of [["user.name", "Forge Test"], ["user.email", "forge-test@example.invalid"], ["commit.gpgsign", "false"]]) await git(["config", key!, value!], worktree);
  await writeFile(join(worktree, "a.txt"), "one\n");
  await git(["add", "a.txt"], worktree);
  await git(["commit", "-m", "prior"], worktree);
  await git(["push", "-u", "origin", "work"], worktree);
  return { worktree, priorCommit: await git(["rev-parse", "HEAD"], worktree) };
}

test("rolls an unpushed failed-repair commit back to the prior commit", async () => {
  const { worktree, priorCommit } = await fixture();
  await git(["commit", "--allow-empty", "-m", "failed repair"], worktree);
  await writeFile(join(worktree, "a.txt"), "dirty\n");
  expect(await rollbackUnpushedRepairCommits(worktree, "work", priorCommit)).toBe(true);
  expect(await git(["rev-parse", "HEAD"], worktree)).toBe(priorCommit);
  expect(await git(["status", "--porcelain"], worktree)).toBe("");
});

test("is a no-op when HEAD already is the prior commit", async () => {
  const { worktree, priorCommit } = await fixture();
  expect(await rollbackUnpushedRepairCommits(worktree, "work", priorCommit)).toBe(true);
  expect(await git(["rev-parse", "HEAD"], worktree)).toBe(priorCommit);
});

test("refuses to discard a commit that is already pushed", async () => {
  const { worktree, priorCommit } = await fixture();
  await git(["commit", "--allow-empty", "-m", "pushed"], worktree);
  await git(["push", "origin", "work"], worktree);
  const head = await git(["rev-parse", "HEAD"], worktree);
  expect(await rollbackUnpushedRepairCommits(worktree, "work", priorCommit)).toBe(false);
  expect(await git(["rev-parse", "HEAD"], worktree)).toBe(head);
});

test("refuses when the prior commit is not an ancestor of HEAD", async () => {
  const { worktree } = await fixture();
  const head = await git(["rev-parse", "HEAD"], worktree);
  expect(await rollbackUnpushedRepairCommits(worktree, "work", "0".repeat(40))).toBe(false);
  expect(await git(["rev-parse", "HEAD"], worktree)).toBe(head);
});

test("refuses when the checked-out branch is not the repair branch", async () => {
  const { worktree, priorCommit } = await fixture();
  await git(["commit", "--allow-empty", "-m", "failed repair"], worktree);
  await git(["checkout", "-b", "other"], worktree);
  const head = await git(["rev-parse", "HEAD"], worktree);
  expect(await rollbackUnpushedRepairCommits(worktree, "work", priorCommit)).toBe(false);
  expect(await git(["rev-parse", "HEAD"], worktree)).toBe(head);
});
