import { expect, test } from "vitest";

import { formatDevLogLine } from "../src/logging.js";

test("collapses Fastify request pairs into the completed request line", () => {
  expect(formatDevLogLine({ level: 30, msg: "incoming request", req: { method: "GET", url: "/api/tasks/123" } }, { color: false, component: "api" })).toBeNull();

  expect(formatDevLogLine({
    level: 30,
    timestamp: new Date(2026, 7, 22, 12, 34, 56).getTime(),
    msg: "request completed",
    reqId: "req-fa",
    req: { method: "GET", url: "/api/tasks/123" },
    res: { statusCode: 200 },
    responseTime: 4.4,
  }, { color: false, component: "api" })).toBe("12:34:56  INFO  api        GET /api/tasks/123 200 4ms  reqId=req-fa");
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
