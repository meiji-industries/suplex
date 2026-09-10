import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskRolePrompt } from "../src/tasks/execution/role-prompt.js";
import { openCodeAttachCommand, openCodeRoleConfig, readOpenCodeServer, stopOpenCodeServer, type OpenCodeServerReference } from "../src/runtimes/opencode/server.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenCode role configuration", () => {
  const profile = { providerID: "openai", modelID: "gpt-5.6-luna", reasoningEffort: "max", serviceTier: "priority" } as const;

  it("denies Coordinator native mutations without resetting inherited MCP servers", () => {
    const config = openCodeRoleConfig({ role: "root", profile, bridge: { command: "/node", args: ["/forge/root-bridge.ts"] } });
    expect(config).toMatchObject({
      default_agent: "forge-root",
      agent: { "forge-root": { permission: { edit: "deny", bash: "deny", task: "deny" }, tools: { bash: false, write: false, edit: false, apply_patch: false, task: false } } },
      mcp: { forge_root: { type: "local", command: ["/node", "/forge/root-bridge.ts"], enabled: true } },
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
      agent: { "forge-worker": { permission: { task: "deny" }, tools: { task: false, "forge_root_*": false } } },
      provider: { openai: { models: { "gpt-5.6-luna": { options: { reasoningEffort: "max", serviceTier: "priority" } } } } },
    });
  });

  it("gives Advisors only the read-only report bridge", () => {
    const config = openCodeRoleConfig({ role: "advisor", profile, bridge: { command: "/node", args: ["/forge/advisor-report-bridge.ts"] }, evidenceDirectory: "/evidence", directory: "/repo" });
    expect(config).toMatchObject({
      agent: { "forge-advisor": { permission: { edit: "deny", bash: "deny", task: "deny", "forge_root_*": "deny" }, tools: { bash: false, edit: false, write: false, task: false, "forge_root_*": false, "forge_advisor_*": true } } },
      mcp: { forge_advisor: { type: "local", command: ["/node", "/forge/advisor-report-bridge.ts"], enabled: true } },
    });
    expect(Object.keys(config.mcp ?? {})).toEqual(["forge_advisor"]);
  });
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
