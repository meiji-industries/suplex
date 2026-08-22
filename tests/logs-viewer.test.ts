import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { parseSince, runLogViewer } from "../src/log-viewer.js";

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-logs-"));
  await writeFile(join(directory, "api.log"), [
    JSON.stringify({ time: "2026-08-22T12:00:02.000Z", level: 20, msg: "request", req: { method: "GET", url: "/api/tasks/task-a" }, res: { statusCode: 200 } }),
    JSON.stringify({ time: "2026-08-22T12:00:04.000Z", level: 50, msg: "api failure", taskId: "task-b", err: { message: "bad" } }),
  ].join("\n"));
  await writeFile(join(directory, "worker.log"), `${JSON.stringify({ time: "2026-08-22T12:00:03.000Z", level: 40, msg: "activity warning", workflowId: "task-a-workflow" })}\n`);
  return directory;
}

test("merges timestamp order and filters task identifiers across URLs and workflows", async () => {
  const output: string[] = [];
  await runLogViewer({ directory: await fixture(), taskId: "task-a", follow: false, all: true, color: false, output: { write: (line: string) => { output.push(line); return true; } } });
  expect(output.join("")).toContain("GET /api/tasks/task-a 200");
  expect(output.join("")).toContain("workflowId=task-a-workflow");
  expect(output.join("")).not.toContain("api failure");
});

test("hides debug request records unless all is enabled", async () => {
  const normal: string[] = [];
  await runLogViewer({ directory: await fixture(), follow: false, color: false, output: { write: (line: string) => { normal.push(line); return true; } } });
  expect(normal.join("")).not.toContain("GET /api/tasks/task-a 200");

  const all: string[] = [];
  await runLogViewer({ directory: await fixture(), follow: false, all: true, color: false, output: { write: (line: string) => { all.push(line); return true; } } });
  expect(all.join("")).toContain("GET /api/tasks/task-a 200");
});

test("filters error levels and validates --since durations", async () => {
  const output: string[] = [];
  await runLogViewer({ directory: await fixture(), errors: true, follow: false, color: false, output: { write: (line: string) => { output.push(line); return true; } } });
  expect(output.join("")).toContain("activity warning");
  expect(output.join("")).toContain("api failure");
  expect(parseSince("10m")).toBe(600_000);
  expect(() => parseSince("soon")).toThrow("Invalid --since value");
});
