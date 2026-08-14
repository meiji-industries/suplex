import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { buildCodexTurnArgs, catalogSupportsCodexTurn } from "../src/codex-turn.js";
import { runCodexProcess } from "../src/codex-lead.js";
import { CodexTurnSupervisor } from "../src/codex-turn-supervisor.js";
import { FileSessionStore } from "../src/codex-session-store.js";
import { prepareCodexTurnWrapper } from "../src/codex-turn-wrapper.js";
import type { ProcessController } from "../src/process-manager.js";

test("Codex initial and resume turns carry the complete pinned configuration", () => {
  const initial = buildCodexTurnArgs({ model: "gpt-5.6-sol", reasoningLevel: "high", servicePriority: "priority", outputSchemaPath: "/var/forge/schema.json", finalOutputPath: "/var/forge/final.json", repositoryPath: "/var/forge/repository", imagePaths: ["/var/forge/image.png"], prompt: "Plan the bounded change" });
  expect(initial).toEqual(expect.arrayContaining(["exec", "--strict-config", "--ignore-user-config", "--output-schema", "/var/forge/schema.json", "--model", "gpt-5.6-sol", "-C", "/var/forge/repository", "--sandbox", "read-only", "--image", "/var/forge/image.png", "-c", 'service_tier="fast"']));
  const resume = buildCodexTurnArgs({ model: "gpt-5.6-sol", reasoningLevel: "high", servicePriority: "standard", outputSchemaPath: "/var/forge/schema.json", repositoryPath: "/var/forge/repository", imagePaths: ["/var/forge/image.png"], resumeSessionId: "thread_opaque", prompt: "Continue" });
  expect(resume).toContain("thread_opaque");
  expect(resume).not.toContain("-C");
  expect(resume).not.toContain("/var/forge/image.png");
  const fast = buildCodexTurnArgs({ model: "gpt-5.6-luna", reasoningLevel: "xhigh", servicePriority: "fast", outputSchemaPath: "/var/forge/schema.json", repositoryPath: "/var/forge/repository", prompt: "Fast" });
  expect(fast).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="xhigh"', 'service_tier="fast"']));
});

test("Codex argv rejects injection-shaped values and noncanonical paths", () => {
  expect(() => buildCodexTurnArgs({ model: "gpt-5.6-sol;rm", reasoningLevel: "low", servicePriority: "standard", outputSchemaPath: "/schema.json", repositoryPath: "/repository", prompt: "Plan" })).toThrow();
  expect(() => buildCodexTurnArgs({ model: "gpt-5.6-sol", reasoningLevel: "low", servicePriority: "standard", outputSchemaPath: "/schema.json", repositoryPath: "/repository/../other", prompt: "Plan" })).toThrow();
});

test("Codex model compatibility requires the pinned reasoning level and priority tier", () => {
  const catalog = { models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "low" }], service_tiers: [] }] };
  expect(catalogSupportsCodexTurn(catalog, { model: "gpt-5.6-sol", reasoningLevel: "low", servicePriority: "standard" })).toBe(true);
  expect(catalogSupportsCodexTurn(catalog, { model: "gpt-5.6-sol", reasoningLevel: "high", servicePriority: "standard" })).toBe(false);
  expect(catalogSupportsCodexTurn(catalog, { model: "gpt-5.6-sol", reasoningLevel: "low", servicePriority: "priority" })).toBe(false);
});

test("Codex session binding requires a reserved opaque reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-session-test-"));
  try {
    await expect(new FileSessionStore(root).bind("session_aaaaaaaaaaaaaaaaaaaaaaaa", "raw-session")).rejects.toMatchObject({ code: "invalid-session-reference" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached turn cancellation signals the verified process group", async () => {
  const controller = new AbortController();
  let pid: number | undefined;
  let processGroup: number | undefined;
  const started = new Promise<void>((resolve) => {
    void runCodexProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      detached: true,
      signal: controller.signal,
      onStart: async (childPid, _startedAt, inspection) => { pid = childPid; processGroup = inspection?.processGroup; resolve(); },
      onLine: async () => {},
    }).then(() => undefined);
  });
  await started;
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(pid).toBeDefined();
  expect(processGroup).toBeDefined();
  expect(() => process.kill(-(processGroup ?? -1), 0)).toThrow();
});

