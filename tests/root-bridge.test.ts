import { insertNativeTaskRow } from "./helpers/native-task-row.js";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { RootBridge, RootBridgeFailure, startRootBridgeTransport, type RootBridgeAdapter } from "../src/coordination/root-bridge.js";
import type { RootIdentity } from "../src/coordination/root-contracts.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { RootController } from "../src/coordination/root-controller.js";
import { FakeTaskHarness } from "./helpers/fake-task-harness.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { runCommand } from "../src/platform/command-runner.js";
import { nativeApp } from "./helpers/native-app.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { TaskUsageSchema } from "../src/tasks/usage.js";
import { writeRootBridgeBinding } from "../src/runtimes/task-harness.js";
import { initializeAndList, runMcpProcess } from "./helpers/mcp-process.js";

test("the Coordinator bridge process authenticates before MCP initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-root-bridge-auth-"));
  const database = new ForgeDatabase(join(directory, "forge.sqlite"));
  database.close();
  try {
    const server = await writeRootBridgeBinding({ runtimeDirectory: join(directory, "runtime"), identity: { taskId: "task", sessionId: "root", generation: 1 }, databasePath: join(directory, "forge.sqlite"), artifactRoot: join(directory, "artifacts") });
    const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "FORGE_ROOT_TOKEN" && value !== undefined));
    for (const token of [undefined, "00000000-0000-4000-8000-000000000000"]) {
      const attempt = await runMcpProcess(server, { ...cleanEnvironment, FORGE_ROOT_BINDING: server.environment.FORGE_ROOT_BINDING!, ...(token ? { FORGE_ROOT_TOKEN: token } : {}) }, initializeAndList);
      expect(attempt.responses).toEqual([]);
      expect(attempt.stderr).toContain("authentication failed");
    }
    const accepted = await runMcpProcess(server, { ...cleanEnvironment, ...server.environment }, initializeAndList);
    expect(accepted.responses).toMatchObject([{ result: { serverInfo: { name: "forge-root-bridge" } } }, { result: { tools: [{ name: "forge_root" }] } }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
  pullRequestBody: string | undefined;
  current = true;
  async readImage(): Promise<never> { throw new Error("No image in this fixture"); }

  async claimToolOwner(): Promise<string | null> { return "token"; }
  async releaseToolOwner(): Promise<void> {}

  async assertCurrentRoot(identity: RootIdentity): Promise<void> {
    this.calls.push(`assert:${identity.taskId}:${identity.sessionId}:${identity.generation}`);
    if (!this.current) throw new RootBridgeFailure("root_identity_mismatch", "Coordinator bridge binding no longer matches this task session");
  }

  async observe(identity: RootIdentity): Promise<unknown> {
    this.calls.push(`observe:${identity.taskId}`);
    return { taskId: identity.taskId, observed: true };
  }

  async readWorkerEvidence(identity: RootIdentity, request: Parameters<RootBridgeAdapter["readWorkerEvidence"]>[1]): Promise<unknown> {
    this.calls.push(`evidence:${identity.taskId}:${request.turnId}:${request.toolId ?? "index"}:${request.field ?? "default"}:${request.position ?? "default"}:${request.cursor ?? "start"}:${request.maxCharacters ?? "default"}`);
    return { turnId: request.turnId, kind: "index", tools: [], nextCursor: null };
  }

  async replaceWorker(identity: RootIdentity, request: Parameters<RootBridgeAdapter["replaceWorker"]>[1]): Promise<unknown> { this.calls.push(`replace:${identity.taskId}:${request.sessionId}`); return { replaced: true }; }

  async delegateWorker(identity: RootIdentity, assignment: Parameters<RootBridgeAdapter["delegateWorker"]>[1]): Promise<unknown> {
    this.calls.push(`delegate:${identity.sessionId}:${assignment.instruction}`);
    return { assignmentId: "worker_1" };
  }

  async delegateAdvisor(identity: RootIdentity, request: Parameters<RootBridgeAdapter["delegateAdvisor"]>[1]): Promise<unknown> {
    this.calls.push(`advisor:${identity.sessionId}:${request.role}`);
    return { advisorId: "advisor_1" };
  }

  async delegatePlanners(identity: RootIdentity): Promise<unknown> {
    this.calls.push(`planners:${identity.sessionId}`);
    return { plannerPairId: "pair_1" };
  }

  async requestDelivery(_identity: RootIdentity, operation: "inspect_delivery_diff" | "complete_local_work" | "push_branch" | "create_or_adopt_pull_request" | "observe_pull_request" | "observe_checks" | "request_review" | "merge_pull_request", _expectedHead?: string, _review?: unknown, pullRequestTitle?: string, pullRequestBody?: string): Promise<unknown> {
    this.pullRequestBody = pullRequestBody;
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
  const bridge = new RootBridge(root, adapter);
  const reader = startRootBridgeTransport({ bridge, stdin, stdout });
  const call = mcpClient(stdin, responses);

  const initialized = await call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
  expect(initialized).toMatchObject({ result: { capabilities: { tools: {} }, serverInfo: { name: "forge-root-bridge" } } });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const listed = await call({ method: "tools/list", params: {} });
  expect(listed).toMatchObject({ result: { tools: [{ inputSchema: { type: "object" } }] } });
  expect(listed).toMatchObject({ result: { tools: [expect.objectContaining({ name: "forge_root" })] } });
  const inputSchema = (listed as { result: { tools: Array<{ inputSchema: Record<string, unknown> }> } }).result.tools[0]!.inputSchema;
  expect(["oneOf", "anyOf", "allOf"].filter(key => key in inputSchema)).toEqual([]);
  expect(inputSchema.properties).not.toHaveProperty("workerProfileId");
  expect(inputSchema).toMatchObject({ required: ["kind"], properties: { kind: { enum: ["observe", "replace_worker", "read_image", "read_worker_evidence", "delegate_worker", "delegate_advisor", "delegate_planners", "request_delivery", "ask_human"], description: expect.stringContaining("delegate_worker: required acceptanceCriteria, instruction") }, turnId: expect.anything(), toolId: expect.anything(), field: { description: expect.stringContaining("Defaults to output") }, position: { description: expect.stringContaining("Defaults to tail") }, cursor: expect.anything(), maxCharacters: expect.anything(), plan: expect.anything(), role: expect.anything(), operation: expect.anything(), question: expect.anything() } });
  expect((inputSchema.properties as Record<string, { description?: string }>).kind?.description).toContain("plan is also required when mode is planned or omitted");
  const observed = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "observe", _meta: { progressToken: "mcp-client" } }, _meta: { progressToken: "request" } } });
  expect(observed).toMatchObject({ result: { structuredContent: { taskId: "task_1", observed: true } } });
  await expect(bridge.call({ kind: "read_worker_evidence", turnId: "turn_1", maxCharacters: 4096 })).resolves.toMatchObject({ turnId: "turn_1", kind: "index", nextCursor: null });
  expect(adapter.calls).toContain("evidence:task_1:turn_1:index:default:default:start:4096");
  const delegated = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "delegate_worker", plan: "Inspect the scoped diff for the requested implementation", acceptanceCriteria: ["The diff contains only requested changes"], instruction: "Inspect the current diff." } } });
  expect(delegated).toMatchObject({ result: { structuredContent: { assignmentId: "worker_1" } } });
  expect(adapter.calls).toContain("delegate:session_1:Inspect the current diff.");
  await expect(bridge.call({ kind: "delegate_planners" })).resolves.toEqual({ plannerPairId: "pair_1" });
  expect(adapter.calls).toContain("planners:session_1");
  const pullRequestBody = "## Summary\n\n- Add the reviewed delivery flow.\n\n## Why\n\nIt records the reviewed result.\n\n## Validation\n\n- pnpm test (passed)\n\n## Review notes\n\nReview the delivery body.";
  await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "request_delivery", operation: "create_or_adopt_pull_request", pullRequestTitle: "  Create reviewed delivery flow  ", pullRequestBody } } });
  expect(adapter.calls).toContain("delivery:create_or_adopt_pull_request:Create reviewed delivery flow");
  expect(adapter.pullRequestBody).toBe(pullRequestBody);
  reader.close();
});

