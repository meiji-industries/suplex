import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redact } from "./logging.js";

export type SystemEvent =
  | { type: "server"; state: "starting" | "listening" | "shutdown_requested" | "stopped" | "heartbeat" | "clock_gap"; reason?: string; wallElapsedMs?: number; monotonicElapsedMs?: number }
  | { type: "task_status"; taskId: string; status: string; previousStatus?: string }
  | { type: "task_snapshot"; taskId: string; status: string; waits: Array<{ id: string; reason: string }> }
  | { type: "queue_wait"; taskId: string; waits: Array<{ id: string; reason: string }> }
  | { type: "task_admitted"; taskId: string; trigger: string; prerequisiteTaskId?: string }
  | { type: "task_action"; taskId: string; action: string }
  | { type: "bridge_tool"; taskId: string; state: "requested" | "completed" | "error"; tool: string; result?: string }
  | { type: "recovery"; taskId: string; state: "requested" | "started" | "finished" | "error"; producer: "host"; durationMs?: number; result?: string }
  | { type: "headless_process"; state: "dispatched" | "started" | "exit_observed"; taskId: string; sessionId: string; turnId: string; generation: string; targetPid?: number; startTime?: string; exitCode?: number | null; exitSignal?: string | null }
  | { type: "command_process"; state: "running" | "finished" | "error"; taskId: string; stepId?: string; commandId: string; targetPid?: number; exitCode?: number | null; exitSignal?: string | null; durationMs?: number; timedOut?: boolean }
  | { type: "process_signal"; state: "requested" | "sent" | "skipped" | "error"; targetPid: number; targetStartTime?: string; targetName?: string; senderPid: number; signal: string; reason: string; result?: string }
  | { type: "native_turn"; state: "observed" | "dispatched" | "finished" | "snapshot" | "agent_final"; taskId: string; sessionId: string; turnId: string; nativeState?: string; reason?: string; admission?: string; elapsedMs?: number; outputAgeMs?: number | null; unsettledToolIds?: string[]; processRunning?: boolean }
  | { type: "client_lifecycle"; state: "startup" | "resumed" | "api_activity" | "pageshow" | "pagehide" | "visible" | "hidden" | "online" | "offline"; tabId: string; documentId: string; clientTime: string; visible: boolean; online: boolean }
  | { type: "history_socket"; state: "connected" | "closed"; taskId: string; sessionId: string };

export type EventContext = { source: string; trigger?: string; requestId?: string; clientId?: string; causeEventId?: string; taskId?: string };
export type ForwardedEventMeta = { eventId: string; producerTime: string; producerPid: number; producerSequence: number; processInstanceId: string };
export type EventSink = (event: SystemEvent, context: EventContext, forwarded?: ForwardedEventMeta) => string | undefined;
const storage = new AsyncLocalStorage<{ sink: EventSink; context: EventContext }>();

export function runWithSystemEvents<T>(sink: EventSink, context: EventContext, callback: () => T): T {
  return storage.run({ sink, context }, callback);
}
export function systemEvent(event: SystemEvent): string | undefined {
  try { const current = storage.getStore(); return current?.sink(event, current.context); }
  catch { return undefined; }
}
export function eventContext(): EventContext | undefined { return storage.getStore()?.context; }
export function hasSystemEventSink(): boolean { return storage.getStore() !== undefined; }
export function withEventCause<T>(causeEventId: string | undefined, callback: () => T): T {
  const current = storage.getStore();
  return current && causeEventId ? runWithSystemEvents(current.sink, { ...current.context, causeEventId }, callback) : callback();
}
export function withEventContext<T>(context: Partial<EventContext>, callback: () => T): T {
  const current = storage.getStore();
  return current ? runWithSystemEvents(current.sink, { ...current.context, ...context }, callback) : callback();
}

