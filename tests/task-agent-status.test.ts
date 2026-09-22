import { afterEach, expect, test, vi } from "vitest";
import * as agentStatuses from "../src/tasks/agent-status.js";
import { readTaskAgentStatuses } from "../src/tasks/agent-status.js";
import { nativeApp } from "./helpers/native-app.js";
import { TaskAgentsResponseSchema } from "../src/http/contracts/tasks.js";

afterEach(() => vi.restoreAllMocks());

test("agent rows use native observations and never turn failed observations into idle", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Agent status", description: "Observe only", startImmediately: true, idempotencyKey: "agent-status" });
    const store = value.tasks.repository.controls;
    const reserved = store.claimRoot({ taskId: task.id });
    const root = store.bindHarnessSession({ sessionId: reserved.id, generation: reserved.generation, nativeSessionId: "ses_status" });
    const updatedAt = Date.parse("2026-09-05T12:34:56.000Z");
    const read = (status: "busy" | "retry" | "idle") => readTaskAgentStatuses(value.config.databasePath, task, [root], async () => ({ status, updatedAt }));
    expect((await read("busy")).agents[0]?.status).toBe("working");
    expect((await read("busy")).agents[0]?.statusChangedAt).toBeNull();
    expect((await read("retry")).agents[0]?.status).toBe("retrying");
    expect((await read("retry")).agents[0]?.statusChangedAt).toBeNull();
    expect((await read("idle")).agents[0]?.status).toBe("idle");
    expect((await read("idle")).agents[0]?.statusChangedAt).toBe("2026-09-05T12:34:56.000Z");
    expect((await readTaskAgentStatuses(value.config.databasePath, task, [root], async () => { throw new Error("Offline"); })).agents[0]?.status).toBe("unknown");
    expect((await readTaskAgentStatuses(value.config.databasePath, { status: "waiting_human" }, [root], async () => ({ status: "idle", updatedAt }))).agents[0]).toMatchObject({ status: "waiting_human", statusChangedAt: null });
    expect((await readTaskAgentStatuses(value.config.databasePath, task, [reserved])).agents[0]?.status).toBe("queued");
    expect((await readTaskAgentStatuses(value.config.databasePath, task, [{ ...root, lifecycle: "stopped", stopRequestedAt: "2026-09-05T12:00:00.000Z", stoppedAt: "2026-09-05T12:01:00.000Z" }])).agents[0]).toMatchObject({ status: "stopped", statusChangedAt: "2026-09-05T12:01:00.000Z" });
    expect((await readTaskAgentStatuses(value.config.databasePath, task, [{ ...root, lifecycle: "cancelled", stopRequestedAt: "2026-09-05T12:02:00.000Z", stoppedAt: null }])).agents[0]).toMatchObject({ status: "stopped", statusChangedAt: "2026-09-05T12:02:00.000Z" });
    expect((await readTaskAgentStatuses(value.config.databasePath, task, [{ ...root, lifecycle: "stopped", stopRequestedAt: null, stoppedAt: null }])).agents[0]?.statusChangedAt).toBeNull();
    expect((await readTaskAgentStatuses(value.config.databasePath, task, [{ ...root, current: false }])).agents).toEqual([]);
    const response = await value.app.inject({ url: `/api/tasks/${task.id}/agents`, headers: value.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().agents[0].status).toBe("unknown");
    expect(response.json().agents[0].statusChangedAt).toBeNull();
    expect((await value.app.inject({ url: `/api/tasks/${task.id}/agents` })).statusCode).toBe(401);
    expect((await value.app.inject({ url: "/api/tasks/missing/agents", headers: value.headers })).statusCode).toBe(404);
    expect(store.get(task.id).status).toBe("active");
    expect(store.turns(task.id)).toHaveLength(0);
  } finally { await value.close(); }
});

test("company agent batches match individual reads and omit foreign, missing, and archived tasks", async () => {
  const value = await nativeApp();
  try {
    const create = async (key: string) => (await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: key, description: "Observe only", startImmediately: true, idempotencyKey: key })).task;
    const first = await create("batch-first");
    const second = await create("batch-second");
    const archived = await create("batch-archived");
    value.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), archived.id));
    const store = value.tasks.repository.controls;
    const reserved = store.claimRoot({ taskId: first.id });
    store.bindHarnessSession({ sessionId: reserved.id, generation: reserved.generation, nativeSessionId: "ses_missing_batch" });
    store.claimRoot({ taskId: second.id });
    const ids = [second.id, first.id, archived.id, "missing", first.id];
    const url = `/api/companies/${value.company.id}/task-agents?${new URLSearchParams(ids.map(id => ["taskId", id]))}`;
    const response = await value.app.inject({ url, headers: value.headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const singles = await Promise.all([first.id, second.id].sort().map(async id => ({ taskId: id, ...TaskAgentsResponseSchema.parse((await value.app.inject({ url: `/api/tasks/${id}/agents`, headers: value.headers })).json()) })));
    expect(response.json()).toEqual({ tasks: singles });
    expect(singles.flatMap(task => task.agents).map(agent => agent.status).sort()).toEqual(["queued", "unknown"]);
    const other = value.auth.createCompany(value.userId, "Other company");
    expect((await value.app.inject({ url: `/api/companies/${other.id}/task-agents?taskId=${first.id}`, headers: value.headers })).json()).toEqual({ tasks: [] });
    expect((await value.app.inject({ url })).statusCode).toBe(401);
    expect((await value.app.inject({ url: "/api/companies/missing/task-agents", headers: value.headers })).statusCode).toBe(404);
    expect((await value.app.inject({ url: `/api/companies/${value.company.id}/task-agents`, headers: value.headers })).json()).toEqual({ tasks: [] });
    for (const query of ["taskId=", new URLSearchParams(Array.from({ length: 11 }, (_, i) => ["taskId", String(i)])).toString()]) {
      expect((await value.app.inject({ url: `/api/companies/${value.company.id}/task-agents?${query}`, headers: value.headers })).statusCode).toBe(400);
    }
  } finally { await value.close(); }
});

test.each(["archive", "revoke", "database failure"])("agent batches recheck authority after asynchronous reads: %s", async change => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Batch access", description: "Observe only", startImmediately: false, idempotencyKey: "batch-access" });
    vi.spyOn(agentStatuses, "readTaskAgentStatuses").mockImplementationOnce(async () => {
      await Promise.resolve();
      if (change === "archive") value.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), task.id));
      if (change === "revoke") value.database.authTransaction(db => db.prepare("UPDATE forge_users SET status = 'revoked' WHERE id = ?").run(value.userId));
      if (change === "database failure") throw new Error("Database unavailable");
      return { agents: [] };
    });
    const response = await value.app.inject({ url: `/api/companies/${value.company.id}/task-agents?taskId=${task.id}`, headers: value.headers });
    expect(response.statusCode).toBe(change === "archive" ? 200 : change === "revoke" ? 401 : 500);
    if (change === "archive") expect(response.json()).toEqual({ tasks: [] });
  } finally { await value.close(); }
});
