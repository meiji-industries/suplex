import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { taskSessionRuntimeDirectory } from "../../src/runtimes/task-harness.js";
import { nativeApp } from "../helpers/native-app.js";

const fixture = await nativeApp();
try {
  fixture.profiles.update(fixture.userId, fixture.project.rootProfileId, { provider: "codex" });
  const { task } = await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
    projectId: fixture.project.id,
    title: "Read native Codex history",
    description: "Compare history page and live snapshot",
    idempotencyKey: "history-read-interop",
    startImmediately: true,
  });
  const root = fixture.tasks.repository.controls.claimRoot({ taskId: task.id });
  fixture.tasks.repository.controls.bindHarnessSession({
    sessionId: root.id, generation: root.generation, nativeSessionId: "codex-history-read",
  });
  const runtime = taskSessionRuntimeDirectory(fixture.config.databasePath, root.id);
  await mkdir(runtime, { recursive: true });
  const firstLog = join(runtime, "turn-msg_history.jsonl");
  await writeFile(firstLog, [
    '{"type":"thread.started","thread_id":"history-thread"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"The local task is ready."}}',
    '{"type":"turn.completed"}', "",
  ].join("\n"));
  await writeFile(join(runtime, "turn-msg_second.jsonl"), [
    '{"type":"thread.started","thread_id":"history-thread"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"A second native turn."}}',
    '{"type":"turn.completed"}', "",
  ].join("\n"));
  // Native directory order is intentionally different from mtime order.
  await utimes(firstLog, new Date("2026-09-25T12:00:30.000Z"), new Date("2026-09-25T12:00:30.000Z"));
  const path = `/api/tasks/${task.id}/sessions/${root.id}/history`;
  const page = await fixture.app.inject({ url: path, headers: fixture.headers });
  const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  const openLive = () => new Promise<{ socket: WebSocket; first: unknown }>((resolve, reject) => {
    const socket = new WebSocket(`${address.replace(/^http/, "ws")}${path}/live`, {
      headers: { cookie: fixture.headers.cookie, origin: address },
    });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Live history timed out")); }, 5_000);
    socket.once("message", bytes => {
      clearTimeout(timeout);
      try { resolve({ socket, first: JSON.parse(bytes.toString()) as unknown }); } catch (error) { reject(error); }
    });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
  const nextLive = (socket: WebSocket) => new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Live update timed out")); }, 5_000);
    socket.once("message", bytes => {
      clearTimeout(timeout);
      try { resolve(JSON.parse(bytes.toString()) as unknown); } catch (error) { reject(error); }
    });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
  const live = await openLive();
  process.stdout.write(JSON.stringify({
    databasePath: fixture.config.databasePath,
    taskId: task.id,
    sessionId: root.id,
    cookie: fixture.headers.cookie,
    page: { status: page.statusCode, body: JSON.parse(page.body) as unknown, cacheControl: page.headers["cache-control"] ?? null },
    live: live.first,
  }) + "\n");
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
  const update = nextLive(live.socket);
  await writeFile(join(runtime, "turn-msg_third.jsonl"), [
    '{"type":"thread.started","thread_id":"history-thread"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"The follow-up is ready."}}',
    '{"type":"turn.completed"}', "",
  ].join("\n"));
  const updated = await update;
  const reconnected = await openLive();
  process.stdout.write(JSON.stringify({ update: updated, reconnect: reconnected.first }) + "\n");
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
  live.socket.close();
  reconnected.socket.close();
} finally {
  await fixture.close();
}
