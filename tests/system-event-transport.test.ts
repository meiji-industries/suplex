import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createSystemEventProducer, startSystemEventReceiver, systemEventSocketPath } from "../src/platform/system-event-transport.js";
import { runWithSystemEvents, systemEvent, withEventCause, type EventContext, type ForwardedEventMeta, type SystemEvent } from "../src/platform/system-events.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the local event receiver");
}

test("bridge events cross the socket with producer identity and causal IDs after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "suplex-event-ipc-"));
  const databasePath = join(directory, "suplex.sqlite");
  writeFileSync(databasePath, "database marker");
  const received: Array<{ event: SystemEvent; context: EventContext; meta?: ForwardedEventMeta }> = [];
  const sink = (event: SystemEvent, context: EventContext, meta?: ForwardedEventMeta): string | undefined => { received.push({ event, context, ...(meta ? { meta } : {}) }); return meta?.eventId; };
  const producer = createSystemEventProducer(databasePath);
  let stop = await startSystemEventReceiver(databasePath, sink);
  try {
    const stopDuplicate = await startSystemEventReceiver(databasePath, sink);
    await stopDuplicate();
    runWithSystemEvents(producer, { source: "root_bridge", taskId: "task-1", trigger: "request_delivery" }, () => {
      const cause = systemEvent({ type: "bridge_tool", taskId: "task-1", state: "requested", tool: "request_delivery" });
      withEventCause(cause, () => systemEvent({ type: "task_admitted", taskId: "task-2", trigger: "prerequisite completion", prerequisiteTaskId: "task-1" }));
    });
    await until(() => received.length === 2);
    expect(received[1]).toMatchObject({ event: { type: "task_admitted", taskId: "task-2", prerequisiteTaskId: "task-1" }, context: { source: "root_bridge", taskId: "task-1", trigger: "request_delivery", causeEventId: received[0]!.meta!.eventId }, meta: { producerPid: process.pid, processInstanceId: received[0]!.meta!.processInstanceId } });
    await stop();
    expect(producer({ type: "task_action", taskId: "task-1", action: "offline" }, { source: "root_bridge", taskId: "task-1", trigger: "offline" })).toBeTypeOf("string");
    stop = await startSystemEventReceiver(databasePath, sink);
    producer({ type: "task_action", taskId: "task-1", action: "reconnected" }, { source: "root_bridge", taskId: "task-1", trigger: "reconnected" });
    await until(() => received.some(item => item.event.type === "task_action" && item.event.action === "reconnected"));
    expect(received.some(item => item.event.type === "task_action" && item.event.action === "offline")).toBe(false);
  } finally { await stop(); rmSync(directory, { recursive: true, force: true }); }
});

test("malformed and oversized input is ignored and shutdown closes open sockets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "suplex-event-ipc-"));
  const databasePath = join(directory, "suplex.sqlite");
  writeFileSync(databasePath, "database marker");
  const received: SystemEvent[] = [];
  const stop = await startSystemEventReceiver(databasePath, event => { received.push(event); return undefined; });
  try {
    const path = systemEventSocketPath(databasePath);
    await new Promise<void>(resolve => { const socket = createConnection(path); socket.once("connect", () => socket.end("{bad json}\n")); socket.once("close", resolve); });
    await new Promise<void>(resolve => { const socket = createConnection(path); socket.once("connect", () => socket.end(`${"x".repeat(9000)}\n`)); socket.once("close", resolve); });
    expect(received).toEqual([]);
    const hanging = createConnection(path);
    await new Promise<void>(resolve => hanging.once("connect", resolve));
    await stop();
    await until(() => hanging.destroyed);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
