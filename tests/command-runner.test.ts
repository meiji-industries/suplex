import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { beforeEach, expect, test, vi } from "vitest";

import { CommandCleanupError, runCommand, setCommandRunnerLogger } from "../src/platform/command-runner.js";
import { StructuredLogger } from "../src/platform/logging.js";
import { compareProcessIdentity, defaultProcessController, inspectProcessOnce, signalOwnedProcess, type OwnedProcess } from "../src/platform/process-manager.js";
import { json } from "../src/shared/json.js";

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

test("logs configured probe exit codes at debug", async () => {
  await runCommand({ taskId: null, stepId: null, expectedExitCodes: [1], command: "sh", args: ["-c", "exit 1"] });

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

test("retains spawn failures and child signals", async () => {
  const missing = await runCommand({ taskId: null, stepId: null, command: "/definitely/missing/forge-command", args: [] });
  expect(missing).toMatchObject({ exitCode: null, spawnError: { code: "ENOENT" }, timedOut: false });

  const killed = await runCommand({ taskId: null, stepId: null, command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGKILL')"] });
  expect(killed).toMatchObject({ exitCode: null, signal: "SIGKILL" });
});

test("truncates stream tails while retaining full 256 KiB output", { timeout: 15_000 }, async () => {
  const bytesPerStream = 256 * 1024;
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

  expect(Buffer.byteLength(result.stdout)).toBe(bytesPerStream);
  expect(Buffer.byteLength(result.stderr)).toBe(bytesPerStream);
  expect(result.exitCode).toBe(0);
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
    message: expect.stringMatching(/\(exit SIGKILL, timed out\)$/),
  })]);
});

test.skipIf(process.platform === "win32")("does not complete a timeout when owned-group termination fails", async () => {
  const originalKill = process.kill;
  let processGroup: number | undefined;
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && signal === "SIGKILL") {
      processGroup = -pid;
      throw new Error("forced SIGKILL failure");
    }
    return originalKill(pid, signal);
  });

  try {
    await expect(runCommand({
      taskId: null,
      stepId: null,
      command: process.execPath,
      args: ["-e", `process.on("SIGTERM", () => {}); require("node:net").createServer().listen(0)`],
      timeout: 500,
    })).rejects.toThrow("forced SIGKILL failure");
  } finally {
    kill.mockRestore();
    if (processGroup !== undefined) originalKill(-processGroup, "SIGKILL");
  }
});

// The held-pipe case depends on real process-group and descriptor lifetimes.
test.skipIf(process.platform === "win32")("timeout kills an owned group when a descendant holds its pipes", async () => {
  const descendant = `process.on("SIGTERM", () => process.stderr.write("descendant-term\\n")); setInterval(() => {}, 1_000)`;
  const parent = `
    process.stdout.write("group=" + process.pid + "\\n");
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
  const processGroup = Number(result.stdout.match(/group=(\d+)/)?.[1]);
  expect(processGroup).toBeGreaterThan(0);
  expect(await defaultProcessController.isProcessGroupAlive!(processGroup)).toBe(false);
  expect(result.stderr).toContain("descendant-term");
  expect(result.durationMs).toBeGreaterThanOrEqual(500);
  expect(result.durationMs).toBeLessThan(3_000);
});

// A detached child creates a new POSIX session; Windows cannot express or inspect this ownership boundary.
// Real clocks are required because fake timers cannot advance OS process or descriptor lifetimes.
test.skipIf(process.platform === "win32")("hard-stops after an escaped descendant retains command pipes", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-command-runner-"));
  const pidFile = join(directory, "descendant.pid");
  const secret = "escapedsecretvalue";
  const descendant = `process.stdout.write("escaped-output token=${secret}\\n"); setTimeout(() => process.exit(0), 30_000); setInterval(() => {}, 1_000)`;
  const parent = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.stdout.write("group=" + process.pid + "\\n");
    child.unref();
    setInterval(() => {}, 1_000);
  `;
  const command = runCommand({
    taskId: null,
    stepId: null,
    command: process.execPath,
    args: ["-e", parent],
    timeout: 500,
  }).then(
    (result) => ({ kind: "result" as const, result }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  let escaped: OwnedProcess | undefined;
  let settlementDeadline: NodeJS.Timeout | undefined;

  try {
    let descendantPid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        descendantPid = Number(await readFile(pidFile, "utf8"));
        if (Number.isSafeInteger(descendantPid) && descendantPid > 0) break;
      } catch {
        // The parent has not published the exact descendant PID yet.
      }
      await delay(25);
    }
    expect(descendantPid).toBeGreaterThan(0);
    if (!descendantPid) throw new Error("escaped descendant did not publish its PID");
    const inspection = await defaultProcessController.inspect(descendantPid);
    expect(inspection).toMatchObject({ pid: descendantPid, processGroup: descendantPid });
    if (!inspection) throw new Error("escaped descendant identity could not be inspected");
    escaped = {
      name: "command-runner escaped test descendant",
      pid: descendantPid,
      command: inspection.command,
      startedAt: new Date().toISOString(),
      processGroup: inspection.processGroup,
      startTime: inspection.startTime,
      executable: inspection.executable,
      argv: inspection.argv,
      ...(inspection.ownerUid === undefined ? {} : { ownerUid: inspection.ownerUid }),
    };

    const unsettled = new Promise<{ kind: "unsettled" }>((resolve) => {
      settlementDeadline = setTimeout(() => resolve({ kind: "unsettled" }), 3_000);
    });
    const outcome = await Promise.race([command, unsettled]);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("runCommand did not return the expected cleanup error");
    expect(outcome.error).toBeInstanceOf(CommandCleanupError);
    if (!(outcome.error instanceof CommandCleanupError)) throw new Error("runCommand returned the wrong cleanup error");
    expect(outcome.error.result).toMatchObject({
      exitCode: null,
      timedOut: true,
      stdout: expect.stringContaining("escaped-output"),
    });
    const result = outcome.error.result;
    expect(outcome.error.stdout).toBe(result.stdout);
    expect(outcome.error.timedOut).toBe(true);
    expect(JSON.stringify({ result, lines })).not.toContain(secret);
    expect(result.stdout).toContain("[REDACTED]");
    const processGroup = Number(result.stdout.match(/group=(\d+)/)?.[1]);
    expect(processGroup).toBeGreaterThan(0);
    expect(await defaultProcessController.isProcessGroupAlive!(processGroup)).toBe(false);
    expect(compareProcessIdentity(escaped, await inspectProcessOnce(escaped.pid)).kind).toBe("exact_match");
    expect(result.durationMs).toBeGreaterThanOrEqual(500);
    expect(result.durationMs).toBeLessThan(3_000);
    expect(records()).toEqual([expect.objectContaining({
      level: 50,
      message: expect.stringMatching(/^Command hard-stopped after timeout because cleanup could not be proven:/),
    })]);
  } finally {
    clearTimeout(settlementDeadline);
    try {
      if (escaped) {
        await signalOwnedProcess(escaped, "SIGKILL", {
          inspect: inspectProcessOnce,
          async signal(pid, signal) {
            process.kill(pid, signal);
          },
        });
      }
      await command;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
