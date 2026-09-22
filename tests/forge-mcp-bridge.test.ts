import { PassThrough } from "node:stream";

import { expect, test } from "vitest";

import { FORGE_MCP_TOOLS, ForgeMcpBridgeFailure, ForgeMcpBridge, readForgeMcpBridgeSettings, startForgeMcpTransport } from "../src/integrations/forge/mcp-bridge.js";
import { runCommand } from "../src/platform/command-runner.js";
import { nativeApp } from "./helpers/native-app.js";

type JsonRecord = Record<string, unknown>;

function mcpClient(stdin: { write(chunk: string): boolean }, responses: unknown[]): (request: JsonRecord) => Promise<JsonRecord> {
  let id = 0;
  return async (request) => {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, ...request })}\n`);
    await expect.poll(() => responses.length, { timeout: 5000 }).toBeGreaterThan(0);
    return responses.shift() as JsonRecord;
  };
}

async function pairedBridgeFixture() {
  const fixture = await nativeApp();
  const issued = fixture.externalAgent.create(fixture.userId, { name: "ForgeMcp Bot", companyId: fixture.company.id, projectIds: [fixture.project.id] });
  const credential = fixture.externalAgent.exchange({ pairingCode: issued.pairingCode, profileId: "profile-bot" }).credential;
  const baseUrl = await fixture.app.listen({ port: 0, host: "127.0.0.1" });
  return { ...fixture, credential, baseUrl };
}

function driveBridge(settings: { baseUrl: string; credential: string }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const responses: unknown[] = [];
  stdout.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) responses.push(JSON.parse(line)); });
  const reader = startForgeMcpTransport({ bridge: new ForgeMcpBridge(settings), stdin, stdout });
  return { call: mcpClient(stdin, responses), close: () => { reader.close(); stdin.destroy(); } };
}

const structured = (response: JsonRecord): JsonRecord => (response.result as { structuredContent: JsonRecord }).structuredContent;

test("tool input schemas stay derived from the served ForgeMcp runtime contract", async () => {
  const fixture = await pairedBridgeFixture();
  try {
    const document = (await fixture.app.inject({ method: "GET", url: "/api/agent/openapi.json", headers: { Authorization: `Bearer ${fixture.credential}` } })).json() as {
      paths: Record<string, Partial<Record<"post" | "put", { requestBody: { content: { "application/json": { schema: { required?: string[]; properties: Record<string, unknown> } } } } }>>>;
    };
    const requestSchema = (path: string, method: "post" | "put" = "post") => document.paths[path]![method]!.requestBody.content["application/json"].schema;
    const tool = (name: string) => FORGE_MCP_TOOLS.find(candidate => candidate.name === name)!.inputSchema as { required?: string[]; properties: Record<string, { enum?: string[] }> };

    const create = requestSchema("/api/agent/tasks");
    expect(Object.keys(tool("forge_create_task").properties).sort()).toEqual(Object.keys(create.properties).sort());
    expect([...(tool("forge_create_task").required ?? [])].sort()).toEqual([...(create.required ?? [])].sort());
    expect(tool("forge_create_task").required).toContain("idempotencyKey");

    const command = requestSchema("/api/agent/tasks/{taskId}/commands");
    expect(Object.keys(tool("forge_command_task").properties).sort()).toEqual([...Object.keys(command.properties), "taskId"].sort());
    expect([...(tool("forge_command_task").required ?? [])].sort()).toEqual([...(command.required ?? []), "taskId"].sort());
    expect(tool("forge_command_task").required).toEqual(expect.arrayContaining(["revision", "idempotencyKey"]));
    expect(tool("forge_command_task").properties.command?.enum).toEqual((command.properties.command as { enum: string[] }).enum);

    const dependencies = requestSchema("/api/agent/tasks/{taskId}/dependencies", "put");
    expect(Object.keys(tool("forge_set_task_dependencies").properties).sort()).toEqual([...Object.keys(dependencies.properties), "taskId"].sort());
    expect([...(tool("forge_set_task_dependencies").required ?? [])].sort()).toEqual([...(dependencies.required ?? []), "taskId"].sort());
    expect(tool("forge_create_task").properties).toHaveProperty("dependsOn");

    expect(FORGE_MCP_TOOLS.map(entry => entry.name)).toEqual(["forge_whoami", "forge_capabilities", "forge_list_workflows", "forge_list_templates", "forge_list_tasks", "forge_get_task", "forge_get_task_delivery", "forge_create_task", "forge_set_task_dependencies", "forge_command_task"]);
    for (const entry of FORGE_MCP_TOOLS) expect(JSON.stringify(entry.inputSchema)).not.toContain("credential");
  } finally { await fixture.close(); }
});

test("the stdio bridge drives the paired ForgeMcp runtime API end to end", async () => {
  const fixture = await pairedBridgeFixture();
  const session = driveBridge({ baseUrl: fixture.baseUrl, credential: fixture.credential });
  try {
    const initialized = await session.call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agent", version: "1" } } });
    expect(initialized).toMatchObject({ result: { capabilities: { tools: {} }, serverInfo: { name: "forge-agent-bridge" } } });

    const listed = await session.call({ method: "tools/list", params: {} });
    expect((listed.result as { tools: Array<{ name: string; description: string }> }).tools.map(entry => entry.name)).toEqual(FORGE_MCP_TOOLS.map(entry => entry.name));
    const commandTool = (listed.result as { tools: Array<{ name: string; description: string }> }).tools.find(entry => entry.name === "forge_command_task")!;
    expect(commandTool.description).toContain("not reversible");
    expect(commandTool.description).toContain("revision_stale");
    expect(commandTool.description).toContain("MCP exposes task lifecycle commands only");

    const whoami = await session.call({ method: "tools/call", params: { name: "forge_whoami", arguments: {} } });
    expect(structured(whoami)).toMatchObject({ status: 200, body: { agent: { name: "ForgeMcp Bot" }, projects: [{ id: fixture.project.id }] } });

    const workflows = await session.call({ method: "tools/call", params: { name: "forge_list_workflows", arguments: { projectId: fixture.project.id } } });
    expect(structured(workflows)).toMatchObject({ status: 200, body: { workflows: expect.arrayContaining([expect.objectContaining({ permittedForAgentTaskCreation: expect.any(Boolean) })]) } });
    const templates = await session.call({ method: "tools/call", params: { name: "forge_list_templates", arguments: { projectId: fixture.project.id } } });
    expect(structured(templates)).toEqual({ status: 200, body: { templates: [] } });

    const created = await session.call({ method: "tools/call", params: { name: "forge_create_task", arguments: { projectId: fixture.project.id, title: "Bridge task", description: "Created through the MCP bridge", idempotencyKey: "bridge-key-1" } } });
    expect(structured(created)).toMatchObject({ status: 201, body: { title: "Bridge task", status: "backlog" } });
    const task = (structured(created).body as { id: string; revision: string });

    const replayed = await session.call({ method: "tools/call", params: { name: "forge_create_task", arguments: { projectId: fixture.project.id, title: "Bridge task", description: "Created through the MCP bridge", idempotencyKey: "bridge-key-1" } } });
    expect(structured(replayed)).toMatchObject({ status: 200, body: { id: task.id } });

    const unchanged = await session.call({ method: "tools/call", params: { name: "forge_get_task", arguments: { taskId: task.id, knownRevision: task.revision } } });
    expect(structured(unchanged)).toEqual({ unchanged: true, revision: task.revision });
    const read = await session.call({ method: "tools/call", params: { name: "forge_get_task", arguments: { taskId: task.id } } });
    expect(structured(read)).toMatchObject({ status: 200, body: { id: task.id, revision: task.revision } });

    const delivery = await session.call({ method: "tools/call", params: { name: "forge_get_task_delivery", arguments: { taskId: task.id } } });
    expect(structured(delivery)).toEqual({ status: 200, body: { taskId: task.id, taskStatus: "backlog", revision: task.revision, queue: { startIntent: "manual", state: "backlog", waitingOn: [] }, blocker: null, delivery: null } });

    const list = await session.call({ method: "tools/call", params: { name: "forge_list_tasks", arguments: { projectId: fixture.project.id, limit: 10 } } });
    expect(structured(list)).toMatchObject({ status: 200, body: { tasks: [{ id: task.id }], nextCursor: null } });
    const listedTask = (structured(list).body as { tasks: Array<Record<string, unknown>> }).tasks.find(candidate => candidate.id === task.id)!;
    expect(Object.keys(listedTask).sort()).toEqual(["id", "title", "status", "archived", "queue", "workflow", "dependsOn", "updatedAt"].sort());
    const fullList = await session.call({ method: "tools/call", params: { name: "forge_list_tasks", arguments: { projectId: fixture.project.id, limit: 10, view: "full" } } });
    expect((structured(fullList).body as { tasks: Array<Record<string, unknown>> }).tasks.find(candidate => candidate.id === task.id)).toHaveProperty("integration");

    const illegal = await session.call({ method: "tools/call", params: { name: "forge_command_task", arguments: { taskId: task.id, command: "unarchive_task", revision: task.revision, idempotencyKey: "bridge-command-1" } } });
    expect(illegal.result).toMatchObject({ isError: true });
    expect(structured(illegal)).toMatchObject({ status: 409, body: { code: "illegal_command" } });

    const stale = await session.call({ method: "tools/call", params: { name: "forge_command_task", arguments: { taskId: task.id, command: "cancel_task", revision: "not-the-current-revision", idempotencyKey: "bridge-command-2" } } });
    expect(structured(stale)).toMatchObject({ status: 412, body: { code: "revision_stale" } });

    // Prerequisites set on create or through the dependency tool read back identically over MCP, the agent API, and the board.
    const second = structured(await session.call({ method: "tools/call", params: { name: "forge_create_task", arguments: { projectId: fixture.project.id, title: "Bridge second", idempotencyKey: "bridge-key-2" } } })).body as { id: string };
    const dependent = await session.call({ method: "tools/call", params: { name: "forge_create_task", arguments: { projectId: fixture.project.id, title: "Bridge dependent", idempotencyKey: "bridge-key-3", dependsOn: [task.id] } } });
    const dependentId = (structured(dependent).body as { id: string }).id;
    expect(structured(dependent)).toMatchObject({ status: 201, body: { dependsOn: [task.id], blockedBy: [{ id: task.id, title: "Bridge task", status: "backlog" }] } });
    const expected = [{ id: task.id, title: "Bridge task", status: "backlog" }, { id: second.id, title: "Bridge second", status: "backlog" }].sort((left, right) => left.id.localeCompare(right.id));
    const set = await session.call({ method: "tools/call", params: { name: "forge_set_task_dependencies", arguments: { taskId: dependentId, dependsOn: [second.id, task.id] } } });
    expect(structured(set)).toMatchObject({ status: 200, body: { dependsOn: expected.map(entry => entry.id), blockedBy: expected } });
    const dependentRead = await session.call({ method: "tools/call", params: { name: "forge_get_task", arguments: { taskId: dependentId } } });
    expect(structured(dependentRead)).toMatchObject({ status: 200, body: { dependsOn: expected.map(entry => entry.id), blockedBy: expected } });
    const http = await fixture.app.inject({ method: "GET", url: `/api/agent/tasks/${dependentId}`, headers: { Authorization: `Bearer ${fixture.credential}` } });
    expect(http.json()).toMatchObject({ dependsOn: expected.map(entry => entry.id), blockedBy: expected });
    const cycle = await session.call({ method: "tools/call", params: { name: "forge_set_task_dependencies", arguments: { taskId: task.id, dependsOn: [dependentId] } } });
    expect(cycle.result).toMatchObject({ isError: true });
    expect(structured(cycle)).toMatchObject({ status: 422, body: { error: "The dependency creates a cycle", code: "task_unavailable" } });
  } finally { session.close(); await fixture.close(); }
});

test("credential and grants stay authoritative when client profile metadata is missing", async () => {
  const fixture = await pairedBridgeFixture();
  const before = fixture.externalAgent.authenticate(fixture.credential);
  fixture.database.authTransaction((db) => db.prepare("UPDATE forge_external_agents SET client_profile_id = NULL WHERE id = ?").run(before.agentId));
  const after = fixture.externalAgent.authenticate(fixture.credential);
  expect(after).toMatchObject({ agentId: before.agentId, companyId: before.companyId, projectIds: before.projectIds, profileId: null });
  const session = driveBridge({ baseUrl: fixture.baseUrl, credential: fixture.credential });
  try {
    await session.call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "metadata-test", version: "1" } } });
    const response = await fixture.app.inject({ method: "GET", url: "/api/agent/me", headers: { Authorization: `Bearer ${fixture.credential}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ agent: { name: "ForgeMcp Bot", profileId: null }, projects: [{ id: fixture.project.id }] });
    expect(response.json().projects.map((project: { id: string }) => project.id)).toEqual(before.projectIds);

    const whoami = await session.call({ method: "tools/call", params: { name: "forge_whoami", arguments: {} } });
    expect(structured(whoami)).toMatchObject({ status: 200, body: { agent: { name: "ForgeMcp Bot", profileId: null }, projects: [{ id: fixture.project.id }] } });
    expect((structured(whoami).body as { projects: Array<{ id: string }> }).projects.map((project) => project.id)).toEqual(before.projectIds);
  } finally {
    session.close();
    await fixture.close();
  }
});

