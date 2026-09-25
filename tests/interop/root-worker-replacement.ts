// Run with a tested Rust binary in SUPLEX_RUST_BIN. The two task stores share
// one SQLite schema; TypeScript supplies the source prompt/hash oracle.
import { createHash } from "node:crypto";
import { deepStrictEqual, equal, match, notEqual } from "node:assert/strict";
import { join, resolve } from "node:path";
import { nativeApp } from "../helpers/native-app.js";
import { RootController } from "../../src/coordination/root-controller.js";
import { FakeTaskHarness } from "../helpers/fake-task-harness.js";
import { writeRootBridgeBinding } from "../../src/runtimes/task-harness.js";
import { initializeAndList, runMcpProcess } from "../helpers/mcp-process.js";

const fixture = await nativeApp();
try {
  const store = fixture.tasks.repository.controls;
  const source = new RootController(store, new FakeTaskHarness());
  const create = async (key: string) => {
    const { task } = await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
      projectId: fixture.project.id,
      title: "Replace an ineffective Worker",
      idempotencyKey: key,
      startImmediately: true,
      deliveryTarget: "local_worktree",
    });
    const root = source.prepareRoot(task.id);
    const worker = store.launchWorker({ taskId: task.id, rootSessionId: root.id, rootGeneration: root.generation, instruction: "Finish the behavior and test it." });
    fixture.database.authTransaction(db => db.prepare("UPDATE suplex_task_turns SET status = 'completed', terminal_observation = ? WHERE session_id = ?").run(JSON.stringify({ state: "completed", text: "Partial change" }), worker.id));
    return { task, root, worker };
  };
  const rust = await create("rust-replacement");
  const typescript = await create("typescript-replacement");
  const request = { sessionId: rust.worker.id, reason: "  Change strategy  ", handoff: "  Finish checks  " };
  const sourceResult = store.replaceWorker(typescript.task.id, { ...request, sessionId: typescript.worker.id });
  const sourceTurn = store.turns(typescript.task.id).find(turn => turn.sessionId === sourceResult.id)!;

  const identity = { taskId: rust.task.id, sessionId: rust.root.id, generation: rust.root.generation };
  const binding = await writeRootBridgeBinding({
    runtimeDirectory: join(fixture.directory, "root-replacement-bridge"), identity,
    databasePath: fixture.config.databasePath, artifactRoot: fixture.config.artifactRoot,
  });
  const server = { ...binding, command: resolve(process.env.SUPLEX_RUST_BIN ?? "rust/target/debug/suplex"), args: ["mcp", "root"] };
  const call = async (args: Record<string, unknown>) => {
    const result = await runMcpProcess(server, { ...process.env, ...binding.environment }, [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: args } },
    ]);
    const response = result.responses.find(value => typeof value === "object" && value !== null && "id" in value && value.id === 3) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } } | undefined;
    equal(response?.result?.isError, false, result.stderr);
    return response!.result!.structuredContent!;
  };
  const replaced = await call({ kind: "replace_worker", ...request });
  const worker = replaced.worker as { id: string; nativeSessionId: string | null; profile: unknown };
  notEqual(worker.id, rust.worker.id);
  equal(worker.nativeSessionId, null);
  deepStrictEqual(worker.profile, rust.worker.profile);
  equal((replaced.acceptedAssignment as { kind: string }).kind, "saved_prompt");
  match(String(replaced.next), /stop the outgoing execution/);
  const rustTurn = store.turns(rust.task.id).find(turn => turn.sessionId === worker.id)!;
  equal(rustTurn.promptText, sourceTurn.promptText);
  equal(rustTurn.promptHash, sourceTurn.promptHash);
  equal(rustTurn.promptHash, createHash("sha256").update(rustTurn.promptText).digest("hex"));
  equal(store.workerReplacementReady(worker.id), false);
  const repeated = await call({ kind: "replace_worker", ...request });
  equal((repeated.worker as { id: string }).id, worker.id);
  fixture.database.authTransaction(db => db.prepare("UPDATE suplex_task_sessions SET stopped_at = ? WHERE id = ?").run(new Date().toISOString(), rust.worker.id));
  equal(store.workerReplacementReady(worker.id), true);
  equal(store.currentSession(rust.task.id, "worker")!.id, worker.id);
  equal(store.currentSession(rust.task.id, "worker")!.replacement?.sessionId, rust.worker.id);
  console.log("Rust Root MCP Worker replacement matches TypeScript prompt/hash and waits for retired native shutdown.");
} finally {
  await fixture.close();
}
