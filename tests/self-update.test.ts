import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { runCommand as executeCommand, type CommandRunResult } from "../src/command-runner.js";
import { writeProcessRegistry, type ProcessController, type ProcessInspection } from "../src/process-manager.js";
import {
  SELF_UPDATE_SERVER_LOG_FILENAME,
  SelfUpdateService,
  SelfUpdateStore,
  runSelfUpdateOperation,
  type SelfUpdateCommand,
  type SelfUpdatePayload,
  type SelfUpdateSpawner,
} from "../src/self-update.js";

const headRevision = "a".repeat(40);
const targetRevision = "b".repeat(40);
const newerRevision = "c".repeat(40);
const watchProbe = fileURLToPath(new URL("./fixtures/self-update-watch-probe.ts", import.meta.url));

async function runWatchProbe(command: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await executeCommand({ taskId: null, stepId: null, command, args, cwd: process.cwd(), env: { ...process.env, ...environment }, timeout: 15_000 });
  return `${result.stdout}\n${result.stderr}`;
}

function commandResult(command: string, args: readonly string[], cwd: string, exitCode = 0, stderr = ""): CommandRunResult {
  return {
    command: [command, ...args].join(" "),
    cwd,
    exitCode,
    durationMs: 1,
    stdout: "",
    stderr,
    entries: [],
    startedAt: "2026-09-06T00:00:00.000Z",
    finishedAt: "2026-09-06T00:00:00.001Z",
    timedOut: false,
  };
}

function inspection(pid: number): ProcessInspection {
  return {
    pid,
    command: "node src/server.ts",
    executable: "node",
    argv: ["node", "src/server.ts"],
    processGroup: pid + 100,
    startTime: "Sun 6 Sep 00:00:00 2026",
  };
}

function gitScript(root: string, dirty = "", overrides: { branch?: string; remoteUrl?: string; fetchedRevision?: string; diverged?: boolean } = {}): { runGit: (args: readonly string[], cwd: string) => Promise<string>; calls: string[][] } {
  let headReads = 0;
  const calls: string[][] = [];
  const runGit = async (args: readonly string[], cwd: string): Promise<string> => {
    expect(cwd).toBe(root);
    const normalized = [...args];
    calls.push(normalized);
    const command = normalized.join(" ");
    if (command === "symbolic-ref --short HEAD") return `${overrides.branch ?? "main"}\n`;
    if (command === "remote") return "origin\n";
    if (command === "remote get-url origin") return `${overrides.remoteUrl ?? "https://github.com/meiji-industries/forge.git"}\n`;
    if (command === "rev-parse --verify HEAD^{commit}") {
      headReads += 1;
      return `${headReads === 1 ? headRevision : targetRevision}\n`;
    }
    if (command === "status --porcelain=v1 --untracked-files=all") return dirty;
    if (command === "fetch --no-tags origin refs/heads/main:refs/remotes/origin/main") return "";
    if (command === "rev-parse --verify refs/remotes/origin/main^{commit}") return `${overrides.fetchedRevision ?? targetRevision}\n`;
    if (command === `merge-base --is-ancestor ${headRevision} ${targetRevision}`) {
      if (overrides.diverged) throw new Error("not an ancestor");
      return "";
    }
    if (command === `merge --ff-only ${targetRevision}`) return "";
    throw new Error(`Unexpected git command: ${command}`);
  };
  return { runGit, calls };
}

function makeCommandRunner(root: string, failingInstall = false, failingBuild = false): { runCommand: SelfUpdateCommand; calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runCommand: SelfUpdateCommand = async (input) => {
    calls.push({ command: input.command, args: input.args });
    if (failingInstall && input.command === "pnpm" && input.args[0] === "install") return commandResult(input.command, input.args, root, 1, "frozen lockfile does not match");
    if (failingBuild && input.command === "pnpm" && input.args[0] === "run") return commandResult(input.command, input.args, root, 1, "build failed");
    return commandResult(input.command, input.args, root);
  };
  return { runCommand, calls };
}

