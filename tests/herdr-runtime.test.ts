import { expect, test } from "vitest";

import { herdrRuntime } from "../src/agent-providers/herdr-runtime.js";

test("builds omp arguments for an OpenRouter model", () => {
  const runtime = herdrRuntime("openrouter");
  expect(runtime.kind).toBe("omp");
  expect(runtime.launchArgs({ model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" }, "session-1", false)).toEqual(["--model", "openrouter/anthropic/claude-sonnet-4.5", "--thinking", "high", "--approval-mode", "yolo", "--no-title", "--resume", "session-1"]);
  expect(() => runtime.launchArgs({ model: "invalid model", reasoningLevel: "high", serviceTier: "default" }, null, false)).toThrow("OpenRouter launch settings are invalid");
});