test("detached wrapper finishes through its spool after the worker pipe closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-wrapper-test-"));
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath, { recursive: true });
  const schemaPath = join(root, "schema.json");
  const promptPath = join(root, "prompt.txt");
  const fakeCodexPath = join(root, "fake-codex");
  await writeFile(schemaPath, "{}");
  await writeFile(promptPath, "Return a JSON object.");
  await writeFile(fakeCodexPath, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread_test\"}'\nsleep 1\nprintf '%s\\n' '{\"type\":\"item.completed\"}'\n");
  await chmod(fakeCodexPath, 0o700);
  try {
    const wrapper = await prepareCodexTurnWrapper({
      command: fakeCodexPath,
      cwd: repositoryPath,
      outputSchemaPath: schemaPath,
      promptPath,
      repositoryPath,
      model: "gpt-5.6-sol",
      reasoningLevel: "low",
      servicePriority: "standard",
      sessionStoreRoot: root,
      spoolPath: join(root, "spool.ndjson"),
      statusPath: join(root, "status.json"),
    }, root);
    const child = spawn(wrapper.command, wrapper.args, { cwd: wrapper.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    child.stdout.destroy();
    child.stderr.destroy();
    let status = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { status = await readFile(wrapper.statusPath, "utf8"); } catch { /* Wrapper is still starting. */ }
      if (status.includes('"state":"completed"')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toContain('"state":"completed"');
    expect(await readFile(wrapper.spoolPath, "utf8")).toContain('"type":"forge.wrapper_started"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation ignores stale observations before signaling", async () => {
  const owned = { name: "codex-wrapper", pid: 4101, command: "wrapper", startedAt: "now", processGroup: 5101, startTime: "started", executable: "node", argv: ["node", "wrapper"] };
  const inspection = { pid: 4101, command: "wrapper", executable: "node", argv: ["node", "wrapper"], processGroup: 5101, startTime: "started" };
  let inspections = 0;
  const signals: string[] = [];
  const controller: ProcessController = {
    async inspect() {
      inspections += 1;
      return { ...inspection, startTime: "reused" };
    },
    async signal() {},
    async signalGroup(_group, signal) { signals.push(signal); },
    async isProcessGroupAlive() { return true; },
  };

  const cancelled = await new CodexTurnSupervisor(controller).cancelOwnedProcess(owned, inspection);

  expect(cancelled).toBe(false);
  expect(signals).toEqual([]);
  expect(inspections).toBe(1);
});

test("cancellation refuses SIGKILL after process identity changes", async () => {
  const owned = { name: "codex-wrapper", pid: 4101, command: "wrapper", startedAt: "now", processGroup: 5101, startTime: "started", executable: "node", argv: ["node", "wrapper"] };
  const inspection = { pid: 4101, command: "wrapper", executable: "node", argv: ["node", "wrapper"], processGroup: 5101, startTime: "started" };
  let inspections = 0;
  const signals: string[] = [];
  const controller: ProcessController = {
    async inspect() {
      inspections += 1;
      return inspections === 1 ? inspection : { ...inspection, startTime: "reused" };
    },
    async signal() {},
    async signalGroup(_group, signal) { signals.push(signal); },
    async isProcessGroupAlive() { return true; },
  };

  const cancelled = await new CodexTurnSupervisor(controller).cancelOwnedProcess(owned);

  expect(cancelled).toBe(false);
  expect(signals).toEqual(["SIGTERM"]);
  expect(inspections).toBe(2);
});
