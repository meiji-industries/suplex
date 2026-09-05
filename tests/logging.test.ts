import { expect, test } from "vitest";

import { createAppServer } from "../src/app.js";
import { createTestConfig } from "../src/config.js";
import type { HostHealthDependencies } from "../src/health.js";
import { configureProcessLogSink, createFastifyLogger, formatDevLogLine, StructuredLogger } from "../src/logging.js";
import { jsonRequired } from "../src/task-utils.js";

function records(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => jsonRequired(line) as Record<string, unknown>);
}

test("bridge logging redirects loggers created before and after bridge initialization", () => {
  const early = new StructuredLogger();
  const lines: string[] = [];
  configureProcessLogSink(line => lines.push(line));
  early.info("early logger");
  new StructuredLogger().info("late logger");
  expect(records(lines).map(record => record.message)).toEqual(["early logger", "late logger"]);
});

function createLoggingApp(lines: string[]) {
  return createAppServer({
    config: createTestConfig("/tmp/forge-logging-test"),
    health: {} as HostHealthDependencies,
    logger: createFastifyLogger((line) => lines.push(line)),
  });
}

test("a fast successful GET is retained at debug and silent at info", async () => {
  const lines: string[] = [];
  const app = createLoggingApp(lines);
  app.get("/fast", () => ({ ok: true }));

  expect((await app.inject({ method: "GET", url: "/fast" })).statusCode).toBe(200);
  await app.close();

  const output = records(lines);
  expect(output.filter((record) => record.level === 30)).toHaveLength(0);
  expect(output).toEqual([expect.objectContaining({ level: 20, msg: "request", req: expect.objectContaining({ method: "GET", url: "/fast" }), res: { statusCode: 200 } })]);
});

test("a failure emits one access line and keeps the error details", async () => {
  const lines: string[] = [];
  const app = createLoggingApp(lines);
  app.get("/boom", () => { throw new Error("boom"); });

  expect((await app.inject({ method: "GET", url: "/boom" })).statusCode).toBe(500);
  await app.close();

  const output = records(lines);
  expect(output.filter((record) => record.msg === "request")).toEqual([expect.objectContaining({ level: 50, req: expect.objectContaining({ method: "GET", url: "/boom" }), res: { statusCode: 500 } })]);
  expect(output).toContainEqual(expect.objectContaining({ msg: "Unhandled request error", error: "boom" }));
});

test("a mutation emits one info access line", async () => {
  const lines: string[] = [];
  const app = createLoggingApp(lines);
  app.post("/mutate", () => ({ ok: true }));

  expect((await app.inject({ method: "POST", url: "/mutate" })).statusCode).toBe(200);
  await app.close();

  expect(records(lines)).toEqual([expect.objectContaining({ level: 30, msg: "request", req: expect.objectContaining({ method: "POST", url: "/mutate" }), res: { statusCode: 200 } })]);
});

test("FORGE_LOG_REQUESTS shows otherwise-debug request records", () => {
  const original = process.env.FORGE_LOG_REQUESTS;
  process.env.FORGE_LOG_REQUESTS = "1";
  try {
    expect(formatDevLogLine({
      level: 20,
      timestamp: new Date(2026, 7, 22, 12, 34, 56).getTime(),
      msg: "request",
      reqId: "req-fa",
      req: { method: "GET", url: "/api/tasks/123" },
      res: { statusCode: 200 },
      responseTime: 4.4,
    }, { color: false, component: "api" })).toBe("12:34:56  INFO  api        GET /api/tasks/123 200 4ms  reqId=req-fa");
  } finally {
    if (original === undefined) delete process.env.FORGE_LOG_REQUESTS;
    else process.env.FORGE_LOG_REQUESTS = original;
  }
});

test("prints error messages with an indented stack", () => {
  expect(formatDevLogLine({
    level: 50,
    timestamp: new Date(2026, 7, 22, 12, 34, 56).getTime(),
    msg: "Builder launch failed",
    executionId: "exec-1",
    err: { message: "process exited 1", stack: "Error: process exited 1\n    at launch (runner.ts:1:1)" },
  }, { color: false, component: "worker" })).toBe("12:34:56  ERROR worker     Builder launch failed  executionId=exec-1 error=process exited 1\n    Error: process exited 1\n        at launch (runner.ts:1:1)");
});

test("prints command failure detail", () => {
  const line = formatDevLogLine({
    level: 50,
    timestamp: new Date(2026, 7, 22, 12, 34, 56).getTime(),
    msg: "Command failed: git cat-file -e HEAD:x (exit 1)",
    error: "fatal: Not a valid object name",
  }, { color: false, component: "worker" });

  expect(line).toContain("Command failed: git cat-file -e HEAD:x (exit 1)");
  expect(line).toContain("error=fatal: Not a valid object name");
});

test("NO_COLOR disables ANSI formatting", () => {
  const original = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    expect(formatDevLogLine({ level: 40, timestamp: "2026-08-22T12:34:56.000Z", msg: "Careful" }, { component: "worker" })).not.toMatch(/\u001B\[/);
  } finally {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  }
});
