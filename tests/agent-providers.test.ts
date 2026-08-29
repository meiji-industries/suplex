import { expect, test } from "vitest";

import { resolveAgentProvider } from "../src/agent-providers/index.js";

test("resolves registered agent providers and rejects unknown providers", () => {
  expect(resolveAgentProvider().id).toBe("codex");
  expect(resolveAgentProvider("claude").id).toBe("claude");
  expect(resolveAgentProvider("openrouter").id).toBe("openrouter");
  expect(() => resolveAgentProvider("unknown" as never)).toThrow("Unknown agent provider: unknown");
});
