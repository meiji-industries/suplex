import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { DeveloperSupervisorInvocationSchema, DeveloperSupervisorResultSchema } from "../src/developer-supervisor-protocol.js";
import { developerSupervisorSocketPath, developerSupervisorSpawnOptions, observeOwnedProcessExit } from "../src/developer-supervisor.js";

test("supervisor spawn is detached and has no worker-owned stdio pipes", () => {
  expect(developerSupervisorSpawnOptions()).toMatchObject({ detached: true, stdio: "ignore" });
});

test("uses a short deterministic socket for long runtime paths", () => {
  const executionRoot = "/Users/dev/conductor/workspaces/forge/curitiba-v1/.forge/data/runtime/developer-executions/developer_aaaaaaaaaaaaaaaaaaaaaaaa";
  const socketPath = developerSupervisorSocketPath(executionRoot);
  expect(socketPath).toMatch(/^\/tmp\/forge-developer-[a-f0-9]{24}\.sock$/);
  expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(100);
});

test("supervisor feeds the durable prompt file to the child stdin", async () => {
  const root = await mkdtemp(join("/tmp", "fg-sup-prompt-"));
  const executionId = `developer_${"d".repeat(24)}`;
  const executionRoot = join(root, "developer-executions", executionId);
  try {
    const invocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId, command: process.execPath, args: ["-e", "process.stdin.on('data', (chunk) => process.stdout.write(chunk))"], cwd: root, env: {} });
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(executionRoot, "invocation.json"), `${JSON.stringify(invocation)}\n`);
    await writeFile(join(executionRoot, "prompt.txt"), "durable retry prompt\n", { mode: 0o600 });
    await writeFile(join(executionRoot, "lease-token"), "supervisor-test-token", { mode: 0o600 });
    const source = fileURLToPath(new URL("../src/developer-supervisor.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", source, executionRoot], { stdio: ["ignore", "pipe", "pipe"] });
    child.unref();
    const resultPath = join(executionRoot, "result.json");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        DeveloperSupervisorResultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
        break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    const events = await readFile(join(executionRoot, "events.jsonl"), "utf8");
    expect(events).toContain("durable retry prompt");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test("INV-06 real supervisor writes one bounded, hashed result envelope", async () => {
  const root = await mkdtemp(join("/tmp", "fg-sup-"));
  const executionRoot = join(root, "runtime".repeat(9), "developer-executions", `developer_${"a".repeat(24)}`);
  const token = "supervisor-test-token";
  try {
    const longPrompt = Array.from({ length: 302 }, (_, index) => `word${index}`).join(" ");
    const invocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId: `developer_${"a".repeat(24)}`, command: process.execPath, args: ["--input-type=module", "-e", "for (let i = 0; i < 20; i += 1) { process.stdout.write('out-' + i + '\\n'); process.stderr.write('err-' + i + '\\n'); } setTimeout(() => undefined, 1_000);", longPrompt], cwd: process.cwd(), env: {} });
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(executionRoot, "invocation.json"), JSON.stringify(invocation));
    await writeFile(join(executionRoot, "prompt.txt"), longPrompt, { mode: 0o600 });
    await writeFile(join(executionRoot, "lease-token"), token, { mode: 0o600 });
    const source = fileURLToPath(new URL("../src/developer-supervisor.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", source, executionRoot], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let exitCode: number | null = null;
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => { exitCode = code; });
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
    expect(result?.child.argv).toEqual([expect.stringMatching(/^sha256:[a-f0-9]{64}$/)]);
    const events = (await readFile(join(executionRoot, "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { sequence: number; line: string });
    expect(events).toHaveLength(40);
    expect(events.map((event) => event.sequence)).toEqual([...events].sort((left, right) => left.sequence - right.sequence).map((event) => event.sequence));
    expect(events.map((event) => event.line)).toContain("out-0");
    expect(events.map((event) => event.line)).toContain("err-19");
    // finalize() renames result.json into place, then updates state.status and writes heartbeat.json, so
    // heartbeat.json can still say "running" for a moment after result.json is observable; poll it too.
    let heartbeat = "";
    for (let attempt = 0; attempt < 100 && !heartbeat.includes("result_ready"); attempt += 1) {
      try { heartbeat = await readFile(join(executionRoot, "heartbeat.json"), "utf8"); } catch { /* not yet written */ }
      if (!heartbeat.includes("result_ready")) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(heartbeat).toContain("result_ready");
    for (let attempt = 0; attempt < 100 && exitCode === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test("supervisor failure before child spawn writes a failed snapshot instead of dying silently", async () => {
  const root = await mkdtemp(join("/tmp", "fg-sup-fail-"));
  const executionRoot = join(root, "developer-executions", `developer_${"b".repeat(24)}`);
  try {
    const invocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId: `developer_${"b".repeat(24)}`, command: join(root, "missing-binary"), args: ["run"], cwd: root, env: {} });
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(executionRoot, "invocation.json"), JSON.stringify(invocation));
    await writeFile(join(executionRoot, "lease-token"), "supervisor-test-token", { mode: 0o600 });
    const source = fileURLToPath(new URL("../src/developer-supervisor.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", source, executionRoot], { stdio: ["ignore", "pipe", "pipe"] });
    let exitCode: number | null = null;
    child.on("exit", (code) => { exitCode = code; });
    let snapshot: { status?: string } = {};
    for (let attempt = 0; attempt < 200 && snapshot.status !== "failed"; attempt += 1) {
      try { snapshot = JSON.parse(await readFile(join(executionRoot, "supervisor.json"), "utf8")) as { status?: string }; } catch { /* not yet written */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(snapshot.status).toBe("failed");
    for (let attempt = 0; attempt < 100 && exitCode === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exitCode).toBe(1);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}, 20_000);

test("PID reuse is live while cancellation observes process liveness", async () => {
  const child = { pid: 42, processGroup: 42, startTime: "original", executable: "/usr/bin/codex", argv: ["codex", "exec"], ownerUid: 501 };
  const observation = await observeOwnedProcessExit({
    async inspect() { return { pid: 42, processGroup: 42, startTime: "reused", command: "codex exec", executable: "/usr/bin/codex", argv: ["codex", "exec"], ownerUid: 501 }; },
    async signal() { throw new Error("must not signal"); },
  }, child);
  expect(observation).toBe("running");
});

test("a failing heartbeat write does not kill the supervisor or orphan the child", async () => {
  const root = await mkdtemp(join("/tmp", "fg-sup-hb-"));
  const executionId = `developer_${"c".repeat(24)}`;
  const executionRoot = join(root, "developer-executions", executionId);
  try {
    const invocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId, command: process.execPath, args: ["-e", "setTimeout(() => process.stdout.write('done\\n'), 5_000);"], cwd: root, env: {} });
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(executionRoot, "invocation.json"), JSON.stringify(invocation));
    await writeFile(join(executionRoot, "prompt.txt"), "heartbeat prompt", { mode: 0o600 });
    await writeFile(join(executionRoot, "lease-token"), "supervisor-test-token", { mode: 0o600 });
    const source = fileURLToPath(new URL("../src/developer-supervisor.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", source, executionRoot], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let exited: number | null = null;
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => { exited = code; });
    const heartbeatPath = join(executionRoot, "heartbeat.json");
    // Make every later heartbeat write fail the way a full disk does: the
    // atomic rename cannot replace a directory.
    let wedged = false;
    for (let attempt = 0; attempt < 200 && !wedged; attempt += 1) {
      try {
        // Wait for the supervisor to be fully up: the awaited startup
        // heartbeat is a deliberate fail-fast, the periodic one is not.
        if (!(await readFile(heartbeatPath, "utf8")).includes('"running"')) throw new Error("not running yet");
        await rm(heartbeatPath, { force: true });
        await mkdir(heartbeatPath);
        wedged = true;
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    expect(wedged).toBe(true);
    let result: ReturnType<typeof DeveloperSupervisorResultSchema.parse> | undefined;
    for (let attempt = 0; attempt < 300 && !result; attempt += 1) {
      try { result = DeveloperSupervisorResultSchema.parse(JSON.parse(await readFile(join(executionRoot, "result.json"), "utf8"))); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    expect(result?.exitCode, `${stderr} (exit=${exited})`).toBe(0);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}, 30_000);
