// eslint-disable-next-line no-restricted-imports -- The regression needs a detached process that outlives its launcher.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { taskProcessEnvironment, sessionProcessEnvironment, stopSessionProcesses, executionProcessEnvironment, stopExecutionProcesses } from "../src/platform/process-manager.js";
import { runCommand } from "../src/platform/command-runner.js";
import { prepareTaskWorktree, removeTaskWorktree } from "../src/tasks/worktree.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const git = async (cwd: string, args: string[]) => (await runCommand({ taskId: null, stepId: null, command: "git", args, cwd })).stdout.trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-task-worktree-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath);
  await git(repositoryPath, ["init", "-b", "main"]);
  await git(repositoryPath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "seed"]);
  const startingSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
  return { taskId: "task_proof", repositoryPath, worktreeRoot: join(root, "worktrees"), branch: "task/proof", startingSha };
}

test("Git materialization reuses out-of-band commits and dirty files without a database gate", async () => {
  const intent = await fixture();
  const initial = await prepareTaskWorktree(intent);
  await writeFile(join(initial.path, "committed.txt"), "out-of-band commit");
  await git(initial.path, ["add", "committed.txt"]);
  await git(initial.path, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "external change"]);
  await writeFile(join(initial.path, "dirty.txt"), "preserve me");
  const resumed = await prepareTaskWorktree(intent);
  expect(resumed).toMatchObject({ path: initial.path, branch: intent.branch, dirty: true });
  expect(resumed.headSha).not.toBe(initial.headSha);
  expect(await readFile(join(resumed.path, "dirty.txt"), "utf8")).toBe("preserve me");
});

test("a missing worktree reattaches the existing branch without discarding its commits", async () => {
  const intent = await fixture();
  const initial = await prepareTaskWorktree(intent);
  await git(initial.path, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "external commit"]);
  const head = await git(initial.path, ["rev-parse", "HEAD"]);
  await rm(initial.path, { recursive: true });
  expect(await prepareTaskWorktree(intent)).toMatchObject({ path: initial.path, headSha: head, dirty: false });
});

test("an existing task worktree is reused after its branch changes", async () => {
  const intent = await fixture();
  const initial = await prepareTaskWorktree(intent);
  await git(initial.path, ["switch", "-c", "somebody-else"]);
  await writeFile(join(initial.path, "preserved.txt"), "keep this");
  await expect(prepareTaskWorktree(intent)).resolves.toMatchObject({ path: initial.path, branch: intent.branch, dirty: true });
  expect(await git(initial.path, ["branch", "--show-current"])).toBe("somebody-else");
  expect(await readFile(join(initial.path, "preserved.txt"), "utf8")).toBe("keep this");
});

test("a symlink at the task path is never silently adopted", async () => {
  const intent = await fixture();
  const initial = await prepareTaskWorktree(intent);
  await git(intent.repositoryPath, ["worktree", "remove", initial.path]);
  await symlink(intent.repositoryPath, initial.path);
  await expect(prepareTaskWorktree(intent)).rejects.toThrow("conflicting owner");
});

test("a repository owned by someone else at the task path is never overwritten", async () => {
  const intent = await fixture();
  const path = join(intent.worktreeRoot, intent.taskId);
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", intent.branch]);
  await git(path, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "foreign"]);
  await writeFile(join(path, "preserved.txt"), "foreign repository");
  await expect(prepareTaskWorktree(intent)).rejects.toThrow("does not match its repository");
  expect(await readFile(join(path, "preserved.txt"), "utf8")).toBe("foreign repository");
});

test("an unrelated directory at the task path is never overwritten", async () => {
  const intent = await fixture();
  const path = join(intent.worktreeRoot, intent.taskId);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "preserved.txt"), "unrelated directory");
  await expect(prepareTaskWorktree(intent)).rejects.toThrow();
  expect(await readFile(join(path, "preserved.txt"), "utf8")).toBe("unrelated directory");
});

test("a task branch already in another worktree is not checked out twice", async () => {
  const intent = await fixture();
  await prepareTaskWorktree(intent);
  await expect(prepareTaskWorktree({ ...intent, taskId: "another_task" })).rejects.toThrow("another worktree");
});

test("an existing task worktree is reused when its intended branch is checked out elsewhere", async () => {
  const intent = await fixture();
  const initial = await prepareTaskWorktree(intent);
  await git(initial.path, ["switch", "-c", "rebase-state"]);
  const otherPath = join(intent.worktreeRoot, "intended-branch");
  await git(intent.repositoryPath, ["worktree", "add", otherPath, intent.branch]);
  await expect(prepareTaskWorktree(intent)).resolves.toMatchObject({ path: initial.path, branch: intent.branch });
  expect(await git(initial.path, ["branch", "--show-current"])).toBe("rebase-state");
});

test("concurrent materialization converges on the same Git worktree", async () => {
  const intent = await fixture();
  const [first, second] = await Promise.all([prepareTaskWorktree(intent), prepareTaskWorktree(intent)]);
  expect(first).toEqual(second);
});

test("worktree roots cannot overlap the repository", async () => {
  const intent = await fixture();
  await expect(prepareTaskWorktree({ ...intent, worktreeRoot: join(intent.repositoryPath, "worktrees") })).rejects.toThrow("overlap");
});

