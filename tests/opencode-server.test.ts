import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskRolePrompt } from "../src/tasks/execution/role-prompt.js";
import { ensureOpenCodeServer, openCodeAttachCommand, openCodeRoleConfig, openCodeServerRunning, readOpenCodeServer, stopOpenCodeServer, type OpenCodeServerReference } from "../src/runtimes/opencode/server.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenCode role configuration", () => {
  const profile = { modelID: "openai/gpt-5.6-luna", reasoningEffort: "max", serviceTier: "priority" } as const;

  it("denies Coordinator native mutations without resetting inherited MCP servers", () => {
    const config = openCodeRoleConfig({ role: "root", profile, bridge: { command: "/node", args: ["/forge/root-bridge.ts"], environment: { FORGE_ROOT_TOKEN: "token" } } });
    expect(config).toMatchObject({
      default_agent: "forge-root",
      agent: { "forge-root": { permission: { edit: "deny", bash: "deny", task: "deny" }, tools: { bash: false, write: false, edit: false, apply_patch: false, task: false } } },
      mcp: { forge_root: { type: "local", command: ["/node", "/forge/root-bridge.ts"], environment: { FORGE_ROOT_TOKEN: "token" }, enabled: true } },
    });
    expect(JSON.stringify(config)).not.toContain('"*":"allow"');
    expect(Object.keys(config.mcp ?? {})).toEqual(["forge_root"]);
    expect(taskRolePrompt("root")).toContain("Delegate one coherent functional assignment");
    expect(taskRolePrompt("root")).toContain("independent reviewer");
    expect(taskRolePrompt("root")).toContain("generate a concise action-oriented title from the final reviewed solution");
    expect(taskRolePrompt("root")).toContain("Supply it as pullRequestTitle");
    expect(taskRolePrompt("root")).toContain("pullRequestBody");
  });

  it("lets Workers edit but not spawn native subagents or call the Coordinator bridge", () => {
    expect(openCodeRoleConfig({ role: "worker", profile })).toMatchObject({
      model: "openai/gpt-5.6-luna",
      agent: { "forge-worker": { permission: { task: "deny" }, tools: { task: false, "forge_root_*": false } } },
      provider: { openai: { models: { "gpt-5.6-luna": { options: { reasoningEffort: "max", serviceTier: "priority" } } } } },
    });
  });

  it("gives Advisors only the read-only report bridge", () => {
    const config = openCodeRoleConfig({ role: "advisor", profile, bridge: { command: "/node", args: ["/forge/advisor-report-bridge.ts"], environment: { FORGE_ADVISOR_TOKEN: "token" } }, evidenceDirectory: "/evidence", directory: "/repo" });
    expect(config).toMatchObject({
      agent: { "forge-advisor": { permission: { edit: "deny", bash: "deny", task: "deny", "forge_root_*": "deny" }, tools: { bash: false, edit: false, write: false, task: false, "forge_root_*": false, "forge_advisor_*": true } } },
      mcp: { forge_advisor: { type: "local", command: ["/node", "/forge/advisor-report-bridge.ts"], environment: { FORGE_ADVISOR_TOKEN: "token" }, enabled: true } },
    });
    expect(Object.keys(config.mcp ?? {})).toEqual(["forge_advisor"]);
  });
});

it("refreshes a live OpenCode server for authenticated bridge environment only after native work is idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-opencode-config-refresh-"));
  directories.push(directory);
  const runtimeDirectory = join(directory, "runtime");
  const statusPath = join(directory, "status.json");
  const configLog = join(directory, "configs.jsonl");
  const executable = join(directory, "opencode");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
