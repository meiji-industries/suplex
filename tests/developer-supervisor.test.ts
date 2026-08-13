import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { DeveloperSupervisorInvocationSchema, DeveloperSupervisorResultSchema } from "../src/developer-supervisor-protocol.js";
import { developerSupervisorSocketPath, observeOwnedProcessExit } from "../src/developer-supervisor.js";

test("uses a short deterministic socket for long runtime paths", () => {
  const executionRoot = "/Users/dev/conductor/workspaces/forge/curitiba-v1/.forge/data/runtime/developer-executions/developer_aaaaaaaaaaaaaaaaaaaaaaaa";
  const socketPath = developerSupervisorSocketPath(executionRoot);
  expect(socketPath).toMatch(/^\/private\/tmp\/forge-developer-[a-f0-9]{24}\.sock$/);
  expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(100);
});

test("INV-06 real supervisor writes one bounded, hashed result envelope", async () => {
  const root = await mkdtemp(join("/tmp", "fg-sup-"));
  const executionRoot = join(root, "runtime".repeat(9), "developer-executions", `developer_${"a".repeat(24)}`);
  const token = "supervisor-test-token";
  try {
    const invocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId: `developer_${"a".repeat(24)}`, command: process.execPath, args: ["--input-type=module", "-e", "for (let i = 0; i < 20; i += 1) { process.stdout.write('out-' + i + '\\n'); process.stderr.write('err-' + i + '\\n'); }"], cwd: process.cwd(), env: {} });
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(executionRoot, "invocation.json"), JSON.stringify(invocation));
    const source = fileURLToPath(new URL("../src/developer-supervisor.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", source, executionRoot], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let stderr = "";
    let exitCode: number | null = null;
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => { exitCode = code; });
    const tokenPipe = child.stdio[3];
    if (!tokenPipe || typeof tokenPipe === "string" || !("end" in tokenPipe)) throw new Error("supervisor token pipe unavailable");
    tokenPipe.end(token);
    const resultPath = join(executionRoot, "result.json");
    let result: ReturnType<typeof DeveloperSupervisorResultSchema.parse> | undefined;
    for (let attempt = 0; attempt < 100 && !result; attempt += 1) {
      try { result = DeveloperSupervisorResultSchema.parse(JSON.parse(await readFile(resultPath, "utf8"))); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    let snapshot = "";
    try { snapshot = await readFile(join(executionRoot, "supervisor.json"), "utf8"); } catch { /* no snapshot */ }
    expect(result, `${stderr} ${snapshot} (exit=${exitCode})`).toBeDefined();
    expect(result?.exitCode).toBe(0);
    expect(result?.outputPath).toBe("events.jsonl");
    const events = (await readFile(join(executionRoot, "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { sequence: number; line: string });
    expect(events).toHaveLength(40);
    expect(events.map((event) => event.sequence)).toEqual([...events].sort((left, right) => left.sequence - right.sequence).map((event) => event.sequence));
    expect(events.map((event) => event.line)).toContain("out-0");
    expect(events.map((event) => event.line)).toContain("err-19");
    expect(await readFile(join(executionRoot, "heartbeat.json"), "utf8")).toContain("result_ready");
    for (let attempt = 0; attempt < 100 && exitCode === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test("INV-11/INV-12 PID reuse during cancellation is ambiguous, never exited", async () => {
  const child = { pid: 42, processGroup: 42, startTime: "original", executable: "/usr/bin/codex", argv: ["codex", "exec"], ownerUid: 501 };
  const observation = await observeOwnedProcessExit({
    async inspect() { return { pid: 42, processGroup: 42, startTime: "reused", command: "codex exec", executable: "/usr/bin/codex", argv: ["codex", "exec"], ownerUid: 501 }; },
    async signal() { throw new Error("must not signal"); },
  }, child);
  expect(observation).toBe("ownership_ambiguous");
});
