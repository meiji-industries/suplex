import { insertNativeTaskRow } from "./helpers/native-task-row.js";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { RootBridge, RootBridgeFailure, startRootBridgeTransport, type RootBridgeAdapter } from "../src/root-bridge.js";
import type { RootIdentity } from "../src/root-contracts.js";
import { ForgeDatabase } from "../src/database.js";
import { RootController } from "../src/root-controller.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";
import { TaskControlStore } from "../src/root-session-store.js";
import { runCommand } from "../src/command-runner.js";
import { nativeApp } from "./helpers/native-app.js";
import { ArtifactStore } from "../src/artifacts.js";

test("Coordinator image reads enforce task ownership and content integrity and return MCP image content", async () => {
  const value = await nativeApp();
  try {
    const image = { filename: "design.png", mimeType: "image/png" as const, base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") };
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Inspect image", description: "Use the attachment", idempotencyKey: "root-image-proof", startImmediately: true, images: [image] });
    const controller = new RootController(value.tasks.repository.controls, new FakeTaskHarness(), undefined, new ArtifactStore(value.config.artifactRoot));
    const session = controller.prepareRoot(task.id);
    const bridge = new RootBridge({ taskId: task.id, sessionId: session.id, generation: session.generation }, controller);
    const id = task.images[0]!.artifactId;
    await expect(bridge.call({ kind: "read_image", artifactId: id })).resolves.toEqual({ kind: "image", filename: image.filename, mimeType: image.mimeType, data: image.base64 });
    const foreign = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Other task", description: "Other image", idempotencyKey: "foreign-image-proof", startImmediately: true, images: [image] });
    await expect(bridge.call({ kind: "read_image", artifactId: foreign.task.images[0]!.artifactId })).rejects.toThrow();
    const input = new PassThrough();
    const replies: unknown[] = [];
    const transport = startRootBridgeTransport({ bridge, stdin: input, stdout: { write(line) { replies.push(JSON.parse(line)); return true; } } });
    try {
      const call = mcpClient(input, replies);
      await call({ method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proof", version: "1" } } });
      const response = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "read_image", artifactId: id } } });
      expect(response.result).toEqual({ content: [{ type: "text", text: image.filename }, { type: "image", data: image.base64, mimeType: image.mimeType }] });
    } finally { transport.close(); input.destroy(); }
    const artifact = value.tasks.repository.controls.image(task.id, id);
    await writeFile(join(value.config.artifactRoot, artifact.storagePath), "changed");
    await expect(bridge.call({ kind: "read_image", artifactId: id })).rejects.toThrow("changed in storage");
    value.tasks.cancelTask(value.userId, task.id);
    await expect(bridge.call({ kind: "read_image", artifactId: id })).rejects.toThrow();
  } finally { await value.close(); }
});

const run = (command: string, args: string[]) => runCommand({ taskId: null, stepId: null, command, args });

const root: RootIdentity = { taskId: "task_1", sessionId: "session_1", generation: 3 };

test("delegation requires the Coordinator's plan and acceptance criteria before dispatch", async () => {
  const adapter = new ForgeAdapterFake();
  const bridge = new RootBridge(root, adapter);
  for (const request of [
    { kind: "delegate_worker", instruction: "Plan and implement the task" },
    { kind: "delegate_worker", plan: " ", acceptanceCriteria: ["Checks pass"], instruction: "Edit the file" },
    { kind: "delegate_worker", plan: "Change the existing handler", acceptanceCriteria: [], instruction: "Edit the file" },
  ]) await expect(bridge.call(request)).rejects.toMatchObject({ code: "invalid_request" });
  expect(adapter.calls).toEqual([]);
});

class ForgeAdapterFake implements RootBridgeAdapter {
  readonly calls: string[] = [];
  current = true;
  async readImage(): Promise<never> { throw new Error("No image in this fixture"); }

  async assertCurrentRoot(identity: RootIdentity): Promise<void> {
    this.calls.push(`assert:${identity.taskId}:${identity.sessionId}:${identity.generation}`);
    if (!this.current) throw new RootBridgeFailure("root_identity_mismatch", "Coordinator bridge binding no longer matches this task session");
  }

  async observe(identity: RootIdentity): Promise<unknown> {
    this.calls.push(`observe:${identity.taskId}`);
    return { taskId: identity.taskId, observed: true };
  }

  async delegateWorker(identity: RootIdentity, assignment: Parameters<RootBridgeAdapter["delegateWorker"]>[1]): Promise<unknown> {
    this.calls.push(`delegate:${identity.sessionId}:${assignment.instruction}`);
    return { assignmentId: "worker_1" };
  }

