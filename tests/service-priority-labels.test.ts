import { expect, test } from "vitest";

import { PROVIDER_HARNESSES, SERVICE_PRIORITIES, servicePriorityLabel } from "../src/agent-providers/kinds.js";

test("service priority labels match each provider's own naming", () => {
  expect(servicePriorityLabel("openrouter", "priority")).toBe("Nitro (throughput)");
  expect(servicePriorityLabel("openrouter", "standard")).toBe("Default routing");
  expect(servicePriorityLabel("codex", "fast")).toBe("Fast");
  expect(servicePriorityLabel("claude", "fast")).toBe("Fast mode");
});

test("unknown priority values fall back to the raw string", () => {
  expect(servicePriorityLabel("codex", "unknown")).toBe("unknown");
});

test("every provider defines a label for each service priority", () => {
  for (const [provider, harness] of Object.entries(PROVIDER_HARNESSES)) {
    expect(Object.keys(harness.servicePriorityLabels), provider).toEqual([...SERVICE_PRIORITIES]);
  }
});
