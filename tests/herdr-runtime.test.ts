import { expect, test } from "vitest";

import { herdrRuntime } from "../src/agent-providers/herdr-runtime.js";

const rootCapability = {
  kind: "root" as const,
  bridgeConfigPath: "/runtime/root.mcp.json",
  bridgeConfig: { version: 1 as const, root: { taskId: "task_1", sessionId: "session_1", generation: 1 }, server: { command: "node", args: ["/forge/root-bridge.js", "--binding", "/runtime/root.binding.json"] } },
};

test("Root argv keeps Codex and Claude read-only and configures Forge's bridge", () => {
  const codex = herdrRuntime("codex").launchArgs({ model: "gpt", reasoningLevel: "high", serviceTier: "default" }, null, false, undefined, rootCapability);
  expect(codex).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never"]));
  expect(codex.join(" ")).toContain("mcp_servers.forge_root.command");
  expect(codex).toContain('mcp_servers.forge_root.default_tools_approval_mode="approve"');
  expect(codex).not.toContain("--ignore-user-config");
  expect(codex).not.toContain("--ignore-rules");
  expect(codex).not.toContain("mcp_servers={}");
  expect(codex).not.toContain("--dangerously-bypass-approvals-and-sandbox");

  const claude = herdrRuntime("claude").launchArgs({ model: "claude-fable-5", reasoningLevel: "high", serviceTier: "default" }, "session-1", false, undefined, rootCapability);
  expect(claude).toEqual(expect.arrayContaining(["--restricted", "--tools", "Read,Grep,Glob,mcp__forge_root__forge_root", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--strict-mcp-config", "--mcp-config", "/runtime/root.mcp.json"]));
  expect(claude).not.toContain("bypassPermissions");

  expect(() => herdrRuntime("openrouter").launchArgs({ model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" }, null, false, undefined, rootCapability)).toThrow("OpenRouter cannot launch a Root session");
});

test("builds omp arguments for an OpenRouter model", () => {
  const runtime = herdrRuntime("openrouter");
  const settings = { model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high" as const, serviceTier: "default" as const };
  expect(runtime.kind).toBe("omp");
  expect(runtime.launchArgs(settings, "session-1", false, "/runtime/prompt.forge", { kind: "worker" })).toEqual(["--model", "openrouter/anthropic/claude-sonnet-4.5", "--thinking", "high", "--approval-mode", "yolo", "--no-title", "--resume", "session-1", "@/runtime/prompt.forge"]);
  expect(herdrRuntime("codex").launchArgs({ model: "gpt", reasoningLevel: "high", serviceTier: "default" }, null, false, "/runtime/prompt.forge", { kind: "worker" })).not.toContain("@/runtime/prompt.forge");
  expect(herdrRuntime("claude").launchArgs({ model: "claude-fable-5", reasoningLevel: "high", serviceTier: "default" }, "session-1", false, "/runtime/prompt.forge", { kind: "worker" })).not.toContain("@/runtime/prompt.forge");
  expect(() => runtime.launchArgs({ ...settings, model: "invalid model" }, null, false, undefined, { kind: "worker" })).toThrow("OpenRouter launch settings are invalid");
});
