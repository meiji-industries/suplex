import { validatorCompiler } from "@fastify/type-provider-zod";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, test, vi } from "vitest";
import WebSocket from "ws";
import taskPane, { originAllowed } from "../src/http/routes/task-pane.js";
import type { BridgeEvent } from "../src/integrations/herdr/terminal-bridge.js";
import { nativeApp } from "./helpers/native-app.js";

test("terminal origin accepts only the request host or configured origin", () => {
  expect(originAllowed("http://127.0.0.1:4111", "127.0.0.1:4111", "https://forge.example")).toBe(true);
  expect(originAllowed("https://forge.example", "127.0.0.1:4111", "https://forge.example")).toBe(true);
  expect(originAllowed("https://evil.example", "127.0.0.1:4111", "https://forge.example")).toBe(false);
});

test("terminal observers are independent and close when the pane binding changes", async () => {
  const value = await nativeApp();
  const app = Fastify();
  const clients: WebSocket[] = [];
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Terminal", description: "Observe only", idempotencyKey: "terminal-test", startImmediately: true });
    const store = value.tasks.repository.controls;
    const root = store.claimRoot({ taskId: task.id });
    store.bindPane({ sessionId: root.id, generation: root.generation, paneId: "pane-root" });
    await app.register(websocket);
    const user = value.auth.listUsers(value.userId)[0]!;
    app.decorateRequest("forgeUser", { getter: () => user });
    app.setValidatorCompiler(validatorCompiler);
    const bridges: Array<{ emit: (event: BridgeEvent) => void; input: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; scroll: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
    await app.register(taskPane, { tasks: value.tasks, config: value.config, openBridge: options => {
      const bridge = { emit: options.onEvent, input: vi.fn(), resize: vi.fn(), scroll: vi.fn(), release: vi.fn() };
      bridges.push(bridge);
      return bridge;
    } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const connect = async () => {
      const messages: string[] = [];
      const client = new WebSocket(`${address.replace("http", "ws")}/api/tasks/${task.id}/pane/root/terminal`);
      clients.push(client);
      client.on("message", data => messages.push(data.toString()));
      await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
      return { client, messages };
    };
    const first = await connect();
    const second = await connect();
    expect(bridges).toHaveLength(2);
    expect(JSON.parse(first.messages[0]!)).toMatchObject({ type: "open", paneId: "pane-root", readOnly: true });
    bridges[0]!.emit({ type: "frame", frame: { seq: 1, full: true, width: 100, height: 30, bytes: Buffer.from("first observer") } });
    bridges[1]!.emit({ type: "frame", frame: { seq: 1, full: true, width: 80, height: 24, bytes: Buffer.from("second observer") } });
    await vi.waitFor(() => expect(first.messages).toContain("first observer"));
    await vi.waitFor(() => expect(second.messages).toContain("second observer"));
    first.client.close();
    await vi.waitFor(() => expect(bridges[0]!.release).toHaveBeenCalledOnce());
    expect(bridges[1]!.release).not.toHaveBeenCalled();
    bridges[1]!.emit({ type: "frame", frame: { seq: 2, full: false, width: 80, height: 24, bytes: Buffer.from("still live") } });
    await vi.waitFor(() => expect(second.messages).toContain("still live"));
    second.client.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    second.client.send(JSON.stringify({ type: "scroll", direction: "up", lines: 10 }));
    second.client.send(Buffer.from("unapproved instruction"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(bridges[1]!.input).not.toHaveBeenCalled();
    expect(bridges[1]!.resize).not.toHaveBeenCalled();
    expect(bridges[1]!.scroll).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/pane/root/input`, payload: { text: "bypass" } })).statusCode).toBe(404);
    const closed = new Promise<number>(resolve => second.client.once("close", code => resolve(code)));
    store.bindPane({ sessionId: root.id, generation: root.generation, paneId: "pane-replacement" });
    expect(await closed).toBe(4404);
    await vi.waitFor(() => expect(bridges[1]!.release).toHaveBeenCalledOnce());
  } finally { for (const client of clients) client.terminate(); await app.close(); await value.close(); }
});

test("shell terminal is writable and forwards input, resize, and scroll to the control bridge", async () => {
  const shellPane = { paneId: "pane-shell", tokens: { forge_task_id: "", forge_role: "shell", forge_binding_id: "" } };
  const herdr = {
    getPane: async (id: string) => id === shellPane.paneId ? shellPane : null,
    getPaneProcessInfo: async () => { throw new Error("unused"); },
    createWorkspace: async () => { throw new Error("unused"); },
    splitPane: async () => { throw new Error("unused"); },
    renamePane: vi.fn(async () => {}),
    runPaneCommand: vi.fn(async () => {}),
    reportPaneMetadata: vi.fn(async () => {}),
  };
  const value = await nativeApp({ herdr });
  const app = Fastify();
  let client: WebSocket | undefined;
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Shell", description: "Interactive", idempotencyKey: "shell-terminal-test", startImmediately: true });
    shellPane.tokens.forge_task_id = task.id;
    shellPane.tokens.forge_binding_id = `${task.id}:shell`;
    value.tasks.repository.controls.bindShellPane(task.id, shellPane.paneId);
    await app.register(websocket);
    const user = value.auth.listUsers(value.userId)[0]!;
    app.decorateRequest("forgeUser", { getter: () => user });
    app.setValidatorCompiler(validatorCompiler);
    const bridge = { input: vi.fn(), resize: vi.fn(), scroll: vi.fn(), release: vi.fn() };
    const openBridge = vi.fn((options: { paneId: string; mode?: string; onEvent: (event: BridgeEvent) => void }) => ({ ...bridge, emit: options.onEvent }));
    await app.register(taskPane, { tasks: value.tasks, config: value.config, openBridge: openBridge as never });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    client = new WebSocket(`${address.replace("http", "ws")}/api/tasks/${task.id}/pane/shell/terminal`);
    const messages: string[] = [];
    client.on("message", data => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => { client!.once("open", resolve); client!.once("error", reject); });
    await vi.waitFor(() => expect(openBridge).toHaveBeenCalledOnce());
    expect(openBridge.mock.calls[0]![0]).toMatchObject({ paneId: "pane-shell", mode: "control" });
    await vi.waitFor(() => expect(messages.some(message => message.includes('"type":"open"'))).toBe(true));
    expect(JSON.parse(messages.find(message => message.includes('"type":"open"'))!)).toMatchObject({ type: "open", paneId: "pane-shell", readOnly: false });
    client.send(Buffer.from("ls\n"));
    client.send(JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
    client.send(JSON.stringify({ type: "scroll", direction: "up", lines: 9 }));
    client.send(JSON.stringify({ type: "mystery" }));
    await vi.waitFor(() => expect(bridge.input).toHaveBeenCalledWith(Buffer.from("ls\n")));
    expect(bridge.resize).toHaveBeenCalledWith(132, 43);
    expect(bridge.scroll).toHaveBeenCalledWith("up", 9);
    client.close();
    await vi.waitFor(() => expect(bridge.release).toHaveBeenCalledOnce());
  } finally { client?.terminate(); await app.close(); await value.close(); }
});

test("shell terminal closes 4404 when no shell pane exists and 4498 after a takeover", async () => {
  const panes = new Map<string, { paneId: string; tokens: Record<string, string> }>();
  const herdr = {
    getPane: async (id: string) => panes.get(id) ?? null,
    getPaneProcessInfo: async () => { throw new Error("unused"); },
    createWorkspace: async () => { throw new Error("Herdr is unavailable"); },
    splitPane: async () => { throw new Error("unused"); },
    renamePane: vi.fn(async () => {}),
    runPaneCommand: vi.fn(async () => {}),
    reportPaneMetadata: vi.fn(async () => {}),
    listWorkspaces: async () => [],
  };
  const value = await nativeApp({ herdr });
  const app = Fastify();
  const clients: WebSocket[] = [];
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Shell", description: "Missing pane", idempotencyKey: "shell-missing-test", startImmediately: true });
    await app.register(websocket);
    const user = value.auth.listUsers(value.userId)[0]!;
    app.decorateRequest("forgeUser", { getter: () => user });
    app.setValidatorCompiler(validatorCompiler);
    let emit: ((event: BridgeEvent) => void) | undefined;
    await app.register(taskPane, { tasks: value.tasks, config: value.config, openBridge: (options: { onEvent: (event: BridgeEvent) => void }) => { emit = options.onEvent; return { input: vi.fn(), resize: vi.fn(), scroll: vi.fn(), release: vi.fn() }; } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const connect = () => {
      const socket = new WebSocket(`${address.replace("http", "ws")}/api/tasks/${task.id}/pane/shell/terminal`);
      clients.push(socket);
      return socket;
    };
    const missing = connect();
    const missingClose = new Promise<number>(resolve => missing.once("close", code => resolve(code)));
    expect(await missingClose).toBe(4404);

    const pane = { paneId: "pane-shell", tokens: { forge_task_id: task.id, forge_role: "shell", forge_binding_id: `${task.id}:shell` } };
    panes.set(pane.paneId, pane);
    value.tasks.repository.controls.bindShellPane(task.id, pane.paneId);
    const live = connect();
    await new Promise<void>((resolve, reject) => { live.once("open", resolve); live.once("error", reject); });
    await vi.waitFor(() => expect(emit).toBeDefined());
    const takeoverClose = new Promise<number>(resolve => live.once("close", code => resolve(code)));
    emit!({ type: "closed", reason: "terminal attach taken over" });
    expect(await takeoverClose).toBe(4498);
  } finally { for (const client of clients) client.terminate(); await app.close(); await value.close(); }
});

test("terminal observation closes after access revocation", async () => {
  const value = await nativeApp();
  const app = Fastify();
  let client: WebSocket | undefined;
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Terminal access", description: "Observe only", idempotencyKey: "terminal-access-test", startImmediately: true });
    const root = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    value.tasks.repository.controls.bindPane({ sessionId: root.id, generation: root.generation, paneId: "pane-root" });
    await app.register(websocket);
    const user = value.auth.listUsers(value.userId)[0]!;
    app.decorateRequest("forgeUser", { getter: () => user });
    app.setValidatorCompiler(validatorCompiler);
    const release = vi.fn();
    await app.register(taskPane, { tasks: value.tasks, config: value.config, openBridge: () => ({ input: vi.fn(), resize: vi.fn(), scroll: vi.fn(), release }) });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    client = new WebSocket(`${address.replace("http", "ws")}/api/tasks/${task.id}/pane/root/terminal`);
    await new Promise<void>((resolve, reject) => { client!.once("open", resolve); client!.once("error", reject); });
    const closed = new Promise<number>(resolve => client!.once("close", code => resolve(code)));
    value.database.authTransaction(db => {
      db.prepare("UPDATE forge_users SET role = 'member' WHERE id = ?").run(value.userId);
      db.prepare("DELETE FROM forge_memberships WHERE user_id = ?").run(value.userId);
    });
    expect(await closed).toBe(4403);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  } finally { client?.terminate(); await app.close(); await value.close(); }
});
