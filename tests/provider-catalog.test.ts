import { afterEach, expect, test, vi } from "vitest";
import * as executables from "../src/platform/executable-resolver.js";
import * as openCodeProviders from "../src/runtimes/opencode/providers.js";
import { readProviders } from "../src/profiles/provider-catalog.js";

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