test("Coordinator bridge rejects invalid evidence query combinations", async () => {
  const bridge = new RootBridge(root, new ForgeAdapterFake());
  await expect(bridge.call({ kind: "read_worker_evidence", turnId: "turn_1", field: "input" })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(bridge.call({ kind: "read_worker_evidence", turnId: "turn_1", toolId: "tool_1", cursor: "field:10" })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(bridge.call({ kind: "read_worker_evidence", turnId: "turn_1", toolId: "tool_1", position: "head", cursor: "index:1" })).rejects.toMatchObject({ code: "invalid_request" });
});

test("Coordinator bridge rejects invalid pull request titles", async () => {
  const bridge = new RootBridge(root, new ForgeAdapterFake());
  for (const pullRequestTitle of [" ", "\nCreate a pull request", "Create\na pull request", `Create${String.fromCharCode(1)} a pull request`, "a".repeat(121)]) {
    await expect(bridge.call({ kind: "request_delivery", operation: "create_or_adopt_pull_request", pullRequestTitle })).rejects.toMatchObject({ code: "invalid_request" });
  }
});

test("Coordinator bridge rejects malformed pull request descriptions", async () => {
  const bridge = new RootBridge(root, new ForgeAdapterFake());
  await expect(bridge.call({ kind: "request_delivery", operation: "create_or_adopt_pull_request", pullRequestBody: "## Summary\n\n- Change\n\n## Validation\n\n- pnpm test (passed)\n\n## Review notes\n\nReview it." })).rejects.toMatchObject({ code: "invalid_request" });
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
    const harness = new FakeTaskHarness();
    const nativeUsage = TaskUsageSchema.parse({ sessionId: "ses_root", messageId: "native-usage", turnId: "native-turn", role: "root", provider: "openai", model: "gpt-5.6-sol", startedAt: 1, completedAt: 2, failed: false, summary: false, steps: 1, cost: 0, subsidized: false, tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message" });
    const timeline = vi.fn(async () => ({ usage: [nativeUsage], liveMessageId: null }));
    const controller = new RootController(store, harness, undefined, undefined, undefined, () => ({
      turnEvidence: async () => ({ tools: [], limitation: null }),
      timeline,
    }));
    const pricingFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ openai: { id: "openai", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol", cost: { input: 1, output: 1 } } } } }), { status: 200 }));
    try {
      await controller.recover("task");
      harness.finish(harness.dispatched[0]!.messageID);
      await controller.recover("task");
      await controller.recover("task");
      expect(pricingFetch).toHaveBeenCalledTimes(1);
      expect(timeline).toHaveBeenCalledTimes(1);
      expect(store.taskSpend("task").costUsd).toBe(1);
    } finally { pricingFetch.mockRestore(); }
    const stdin = new PassThrough(); const stdout = new PassThrough(); const responses: unknown[] = [];
    stdout.on("data", (chunk: Buffer) => responses.push(JSON.parse(chunk.toString())));
    const reader = startRootBridgeTransport({ bridge: new RootBridge({ taskId: "task", sessionId: session.id, generation: session.generation }, controller), stdin, stdout });
    const call = mcpClient(stdin, responses);
    await call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
    const delegated = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "delegate_worker", plan: "Inspect the scoped diff for the requested implementation", acceptanceCriteria: ["The diff contains only requested changes"], instruction: "Inspect the worktree." } } });
    expect(delegated).toMatchObject({ result: { structuredContent: { worker: { kind: "worker", lifecycle: "reserved", nativeSessionId: null } } } });
    expect(store.currentSession("task", "worker")).toMatchObject({ lifecycle: "reserved", nativeSessionId: null });
    reader.close();
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("exposes Worker replacement through the Coordinator tool", async () => {
  const adapter = new ForgeAdapterFake();
  const bridge = new RootBridge(root, adapter);
  await expect(bridge.call({ kind: "replace_worker", sessionId: "worker_1", reason: "Repeated partial returns", handoff: "Finish the behavior" })).resolves.toEqual({ replaced: true });
  expect(adapter.calls).toContain("replace:task_1:worker_1");
});

test("Coordinator bridge rejects a Worker profile selection for replace_worker", async () => {
  const adapter = new ForgeAdapterFake();
  const bridge = new RootBridge(root, adapter);
  await expect(bridge.call({ kind: "replace_worker", sessionId: "worker_1", reason: "Repeated partial returns", workerProfileId: "alternate" })).rejects.toMatchObject({ code: "invalid_request" });
  expect(adapter.calls).toEqual([]);
});
