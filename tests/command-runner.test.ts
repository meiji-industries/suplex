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

test("keeps unexpected probe failures at error level", async () => {
  await runCommand({ taskId: null, stepId: null, expectNonZero: (result) => result.stderr.includes("not found"), command: "sh", args: ["-c", "echo permission-denied >&2; exit 3"] });

  expect(records()).toEqual([expect.objectContaining({ level: 50, error: "permission-denied" })]);
});

test("logs completed commands at info", async () => {
  await runCommand({ taskId: null, stepId: null, command: "sh", args: ["-c", "exit 0"] });

  expect(records()).toEqual([expect.objectContaining({ level: 30, message: expect.stringMatching(/^Command completed:/) })]);
});

test("retains exact byte tails while streaming 100 MiB", { timeout: 15_000 }, async () => {
  const bytesPerStream = 50 * 1024 * 1024;
  const script = `
    const { once } = require("node:events");
    const chunk = "x".repeat(64 * 1024);
    (async () => {
      for (const stream of [process.stdout, process.stderr]) {
        let remaining = ${bytesPerStream};
        while (remaining > 0) {
          const output = remaining < chunk.length ? chunk.slice(0, remaining) : chunk;
          remaining -= output.length;
          if (!stream.write(output)) await once(stream, "drain");
        }
      }
    })();
  `;

  const result = await runCommand({ taskId: null, stepId: null, command: process.execPath, args: ["-e", script] });

  expect(Buffer.byteLength(result.stdout)).toBe(8 * 1024);
  expect(Buffer.byteLength(result.stderr)).toBe(8 * 1024);
  expect(result.entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0)).toBe(8 * 1024);
  expect(lines.join("\n").length).toBeLessThan(2_048);
});

test("redacts retained output and stream entries", async () => {
  const secret = "supersecretvalue";
  const result = await runCommand({
    taskId: null,
    stepId: null,
    command: process.execPath,
    args: ["-e", `console.log("token=${secret}"); console.error("authorization: Bearer ${secret}")`],
  });

  expect(JSON.stringify({ stdout: result.stdout, stderr: result.stderr, entries: result.entries, lines })).not.toContain(secret);
  expect(result.stdout).toContain("[REDACTED]");
  expect(result.stderr).toContain("[REDACTED]");
});

// Real subprocess clocks are required here: fake timers cannot deliver OS signals.
test.skipIf(process.platform === "win32")("timeout escalates when the owned child ignores SIGTERM", async () => {
  const script = `process.on("SIGTERM", () => process.stderr.write("term-observed\\n")); setInterval(() => {}, 1_000)`;

  const result = await runCommand({
    taskId: null,
    stepId: null,
    command: process.execPath,
    args: ["-e", script],
    timeout: 500,
  });

  expect(result).toMatchObject({ exitCode: null, timedOut: true });
  expect(result.stderr).toContain("term-observed");
  expect(result.durationMs).toBeGreaterThanOrEqual(500);
  expect(result.durationMs).toBeLessThan(3_000);
  expect(records()).toEqual([expect.objectContaining({
    level: 50,
    message: expect.stringMatching(/\(exit signal, timed out\)$/),
  })]);
});

// The held-pipe case depends on real process-group and descriptor lifetimes.
test.skipIf(process.platform === "win32")("timeout kills an owned group when a descendant holds its pipes", async () => {
  const descendant = `process.on("SIGTERM", () => process.stderr.write("descendant-term\\n")); setInterval(() => {}, 1_000)`;
  const parent = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });
    child.unref();
  `;

  const result = await runCommand({
    taskId: null,
    stepId: null,
    command: process.execPath,
    args: ["-e", parent],
    timeout: 500,
  });

  expect(result).toMatchObject({ exitCode: null, timedOut: true });
  expect(result.stderr).toContain("descendant-term");
  expect(result.durationMs).toBeGreaterThanOrEqual(500);
  expect(result.durationMs).toBeLessThan(3_000);
});
