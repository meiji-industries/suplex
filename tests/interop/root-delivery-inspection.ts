// Run against a built Rust binary. All Git remotes and task data are isolated.
import { deepStrictEqual, equal } from "node:assert/strict";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RootController } from "../../src/coordination/root-controller.js";
import { inspectDeliveryDiff } from "../../src/delivery/review.js";
import { runCommand } from "../../src/platform/command-runner.js";
import { taskSessionRuntimeDirectory, writeRootBridgeBinding } from "../../src/runtimes/task-harness.js";
import { FakeTaskHarness } from "../helpers/fake-task-harness.js";
import { initializeAndList, runMcpProcess } from "../helpers/mcp-process.js";
import { nativeApp } from "../helpers/native-app.js";

const fixture = await nativeApp();
try {
  const created = await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
    projectId: fixture.project.id,
    title: "Inspect complete delivery patch",
    description: "Review real Git changes",
    idempotencyKey: "delivery-inspection",
    startImmediately: true,
    deliveryTarget: "local_worktree",
  });
  const store = fixture.tasks.repository.controls;
  const root = new RootController(store, new FakeTaskHarness()).prepareRoot(created.task.id);
  const identity = { taskId: created.task.id, sessionId: root.id, generation: root.generation };
  const worktree = join(fixture.directory, "review-worktree");
  const bare = join(fixture.directory, "published.git");
  await mkdir(worktree);
  const git = async (cwd: string, ...args: string[]) => (await runCommand({ taskId: null, stepId: null, command: "git", cwd, args })).stdout.trim();
  await git(worktree, "init", "-b", "main");
  await git(worktree, "config", "user.name", "Review probe");
  await git(worktree, "config", "user.email", "review@example.invalid");
  await git(worktree, "config", "diff.context", "5");
  await writeFile(join(worktree, "plain.txt"), "before\n");
  await writeFile(join(worktree, "rename.txt"), "renamed content\n");
  await writeFile(join(worktree, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(worktree, "nonewline.txt"), "before");
  await writeFile(join(worktree, "mode.sh"), "#!/bin/sh\necho hi\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-m", "Base");
  const publishedBase = await git(worktree, "rev-parse", "HEAD");
  await git(fixture.directory, "clone", "--bare", worktree, bare);
  await git(worktree, "config", "--local", `url.file://${bare}.insteadOf`, "https://github.com/owner/repo.git");
  await git(worktree, "remote", "add", "origin", "https://github.com/owner/repo.git");
  const branch = store.get(created.task.id).deliveryIntent.headBranch;
  await git(worktree, "checkout", "-b", branch);
  await writeFile(join(worktree, "plain.txt"), "after\n");
  await rename(join(worktree, "rename.txt"), join(worktree, "moved.txt"));
  await writeFile(join(worktree, "binary.bin"), Buffer.from([0, 1, 2, 254]));
  await writeFile(join(worktree, "nonewline.txt"), "after");
  await writeFile(join(worktree, "password=fixture.txt"), "Synthetic gho_ABCDEFGH and égho_ABCDEFGH\n");
  await chmod(join(worktree, "mode.sh"), 0o755);
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-m", "Change source");
  await writeFile(join(worktree, "second.txt"), "Second commit\n");
  await git(worktree, "add", "second.txt");
  await git(worktree, "commit", "-m", "Add second change");
  const headSha = await git(worktree, "rev-parse", "HEAD");
  store.setWorktree(created.task.id, { path: worktree, branch, baseSha: "0".repeat(40), headSha: "f".repeat(40), dirty: true });
  await git(worktree, "update-ref", "refs/remotes/origin/main", headSha);
  const source = { ...await inspectDeliveryDiff(worktree, publishedBase, headSha), baseBranch: "main" };
  const binding = await writeRootBridgeBinding({ runtimeDirectory: taskSessionRuntimeDirectory(fixture.config.databasePath, root.id), identity, databasePath: fixture.config.databasePath, artifactRoot: fixture.config.artifactRoot });
  const server = { ...binding, command: resolve(process.env.SUPLEX_RUST_BIN ?? "rust/target/debug/suplex"), args: ["mcp", "root"] };
  const responses = await runMcpProcess(server, { ...process.env, ...binding.environment }, [
    ...initializeAndList,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: { kind: "request_delivery", operation: "inspect_delivery_diff" } } },
  ]);
  const call = responses.responses.find((candidate): candidate is { id: number; result?: Record<string, unknown> } =>
    typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === 3);
  equal(call?.result?.isError, false, `${JSON.stringify(call)}; ${responses.stderr}`);
  deepStrictEqual(call?.result?.structuredContent, source);
  equal((await readFile(join(worktree, "plain.txt"), "utf8")), "after\n");
  equal(store.get(created.task.id).worktree?.headSha, "f".repeat(40), "inspection must not replace saved task intent");
  await git(bare, "update-ref", "-d", "refs/heads/main");
  const missing = await runMcpProcess(server, { ...process.env, ...binding.environment }, [
    ...initializeAndList,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: { kind: "request_delivery", operation: "inspect_delivery_diff" } } },
  ]);
  const missingCall = missing.responses.find((candidate): candidate is { id: number; result?: Record<string, unknown> } =>
    typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === 3);
  equal(missingCall?.result?.isError, true, "a cached commit and tracking ref cannot replace the published branch");
  store.cancel(created.task.id);
  const cancelled = await runMcpProcess(server, { ...process.env, ...binding.environment }, [
    ...initializeAndList,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: { kind: "request_delivery", operation: "inspect_delivery_diff" } } },
  ]);
  const cancelledCall = cancelled.responses.find((candidate): candidate is { id: number; result?: Record<string, unknown> } =>
    typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === 3);
  equal(cancelledCall?.result?.isError, true, "a cancelled Root cannot inspect delivery");
  console.log("Rust Root delivery inspection matches the complete TypeScript patch response on the same Git task.");
} finally {
  await fixture.close();
}
