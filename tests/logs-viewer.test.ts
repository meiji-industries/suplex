import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { parseSince, runLogViewer } from "../src/log-viewer.js";

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-logs-"));
  await writeFile(join(directory, "api.log"), [
    JSON.stringify({ time: "2026-08-22T12:00:02.000Z", level: 30, msg: "request completed", req: { method: "GET", url: "/api/tasks/task-a" }, res: { statusCode: 200 } }),
    JSON.stringify({ time: "2026-08-22T12:00:04.000Z", level: 50, msg: "api failure", taskId: "task-b", err: { message: "bad" } }),
  ].join("\n"));
  await writeFile(join(directory, "worker.log"), `${JSON.stringify({ time: "2026-08-22T12:00:03.000Z", level: 40, msg: "activity warning", workflowId: "task-a-workflow" })}\n`);
  return directory;
}

test("merges timestamp order and filters task identifiers across URLs and workflows", async () => {
  const output: string[] = [];
  await runLogViewer({ directory: await fixture(), taskId: "task-a", follow: false, color: false, output: { write: (line: string) => { output.push(line); return true; } } });
  expect(output.join("")).toContain("GET /api/tasks/task-a 200");
  expect(output.join("")).toContain("workflowId=task-a-workflow");
  expect(output.join("")).not.toContain("api failure");
});

test("filters error levels and validates --since durations", async () => {
  const output: string[] = [];
  await runLogViewer({ directory: await fixture(), errors: true, follow: false, color: false, output: { write: (line: string) => { output.push(line); return true; } } });
  expect(output.join("")).toContain("activity warning");
  expect(output.join("")).toContain("api failure");
  expect(parseSince("10m")).toBe(600_000);
  expect(() => parseSince("soon")).toThrow("Invalid --since value");
});
