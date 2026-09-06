import { expect, test } from "vitest";
import { readTaskAgentStatuses } from "../src/task-agent-status.js";
import { nativeApp } from "./helpers/native-app.js";

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
