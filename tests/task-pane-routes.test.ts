import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatorCompiler } from "@fastify/type-provider-zod";
import Fastify from "fastify";
import { expect, test, vi } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import taskPane from "../src/http/routes/task-pane.js";
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
