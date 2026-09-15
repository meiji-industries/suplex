// eslint-disable-next-line no-restricted-imports
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { canonicalForgeRepository } from "../src/platform/updates/supervisor.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supervisorPath = join(projectRoot, "src/platform/updates/supervisor.ts");
const childFixture = join(projectRoot, "tests/fixtures/update-supervisor-server.ts");

type Fixture = {
  root: string;
  remote: string;
  checkout: string;
  producer: string;
  environment: NodeJS.ProcessEnv;
  port: number;
  failInstall: string;
  slowInstall: string;
  failReady: string;
  lateReady: string;
  startLog: string;
  commandLog: string;
  installPid: string;
  delayedMarker: string;
  supervisor?: ChildProcess;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "forge-supervisor-test-"));
  const checkout = join(root, "checkout");
  const producer = join(root, "producer");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const startLog = join(root, "starts.log");
  const commandLog = join(root, "commands.log");
  const failInstall = join(root, "fail-install");
  const slowInstall = join(root, "slow-install");
  const failReady = join(root, "fail-ready");
  const lateReady = join(root, "late-ready");
  const installPid = join(root, "install-child.pid");
  const delayedMarker = join(root, "install-delayed-marker");
  await writeFile(startLog, "");
  await writeFile(commandLog, "");
  await writeFile(join(root, "placeholder"), "");
  await mkdir(join(checkout, "src"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(childFixture, join(checkout, "src/server.ts"));
  await writeFile(join(checkout, "keep.txt"), "base\n");
  await writeFile(join(checkout, "overlap.txt"), "base\n");
  await writeFile(join(checkout, "remote.txt"), "before\n");
  await writeFile(join(checkout, ".gitignore"), "node_modules\n");
  await symlink(join(projectRoot, "node_modules"), join(checkout, "node_modules"));
  git(checkout, "init", "--initial-branch=main");
  git(checkout, "config", "user.name", "Forge supervisor test");
  git(checkout, "config", "user.email", "forge@example.invalid");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "Initial");
  git(root, "clone", "--bare", checkout, remote);
  git(checkout, "remote", "add", "origin", "git@github.com:meiji-industries/forge.git");
  git(checkout, "config", "branch.main.remote", "origin");
  git(checkout, "config", "branch.main.merge", "refs/heads/main");
  git(root, "clone", remote, producer);
  git(producer, "config", "user.name", "Forge supervisor test");
  git(producer, "config", "user.email", "forge@example.invalid");
  const ssh = join(bin, "ssh");
  await writeFile(ssh, '#!/bin/sh\nexec git-upload-pack "$FORGE_TEST_REMOTE"\n');
  await chmod(ssh, 0o755);
  const pnpm = join(bin, "pnpm");
  await writeFile(pnpm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FORGE_SUPERVISOR_TEST_COMMAND_LOG"\nif [ -f "$FORGE_SUPERVISOR_TEST_FAIL_INSTALL" ]; then echo "deliberate install failure" >&2; exit 1; fi\nif [ -f "$FORGE_SUPERVISOR_TEST_SLOW_INSTALL" ]; then stubborn-install & wait; fi\n');
  await chmod(pnpm, 0o755);
  const stubbornInstall = join(bin, "stubborn-install");
  await writeFile(stubbornInstall, '#!/usr/bin/env node\nconst fs = require("node:fs");\nprocess.on("SIGTERM", () => {});\nfs.writeFileSync(process.env.FORGE_SUPERVISOR_TEST_INSTALL_PID, String(process.pid));\nsetTimeout(() => fs.writeFileSync(process.env.FORGE_SUPERVISOR_TEST_DELAYED_MARKER, "late\\n"), 2000);\nsetInterval(() => {}, 1000);\n');
  await chmod(stubbornInstall, 0o755);
  const port = await freePort();
  return {
    root, remote, checkout, producer, port, failInstall, slowInstall, failReady, lateReady, startLog, commandLog, installPid, delayedMarker,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GIT_SSH_COMMAND: ssh,
      GIT_SSH_VARIANT: "ssh",
      FORGE_TEST_REMOTE: remote,
      FORGE_FRONTEND_DEV_SERVER: "1",
      FORGE_SUPERVISOR_TEST_PORT: String(port),
      FORGE_SUPERVISOR_TEST_START_LOG: startLog,
      FORGE_SUPERVISOR_TEST_COMMAND_LOG: commandLog,
      FORGE_SUPERVISOR_TEST_FAIL_INSTALL: failInstall,
      FORGE_SUPERVISOR_TEST_SLOW_INSTALL: slowInstall,
      FORGE_SUPERVISOR_TEST_FAIL_READY: failReady,
      FORGE_SUPERVISOR_TEST_LATE_READY: lateReady,
      FORGE_SUPERVISOR_TEST_INSTALL_PID: installPid,
      FORGE_SUPERVISOR_TEST_DELAYED_MARKER: delayedMarker,
    },
  };
}

