import { validatorCompiler } from "@fastify/type-provider-zod";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, test, vi } from "vitest";
import WebSocket from "ws";
import taskPane, { originAllowed } from "../src/http/routes/task-pane.js";
import type { BridgeEvent } from "../src/herdr-terminal-bridge.js";
import { nativeApp } from "./helpers/native-app.js";

test("terminal origin accepts only the request host or configured origin", () => {
  expect(originAllowed("http://127.0.0.1:4111", "127.0.0.1:4111", "https://forge.example")).toBe(true);
  expect(originAllowed("https://forge.example", "127.0.0.1:4111", "https://forge.example")).toBe(true);
  expect(originAllowed("https://evil.example", "127.0.0.1:4111", "https://forge.example")).toBe(false);
});

test("native terminal streams frames but rejects instructions and closes after access revocation", async () => {
  const value = await nativeApp();
  const app = Fastify();
  let client: WebSocket | undefined;
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Terminal", description: "Observe only", idempotencyKey: "terminal-test", startImmediately: true });
    const store = value.tasks.repository.controls;
    const root = store.claimRoot({ taskId: task.id });
    store.bindPane({ sessionId: root.id, generation: root.generation, paneId: "pane-root" });
    await app.register(websocket);
    const user = value.auth.listUsers(value.userId)[0]!;
    app.decorateRequest("forgeUser", { getter: () => user });
    app.setValidatorCompiler(validatorCompiler);
    const input = vi.fn();
    const resize = vi.fn();
    const release = vi.fn();
    const scroll = vi.fn();
    let emit: ((event: BridgeEvent) => void) | undefined;
    await app.register(taskPane, { tasks: value.tasks, config: value.config, openBridge: options => {
      emit = options.onEvent;
      return { input, resize, scroll, release };
    } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const messages: string[] = [];
    client = new WebSocket(`${address.replace("http", "ws")}/api/tasks/${task.id}/pane/root/terminal`);
    client.on("message", data => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => { client!.once("open", resolve); client!.once("error", reject); });
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    expect(JSON.parse(messages[0]!)).toMatchObject({ type: "open", paneId: "pane-root", readOnly: true });
    emit?.({ type: "frame", frame: { seq: 1, full: true, width: 100, height: 30, bytes: Buffer.from("native frame") } });
    await vi.waitFor(() => expect(messages).toContain("native frame"));
    client.send(Buffer.from("unapproved instruction"));
    client.send(JSON.stringify({ type: "input", text: "unapproved instruction" }));
    client.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    client.send(JSON.stringify({ type: "scroll", direction: "up", lines: 10 }));
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith(120, 40));
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledWith("up", 10));
    expect(input).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/pane/root/input`, payload: { text: "bypass" } })).statusCode).toBe(404);
    const closed = new Promise<number>(resolve => client!.once("close", code => resolve(code)));
    value.database.authTransaction(db => {
      db.prepare("UPDATE forge_users SET role = 'member' WHERE id = ?").run(value.userId);
      db.prepare("DELETE FROM forge_memberships WHERE user_id = ?").run(value.userId);
    });
    expect(await closed).toBe(4403);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  } finally { client?.terminate(); await app.close(); await value.close(); }
});
