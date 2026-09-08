import { expect, test } from "vitest";
import { RootToolSchema } from "../src/coordination/root-contracts.js";

const options = [{ label: "Wait", description: "Wait for the prerequisite to land.", recommended: true }, { label: "Change scope", description: "Use the existing published code.", recommended: false }];

test("Coordinator questions require choices and exactly one recommendation", () => {
  expect(RootToolSchema.safeParse({ kind: "ask_human", question: "Which base?", options }).success).toBe(true);
  for (const invalid of [undefined, [], [options[0]], options.map(option => ({ ...option, recommended: false })), options.map(option => ({ ...option, recommended: true })), [options[0], { ...options[1], label: "Other" }]]) {
    expect(RootToolSchema.safeParse({ kind: "ask_human", question: "Which base?", options: invalid }).success).toBe(false);
  }
});
