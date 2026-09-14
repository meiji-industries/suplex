import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as executables from "../src/platform/executable-resolver.js";
import * as openCodeProviders from "../src/runtimes/opencode/providers.js";
import { readProviders } from "../src/profiles/provider-catalog.js";
import { createProviderConnectionProbe } from "../src/profiles/provider-connection.js";
import type { ProviderProbeResult } from "../src/profiles/provider-readiness.js";

const probed = (stdout: string, exitCode = 0): ProviderProbeResult => ({ stdout, stderr: "", exitCode, timedOut: false });

afterEach(() => vi.restoreAllMocks());

test("lists Devin CLI and its models whether or not its executable is installed", async () => {
  vi.spyOn(openCodeProviders, "readOpenCodeProviders").mockResolvedValue({ directory: "/workspace", observedAt: "2026-09-12T00:00:00.000Z", providers: [] });
  vi.spyOn(executables, "resolveClaudeExecutable").mockRejectedValue(new Error("missing"));
  const devin = vi.spyOn(executables, "resolveDevinExecutable").mockRejectedValue(new Error("missing"));

  const missing = await readProviders({ directory: "/workspace" });
  expect(missing.providers).toContainEqual(expect.objectContaining({ id: "devin", status: "missing", models: expect.arrayContaining([{ id: "swe-2", label: "SWE-2" }]) }));

  devin.mockResolvedValue("/usr/local/bin/devin");
  const configured = await readProviders({ directory: "/workspace" });
  expect(configured.providers).toContainEqual(expect.objectContaining({ id: "devin", status: "configured" }));
});

test("returns local CLI providers when the OpenCode observation fails", async () => {
  vi.spyOn(openCodeProviders, "readOpenCodeProviders").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(executables, "resolveClaudeExecutable").mockRejectedValue(new Error("missing"));
  vi.spyOn(executables, "resolveDevinExecutable").mockRejectedValue(new Error("missing"));

  const providers = await readProviders({ directory: "/workspace" });
  expect(providers.providers).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "claude-code", status: "missing" }),
    expect.objectContaining({ id: "devin", status: "missing" }),
  ]));
});

test("reports unknown sign-in when no connection probe is supplied", async () => {
  vi.spyOn(openCodeProviders, "readOpenCodeProviders").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(executables, "resolveClaudeExecutable").mockRejectedValue(new Error("missing"));
  vi.spyOn(executables, "resolveDevinExecutable").mockRejectedValue(new Error("missing"));

  const result = await readProviders({ directory: "/workspace" });
  expect(result.providers).toContainEqual(expect.objectContaining({ id: "claude-code", connection: expect.objectContaining({ status: "unknown" }) }));
});

test("attaches probed sign-in state to every provider row", async () => {
  vi.spyOn(openCodeProviders, "readOpenCodeProviders").mockResolvedValue({ directory: "/workspace", observedAt: "2026-09-12T00:00:00.000Z", providers: [{ id: "openai", label: "OpenAI", modelCount: 1, models: [], status: "configured" }] });
  vi.spyOn(executables, "resolveClaudeExecutable").mockResolvedValue("/bin/claude");
  vi.spyOn(executables, "resolveDevinExecutable").mockRejectedValue(new Error("missing"));

  const result = await readProviders({ directory: "/workspace", connection: async id => ({ status: id === "openai" ? "connected" : "not-connected", summary: `checked ${id}` }) });
  expect(result.providers).toContainEqual(expect.objectContaining({ id: "openai", connection: { status: "connected", summary: "checked openai" } }));
  expect(result.providers).toContainEqual(expect.objectContaining({ id: "devin", connection: { status: "not-connected", summary: "checked devin" } }));
});

test("provider connection probe maps Claude Code auth status", async () => {
  vi.spyOn(executables, "resolveClaudeExecutable").mockResolvedValue("/bin/claude");
  const runCommand = vi.fn(async () => probed(JSON.stringify({ loggedIn: true })));
  const connected = createProviderConnectionProbe({ runCommand });
  expect(await connected("claude-code")).toEqual({ status: "connected", summary: expect.stringContaining("signed in") });
  expect(runCommand).toHaveBeenCalledWith("/bin/claude", ["auth", "status", "--json"], expect.objectContaining({ timeout: 5_000 }));

  const signedOut = createProviderConnectionProbe({ runCommand: async () => probed(JSON.stringify({ loggedIn: false })) });
  expect(await signedOut("claude-code")).toMatchObject({ status: "not-connected" });
});

test("OpenCode-backed providers report their own stored credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-opencode-auth-"));
  try {
    await mkdir(join(root, "opencode"), { recursive: true });
    await writeFile(join(root, "opencode", "auth.json"), JSON.stringify({ openai: { type: "api", key: "stored" } }));
    vi.spyOn(executables, "resolveOpenCodeExecutable").mockResolvedValue("/bin/opencode");
    const runCommand = vi.fn(async () => probed("1 credentials"));
    const probe = createProviderConnectionProbe({ runCommand, env: { XDG_DATA_HOME: root } });
    expect(await probe("openai")).toMatchObject({ status: "connected" });
    expect(await probe("opencode")).toMatchObject({ status: "not-connected" });
    expect(await probe("github-copilot")).toMatchObject({ status: "not-connected" });
    // The auth file answers per provider; the shared auth-list probe is not needed.
    expect(runCommand).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing OpenCode auth file reports every provider not-connected", async () => {
  const runCommand = vi.fn(async () => probed("0 credentials"));
  const probe = createProviderConnectionProbe({ runCommand, env: { XDG_DATA_HOME: join(tmpdir(), "forge-no-such-data-home") } });
  expect(await probe("openai")).toMatchObject({ status: "not-connected" });
  expect(runCommand).not.toHaveBeenCalled();
});

test("OpenCode providers keep the shared probe result when the auth file cannot be read", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-opencode-auth-"));
  try {
    await mkdir(join(root, "opencode"), { recursive: true });
    await writeFile(join(root, "opencode", "auth.json"), "not json");
    vi.spyOn(executables, "resolveOpenCodeExecutable").mockResolvedValue("/bin/opencode");
    const runCommand = vi.fn(async () => probed("2 credentials"));
    const probe = createProviderConnectionProbe({ runCommand, env: { XDG_DATA_HOME: root } });
    expect(await probe("openai")).toMatchObject({ status: "connected" });
    expect(await probe("opencode")).toMatchObject({ status: "connected" });
    expect(runCommand).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin CLI auth status output drives its connection state", async () => {
  vi.spyOn(executables, "resolveDevinExecutable").mockResolvedValue("/bin/devin");
  const connected = createProviderConnectionProbe({ runCommand: async () => probed("Logged in (via Devin).\n\nUser:\n  Name: Ada") });
  expect(await connected("devin")).toEqual({ status: "connected", summary: expect.stringContaining("signed in") });
  const signedOut = createProviderConnectionProbe({ runCommand: async () => ({ stdout: "", stderr: "Not logged in", exitCode: 1, timedOut: false }) });
  expect(await signedOut("devin")).toMatchObject({ status: "not-connected" });
  const timedOut = createProviderConnectionProbe({ runCommand: async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true }) });
  expect(await timedOut("devin")).toMatchObject({ status: "unknown" });
});

test("an absent Devin CLI reports not-connected", async () => {
  vi.spyOn(executables, "resolveDevinExecutable").mockRejectedValue(new Error("missing"));
  const probe = createProviderConnectionProbe();
  expect(await probe("devin")).toEqual({ status: "not-connected", summary: "Devin CLI is not installed" });
});