function publish(value: Fixture, files: Record<string, string>, message = "Update"): string {
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(value.producer, name), contents);
  git(value.producer, "add", ".");
  git(value.producer, "commit", "-m", message);
  git(value.producer, "push", "origin", "main");
  return git(value.producer, "rev-parse", "HEAD");
}

async function start(value: Fixture, watch = false): Promise<void> {
  const child = spawn(process.execPath, [supervisorPath, ...(watch ? ["--watch"] : [])], { cwd: value.checkout, env: value.environment, stdio: ["ignore", "pipe", "pipe"] });
  value.supervisor = child;
  await waitForHost(value);
}

async function waitForHost(value: Fixture): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return await state(value, false); } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  }
  throw new Error("Supervisor test host did not become ready");
}

async function state(value: Fixture, check: boolean): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${value.port}/update${check ? "?check=1" : ""}`, { signal: AbortSignal.timeout(2_000) });
  const envelope = await response.json();
  if (!envelope || typeof envelope !== "object" || !("value" in envelope) || !envelope.value || typeof envelope.value !== "object") throw new Error("Invalid supervisor response");
  return Object.fromEntries(Object.entries(envelope.value));
}

async function apply(value: Fixture): Promise<void> {
  await fetch(`http://127.0.0.1:${value.port}/apply`, { method: "POST", signal: AbortSignal.timeout(2_000) });
}

