// Run after `cargo build --manifest-path rust/Cargo.toml --bin suplex`:
// mise exec -- pnpm exec tsx tests/interop/root-worker-evidence.ts
import { deepStrictEqual, equal } from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeApp } from "../helpers/native-app.js";
import { RootController } from "../../src/coordination/root-controller.js";
import { FakeTaskHarness } from "../helpers/fake-task-harness.js";
import { parseCodexEvents, codexTools } from "../../src/runtimes/codex/transcript.js";
import { taskSessionRuntimeDirectory, writeRootBridgeBinding } from "../../src/runtimes/task-harness.js";
import { initializeAndList, runMcpProcess } from "../helpers/mcp-process.js";
import { runCommand } from "../../src/platform/command-runner.js";

const value = await nativeApp();
try {
  const created = await value.tasks.createTask(value.userId, value.company.id, {
    projectId: value.project.id,
    title: "Read native Worker evidence",
    description: "Inspect a completed native command",
    idempotencyKey: "root-evidence-probe",
    startImmediately: true,
    deliveryTarget: "local_worktree",
  });
  const store = value.tasks.repository.controls;
  const output = `${"x".repeat(5_000)}\n2 passed`;
  const log = [
    JSON.stringify({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "pnpm test", status: "in_progress" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "pnpm test", aggregated_output: output, exit_code: 0, status: "completed" } }),
  ].join("\n") + "\n";
  const source = new RootController(store, new FakeTaskHarness(), undefined, undefined, undefined, () => ({
    turnEvidence: async () => ({ tools: codexTools(parseCodexEvents(log)), limitation: null }),
  }));
  const root = source.prepareRoot(created.task.id);
  const worker = store.launchWorker({ taskId: created.task.id, rootSessionId: root.id, rootGeneration: root.generation, instruction: "Run a check" });
  const turn = store.turns(created.task.id).find(candidate => candidate.sessionId === worker.id)!;
  const nativeDirectory = taskSessionRuntimeDirectory(value.config.databasePath, worker.id);
  await mkdir(nativeDirectory, { recursive: true });
  await writeFile(join(nativeDirectory, `turn-${turn.id}.jsonl`), log);

  const identity = { taskId: created.task.id, sessionId: root.id, generation: root.generation };
  const index = await source.readWorkerEvidence(identity, { turnId: turn.id });
  const tail = await source.readWorkerEvidence(identity, { turnId: turn.id, toolId: "item_0", maxCharacters: 1_000 });
  const head = await source.readWorkerEvidence(identity, { turnId: turn.id, toolId: "item_0", position: "head", maxCharacters: 1_000 });
  const next = await source.readWorkerEvidence(identity, { turnId: turn.id, toolId: "item_0", position: "head", cursor: head.nextCursor!, maxCharacters: 1_000 });
  const binding = await writeRootBridgeBinding({ runtimeDirectory: join(value.directory, "root-bridge"), identity, databasePath: value.config.databasePath, artifactRoot: value.config.artifactRoot });
  const server = { ...binding, command: resolve(process.env.SUPLEX_RUST_BIN ?? "rust/target/debug/suplex"), args: ["mcp", "root"] };
  const calls = [
    { args: { kind: "read_worker_evidence", turnId: turn.id }, expected: index },
    { args: { kind: "read_worker_evidence", turnId: turn.id, toolId: "item_0", maxCharacters: 1_000 }, expected: tail },
    { args: { kind: "read_worker_evidence", turnId: turn.id, toolId: "item_0", position: "head", maxCharacters: 1_000 }, expected: head },
    { args: { kind: "read_worker_evidence", turnId: turn.id, toolId: "item_0", position: "head", cursor: head.nextCursor, maxCharacters: 1_000 }, expected: next },
  ];
  for (const [index, call] of calls.entries()) {
    const responses = await runMcpProcess(server, { ...process.env, ...binding.environment }, [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: call.args } },
    ]);
    const response = (id: number) => responses.responses.find((candidate): candidate is { id: number; result?: Record<string, unknown> } =>
      typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === id);
    equal(response(3)?.result?.isError, false, `MCP call ${index}: ${JSON.stringify(response(3))}; ${responses.stderr}`);
    deepStrictEqual(response(3)?.result?.structuredContent, call.expected);
    const listed = response(2)?.result?.tools;
    equal(Array.isArray(listed) && listed[0]?.name, "suplex_root");
  }
  const worktree = join(value.directory, "delivery-worktree");
  await mkdir(worktree);
  const headBranch = store.get(created.task.id).deliveryIntent.headBranch;
  const git = async (...args: string[]) => (await runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", worktree, ...args] })).stdout.trim();
  await git("init", "-b", headBranch);
  await git("config", "user.name", "Suplex probe");
  await git("config", "user.email", "suplex-probe@example.invalid");
  await writeFile(join(worktree, "README.md"), "Committed change\n");
  await git("add", "README.md");
  await git("commit", "-m", "Prepare reviewed change");
  const headSha = await git("rev-parse", "HEAD");
  store.setWorktree(created.task.id, { path: worktree, branch: headBranch, baseSha: headSha, headSha, dirty: false });
  await writeFile(join(worktree, "README.md"), "Committed change\nUncommitted note\n");
  for (const [expectedHead, shouldComplete] of [["wrong-head", false], [headSha, true]] as const) {
    const result = await runMcpProcess(server, { ...process.env, ...binding.environment }, [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: { kind: "request_delivery", operation: "complete_local_work", expectedHead } } },
    ]);
    const call = result.responses.find((candidate): candidate is { id: number; result?: Record<string, unknown> } =>
      typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === 3);
    equal(call?.result?.isError, !shouldComplete, `${JSON.stringify(call)}; ${result.stderr}`);
    if (shouldComplete) deepStrictEqual(call?.result?.structuredContent, { kind: "local_work_completed", headSha });
    equal(store.get(created.task.id).status, shouldComplete ? "delivered" : "active");
  }
  equal(store.get(created.task.id).worktree?.dirty, true);
  console.log("Root Worker evidence and local delivery pass through Rust MCP on the same TypeScript task and native Git state.");
} finally {
  await value.close();
}