test("archive stops detached worktree commands while preserving unrelated processes", async () => {
  const intent = await fixture();
  const worktree = await prepareTaskWorktree(intent);
  const owned = spawn("sleep", ["300"], { cwd: worktree.path, detached: true, stdio: "ignore" });
  const unrelated = spawn("sleep", ["300"], { cwd: intent.repositoryPath, detached: true, stdio: "ignore" });
  await Promise.all([once(owned, "spawn"), once(unrelated, "spawn")]);
  cleanups.unshift(async () => { owned.kill("SIGKILL"); unrelated.kill("SIGKILL"); });
  await expect(removeTaskWorktree(intent, worktree, false, () => {})).resolves.toEqual({ status: "cleaned" });
  expect(() => process.kill(owned.pid!, 0)).toThrow();
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
});

test.each([false, true])("archive finds a detached command outside the worktree, already removed=%s", async removed => {
  const intent = await fixture();
  const worktree = await prepareTaskWorktree(intent);
  const owned = spawn("sleep", ["300"], { cwd: intent.repositoryPath, env: { ...process.env, ...taskProcessEnvironment(worktree.path) }, detached: true, stdio: "ignore" });
  const marker = taskProcessEnvironment(worktree.path).FORGE_TASK_PROCESS_OWNER!;
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", `FORGE_TASK_PROCESS_OWNER=${marker}`], { cwd: intent.repositoryPath, stdio: "ignore" });
  await Promise.all([once(owned, "spawn"), once(unrelated, "spawn")]);
  cleanups.unshift(async () => { owned.kill("SIGKILL"); unrelated.kill("SIGKILL"); });
  if (removed) await git(intent.repositoryPath, ["worktree", "remove", worktree.path]);
  await expect(removeTaskWorktree(intent, worktree, false, () => {})).resolves.toEqual({ status: removed ? "already_absent" : "cleaned" });
  expect(() => process.kill(owned.pid!, 0)).toThrow();
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
});

test("retired session cleanup preserves another session in the same worktree", async () => {
  const intent = await fixture();
  const worktree = await prepareTaskWorktree(intent);
  const retiredDirectory = join(intent.repositoryPath, "retired-session");
  const currentDirectory = join(intent.repositoryPath, "current-session");
  const retired = spawn("sleep", ["300"], { cwd: intent.repositoryPath, env: { ...process.env, ...taskProcessEnvironment(worktree.path), ...sessionProcessEnvironment(retiredDirectory) }, detached: true, stdio: "ignore" });
  const current = spawn("sleep", ["300"], { cwd: intent.repositoryPath, env: { ...process.env, ...taskProcessEnvironment(worktree.path), ...sessionProcessEnvironment(currentDirectory) }, detached: true, stdio: "ignore" });
  await Promise.all([once(retired, "spawn"), once(current, "spawn")]);
  cleanups.unshift(async () => { retired.kill("SIGKILL"); current.kill("SIGKILL"); });
  await stopSessionProcesses(retiredDirectory);
  expect(() => process.kill(retired.pid!, 0)).toThrow();
  expect(() => process.kill(current.pid!, 0)).not.toThrow();
});

test("dispatch recovery stops the old execution without stopping its replacement", async () => {
  const intent = await fixture();
  const runtime = join(intent.repositoryPath, "session");
  const launch = (generation: string) => spawn("sleep", ["300"], { cwd: intent.repositoryPath, env: { ...process.env, ...sessionProcessEnvironment(runtime), ...executionProcessEnvironment(runtime, generation) }, detached: true, stdio: "ignore" });
  const old = launch("old");
  const replacement = launch("replacement");
  await Promise.all([once(old, "spawn"), once(replacement, "spawn")]);
  cleanups.unshift(async () => { old.kill("SIGKILL"); replacement.kill("SIGKILL"); });
  await stopExecutionProcesses(runtime, "old");
  expect(() => process.kill(old.pid!, 0)).toThrow();
  expect(() => process.kill(replacement.pid!, 0)).not.toThrow();
});

test("cleanup also stops a detached child created during shutdown", async () => {
  const intent = await fixture();
  const runtime = join(intent.repositoryPath, "session");
  const pidFile = join(intent.repositoryPath, "child-pid");
  const script = `const {spawn}=require("node:child_process"); const {writeFileSync}=require("node:fs"); process.on("SIGTERM",()=>{const child=spawn("sleep",["300"],{detached:true,stdio:"ignore"}); writeFileSync(process.argv[1],String(child.pid)); child.unref(); process.exit(0);}); console.log("ready"); setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ["-e", script, pidFile], { cwd: intent.repositoryPath, env: { ...process.env, ...sessionProcessEnvironment(runtime) }, stdio: ["ignore", "pipe", "ignore"] });
  await once(parent.stdout!, "data");
  cleanups.unshift(async () => {
    parent.kill("SIGKILL");
    try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch {}
  });
  await stopSessionProcesses(runtime);
  const childPid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(parent.pid!, 0)).toThrow();
  expect(() => process.kill(childPid, 0)).toThrow();
});