fs.appendFileSync(process.env.FORGE_TEST_CONFIG_LOG, process.env.OPENCODE_CONFIG_CONTENT + "\\n");
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url.startsWith("/global/health")) response.end(JSON.stringify({ healthy: true, version: "test" }));
  else if (request.url.startsWith("/session/status")) response.end(fs.readFileSync(process.env.FORGE_TEST_STATUS_PATH, "utf8"));
  else { response.statusCode = 404; response.end(JSON.stringify({ error: "missing" })); }
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, { mode: 0o700 });
  await writeFile(statusPath, JSON.stringify({ ses_existing: { type: "busy" } }));
  const oldConfig = { mcp: { forge_root: { type: "local", command: ["node", "bridge"], enabled: true } } };
  const authenticatedConfig = { mcp: { forge_root: { type: "local", command: ["node", "bridge"], environment: { FORGE_ROOT_TOKEN: "token" }, enabled: true } } };
  const environment = { ...process.env, FORGE_TEST_STATUS_PATH: statusPath, FORGE_TEST_CONFIG_LOG: configLog };
  const first = await ensureOpenCodeServer({ runtimeDirectory, executable, directory, config: oldConfig, env: environment });
  const retained = await ensureOpenCodeServer({ runtimeDirectory, executable, directory, config: authenticatedConfig, env: environment });
  expect(retained.generation).toBe(first.generation);
  expect(await openCodeServerRunning(first)).toBe(true);
  expect((await readFile(configLog, "utf8")).trim().split("\n")).toHaveLength(1);
  await writeFile(statusPath, JSON.stringify({ ses_existing: { type: "idle" } }));
  const refreshed = await ensureOpenCodeServer({ runtimeDirectory, executable, directory, config: authenticatedConfig, env: environment });
  expect(refreshed.generation).not.toBe(first.generation);
  const launchedConfigs = (await readFile(configLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(launchedConfigs).toHaveLength(2);
  expect(launchedConfigs[1]).toEqual(authenticatedConfig);
  await stopOpenCodeServer(refreshed);
});

it("keeps attach credentials out of the pane command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-attach-test-"));
  directories.push(directory);
  const reference: OpenCodeServerReference = { pid: process.pid, baseUrl: "http://127.0.0.1:1234", password: "private-proof-password-not-for-pane-output", directory: "/repo with spaces", executable: "/bin/opencode", generation: "b775df17-718a-4cb2-8e23-6912b8aa0d39", configHash: "a".repeat(64), processIdentity: { command: "opencode serve", executable: "/bin/opencode", argv: ["opencode", "serve"], processGroup: process.pid, startTime: "original", ownerUid: 501 } };
  const command = await openCodeAttachCommand({ reference, runtimeDirectory: directory, sessionID: "ses_proof" });
  expect(command).not.toContain(reference.password);
  expect(command).toContain("--session 'ses_proof'");
  expect(command).toContain("--mini");
  expect(command).toContain("--dir '/repo with spaces'");
  expect((await stat(join(directory, "attach.env"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(directory, "attach.env"), "utf8")).toContain(reference.password);
  expect(await readOpenCodeServer(directory)).toBeNull();
  await expect(openCodeAttachCommand({ reference, runtimeDirectory: directory, sessionID: "ses_bad; touch /tmp/no" })).rejects.toThrow("Invalid OpenCode session identity");
});

it("never signals a reused server PID", async () => {
  const reference: OpenCodeServerReference = {
    pid: 4321, baseUrl: "http://127.0.0.1:1234", password: "a".repeat(64), directory: "/repo", executable: "/bin/opencode",
    generation: "b775df17-718a-4cb2-8e23-6912b8aa0d39", configHash: "a".repeat(64),
    processIdentity: { command: "opencode serve", executable: "/bin/opencode", argv: ["opencode", "serve"], processGroup: 4321, startTime: "original", ownerUid: 501 },
  };
  const signalled: number[] = [];
  await expect(stopOpenCodeServer(reference, {
    inspect: async () => ({ pid: reference.pid, ...reference.processIdentity, startTime: "replacement" }),
    signal: async pid => { signalled.push(pid); },
    signalGroup: async pid => { signalled.push(pid); },
  })).resolves.toBeUndefined();
  expect(signalled).toEqual([]);
});