async function waitForState(value: Fixture, kind: string, timeoutMs = 12_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const observed = await state(value, false);
      const status = observed.status;
      if (status && typeof status === "object" && "kind" in status && status.kind === kind) return observed;
    } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); continue; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Supervisor did not reach ${kind}`);
}

async function starts(value: Fixture): Promise<number[]> {
  return (await readFile(value.startLog, "utf8")).trim().split("\n").filter(Boolean).map(Number);
}

async function cleanup(value: Fixture): Promise<void> {
  if (value.supervisor?.exitCode === null) {
    value.supervisor.kill("SIGTERM");
    await new Promise<void>((resolveExit) => value.supervisor?.once("exit", () => resolveExit()));
  }
  await rm(value.root, { recursive: true, force: true });
}

test.each(["https://github.com/meiji-industries/forge.git", "git@github.com:meiji-industries/forge.git", "ssh://git@github.com/meiji-industries/forge.git"])("accepts the pinned Forge remote %s", (url) => {
  expect(canonicalForgeRepository(url)).toBe(true);
  expect(canonicalForgeRepository("https://github.com/another/forge.git")).toBe(false);
});

test("real Git update preserves dirty work, refreshes stale notice, retries install, and stays single-flight", async () => {
  const value = await fixture();
  try {
    publish(value, { "remote.txt": "first\n" }, "First remote update");
    await writeFile(join(value.checkout, "keep.txt"), "local edit\n");
    await writeFile(join(value.checkout, ".forge-old-update-lock"), "stale\n");
    await start(value);
    const notice = await state(value, true);
    expect(notice).toMatchObject({ status: { kind: "available" } });
    const latest = publish(value, { "remote.txt": "second\n" }, "Newer than notice");
    await writeFile(value.failInstall, "fail\n");
    await Promise.all([apply(value), apply(value)]);
    const failed = await waitForState(value, "failed");
    expect(failed).toMatchObject({ status: { kind: "failed", action: "apply", error: expect.stringContaining("deliberate install failure") }, currentRevision: latest });
    await rename(value.remote, `${value.remote}.offline`);
    expect(await state(value, true)).toMatchObject({ status: { kind: "failed", action: "apply", error: expect.stringContaining("deliberate install failure") } });
    await rename(`${value.remote}.offline`, value.remote);
    expect(await state(value, true)).toMatchObject({ status: { kind: "failed", action: "apply" } });
    expect(await readFile(join(value.checkout, "keep.txt"), "utf8")).toBe("local edit\n");
    await rm(value.failInstall);
    await Promise.all([apply(value), apply(value)]);
    await waitForState(value, "current");
    const commands = (await readFile(value.commandLog, "utf8")).trim().split("\n");
    expect(commands).toEqual(["install --frozen-lockfile", "install --frozen-lockfile"]);
  } finally { await cleanup(value); }
}, 30_000);

test("overlapping work fails honestly without stopping a safe running host", async () => {
  const value = await fixture();
  try {
    publish(value, { "overlap.txt": "remote edit\n" });
    await writeFile(join(value.checkout, "overlap.txt"), "local edit\n");
    await start(value);
    await state(value, true);
    await apply(value);
    const failed = await waitForState(value, "failed");
    expect(failed).toMatchObject({ status: { kind: "failed", action: "apply", error: expect.stringMatching(/local changes|overwritten/i) } });
    expect(await readFile(join(value.checkout, "overlap.txt"), "utf8")).toBe("local edit\n");
  } finally { await cleanup(value); }
}, 30_000);

test("divergence fails honestly without stopping a safe running host", async () => {
  const value = await fixture();
  try {
    publish(value, { "remote.txt": "remote edit\n" });
    await writeFile(join(value.checkout, "local.txt"), "local\n");
    git(value.checkout, "add", "local.txt");
    git(value.checkout, "commit", "-m", "Diverge locally");
    await start(value);
    const runningBefore = (await starts(value)).at(-1);
    expect(await state(value, true)).toMatchObject({ status: { kind: "failed", action: "check", error: expect.stringContaining("diverged") } });
    expect((await starts(value)).at(-1)).toBe(runningBefore);
  } finally { await cleanup(value); }
}, 30_000);

test("replacement readiness failure settles, recovers once, and keeps the failure", async () => {
  const value = await fixture();
  try {
    publish(value, { "remote.txt": "after\n" });
    await start(value);
    await state(value, true);
    await writeFile(value.failReady, "fail once\n");
    await apply(value);
    const failed = await waitForState(value, "failed");
    expect(failed).toMatchObject({ status: { kind: "failed", action: "apply", error: expect.stringContaining("before readiness") } });
    expect(await starts(value)).toHaveLength(3);
  } finally { await cleanup(value); }
}, 30_000);

test("late readiness after timeout cannot report a successful replacement", async () => {
  const value = await fixture();
  try {
    publish(value, { "remote.txt": "after\n" });
    await start(value);
    await state(value, true);
    await writeFile(value.lateReady, "late once\n");
    await apply(value);
    const failed = await waitForState(value, "failed", 40_000);
    expect(failed).toMatchObject({ status: { kind: "failed", action: "apply", error: expect.stringContaining("did not report readiness") } });
    expect(await starts(value)).toHaveLength(3);
  } finally { await cleanup(value); }
}, 45_000);

test("Check compares remote main with the running child after checkout HEAD advances", async () => {
  const value = await fixture();
  try {
    const runningRevision = git(value.checkout, "rev-parse", "HEAD");
    const remoteRevision = publish(value, { "remote.txt": "after\n" });
    await start(value);
    execFileSync("git", ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"], { cwd: value.checkout, env: value.environment });
    git(value.checkout, "merge", "--ff-only", "refs/remotes/origin/main");
    expect(git(value.checkout, "rev-parse", "HEAD")).toBe(remoteRevision);
    expect(await state(value, true)).toMatchObject({ status: { kind: "available" }, currentRevision: runningRevision, availableRevision: remoteRevision });
  } finally { await cleanup(value); }
}, 30_000);

test.skipIf(process.platform === "win32")("watch changes coalesce and Ctrl-C stop the owned install group without touching another process", async () => {
  const value = await fixture();
  const unrelated = spawn("sleep", ["10"], { stdio: "ignore" });
  try {
    publish(value, { "remote.txt": "after\n" });
    await start(value, true);
    await Promise.all([writeFile(join(value.checkout, "src/one.ts"), "export {};\n"), writeFile(join(value.checkout, "src/two.ts"), "export {};\n"), writeFile(join(value.checkout, "src/three.ts"), "export {};\n")]);
    const deadline = Date.now() + 5_000;
    while ((await starts(value)).length < 2 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    expect(await starts(value)).toHaveLength(2);
    await state(value, true);
    await writeFile(value.slowInstall, "slow\n");
    await apply(value);
    while (!(await readFile(value.commandLog, "utf8")).includes("install --frozen-lockfile")) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    let installPid = 0;
    while (!installPid) {
      try { installPid = Number((await readFile(value.installPid, "utf8")).trim()); } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 20)); }
    }
    value.supervisor!.kill("SIGINT");
    await new Promise<void>((resolveExit) => value.supervisor!.once("exit", () => resolveExit()));
    expect(() => process.kill(installPid, 0)).toThrow();
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_200));
    await expect(readFile(value.delayedMarker, "utf8")).rejects.toThrow();
    expect(await starts(value)).toHaveLength(2);
  } finally { unrelated.kill("SIGTERM"); await cleanup(value); }
}, 30_000);