async function operationFixture(dirty = ""): Promise<{
  root: string;
  config: ReturnType<typeof createTestConfig>;
  store: SelfUpdateStore;
  operationId: string;
  processController: ProcessController;
}> {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-fixture-"));
  const config = createTestConfig(root);
  const store = new SelfUpdateStore(config.runtimeRoot);
  const operationId = "11111111-1111-4111-8111-111111111111";
  const serverInspection = inspection(4242);
  const serverIdentity: SelfUpdatePayload["serverIdentity"] = {
    ...serverInspection,
    name: "server",
    startedAt: "2026-09-06T00:00:00.000Z",
    startId: "server-start",
  };
  let live = true;
  const processController: ProcessController = {
    async inspect(pid) {
      return live && pid === serverIdentity.pid ? serverInspection : undefined;
    },
    async signal(pid, signal) {
      expect(pid).toBe(serverIdentity.pid);
      expect(signal).toBe("SIGTERM");
      live = false;
    },
  };
  await store.writePayload({ version: 1, operationId, targetRevision, ownership: "direct", serverIdentity, workingDirectory: root, config });
  await store.writeStatus({ operationId, status: "pending", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" });
  await store.acquireLock(operationId);
  if (dirty) {
    // The dirty result is returned by the command seam in the test below.
  }
  return { root, config, store, operationId, processController };
}

function fakeDetachedChild(): ReturnType<SelfUpdateSpawner> {
  const child = new EventEmitter() as unknown as ReturnType<SelfUpdateSpawner>;
  Object.defineProperty(child, "pid", { value: 5252 });
  child.unref = () => child;
  return child;
}

test("direct self-update prepares, signals only the exact server PID, and starts a detached replacement", async () => {
  const fixture = await operationFixture();
  try {
    const git = gitScript(fixture.root);
    const commands = makeCommandRunner(fixture.root);
    const spawned: { command?: string; args?: readonly string[]; options?: Parameters<SelfUpdateSpawner>[2] } = {};
    const spawnProcess: SelfUpdateSpawner = (command, args, options) => {
      spawned.command = command;
      spawned.args = args;
      spawned.options = options;
      return fakeDetachedChild();
    };
    await runSelfUpdateOperation({
      operationId: fixture.operationId,
      config: fixture.config,
      store: fixture.store,
      processController: fixture.processController,
      runGit: git.runGit,
      runCommand: commands.runCommand,
      spawn: spawnProcess,
      fetch: async () => new Response("", { status: 200 }),
      sleep: async () => undefined,
      environment: {},
    });

    await expect(fixture.store.readStatus()).resolves.toMatchObject({ status: "succeeded", targetRevision });
    await expect(fixture.store.readLock()).resolves.toBeUndefined();
    await expect(fixture.store.readPayload()).resolves.toBeUndefined();
    expect(commands.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "run", "build"],
    ]);
    expect(spawned.command).toBe(process.execPath);
    expect(spawned.args).toEqual(["--import", "tsx", "src/server.ts"]);
    expect(spawned.options?.detached).toBe(true);
    expect(spawned.options?.cwd).toBe(fixture.root);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("direct self-update never signals a process group when the server leads it", async () => {
  const fixture = await operationFixture();
  try {
    const serverInspection = { ...inspection(4242), processGroup: 4242 };
    const payload = await fixture.store.readPayload();
    if (!payload) throw new Error("operation payload missing");
    await fixture.store.writePayload({ ...payload, serverIdentity: { ...payload.serverIdentity, ...serverInspection } });
    let live = true;
    const signals: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }> = [];
    let groupSignals = 0;
    const processController: ProcessController = {
      async inspect(pid) { return live && pid === 4242 ? serverInspection : undefined; },
      async signal(pid, signal) { signals.push({ pid, signal }); live = false; },
      async signalGroup() { groupSignals += 1; },
    };
    const commands = makeCommandRunner(fixture.root);
    await runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController, runGit: gitScript(fixture.root).runGit, runCommand: commands.runCommand, spawn: () => fakeDetachedChild(), fetch: async () => new Response("", { status: 200 }), sleep: async () => undefined, environment: {} });

    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(groupSignals).toBe(0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("direct self-update refuses to signal after server identity changes", async () => {
  const fixture = await operationFixture();
  try {
    const git = gitScript(fixture.root);
    const commands = makeCommandRunner(fixture.root);
    let inspections = 0;
    let signalled = false;
    const processController: ProcessController = {
      async inspect(pid) {
        inspections += 1;
        return inspections === 3 ? { ...inspection(pid), startTime: "Sun 6 Sep 00:01:00 2026" } : inspection(pid);
      },
      async signal() {
        signalled = true;
      },
    };
    await expect(runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController, runGit: git.runGit, runCommand: commands.runCommand, sleep: async () => undefined, environment: {} })).rejects.toThrow(/ownership/);
    expect(signalled).toBe(false);
    await expect(fixture.store.readStatus()).resolves.toMatchObject({ status: "failed", error: expect.stringMatching(/ownership/) });
    await expect(fixture.store.readLock()).resolves.toBeUndefined();
    await expect(fixture.store.readPayload()).resolves.toBeUndefined();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("install failure records actionable status and leaves the current server running", async () => {
  const fixture = await operationFixture();
  try {
    const git = gitScript(fixture.root);
    const commands = makeCommandRunner(fixture.root, true);
    let signalled = false;
    const processController: ProcessController = {
      ...fixture.processController,
      async signal() {
        signalled = true;
      },
    };
    await expect(runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController, runGit: git.runGit, runCommand: commands.runCommand, sleep: async () => undefined, environment: {} })).rejects.toThrow(/frozen lockfile/);
    await expect(fixture.store.readStatus()).resolves.toMatchObject({ status: "failed", error: expect.stringMatching(/frozen lockfile/) });
    expect(signalled).toBe(false);
    expect(git.calls).toContainEqual(["merge", "--ff-only", targetRevision]);
    await expect(fixture.store.readLock()).resolves.toBeUndefined();
    await expect(fixture.store.readPayload()).resolves.toBeUndefined();

    const retryController: ProcessController = { async inspect() { return inspection(process.pid); }, async signal() {} };
    const service = new SelfUpdateService({ config: fixture.config, store: fixture.store, processController: retryController, runGit: git.runGit, runningRevision: headRevision, argv: ["node", "src/server.ts"], environment: {} });
    await expect(service.readUpdate()).resolves.toMatchObject({ available: true, revision: targetRevision, currentRevision: headRevision, operation: { status: "failed", targetRevision } });
    await expect(service.acceptRestart(targetRevision)).resolves.toMatchObject({ accepted: true, operation: { status: "pending", targetRevision } });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("build failure records actionable status and leaves the current server running", async () => {
  const fixture = await operationFixture();
  try {
    const git = gitScript(fixture.root);
    const commands = makeCommandRunner(fixture.root, false, true);
    let signalled = false;
    const processController: ProcessController = {
      ...fixture.processController,
      async signal() { signalled = true; },
    };
    await expect(runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController, runGit: git.runGit, runCommand: commands.runCommand, sleep: async () => undefined, environment: {} })).rejects.toThrow(/build failed/);
    await expect(fixture.store.readStatus()).resolves.toMatchObject({ status: "failed", error: expect.stringMatching(/build failed/) });
    expect(signalled).toBe(false);
    expect(commands.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "run", "build"],
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dirty checkout records failure before fetch, merge, install, or shutdown", async () => {
  const fixture = await operationFixture();
  try {
    const git = gitScript(fixture.root, "?? local.txt\n");
    const commands = makeCommandRunner(fixture.root);
    let signalled = false;
    const processController: ProcessController = {
      ...fixture.processController,
      async signal() {
        signalled = true;
      },
    };
    await expect(runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController, runGit: git.runGit, runCommand: commands.runCommand, sleep: async () => undefined, environment: {} })).rejects.toThrow(/dirty checkout/);
    await expect(fixture.store.readStatus()).resolves.toMatchObject({ status: "failed", error: expect.stringMatching(/dirty checkout/) });
    expect(signalled).toBe(false);
    expect(git.calls.some((call) => call[0] === "fetch" || call[0] === "merge")).toBe(false);
    expect(commands.calls).toHaveLength(0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test.each([
  ["a non-main checkout", { branch: "feature/update" }, /main branch/],
  ["a wrong remote", { remoteUrl: "https://github.com/example/forge.git" }, /pinned GitHub remote/],
  ["a diverged checkout", { diverged: true }, /not an ancestor/],
  ["a stale requested revision", { fetchedRevision: headRevision }, /freshly fetched main revision/],
] as const)("rejects %s before shutdown", async (_label, overrides, error) => {
  const fixture = await operationFixture();
  try {
    const git = gitScript(fixture.root, "", overrides);
    const commands = makeCommandRunner(fixture.root);
    let signalled = false;
    const processController: ProcessController = {
      ...fixture.processController,
      async signal() { signalled = true; },
    };
    await expect(runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController, runGit: git.runGit, runCommand: commands.runCommand, sleep: async () => undefined, environment: {} })).rejects.toThrow(error);
    expect(signalled).toBe(false);
    await expect(fixture.store.readStatus()).resolves.toMatchObject({ status: "failed" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("restart acceptance is single-flight and captures helper spawn failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-service-"));
  try {
    const config = createTestConfig(root);
    const identity: ProcessInspection = {
      pid: process.pid,
      command: "node src/server.ts",
      executable: "node",
      argv: ["node", "src/server.ts"],
      processGroup: process.pid,
      startTime: "Sun 6 Sep 00:00:00 2026",
    };
    const processController: ProcessController = { async inspect() { return identity; }, async signal() {} };
    const service = new SelfUpdateService({ config, processController, argv: ["node", "src/server.ts"], environment: {}, spawn: () => { throw new Error("spawn denied"); } });
    await expect(service.acceptRestart("invalid")).rejects.toThrow(/full commit revision/);
    const first = await service.acceptRestart(targetRevision);
    const second = await service.acceptRestart(targetRevision);
    expect(second).toEqual(first);
    await expect(service.launchRestart(first.operation.operationId)).rejects.toThrow(/spawn denied/);
    const store = new SelfUpdateStore(config.runtimeRoot);
    await expect(store.readStatus()).resolves.toMatchObject({ status: "failed", error: expect.stringMatching(/spawn denied/) });
    await expect(store.readLock()).resolves.toBeUndefined();
    await expect(store.readPayload()).resolves.toBeUndefined();
    await expect(service.acceptRestart(targetRevision)).resolves.toMatchObject({ accepted: true, operation: { status: "pending" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launching the same accepted operation again after spawn resolves does not start another helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-launch-"));
  try {
    const config = createTestConfig(root);
    const identity: ProcessInspection = {
      pid: process.pid,
      command: "node src/server.ts",
      executable: "node",
      argv: ["node", "src/server.ts"],
      processGroup: process.pid,
      startTime: "Sun 6 Sep 00:00:00 2026",
    };
    const processController: ProcessController = { async inspect() { return identity; }, async signal() {} };
    let spawns = 0;
    const service = new SelfUpdateService({ config, processController, argv: ["node", "src/server.ts"], environment: {}, spawn: () => { spawns += 1; return fakeDetachedChild(); } });
    const accepted = await service.acceptRestart(targetRevision);
    await service.launchRestart(accepted.operation.operationId);
    await service.launchRestart(accepted.operation.operationId);
    expect(spawns).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate runner invocations claim one preparation", async () => {
  const fixture = await operationFixture();
  try {
    const git = gitScript(fixture.root);
    const calls: string[] = [];
    let installStarted!: () => void;
    const started = new Promise<void>((resolve) => { installStarted = resolve; });
    let releaseInstall!: () => void;
    const installReleased = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const runCommand: SelfUpdateCommand = async (input) => {
      calls.push([input.command, ...input.args].join(" "));
      if (input.command === "pnpm" && input.args[0] === "install") {
        installStarted();
        await installReleased;
      }
      return commandResult(input.command, input.args, fixture.root);
    };
    const first = runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController: fixture.processController, runGit: git.runGit, runCommand, spawn: () => fakeDetachedChild(), fetch: async () => new Response("", { status: 200 }), sleep: async () => undefined, environment: {} });
    await started;
    const second = runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController: fixture.processController, runGit: git.runGit, runCommand, spawn: () => fakeDetachedChild(), fetch: async () => new Response("", { status: 200 }), sleep: async () => undefined, environment: {} });
    await second;
    releaseInstall();
    await first;
    expect(calls).toEqual(["pnpm install --frozen-lockfile", "pnpm run build"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement startup acknowledges the target without deleting runner-owned operation files", async () => {
  const fixture = await operationFixture();
  try {
    await fixture.store.writeStatus({ operationId: fixture.operationId, status: "restarting", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" });
    const service = new SelfUpdateService({ config: fixture.config, store: fixture.store, runningRevision: targetRevision, argv: ["node", "src/server.ts"], environment: {} });
    await service.initialize();
    await expect(fixture.store.readStatus()).resolves.toMatchObject({ status: "succeeded", targetRevision });
    await expect(fixture.store.readPayload()).resolves.toMatchObject({ operationId: fixture.operationId });
    await expect(fixture.store.readLock()).resolves.toMatchObject({ operationId: fixture.operationId });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a dead helper identity allows a stale operation to recover without touching a new operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-stale-"));
  try {
    const config = createTestConfig(root);
    const store = new SelfUpdateStore(config.runtimeRoot);
    const oldOperationId = "33333333-3333-4333-8333-333333333333";
    const oldPayload: SelfUpdatePayload = {
      version: 1,
      operationId: oldOperationId,
      targetRevision,
      ownership: "direct",
      serverIdentity: { ...inspection(process.pid), name: "server", startedAt: "2026-09-06T00:00:00.000Z", startId: "server-start" },
      workingDirectory: root,
      config,
    };
    await store.writePayload(oldPayload);
    await store.writeStatus({ operationId: oldOperationId, status: "preparing", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" });
    await store.acquireLock(oldOperationId);
    await store.recordHelper(oldOperationId, { ...inspection(5252), name: "self-update-helper", startedAt: "2026-09-06T00:00:00.000Z", startId: "helper-start" });
    const serverInspection = inspection(process.pid);
    const processController: ProcessController = { async inspect(pid) { return pid === serverInspection.pid ? serverInspection : undefined; }, async signal() {} };
    const service = new SelfUpdateService({ config, store, processController, now: () => new Date("2026-09-06T00:20:00.000Z"), argv: ["node", "src/server.ts"], environment: {} });
    const accepted = await service.acceptRestart(targetRevision);
    expect(accepted.operation.operationId).not.toBe(oldOperationId);
    await expect(store.readPayload()).resolves.toMatchObject({ operationId: accepted.operation.operationId });
    await expect(store.readLock()).resolves.toMatchObject({ operationId: accepted.operation.operationId });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active update observations do not fetch while the helper owns preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-observation-"));
  try {
    const config = createTestConfig(root);
    const store = new SelfUpdateStore(config.runtimeRoot);
    await store.writeStatus({ operationId: "22222222-2222-4222-8222-222222222222", status: "preparing", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" });
    const calls: string[][] = [];
    const service = new SelfUpdateService({
      config,
      store,
      runGit: async (args) => {
        calls.push([...args]);
        if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return `${headRevision}\n`;
        throw new Error(`unexpected Git observation: ${args.join(" ")}`);
      },
      environment: {},
    });
    await expect(service.readUpdate()).resolves.toMatchObject({ available: true, revision: targetRevision, currentRevision: headRevision, operation: { status: "preparing" } });
    expect(calls).toEqual([["rev-parse", "--verify", "HEAD^{commit}"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed update observations prefer a newer remote revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-newer-observation-"));
  try {
    const config = createTestConfig(root);
    const store = new SelfUpdateStore(config.runtimeRoot);
    await store.writeStatus({ operationId: "55555555-5555-4555-8555-555555555555", status: "failed", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:01.000Z", error: "build failed" });
    let headReads = 0;
    const calls: string[][] = [];
    const service = new SelfUpdateService({
      config,
      store,
      runGit: async (args) => {
        const command = [...args];
        calls.push(command);
        switch (command.join(" ")) {
          case "symbolic-ref --short HEAD": return "main\n";
          case "remote": return "origin\n";
          case "remote get-url origin": return "https://github.com/meiji-industries/forge.git\n";
          case "rev-parse --verify HEAD^{commit}":
            headReads += 1;
            return `${headReads === 1 ? headRevision : targetRevision}\n`;
          case "fetch --no-tags origin refs/heads/main:refs/remotes/origin/main": return "";
          case "rev-parse --verify refs/remotes/origin/main^{commit}": return `${newerRevision}\n`;
          case "rev-list --count HEAD..refs/remotes/origin/main": return "1\n";
          default: throw new Error(`unexpected Git observation: ${command.join(" ")}`);
        }
      },
      argv: ["node", "src/server.ts"],
      environment: {},
    });

    await expect(service.readUpdate()).resolves.toMatchObject({ available: true, revision: newerRevision, currentRevision: headRevision, operation: { status: "failed", targetRevision } });
    expect(calls).toContainEqual(["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed update observations retain the target when HEAD already reached it", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-same-target-observation-"));
  try {
    const config = createTestConfig(root);
    const store = new SelfUpdateStore(config.runtimeRoot);
    await store.writeStatus({ operationId: "66666666-6666-4666-8666-666666666666", status: "failed", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:01.000Z", error: "build failed" });
    const calls: string[][] = [];
    const service = new SelfUpdateService({
      config,
      store,
      runningRevision: headRevision,
      runGit: async (args) => {
        const command = [...args];
        calls.push(command);
        switch (command.join(" ")) {
          case "symbolic-ref --short HEAD": return "main\n";
          case "remote": return "origin\n";
          case "remote get-url origin": return "https://github.com/meiji-industries/forge.git\n";
          case "rev-parse --verify HEAD^{commit}": return `${targetRevision}\n`;
          case "fetch --no-tags origin refs/heads/main:refs/remotes/origin/main": return "";
          case "rev-parse --verify refs/remotes/origin/main^{commit}": return `${targetRevision}\n`;
          case "rev-list --count HEAD..refs/remotes/origin/main": return "0\n";
          default: throw new Error(`unexpected Git observation: ${command.join(" ")}`);
        }
      },
      argv: ["node", "src/server.ts"],
      environment: {},
    });

    await expect(service.readUpdate()).resolves.toMatchObject({ available: true, revision: targetRevision, currentRevision: headRevision, operation: { status: "failed", targetRevision } });
    expect(calls).toContainEqual(["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update observations keep the revision of the running server after checkout mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-revision-"));
  try {
    const config = createTestConfig(root);
    const store = new SelfUpdateStore(config.runtimeRoot);
    const operationId = "44444444-4444-4444-8444-444444444444";
    await store.writeStatus({ operationId, status: "failed", targetRevision, acceptedAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:01.000Z", error: "build failed" });
    let revisionReads = 0;
    const service = new SelfUpdateService({
      config,
      store,
      runGit: async (args) => {
        if (args.join(" ") !== "rev-parse --verify HEAD^{commit}") throw new Error("unexpected observation");
        revisionReads += 1;
        return `${revisionReads === 1 ? headRevision : targetRevision}\n`;
      },
      argv: ["node", "src/server.ts"],
      environment: {},
    });

    await expect(service.readUpdate()).resolves.toMatchObject({ available: true, revision: targetRevision, currentRevision: headRevision });
    await expect(service.readUpdate()).resolves.toMatchObject({ available: true, revision: targetRevision, currentRevision: headRevision });
    expect(revisionReads).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watch-owned servers cannot accept a self-update restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-watch-"));
  try {
    const config = createTestConfig(root);
    const identity: ProcessInspection = {
      pid: process.pid,
      command: "node --watch-path=src src/server.ts",
      executable: "node",
      argv: ["node", "--watch-path=src", "src/server.ts"],
      processGroup: process.pid,
      startTime: "Sun 6 Sep 00:00:00 2026",
    };
    const processController: ProcessController = { async inspect() { return identity; }, async signal() {} };
    const service = new SelfUpdateService({ config, processController, argv: identity.argv, environment: {} });
    await expect(service.acceptRestart(targetRevision)).rejects.toMatchObject({ code: "watch_ownership_unsupported", statusCode: 409 });
    await expect(new SelfUpdateStore(config.runtimeRoot).readLock()).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["Node watch execArgv", ["--watch"], {}],
  ["tsx watch marker", ["--import", "tsx"], { FORGE_WATCH_MODE: "1" }],
] as const)("rejects %s before creating an operation", async (_label, execArgv, environment) => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-watch-mode-"));
  try {
    const config = createTestConfig(root);
    const identity: ProcessInspection = {
      pid: process.pid,
      command: "node src/server.ts",
      executable: "node",
      argv: ["node", "src/server.ts"],
      processGroup: process.pid,
      startTime: "Sun 6 Sep 00:00:00 2026",
    };
    const processController: ProcessController = { async inspect() { return identity; }, async signal() {} };
    const service = new SelfUpdateService({ config, processController, argv: ["node", "src/server.ts"], execArgv, environment });
    await expect(service.acceptRestart(targetRevision)).rejects.toMatchObject({ code: "watch_ownership_unsupported" });
    await expect(new SelfUpdateStore(config.runtimeRoot).readLock()).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["Node --watch", process.execPath, ["--watch", "--import", "tsx", watchProbe], { WATCH_PROBE_KILL_PARENT: "1" }],
  ["tsx watch", join(process.cwd(), "node_modules/.bin/tsx"), ["watch", "--clear-screen=false", watchProbe], { FORGE_WATCH_MODE: "1", WATCH_PROBE_KILL_PARENT: "1" }],
] as const)("rejects an actual %s launch before checkout mutation", async (_label, command, args, environment) => {
  const root = await mkdtemp(join(tmpdir(), "forge-self-update-real-watch-"));
  try {
    const output = await runWatchProbe(command, [...args, root], environment);
    expect(output).toContain("watch-probe:watch_ownership_unsupported:lock=absent:git=not-called");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the mise watch task propagates an explicit watcher marker to the server", async () => {
  const mise = await readFile(new URL("../mise.toml", import.meta.url), "utf8");
  expect(mise).toMatch(/\[tasks\."dev:watch"\][\s\S]*FORGE_WATCH_MODE = "1"/);
});

test("restart environment preserves the configured address and development login", async () => {
  const fixture = await operationFixture();
  try {
    const config = { ...fixture.config, developmentAutoLogin: true };
    const payload = await fixture.store.readPayload();
    if (!payload) throw new Error("operation payload missing");
    await fixture.store.writePayload({ ...payload, config });
    const spawned: { options?: Parameters<SelfUpdateSpawner>[2] } = {};
    await runSelfUpdateOperation({
      operationId: fixture.operationId,
      config,
      store: fixture.store,
      processController: fixture.processController,
      runGit: gitScript(fixture.root).runGit,
      runCommand: makeCommandRunner(fixture.root).runCommand,
      spawn: (_command, _args, options) => { spawned.options = options; return fakeDetachedChild(); },
      fetch: async () => new Response("", { status: 200 }),
      sleep: async () => undefined,
      environment: {},
    });
    expect(spawned.options?.env).toMatchObject({ FORGE_TAILSCALE_ADDRESS: "127.0.0.1", FORGE_BIND_ADDRESS: "127.0.0.1", FORGE_DEVELOPMENT_AUTO_LOGIN: "1" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("managed restart invokes the registry command and preserves restart configuration", async () => {
  const fixture = await operationFixture();
  try {
    const payload = await fixture.store.readPayload();
    if (!payload) throw new Error("operation payload missing");
    await fixture.store.writePayload({ ...payload, ownership: "registry" });
    await writeProcessRegistry(join(fixture.config.runtimeRoot, "owned-processes.json"), { version: 1, processes: [payload.serverIdentity] });
    const commands = makeCommandRunner(fixture.root);
    await runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController: fixture.processController, runGit: gitScript(fixture.root).runGit, runCommand: commands.runCommand, sleep: async () => undefined, environment: {}, fetch: async () => new Response("", { status: 200 }) });

    expect(commands.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "run", "build"],
      [process.execPath, "--import", "tsx", "src/cli.ts", "restart"],
    ]);
    expect(commands.calls[2]?.command).toBe(process.execPath);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("managed restart refuses a registry identity changed after preparation", async () => {
  const fixture = await operationFixture();
  try {
    const payload = await fixture.store.readPayload();
    if (!payload) throw new Error("operation payload missing");
    await fixture.store.writePayload({ ...payload, ownership: "registry" });
    const registryPath = join(fixture.config.runtimeRoot, "owned-processes.json");
    await writeProcessRegistry(registryPath, { version: 1, processes: [payload.serverIdentity] });
    const commands = makeCommandRunner(fixture.root);
    const runCommand: SelfUpdateCommand = async (input) => {
      const result = await commands.runCommand(input);
      if (input.command === "pnpm" && input.args[0] === "run") {
        await writeProcessRegistry(registryPath, { version: 1, processes: [{ ...payload.serverIdentity, startTime: "Sun 6 Sep 00:01:00 2026" }] });
      }
      return result;
    };
    await expect(runSelfUpdateOperation({ operationId: fixture.operationId, config: fixture.config, store: fixture.store, processController: fixture.processController, runGit: gitScript(fixture.root).runGit, runCommand, sleep: async () => undefined, environment: {} })).rejects.toThrow(/registry changed/);
    expect(commands.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "run", "build"],
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("direct replacement logs are kept under the runtime root", () => {
  expect(SELF_UPDATE_SERVER_LOG_FILENAME).toBe("self-update-server.log");
});
