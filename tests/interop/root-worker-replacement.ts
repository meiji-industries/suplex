// Run with a tested Rust binary in SUPLEX_RUST_BIN.
import { createHash, randomUUID } from "node:crypto";
import { deepStrictEqual, equal, match, notEqual } from "node:assert/strict";
import { nativeFixture } from "../helpers/native-browser.js";
import { nativeRootBridge } from "../helpers/native-root-bridge.js";
import { initializeAndList, runMcpProcess } from "../helpers/mcp-process.js";

const fixture = await nativeFixture();
try {
  const task = await fixture.createTask({ title: "Replace an ineffective Worker", idempotencyKey: "rust-replacement", startImmediately: false, deliveryTarget: "local_worktree" });
  const { server } = await nativeRootBridge(fixture, task.id);
  const oldWorker = `worker_${randomUUID()}`;
  const now = new Date().toISOString();
  const profile = fixture.database.prepare("SELECT worker_profile_json FROM suplex_task_controls WHERE task_id = ?").get(task.id) as { worker_profile_json: string };
  fixture.database.prepare("UPDATE suplex_task_controls SET worker_session_id = ? WHERE task_id = ?").run(oldWorker, task.id);
  fixture.database.prepare("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,profile_json,delegate_slot,created_at,updated_at) VALUES (?,?,'worker',1,1,'live',?,'delegate',?,?)")
    .run(oldWorker, task.id, profile.worker_profile_json, now, now);
  fixture.database.prepare("INSERT INTO suplex_task_turns (id,task_id,session_id,generation,prompt_hash,prompt_text,status,terminal_observation,created_at,updated_at) VALUES (?,?,?,1,'original-hash','Worker assignment: build','completed',?,?,?)")
    .run(`msg_${randomUUID()}`, task.id, oldWorker, JSON.stringify({ state: "completed", text: "Partial change" }), now, now);
  const call = async (args: Record<string, unknown>) => {
    const result = await runMcpProcess(server, { ...process.env, ...server.environment }, [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: args } },
    ]);
    const response = result.responses.find(value => typeof value === "object" && value !== null && "id" in value && value.id === 3) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } } | undefined;
    equal(response?.result?.isError, false, result.stderr);
    return response!.result!.structuredContent!;
  };
  const request = { kind: "replace_worker", sessionId: oldWorker, reason: "  Change strategy  ", handoff: "  Finish checks  " };
  const replaced = await call(request);
  const worker = replaced.worker as { id: string; nativeSessionId: string | null; profile: unknown };
  notEqual(worker.id, oldWorker);
  equal(worker.nativeSessionId, null);
  deepStrictEqual(worker.profile, JSON.parse(profile.worker_profile_json));
  equal((replaced.acceptedAssignment as { kind: string }).kind, "saved_prompt");
  match(String(replaced.next), /stop the outgoing execution/);
  const saved = fixture.database.prepare("SELECT prompt_text,prompt_hash FROM suplex_task_turns WHERE session_id = ?").get(worker.id) as { prompt_text: string; prompt_hash: string };
  match(saved.prompt_text, /Reason for replacement: Change strategy/);
  match(saved.prompt_text, /Additional direction:\nFinish checks/);
  match(saved.prompt_text, /Partial change/);
  equal(saved.prompt_hash, createHash("sha256").update(saved.prompt_text).digest("hex"));
  const repeated = await call(request);
  equal((repeated.worker as { id: string }).id, worker.id);
  const stopped = fixture.database.prepare("SELECT stop_requested_at, stopped_at FROM suplex_task_sessions WHERE id = ?").get(oldWorker) as { stop_requested_at: string | null; stopped_at: string | null };
  notEqual(stopped.stop_requested_at, null);
  equal(stopped.stopped_at, null);
  fixture.database.prepare("UPDATE suplex_task_sessions SET stopped_at = ? WHERE id = ?").run(new Date().toISOString(), oldWorker);
  const current = fixture.database.prepare("SELECT id,replaces_session_id FROM suplex_task_sessions WHERE task_id = ? AND kind = 'worker' AND is_current = 1").get(task.id) as { id: string; replaces_session_id: string };
  equal(current.id, worker.id);
  equal(current.replaces_session_id, oldWorker);
  console.log("Rust Root MCP Worker replacement preserves profile, handoff, prompt hash, idempotency, and retired-session fencing.");
} finally { await fixture.close(); }
