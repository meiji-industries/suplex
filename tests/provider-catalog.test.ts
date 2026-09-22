import { afterEach, expect, test, vi } from "vitest";
import * as executables from "../src/platform/executable-resolver.js";
import * as openCodeProviders from "../src/runtimes/opencode/providers.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MODELS } from "../src/runtimes/task-harness.js";
import { readCodexModels, readProviders } from "../src/profiles/provider-catalog.js";
import { createProviderConnectionProbe } from "../src/profiles/provider-connection.js";
import type { ProviderProbeResult } from "../src/profiles/provider-readiness.js";

const probed = (stdout: string, exitCode = 0): ProviderProbeResult => ({ stdout, stderr: "", exitCode, timedOut: false });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test("lists one row per agent tool with OpenCode's vendors folded into qualified model ids", async () => {
  vi.stubEnv("CODEX_HOME", join(tmpdir(), "suplex-missing-codex-home"));
  vi.spyOn(openCodeProviders, "readOpenCodeProviders").mockResolvedValue({ directory: "/workspace", observedAt: "2026-09-15T00:00:00.000Z", providers: [
    { id: "openai", label: "OpenAI", modelCount: 1, models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }], status: "configured" },
    { id: "github-copilot", label: "GitHub Copilot", modelCount: 1, models: [{ id: "claude-fable-5", label: "Claude Fable 5" }], status: "configured" },
  ] });
  vi.spyOn(executables, "resolveOpenCodeExecutable").mockResolvedValue("/bin/opencode");
  vi.spyOn(executables, "resolveClaudeExecutable").mockRejectedValue(new Error("missing"));
  vi.spyOn(executables, "resolveDevinExecutable").mockRejectedValue(new Error("missing"));
  vi.spyOn(executables, "resolveCodexExecutable").mockResolvedValue("/opt/codex/codex");

  const listed = await readProviders({ directory: "/workspace", connection: async id => ({ status: "connected", summary: `checked ${id}` }) });
  expect(listed.providers.map(provider => [provider.id, provider.status, provider.modelCount])).toEqual([
    ["claude-code", "missing", 9], ["codex", "configured", 5], ["devin", "missing", 4], ["opencode", "configured", 2],
  ]);
  expect(listed.providers.find(provider => provider.id === "opencode")?.models).toEqual([
    { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol (OpenAI)" },
    { id: "github-copilot/claude-fable-5", label: "Claude Fable 5 (GitHub Copilot)" },
  ]);
  expect(listed.providers.map(provider => provider.connection.summary)).toEqual(["checked claude-code", "checked codex", "checked devin", "checked opencode"]);
});

test("Codex models come from its model cache, skipping hidden ones, with the static list as fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "suplex-codex-home-"));
  expect(await readCodexModels(home)).toEqual(CODEX_MODELS);
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-7", display_name: "GPT-7", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
  ] }));
  expect(await readCodexModels(home)).toEqual([{ id: "gpt-7", label: "GPT-7" }]);
  writeFileSync(join(home, "models_cache.json"), "not json");
  expect(await readCodexModels(home)).toEqual(CODEX_MODELS);
});

test("a failed OpenCode observation leaves its row empty and still reports the executable", async () => {
  vi.spyOn(openCodeProviders, "readOpenCodeProviders").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(executables, "resolveOpenCodeExecutable").mockResolvedValue("/bin/opencode");
  vi.spyOn(executables, "resolveClaudeExecutable").mockRejectedValue(new Error("missing"));
  vi.spyOn(executables, "resolveDevinExecutable").mockRejectedValue(new Error("missing"));

  const providers = await readProviders({ directory: "/workspace" });
  expect(providers.providers).toContainEqual(expect.objectContaining({ id: "opencode", status: "configured", modelCount: 0, models: [] }));
  expect(providers.providers).toContainEqual(expect.objectContaining({ id: "claude-code", status: "missing", connection: expect.objectContaining({ status: "unknown" }) }));
  expect(providers.providers).toContainEqual(expect.objectContaining({ id: "devin", models: expect.arrayContaining([{ id: "swe-2", label: "SWE-2" }]) }));
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

test("Codex CLI login status output drives its connection state", async () => {
  vi.spyOn(executables, "resolveCodexExecutable").mockResolvedValue("/bin/codex");
  const runCommand = vi.fn(async () => probed("Logged in using ChatGPT"));
  const connected = createProviderConnectionProbe({ runCommand });
  expect(await connected("codex")).toEqual({ status: "connected", summary: expect.stringContaining("signed in") });
  expect(runCommand).toHaveBeenCalledWith("/bin/codex", ["login", "status"], expect.objectContaining({ timeout: 5_000 }));

  const signedOut = createProviderConnectionProbe({ runCommand: async () => ({ stdout: "", stderr: "Not logged in", exitCode: 1, timedOut: false }) });
  expect(await signedOut("codex")).toEqual({ status: "not-connected", summary: "Codex CLI is not signed in" });
  const timedOut = createProviderConnectionProbe({ runCommand: async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true }) });
  expect(await timedOut("codex")).toMatchObject({ status: "unknown" });
});

test("an absent Codex CLI reports not-connected", async () => {
  vi.spyOn(executables, "resolveCodexExecutable").mockRejectedValue(new Error("missing"));
  expect(await createProviderConnectionProbe()("codex")).toEqual({ status: "not-connected", summary: "Codex CLI is not installed" });
});
