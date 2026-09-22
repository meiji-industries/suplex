import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, test } from "vitest";
import WebSocket from "ws";

import taskRoutes from "../src/http/routes/tasks.js";
import type { NativeHistoryMessage, SessionHistoryLiveEvent } from "../src/tasks/history/contracts.js";
import { nativeApp } from "./helpers/native-app.js";

const message = (id: string, text = id): NativeHistoryMessage => ({ id, role: "assistant", createdAt: null, content: [{ id: `${id}:text`, type: "text", text }] });

async function nextEvent(events: SessionHistoryLiveEvent[], type: SessionHistoryLiveEvent["type"], offset = 0): Promise<SessionHistoryLiveEvent> {
  await expect.poll(() => events.slice(offset).find(event => event.type === type)).toBeTruthy();
  return events.slice(offset).find(event => event.type === type)!;
}

test("live task history preserves authoritative order, removes drafts, and snapshots after source recovery", async () => {
  const value = await nativeApp();
  const app = Fastify();
  const clients: WebSocket[] = [];
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Live history", description: "Observe updates", startImmediately: true, idempotencyKey: "live-history" });
    const reserved = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    const session = value.tasks.repository.controls.bindHarnessSession({ sessionId: reserved.id, generation: reserved.generation, nativeSessionId: "ses_live" });
    let history = [message("old", "pending"), message("draft", "partial")];
    let failure: Error | null = null;
    let reads = 0;
    await app.register(websocket);
    app.decorateRequest("suplexUser", { getter: () => value.auth.listUsers(value.userId)[0]! });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(taskRoutes, { tasks: value.tasks, config: value.config, readHistory: async () => {
      reads += 1;
      if (failure) throw failure;
      return history;
    } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const connect = async () => {
      const events: SessionHistoryLiveEvent[] = [];
      const client = new WebSocket(`${address.replace("http", "ws")}/api/tasks/${task.id}/sessions/${session.id}/history/live`, { headers: { origin: value.config.reachableAddress } });
      clients.push(client);
      client.on("message", data => events.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
      return { client, events };
    };
    const first = await connect();
    const initial = await nextEvent(first.events, "snapshot");
    expect(initial).toMatchObject({ type: "snapshot", order: ["old", "draft"], page: { olderCursor: null } });

    value.tasks.repository.controls.bindPane({ sessionId: session.id, generation: session.generation, paneId: "recreated-pane" });
    history = [message("old", "complete"), message("final", "complete"), message("new")];
    const update = await nextEvent(first.events, "update", first.events.length);
    expect(update).toEqual({ type: "update", messages: history, removedIds: ["draft"], order: ["old", "final", "new"] });

    const second = await connect();
    expect(await nextEvent(second.events, "snapshot")).toMatchObject({ type: "snapshot", order: ["old", "final", "new"] });
    failure = new Error("offline");
    const errorOffset = first.events.length;
    expect(await nextEvent(first.events, "error", errorOffset)).toEqual({ type: "error", message: "Live output is not available. Suplex will retry." });
    failure = null;
    const recovery = await nextEvent(first.events, "snapshot", errorOffset);
    expect(recovery).toMatchObject({ type: "snapshot", order: ["old", "final", "new"] });
    expect(reads).toBeGreaterThanOrEqual(5);
  } finally {
    for (const client of clients) client.terminate();
    await app.close();
    await value.close();
  }
});

test("live task history rejects a session from another task and closes observers when access is revoked", async () => {
  const value = await nativeApp();
  const app = Fastify();
  const clients: WebSocket[] = [];
  try {
    const first = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "First live", description: "Observe", startImmediately: true, idempotencyKey: "first-live" });
    const second = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Second live", description: "Observe", startImmediately: true, idempotencyKey: "second-live" });
    const firstReserved = value.tasks.repository.controls.claimRoot({ taskId: first.task.id });
    const firstSession = value.tasks.repository.controls.bindHarnessSession({ sessionId: firstReserved.id, generation: firstReserved.generation, nativeSessionId: "ses_first" });
    const secondReserved = value.tasks.repository.controls.claimRoot({ taskId: second.task.id });
    const secondSession = value.tasks.repository.controls.bindHarnessSession({ sessionId: secondReserved.id, generation: secondReserved.generation, nativeSessionId: "ses_second" });
    await app.register(websocket);
    app.decorateRequest("suplexUser", { getter: () => value.auth.listUsers(value.userId)[0]! });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(taskRoutes, { tasks: value.tasks, config: value.config, readHistory: async () => [message("visible")] });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const connect = (taskId: string, sessionId: string) => {
      const client = new WebSocket(`${address.replace("http", "ws")}/api/tasks/${taskId}/sessions/${sessionId}/history/live`, { headers: { origin: value.config.reachableAddress } });
      clients.push(client);
      return client;
    };
    const foreign = connect(first.task.id, secondSession.id);
    expect(await new Promise<number>(resolve => foreign.once("close", resolve))).toBe(4404);

    const observer = connect(first.task.id, firstSession.id);
    await new Promise<void>((resolve, reject) => { observer.once("open", resolve); observer.once("error", reject); });
    const closed = new Promise<number>(resolve => observer.once("close", resolve));
    value.database.authTransaction(db => {
      db.prepare("UPDATE suplex_users SET role = 'member' WHERE id = ?").run(value.userId);
      db.prepare("DELETE FROM suplex_memberships WHERE user_id = ?").run(value.userId);
    });
    expect(await closed).toBe(4403);
  } finally {
    for (const client of clients) client.terminate();
    await app.close();
    await value.close();
  }
});

test("closing the application releases live history polling", async () => {
  const value = await nativeApp();
  const app = Fastify();
  let client: WebSocket | undefined;
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Close live", description: "Release", startImmediately: true, idempotencyKey: "close-live" });
    const reserved = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    const session = value.tasks.repository.controls.bindHarnessSession({ sessionId: reserved.id, generation: reserved.generation, nativeSessionId: "ses_close" });
    let reads = 0;
    await app.register(websocket);
    app.decorateRequest("suplexUser", { getter: () => value.auth.listUsers(value.userId)[0]! });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(taskRoutes, { tasks: value.tasks, config: value.config, readHistory: async () => { reads += 1; return []; } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    client = new WebSocket(`${address.replace("http", "ws")}/api/tasks/${task.id}/sessions/${session.id}/history/live`, { headers: { origin: value.config.reachableAddress } });
    await new Promise<void>((resolve, reject) => { client!.once("open", resolve); client!.once("error", reject); });
    await expect.poll(() => reads).toBeGreaterThan(0);
    const closed = new Promise<number>(resolve => client!.once("close", resolve));
    await app.close();
    await closed;
    const stoppedAt = reads;
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(reads).toBe(stoppedAt);
  } finally {
    client?.terminate();
    await app.close();
    await value.close();
  }
});
