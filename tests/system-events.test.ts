import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createSystemEventWriter, runWithSystemEvents, systemEvent, systemLogDirectory } from "../src/platform/system-events.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const directory = (): string => { const path = mkdtempSync(join(tmpdir(), "forge-system-events-")); directories.push(path); return path; };
const heartbeat = () => ({ type: "server" as const, state: "heartbeat" as const });

test("production and fixture log directories are isolated", () => {
  expect(systemLogDirectory("/repo/.forge/data")).toBe("/repo/.forge/logs");
  expect(systemLogDirectory("/tmp/fixture")).toBe("/tmp/fixture/logs");
});

test("records are bounded, redacted, correlated, and privately written", () => {
  const path = directory();
  const sink = createSystemEventWriter({ directory: path });
  runWithSystemEvents(sink, { source: "test", requestId: "request-1", clientId: "client-1" }, () => {
    expect(systemEvent({ type: "recovery", taskId: "task-1", state: "requested", producer: "host", result: "Bearer secret-value" })).toBeTypeOf("string");
  });
  const file = join(path, "system.log");
  const record = JSON.parse(readFileSync(file, "utf8"));
  expect(record).toMatchObject({ schemaVersion: 1, type: "recovery", taskId: "task-1", requestId: "request-1", clientId: "client-1", sequence: 1 });
  expect(record.result).toBe("[REDACTED]");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).not.toContain("secret-value");
});

test("forwarded bridge identity stays separate from the API writer identity", () => {
  const path = directory();
  const sink = createSystemEventWriter({ directory: path });
  const eventId = "11111111-1111-4111-8111-111111111111";
  sink({ type: "task_admitted", taskId: "task-2", trigger: "prerequisite completion", prerequisiteTaskId: "task-1" }, { source: "root_bridge", taskId: "task-1", causeEventId: "22222222-2222-4222-8222-222222222222" }, { eventId, producerTime: "2026-09-22T12:00:00.000Z", producerPid: 12345, producerSequence: 7, processInstanceId: "33333333-3333-4333-8333-333333333333" });
  expect(JSON.parse(readFileSync(join(path, "system.log"), "utf8"))).toMatchObject({ eventId, pid: process.pid, producerPid: 12345, producerSequence: 7, source: "root_bridge", taskId: "task-2", prerequisiteTaskId: "task-1" });
});

test("rotation prunes old archives and enforces total bytes on each rotation", () => {
  const path = directory();
  let time = new Date("2026-09-22T12:00:00Z");
  const sink = createSystemEventWriter({ directory: path, now: () => time, segmentBytes: 650, totalBytes: 1200 });
  for (let index = 0; index < 20; index += 1) sink({ type: "task_status", taskId: `task-${index}`, status: "active" }, { source: "test" });
  const files = readdirSync(path);
  expect(files.some(name => name.startsWith("system-"))).toBe(true);
  expect(files.reduce((sum, name) => sum + statSync(join(path, name)).size, 0)).toBeLessThanOrEqual(1200);
  const old = new Date("2026-09-01T12:00:00Z");
  for (const name of files) utimesSync(join(path, name), old, old);
  time = new Date("2026-09-23T12:00:00Z");
  sink(heartbeat(), { source: "test" });
  expect(readdirSync(path)).toEqual(["system.log"]);
});

test("writer failures and oversize events do not affect callers", () => {
  const path = directory();
  const sink = createSystemEventWriter({ directory: path, maxRecordBytes: 250 });
  expect(() => sink({ type: "task_status", taskId: "x".repeat(1000), status: "active" }, { source: "test" })).not.toThrow();
  expect(readdirSync(path)).toEqual([]);
  const parentFile = join(path, "unavailable");
  writeFileSync(parentFile, "file");
  const unavailable = createSystemEventWriter({ directory: join(parentFile, "logs") });
  expect(unavailable(heartbeat(), { source: "test" })).toBeUndefined();
});

test("a corrupt current segment is preserved and logging resumes in a clean file", () => {
  const path = directory();
  writeFileSync(join(path, "system.log"), '{"time":"2026-09-01T00:00:00.000Z"');
  const sink = createSystemEventWriter({ directory: path, now: () => new Date("2026-09-22T12:00:00Z") });
  expect(sink(heartbeat(), { source: "test" })).toBeTypeOf("string");
  expect(JSON.parse(readFileSync(join(path, "system.log"), "utf8"))).toMatchObject({ type: "server", state: "heartbeat" });
  const archives = readdirSync(path).filter(name => name.startsWith("system-"));
  expect(archives).toHaveLength(1);
  expect(readFileSync(join(path, archives[0]!), "utf8")).toBe('{"time":"2026-09-01T00:00:00.000Z"');
});
