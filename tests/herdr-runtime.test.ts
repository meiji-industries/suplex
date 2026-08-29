import { expect, test } from "vitest";

import { herdrRuntime } from "../src/agent-providers/herdr-runtime.js";

test("builds omp arguments for an OpenRouter model", () => {
  const runtime = herdrRuntime("openrouter");
  const settings = { model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high" as const, serviceTier: "default" as const };
  expect(runtime.kind).toBe("omp");
  expect(runtime.launchArgs(settings, "session-1", false, "/runtime/prompt.forge")).toEqual(["--model", "openrouter/anthropic/claude-sonnet-4.5", "--thinking", "high", "--approval-mode", "yolo", "--no-title", "--resume", "session-1", "@/runtime/prompt.forge"]);
  expect(herdrRuntime("codex").launchArgs({ model: "gpt", reasoningLevel: "high", serviceTier: "default" }, null, false, "/runtime/prompt.forge")).not.toContain("@/runtime/prompt.forge");
  expect(herdrRuntime("claude").launchArgs({ model: "claude-fable-5", reasoningLevel: "high", serviceTier: "default" }, "session-1", false, "/runtime/prompt.forge")).not.toContain("@/runtime/prompt.forge");
  expect(() => runtime.launchArgs({ ...settings, model: "invalid model" }, null, false)).toThrow("OpenRouter launch settings are invalid");
});
