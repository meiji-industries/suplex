import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { EventSink, SystemEvent } from "./system-events.js";
import { TaskQueueWaitReasonSchema } from "../tasks/contracts.js";

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const short = z.string().max(120);
const optionalShort = short.optional();
const bridgeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task_status"), taskId: id, status: z.string().max(32), previousStatus: z.string().max(32).optional() }).strict(),
  z.object({ type: z.literal("queue_wait"), taskId: id, waits: z.array(z.object({ id, reason: TaskQueueWaitReasonSchema }).strict()).max(64) }).strict(),
  z.object({ type: z.literal("task_admitted"), taskId: id, trigger: z.string().max(120), prerequisiteTaskId: id.optional() }).strict(),
  z.object({ type: z.literal("task_action"), taskId: id, action: z.string().max(80) }).strict(),
  z.object({ type: z.literal("bridge_tool"), taskId: id, state: z.enum(["requested", "completed", "error"]), tool: z.string().max(80), result: z.string().max(80).optional() }).strict(),
  z.object({ type: z.literal("recovery"), taskId: id, state: z.enum(["requested", "started", "finished", "error"]), producer: z.literal("host"), durationMs: z.number().nonnegative().optional(), result: optionalShort }).strict(),
  z.object({ type: z.literal("headless_process"), state: z.enum(["dispatched", "started", "exit_observed"]), taskId: id, sessionId: id, turnId: id, generation: id, targetPid: z.number().int().positive().optional(), startTime: optionalShort, exitCode: z.number().int().nullable().optional(), exitSignal: short.nullable().optional() }).strict(),
  z.object({ type: z.literal("command_process"), state: z.enum(["running", "finished", "error"]), taskId: id, stepId: id.optional(), commandId: z.uuid(), targetPid: z.number().int().positive().optional(), exitCode: z.number().int().nullable().optional(), exitSignal: short.nullable().optional(), durationMs: z.number().nonnegative().optional(), timedOut: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("process_signal"), state: z.enum(["requested", "sent", "skipped", "error"]), targetPid: z.number().int().positive(), targetStartTime: optionalShort, targetName: optionalShort, senderPid: z.number().int().positive(), signal: short, reason: short, result: optionalShort }).strict(),
  z.object({ type: z.literal("native_turn"), state: z.enum(["observed", "dispatched", "finished", "snapshot", "agent_final"]), taskId: id, sessionId: id, turnId: id, nativeState: optionalShort, reason: optionalShort, admission: optionalShort, elapsedMs: z.number().nonnegative().optional(), outputAgeMs: z.number().nonnegative().nullable().optional(), unsettledToolIds: z.array(id).max(32).optional(), processRunning: z.boolean().optional() }).strict(),
]);
const wireSchema = z.object({
  schemaVersion: z.literal(1),
  event: bridgeEvent,
  context: z.object({ source: z.literal("root_bridge"), taskId: id, trigger: z.string().max(80), causeEventId: z.uuid().optional() }).strict(),
  meta: z.object({ eventId: z.uuid(), producerTime: z.iso.datetime(), producerPid: z.number().int().positive(), producerSequence: z.number().int().nonnegative(), processInstanceId: z.uuid() }).strict(),
}).strict();
const maxBytes = 8192;

export function systemEventSocketPath(databasePath: string): string {
  const canonical = realpathSync(databasePath);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 20);
  return process.platform === "win32" ? `\\\\.\\pipe\\suplex-system-${digest}` : join(tmpdir(), `suplex-system-${process.getuid?.() ?? 0}-${digest}.sock`);
}

export function createSystemEventProducer(databasePath: string): EventSink {
  let path: string;
  let processInstanceId: string;
  try { path = systemEventSocketPath(databasePath); processInstanceId = randomUUID(); }
  catch { return () => undefined; }
  let sequence = 0;
  let inFlight = 0;
  return (event, context) => {
    try {
      const eventId = randomUUID();
      const wire = { schemaVersion: 1, event, context: { source: "root_bridge", taskId: context.taskId ?? ("taskId" in event ? event.taskId : "unknown"), trigger: context.trigger ?? "bridge", ...(context.causeEventId ? { causeEventId: context.causeEventId } : {}) }, meta: { eventId, producerTime: new Date().toISOString(), producerPid: process.pid, producerSequence: ++sequence, processInstanceId } };
      const line = `${JSON.stringify(wire)}\n`;
      if (Buffer.byteLength(line) > maxBytes || inFlight >= 32) return undefined;
      inFlight++;
      const socket = createConnection(path);
      socket.setTimeout(1000, () => socket.destroy());
      socket.once("error", () => undefined);
      socket.once("connect", () => socket.end(line));
      socket.once("close", () => { inFlight--; });
      socket.unref();
      return eventId;
    } catch { return undefined; }
  };
}

async function staleSocket(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT"));
  });
}

export async function startSystemEventReceiver(databasePath: string, sink: EventSink): Promise<() => Promise<void>> {
  let path: string;
  try { path = systemEventSocketPath(databasePath); } catch { return async () => undefined; }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    let bytes = 0;
    let buffer = "";
    socket.setTimeout(1000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { socket.destroy(); return; }
      buffer += chunk.toString("utf8");
      if (!buffer.endsWith("\n")) return;
      const line = buffer.slice(0, -1);
      buffer = "";
      try {
        const parsed = wireSchema.safeParse(JSON.parse(line));
        if (parsed.success) sink(parsed.data.event as SystemEvent, { source: "root_bridge", taskId: parsed.data.context.taskId, trigger: parsed.data.context.trigger, ...(parsed.data.context.causeEventId ? { causeEventId: parsed.data.context.causeEventId } : {}) }, parsed.data.meta);
      } catch { /* Malformed producer data is ignored. */ }
      socket.end();
    });
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => undefined);
  });
  server.on("error", () => undefined);
  const listen = (): Promise<void> => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  try {
    try { await listen(); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE") || !lstatSync(path).isSocket() || !await staleSocket(path)) return async () => undefined;
      unlinkSync(path);
      await listen();
    }
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    try { server.close(); } catch { /* Receiver was never listening. */ }
    return async () => undefined;
  }
  const ownedInode = process.platform === "win32" ? undefined : statSync(path).ino;
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.platform !== "win32") { try { if (lstatSync(path).ino === ownedInode) unlinkSync(path); } catch { /* A removed socket needs no cleanup. */ } }
  };
}
