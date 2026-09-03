import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatorCompiler } from "@fastify/type-provider-zod";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, test, vi } from "vitest";
import WebSocket from "ws";

import { ForgeDatabase } from "../src/database.js";
import taskPane, { originAllowed } from "../src/http/routes/task-pane.js";
import { installHttpErrorHandlers } from "../src/http/errors.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-task-pane-routes-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, pane_id, agent_name, status, created_at, updated_at) VALUES ('planner', 'task', 'planner', 1, 1, 'codex', 'pane-planner', 'task-planner', 'working', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, pane_id, agent_name, status, created_at, updated_at) VALUES ('builder', 'task', 'builder', 1, 1, 'codex', 'pane-builder', 'task-builder', 'ready', ?, ?)").run(now, now);
  });
  const app = Fastify();
  await app.register(websocket);
  app.decorateRequest("forgeUser", undefined as never);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installHttpErrorHandlers(app);
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  const sendText = vi.fn(async () => {});
  const sendKeys = vi.fn(async () => {});
  await app.register(taskPane, {
    tasks: { getTask: () => ({ companyId: "company" }) } as never,
    database,
    herdr: { sendText, sendKeys, attachCommand: (name) => `herdr agent attach ${name}` },
  });
  await app.ready();
  return { root, database, app, sendText, sendKeys };
}

test("pane input sends text and keys to the recorded agent", async () => {
  const value = await fixture();
  try {
    const text = await value.app.inject({ method: "POST", url: "/api/tasks/task/pane/planner/input", payload: { text: "Please continue" } });
    const keys = await value.app.inject({ method: "POST", url: "/api/tasks/task/pane/builder/input", payload: { keys: ["ctrl+c"] } });
    expect(text.statusCode).toBe(200);
    expect(keys.statusCode).toBe(200);
    expect(value.sendText).toHaveBeenCalledWith("task-planner", "Please continue");
    expect(value.sendKeys).toHaveBeenCalledWith("task-builder", ["ctrl+c"]);
    expect(value.database.authQuery((db) => db.prepare("SELECT metadata_json FROM forge_audit_events WHERE action = 'pane_input' ORDER BY created_at").all())).toHaveLength(2);
  } finally {
    await value.app.close();
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("terminal origin accepts same-host loopback and configured origin only", () => {
  expect(originAllowed("http://127.0.0.1:4111", "127.0.0.1:4111", "https://meiji.tail1234.ts.net:4111")).toBe(true);
  expect(originAllowed("https://meiji.tail1234.ts.net:4111", "127.0.0.1:4111", "https://meiji.tail1234.ts.net:4111")).toBe(true);
  expect(originAllowed("https://evil.example", "127.0.0.1:4111", "https://meiji.tail1234.ts.net:4111")).toBe(false);
  expect(originAllowed(undefined, "127.0.0.1:4111", "https://meiji.tail1234.ts.net:4111")).toBe(true);
});

test("terminal WebSocket streams frames and forwards client controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-pane-websocket-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, pane_id, agent_name, status, created_at, updated_at) VALUES ('builder', 'task', 'builder', 1, 1, 'codex', 'pane-builder', 'task-builder', 'ready', ?, ?)").run(now, now);
  });
  const app = Fastify();
  await app.register(websocket);
  app.decorateRequest("forgeUser", undefined as never);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  app.addHook("preHandler", async (request) => { request.forgeUser = { id: "user" } as never; });
  const input = vi.fn();
  const resize = vi.fn();
  const release = vi.fn();
  let emit: ((event: import("../src/herdr-terminal-bridge.js").BridgeEvent) => void) | undefined;
  await app.register(taskPane, {
    tasks: { getTask: () => ({ companyId: "company" }) } as never,
    database,
    herdr: { sendText: async () => {}, sendKeys: async () => {}, attachCommand: () => "attach" },
    openBridge: ((value: { onEvent: typeof emit }) => { emit = value.onEvent; return { input, resize, scroll: vi.fn(), release }; }) as never,
  });
  await app.ready();
  const address = await app.listen({ port: 0 });
  const messages: Array<{ data: Buffer; binary: boolean }> = [];
  const client = new WebSocket(`${address.replace("http", "ws")}/api/tasks/task/pane/builder/terminal?cols=80&rows=24`);
  client.on("message", (data, binary) => { messages.push({ data: Buffer.from(data as Buffer), binary }); });
  try {
    await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(JSON.parse(messages[0]!.data.toString())).toMatchObject({ type: "open", paneId: "pane-builder" });
    emit?.({ type: "frame", frame: { seq: 1, full: true, width: 100, height: 30, bytes: Buffer.from("frame") } });
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(JSON.parse(messages[1]!.data.toString())).toEqual({ type: "size", cols: 100, rows: 30 });
    expect(messages[2]).toMatchObject({ data: Buffer.from("frame"), binary: true });
    client.send(Buffer.from("input"));
    client.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await vi.waitFor(() => expect(input).toHaveBeenCalledWith(Buffer.from("input")));
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith(120, 40));
    client.close();
    await new Promise<void>((resolve) => client.once("close", resolve));
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET pane_id = NULL WHERE id = 'builder'").run());
    const missing = new WebSocket(`${address.replace("http", "ws")}/api/tasks/task/pane/builder/terminal`);
    const closed = await new Promise<{ message: string; code: number }>((resolve, reject) => {
      let message = "";
      missing.once("message", (data) => { message = data.toString(); });
      missing.once("close", (code) => resolve({ message, code }));
      missing.once("error", reject);
    });
    expect(JSON.parse(closed.message)).toEqual({ type: "closed", reason: "no live session" });
    expect(closed.code).toBe(4404);
  } finally {
    client.terminate();
    await app.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pane input rejects an unknown role and invalid input shapes", async () => {
  const value = await fixture();
  try {
    const unknownRole = await value.app.inject({ method: "POST", url: "/api/tasks/task/pane/unknown/input", payload: { text: "Hello" } });
    const both = await value.app.inject({ method: "POST", url: "/api/tasks/task/pane/planner/input", payload: { text: "Hello", keys: ["enter"] } });
    const neither = await value.app.inject({ method: "POST", url: "/api/tasks/task/pane/planner/input", payload: {} });
    expect(unknownRole.statusCode).toBe(404);
    expect(both.statusCode).toBe(400);
    expect(neither.statusCode).toBe(400);
  } finally {
    await value.app.close();
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("pane reads come from SQLite without calling Herdr", async () => {
  const value = await fixture();
  try {
    const response = await value.app.inject({ method: "GET", url: "/api/tasks/task/pane" });
    expect(response.statusCode).toBe(200);
    expect(response.json().panes).toEqual(expect.arrayContaining([expect.objectContaining({ role: "planner", paneId: "pane-planner" })]));
  } finally {
    await value.app.close();
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
