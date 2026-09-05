import { PassThrough } from "node:stream";

import { expect, test } from "vitest";

import { RootBridge, RootBridgeFailure, startRootBridgeTransport, type RootBridgeAdapter } from "../src/root-bridge.js";
import type { RootIdentity } from "../src/root-contracts.js";

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
  expect(listed).toMatchObject({ result: { tools: [expect.objectContaining({ name: "forge_root" })] } });
  const observed = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "observe", _meta: { progressToken: "mcp-client" } }, _meta: { progressToken: "request" } } });
  expect(observed).toMatchObject({ result: { structuredContent: { taskId: "task_1", observed: true } } });
  const delegated = await call({ method: "tools/call", params: { name: "forge_root", arguments: { kind: "delegate_worker", instruction: "Inspect the current diff." } } });
  expect(delegated).toMatchObject({ result: { structuredContent: { assignmentId: "worker_1" } } });
  expect(adapter.calls).toContain("delegate:session_1:Inspect the current diff.");
  reader.close();
});