  async requestDelivery(_identity: RootIdentity, operation: "inspect_delivery_diff" | "complete_local_work" | "push_branch" | "create_or_adopt_pull_request" | "observe_pull_request" | "observe_checks" | "request_review" | "merge_pull_request", _expectedHead?: string, _review?: unknown, pullRequestTitle?: string): Promise<unknown> {
    this.calls.push(`delivery:${operation}:${pullRequestTitle ?? "none"}`);
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
    await expect.poll(() => responses.length, { timeout: 5000 }).toBeGreaterThan(0);
    const response = responses.shift();
    if (!response || typeof response !== "object") throw new Error("MCP server did not respond");
    return response as Record<string, unknown>;
  };
}

test("Coordinator bridge rejects stale persisted bindings before every operation", async () => {
  const adapter = new ForgeAdapterFake();
  const bridge = new RootBridge(root, adapter);
  await expect(bridge.call({ kind: "observe" })).resolves.toEqual({ taskId: "task_1", observed: true });
  adapter.current = false;
  await expect(bridge.call({ kind: "delegate_worker", plan: "Inspect the scoped diff for the requested implementation", acceptanceCriteria: ["The diff contains only requested changes"], instruction: "Inspect the current diff." })).rejects.toMatchObject({ code: "root_identity_mismatch" });
  expect(adapter.calls).toEqual([
    "assert:task_1:session_1:3",
    "observe:task_1",
    "assert:task_1:session_1:3",
  ]);
});

test("MCP discovery and typed Coordinator calls use the scoped bridge transport", async () => {
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
  const delegated = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "delegate_worker", plan: "Inspect the scoped diff for the requested implementation", acceptanceCriteria: ["The diff contains only requested changes"], instruction: "Inspect the current diff." } } });
  expect(delegated).toMatchObject({ result: { structuredContent: { assignmentId: "worker_1" } } });
  expect(adapter.calls).toContain("delegate:session_1:Inspect the current diff.");
  await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "request_delivery", operation: "create_or_adopt_pull_request", pullRequestTitle: "  Create reviewed delivery flow  " } } });
  expect(adapter.calls).toContain("delivery:create_or_adopt_pull_request:Create reviewed delivery flow");
  reader.close();
});

test("Coordinator bridge rejects invalid pull request titles", async () => {
  const bridge = new RootBridge(root, new ForgeAdapterFake());
  for (const pullRequestTitle of [" ", "\nCreate a pull request", "Create\na pull request", `Create${String.fromCharCode(1)} a pull request`, "a".repeat(121)]) {
    await expect(bridge.call({ kind: "request_delivery", operation: "create_or_adopt_pull_request", pullRequestTitle })).rejects.toMatchObject({ code: "invalid_request" });
  }
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
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', '', ?, ?)").run(repository, directory, stamp, stamp);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
      insertNativeTaskRow(db);
    });
    const store = new TaskControlStore(database);
    const profile = { profileId: "profile", provider: "openai", model: "gpt-5.6-sol", reasoningLevel: "medium" as const, serviceTier: "default" as const };
    store.create({ startImmediately: true, taskId: "task", objective: "Ship it", deliveryTarget: "pull request", deliveryIntent: { repository: "owner/repo", headBranch: "main", baseBranch: "main", baselineSha: "a", pullRequestNumber: null }, rootProfile: profile, workerProfile: profile, worktree: { path: repository, branch: "main", baseSha: "a", headSha: "a", dirty: false } });
    const session = store.claimRoot({ taskId: "task" });
    store.bindHarnessSession({ sessionId: session.id, generation: session.generation, nativeSessionId: "ses_root" });
    store.bindPane({ sessionId: session.id, generation: session.generation, paneId: "root-pane" });
    const controller = new RootController(store, new FakeTaskHarness());
    const stdin = new PassThrough(); const stdout = new PassThrough(); const responses: unknown[] = [];
    stdout.on("data", (chunk: Buffer) => responses.push(JSON.parse(chunk.toString())));
    const reader = startRootBridgeTransport({ bridge: new RootBridge({ taskId: "task", sessionId: session.id, generation: session.generation }, controller), stdin, stdout });
    const call = mcpClient(stdin, responses);
    await call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
    const delegated = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "delegate_worker", plan: "Inspect the scoped diff for the requested implementation", acceptanceCriteria: ["The diff contains only requested changes"], instruction: "Inspect the worktree." } } });
    expect(delegated).toMatchObject({ result: { structuredContent: { worker: { kind: "worker", lifecycle: "live" }, next: expect.stringContaining("End this Coordinator turn now") } } });
    expect(store.currentSession("task", "worker")).toMatchObject({ lifecycle: "live", nativeSessionId: expect.stringMatching(/^ses_/) });
    reader.close();
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});