test("the shipped Python client can use the legacy Hermes route", async () => {
  const fixture = await pairedBridgeFixture();
  const program = [
    "import importlib.util, json",
    "spec = importlib.util.spec_from_file_location('forge_client', 'skills/forge/forge_client.py')",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "client = module.ForgeClient()",
    "body = client.call('GET', '/api/hermes/me')",
    "print(json.dumps({'id': body['agent']['id'], 'profileId': body['agent']['profileId']}))",
  ].join("\n");
  try {
    const result = await runCommand({
      taskId: null,
      stepId: null,
      command: "python3",
      args: ["-c", program],
      cwd: process.cwd(),
      env: { ...process.env, FORGE_BASE_URL: fixture.baseUrl, FORGE_AGENT_CREDENTIAL: fixture.credential },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: fixture.externalAgent.authenticate(fixture.credential).agentId, profileId: "profile-bot" });
    expect(result.stdout).not.toContain(fixture.credential);
  } finally {
    await fixture.close();
  }
});

test("an invalid credential fails with a safe code and never reaches tool output", async () => {
  const fixture = await pairedBridgeFixture();
  const credential = "forge-not-a-real-credential-value";
  const session = driveBridge({ baseUrl: fixture.baseUrl, credential });
  try {
    await session.call({ method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agent", version: "1" } } });
    const whoami = await session.call({ method: "tools/call", params: { name: "forge_whoami", arguments: {} } });
    expect(whoami.result).toMatchObject({ isError: true });
    expect(structured(whoami)).toMatchObject({ status: 401, body: { code: "credential_invalid" } });
    expect(JSON.stringify(whoami)).not.toContain(credential);
    expect(new ForgeMcpBridge({ baseUrl: fixture.baseUrl, credential }).redact(`token ${credential} leaked`)).toBe("token [redacted credential] leaked");
  } finally { session.close(); await fixture.close(); }
});

test("missing bridge configuration reports the variable to set without printing any value", () => {
  expect(() => readForgeMcpBridgeSettings({})).toThrow(/Set FORGE_BASE_URL in the MCP server environment/);
  expect(() => readForgeMcpBridgeSettings({ FORGE_BASE_URL: "http://127.0.0.1:4111" })).toThrow(/Set FORGE_AGENT_CREDENTIAL in the MCP server environment/);
  try {
    readForgeMcpBridgeSettings({ FORGE_BASE_URL: "http://127.0.0.1:4111", FORGE_AGENT_CREDENTIAL: "  " });
    throw new Error("Bridge settings accepted a blank credential");
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeMcpBridgeFailure);
    expect((error as Error).message).not.toContain("http://127.0.0.1:4111");
  }
  expect(readForgeMcpBridgeSettings({ FORGE_BASE_URL: "http://127.0.0.1:4111/", FORGE_AGENT_CREDENTIAL: " secret " })).toEqual({ baseUrl: "http://127.0.0.1:4111", credential: "secret" });
});
