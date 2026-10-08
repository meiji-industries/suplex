import { expect, test } from "vitest";
import { modelHint } from "../features/admin/model-hints.js";

test("modelHint returns the hand-written hint for a listed model", () => {
  expect(modelHint("gpt-5.6-luna", "Codex model")).toBe("Fast and cheap. Good for routine edits.");
  expect(modelHint("anthropic/claude-haiku-4-5-20251001")).toBe("Fastest and cheapest. Good for routine edits.");
});

test("modelHint returns the fallback for a model without a hint", () => {
  expect(modelHint("gpt-7", "Codex model")).toBe("Codex model");
  expect(modelHint("gpt-7")).toBe("");
});
