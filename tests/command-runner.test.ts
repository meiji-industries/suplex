import { beforeEach, expect, test } from "vitest";

import { runCommand, setCommandRunnerLogger } from "../src/command-runner.js";
import { StructuredLogger } from "../src/logging.js";
import { json } from "../src/task-utils.js";

let lines: string[];

beforeEach(() => {
  lines = [];
  setCommandRunnerLogger(new StructuredLogger((line) => lines.push(line)));
});

function records(): Array<Record<string, unknown>> {
  return lines.map((line) => json<Record<string, unknown>>(line, {}));
}

test("logs failed commands with stderr detail", async () => {
  await runCommand({ taskId: null, stepId: null, command: "sh", args: ["-c", "echo boom >&2; exit 3"] });

  expect(records()).toEqual([expect.objectContaining({
    level: 50,
    message: expect.stringMatching(/^Command failed: sh .* \(exit 3\)$/),
    error: "boom",
  })]);
});

test("logs expected non-zero commands at debug", async () => {
  await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "sh", args: ["-c", "exit 3"] });

  expect(records()).not.toContainEqual(expect.objectContaining({ level: 50 }));
});

test("logs completed commands at info", async () => {
  await runCommand({ taskId: null, stepId: null, command: "sh", args: ["-c", "exit 0"] });

  expect(records()).toEqual([expect.objectContaining({ level: 30, message: expect.stringMatching(/^Command completed:/) })]);
});