export function createSystemEventWriter(options: { directory: string; now?: () => Date; monotonic?: () => bigint; segmentBytes?: number; totalBytes?: number; retentionMs?: number; maxRecordBytes?: number }): EventSink {
  const now = options.now ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => process.hrtime.bigint());
  const bootId = randomUUID();
  const bootTime = monotonic();
  const segmentBytes = options.segmentBytes ?? 10 * 1024 * 1024;
  const totalBytes = options.totalBytes ?? 100 * 1024 * 1024;
  const retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxRecordBytes = options.maxRecordBytes ?? 8 * 1024;
  const current = join(options.directory, "system.log");
  let sequence = 0;
  let lastPrune = 0;
  let currentStartMs: number | undefined;
  const archive = /^system-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]+\.log$/;
  const prune = (time: number): void => {
    const files = readdirSync(options.directory).filter(name => archive.test(name)).map(name => ({ name, path: join(options.directory, name) })).map(file => ({ ...file, stat: statSync(file.path) })).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    let bytes = (existsSync(current) ? statSync(current).size : 0) + files.reduce((sum, file) => sum + file.stat.size, 0);
    for (const file of files) {
      if (time - file.stat.mtimeMs <= retentionMs && bytes <= totalBytes) continue;
      unlinkSync(file.path);
      bytes -= file.stat.size;
    }
  };
  const firstRecordTime = (): number | undefined => {
    if (currentStartMs !== undefined) return currentStartMs;
    if (!existsSync(current)) return undefined;
    const fd = openSync(current, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      if (count === 0) return undefined;
      const finalByte = Buffer.alloc(1);
      readSync(fd, finalByte, 0, 1, statSync(current).size - 1);
      if (finalByte[0] !== 10) return undefined;
      const firstLine = buffer.subarray(0, count).toString("utf8").split("\n", 1)[0];
      let record: unknown;
      try { record = JSON.parse(firstLine ?? "null"); } catch { return undefined; }
      if (record && typeof record === "object" && "time" in record && typeof record.time === "string") {
        const parsed = Date.parse(record.time);
        if (Number.isFinite(parsed)) return currentStartMs = parsed;
      }
      return undefined;
    } finally { closeSync(fd); }
  };
  return (event, context, forwarded) => {
    try {
      const time = now();
      const eventId = forwarded?.eventId ?? randomUUID();
      const record = redact({ schemaVersion: 1, time: time.toISOString(), eventId, bootId, sequence: ++sequence, pid: process.pid, bootElapsedMs: Number((monotonic() - bootTime) / 1_000_000n), ...(forwarded ? { producerTime: forwarded.producerTime, producerPid: forwarded.producerPid, producerSequence: forwarded.producerSequence, processInstanceId: forwarded.processInstanceId } : {}), ...context, ...event });
      const line = `${JSON.stringify(record)}\n`;
      const size = Buffer.byteLength(line);
      if (size > maxRecordBytes || size > totalBytes) return undefined;
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      const currentStat = existsSync(current) ? statSync(current) : undefined;
      const start = currentStat ? firstRecordTime() : undefined;
      const rotate = currentStat && currentStat.size > 0 && (start === undefined || currentStat.size + size > Math.min(segmentBytes, totalBytes) || time.getTime() - start > retentionMs || new Date(start).toISOString().slice(0, 10) !== time.toISOString().slice(0, 10));
      if (rotate) {
        renameSync(current, join(options.directory, `system-${time.toISOString().replaceAll(":", "-")}-${randomUUID()}.log`));
        currentStartMs = undefined;
      }
      appendFileSync(current, line, { mode: 0o600 });
      currentStartMs ??= time.getTime();
      chmodSync(current, 0o600);
      if (rotate || time.getTime() - lastPrune >= 60_000 || readdirSync(options.directory).some(name => archive.test(name))) { lastPrune = time.getTime(); prune(lastPrune); }
      return eventId;
    } catch { return undefined; }
  };
}

export function systemLogDirectory(dataRoot: string): string {
  return join(basename(dataRoot) === "data" && basename(dirname(dataRoot)) === ".suplex" ? dirname(dataRoot) : dataRoot, "logs");
}
