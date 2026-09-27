// Run after building Rust; all task and Git state is disposable.
import { equal, match, notEqual, ok } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { nativeFixture } from "../helpers/native-browser.js";
import { nativeRootBridge } from "../helpers/native-root-bridge.js";
import { initializeAndList, runMcpProcess } from "../helpers/mcp-process.js";

const execute = promisify(execFile);
const fixture = await nativeFixture();
try {
  const task = await fixture.createTask({ title: "Read native Worker evidence", description: "Inspect a completed native command", idempotencyKey: "root-evidence-probe", startImmediately: false, deliveryTarget: "local_worktree" });
  const { server } = await nativeRootBridge(fixture, task.id);
  const worker = `worker_${randomUUID()}`;
  const turn = `msg_${randomUUID()}`;
  const now = new Date().toISOString();
  const nativeId = "codex-evidence-fixture";
  fixture.database.prepare("UPDATE suplex_task_controls SET worker_session_id = ? WHERE task_id = ?").run(worker, task.id);
  fixture.database.prepare("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,native_session_id,lifecycle,delegate_slot,created_at,updated_at) VALUES (?,?,'worker',1,1,?,'stopped','delegate',?,?)")
    .run(worker, task.id, nativeId, now, now);
  fixture.database.prepare("INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,terminal_observation,created_at,updated_at) VALUES (?,?,?,1,'saved-hash','Run a check','completed',?,?,?)")
    .run(turn, task.id, worker, JSON.stringify({ state: "completed", text: "2 passed" }), now, now);
  const output = `${"x".repeat(5_000)}\n2 passed`;
  const nativeDirectory = join(dirname(fixture.config.databasePath), "runtime", "task-sessions", worker);
  await mkdir(nativeDirectory, { recursive: true });
  await writeFile(join(nativeDirectory, `turn-${turn}.jsonl`), [
    JSON.stringify({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "pnpm test", status: "in_progress" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "pnpm test", aggregated_output: output, exit_code: 0, status: "completed" } }),
  ].join("\n") + "\n");
  const call = async (args: Record<string, unknown>) => {
    const result = await runMcpProcess(server, { ...process.env, ...server.environment }, [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: args } },
    ]);
    const response = result.responses.find(value => typeof value === "object" && value !== null && "id" in value && value.id === 3) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } } | undefined;
    equal(response?.result?.isError, false, result.stderr);
    return response!.result!.structuredContent!;
  };
  const index = await call({ kind: "read_worker_evidence", turnId: turn });
  equal(index.turnId, turn);
  equal(index.sessionId, worker);
  equal((index.tools as Array<{ toolId: string }>)[0]!.toolId, "item_0");
  const tail = await call({ kind: "read_worker_evidence", turnId: turn, toolId: "item_0", maxCharacters: 1_000 });
  match(JSON.stringify(tail), /2 passed/);
  const head = await call({ kind: "read_worker_evidence", turnId: turn, toolId: "item_0", position: "head", maxCharacters: 1_000 });
  notEqual(head.nextCursor, null);
  const next = await call({ kind: "read_worker_evidence", turnId: turn, toolId: "item_0", position: "head", cursor: head.nextCursor, maxCharacters: 1_000 });
  ok(JSON.stringify(next).includes("x"));

  const branch = task.configuration.branch;
  const worktree = join(fixture.project.worktreeRoot, task.id);
  await mkdir(fixture.project.worktreeRoot, { recursive: true });
  const git = async (...args: string[]) => (await execute("git", ["-C", fixture.project.repositoryPath, ...args])).stdout.trim();
  const startingSha = await git("rev-parse", "HEAD");
  await git("worktree", "add", "--quiet", "-b", branch, worktree, startingSha);
  await writeFile(join(worktree, "README.md"), "Committed change\n");
  await execute("git", ["-C", worktree, "add", "README.md"]);
  await execute("git", ["-C", worktree, "commit", "--quiet", "-m", "Prepare reviewed change"]);
  const headSha = (await execute("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
  fixture.database.prepare("UPDATE suplex_task_controls SET worktree_json = ? WHERE task_id = ?")
    .run(JSON.stringify({ path: worktree, branch, baseSha: startingSha, headSha, dirty: false }), task.id);
  await writeFile(join(worktree, "README.md"), "Committed change\nUncommitted note\n");
  const rejected = await runMcpProcess(server, { ...process.env, ...server.environment }, [
    ...initializeAndList,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: { kind: "request_delivery", operation: "complete_local_work", expectedHead: "wrong-head" } } },
  ]);
  ok(JSON.stringify(rejected.responses).includes('"isError":true'));
  const delivered = await call({ kind: "request_delivery", operation: "complete_local_work", expectedHead: headSha });
  equal(delivered.kind, "local_work_completed");
  equal(delivered.headSha, headSha);
  equal((fixture.database.prepare("SELECT status FROM suplex_task_controls WHERE task_id = ?").get(task.id) as { status: string }).status, "delivered");
  console.log("Rust Root MCP reads native Worker evidence with cursors and completes only the live reviewed local head.");
} finally { await fixture.close(); }
