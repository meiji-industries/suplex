import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { RootBridge, RootBridgeFailure, startRootBridgeTransport, type RootBridgeAdapter } from "../src/root-bridge.js";
import type { RootIdentity } from "../src/root-contracts.js";
import { ForgeDatabase } from "../src/database.js";
import { RootController } from "../src/root-controller.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";
import { TaskControlStore } from "../src/root-session-store.js";

const run = promisify(execFile);

const root: RootIdentity = { taskId: "task_1", sessionId: "session_1", generation: 3 };

class ForgeAdapterFake implements RootBridgeAdapter {
  readonly calls: string[] = [];
  current = true;

  async assertCurrentRoot(identity: RootIdentity): Promise<void> {
    this.calls.push(`assert:${identity.taskId}:${identity.sessionId}:${identity.generation}`);
    if (!this.current) throw new RootBridgeFailure("root_identity_mismatch", "Root bridge binding no longer matches this task session");
  }

  async observe(identity: RootIdentity): Promise<unknown> {
    this.calls.push(`observe:${identity.taskId}`);
    return { taskId: identity.taskId, observed: true };
  }

  async delegateWorker(identity: RootIdentity, instruction: string): Promise<unknown> {
    this.calls.push(`delegate:${identity.sessionId}:${instruction}`);
    return { assignmentId: "worker_1" };
  }

  async requestDelivery(): Promise<unknown> {
    return { delivered: true };
  }

  async askHuman(): Promise<unknown> {
    return { asked: true };
  }
}

function mcpClient(transport: { write(chunk: string): boolean }, responses: unknown[]): (request: Record<string, unknown>) => Promise<Record<string, unknown>> {
  let id = 0;
  return async (request: Record<string, unknown>) => {
    const requestId = ++id;
    transport.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, ...request })}\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const response = responses.shift();
    if (!response || typeof response !== "object") throw new Error("MCP server did not respond");
    return response as Record<string, unknown>;
  };
}

test("Root bridge rejects stale persisted bindings before every operation", async () => {
  const adapter = new ForgeAdapterFake();
  const bridge = new RootBridge(root, adapter);
  await expect(bridge.call({ kind: "observe" })).resolves.toEqual({ taskId: "task_1", observed: true });
  adapter.current = false;
  await expect(bridge.call({ kind: "delegate_worker", instruction: "Inspect the current diff." })).rejects.toMatchObject({ code: "root_identity_mismatch" });
  expect(adapter.calls).toEqual([
    "assert:task_1:session_1:3",
    "observe:task_1",
    "assert:task_1:session_1:3",
  ]);
});

test("MCP discovery and typed Root calls use the scoped bridge transport", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const responses: unknown[] = [];
  stdout.on("data", (chunk: Buffer) => responses.push(JSON.parse(chunk.toString())));
  const adapter = new ForgeAdapterFake();
  const reader = startRootBridgeTransport({ bridge: new RootBridge(root, adapter), stdin, stdout });
  const call = mcpClient(stdin, responses);

  const initialized = await call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
  expect(initialized).toMatchObject({ result: { capabilities: { tools: {} }, serverInfo: { name: "forge-root-bridge" } } });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const listed = await call({ method: "tools/list", params: {} });
  expect(listed).toMatchObject({ result: { tools: [{ inputSchema: { type: "object" } }] } });
  expect(listed).toMatchObject({ result: { tools: [expect.objectContaining({ name: "forge_root" })] } });
  const observed = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "observe", _meta: { progressToken: "mcp-client" } }, _meta: { progressToken: "request" } } });
  expect(observed).toMatchObject({ result: { structuredContent: { taskId: "task_1", observed: true } } });
  const delegated = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "delegate_worker", instruction: "Inspect the current diff." } } });
  expect(delegated).toMatchObject({ result: { structuredContent: { assignmentId: "worker_1" } } });
  expect(adapter.calls).toContain("delegate:session_1:Inspect the current diff.");
  reader.close();
});

test("stdio bridge invokes the production controller against a durable task control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-root-bridge-"));
  const repository = join(directory, "repo");
  const database = new ForgeDatabase(join(directory, "forge.sqlite"));
  const stamp = new Date().toISOString();
  await run("git", ["init", repository]);
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(repository, directory, stamp, stamp);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), stamp, stamp);
    });
    const store = new TaskControlStore(database);
    const profile = { profileId: "profile", provider: "codex" as const, model: "gpt-5.6-sol", reasoningLevel: "medium" as const, serviceTier: "default" as const };
    store.create({ taskId: "task", objective: "Ship it", deliveryTarget: "pull request", deliveryIntent: { repository: "owner/repo", headBranch: "main", baseBranch: "main", baselineSha: "a", pullRequestNumber: null }, rootProfile: profile, workerProfile: profile, worktree: { path: repository, branch: "main", baseSha: "a", headSha: "a", dirty: false } });
    const session = store.claimRoot({ taskId: "task" });
    store.bindHarnessSession({ sessionId: session.id, generation: session.generation, nativeSessionId: "ses_root" });
    store.bindPane({ sessionId: session.id, generation: session.generation, paneId: "root-pane" });
    const controller = new RootController(store, new FakeTaskHarness());
    const stdin = new PassThrough(); const stdout = new PassThrough(); const responses: unknown[] = [];
    stdout.on("data", (chunk: Buffer) => responses.push(JSON.parse(chunk.toString())));
    const reader = startRootBridgeTransport({ bridge: new RootBridge({ taskId: "task", sessionId: session.id, generation: session.generation }, controller), stdin, stdout });
    const call = mcpClient(stdin, responses);
    await call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
    const delegated = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "delegate_worker", instruction: "Inspect the worktree." } } });
    expect(delegated).toMatchObject({ result: { structuredContent: { kind: "worker", lifecycle: "live" } } });
    expect(store.currentSession("task", "worker")).toMatchObject({ lifecycle: "live", nativeSessionId: expect.stringMatching(/^ses_/) });
    reader.close();
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});
