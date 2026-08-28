import { expect, test } from "vitest";

import { classifyDelivery } from "../src/developer-contracts.js";

const sha = "b".repeat(40);
const partial = { steps: [{ number: 1, status: "completed" }, { number: 2, status: "incomplete" }], authorizedStepsNotCompleted: [2], dirtyState: "clean", resultCommit: sha, blocker: "Required tests are incomplete." };

test("classifies completed authorized steps as complete", () => {
  expect(classifyDelivery({ ...partial, steps: [{ number: 1, status: "completed" }, { number: 2, status: "not_applicable_locally" }], authorizedStepsNotCompleted: [] }, "a".repeat(40))).toBe("complete");
});

test("classifies clean new committed partial work as incomplete regardless of blocker text", () => {
  expect(classifyDelivery(partial, "a".repeat(40))).toBe("incomplete");
});

test("classifies blocked steps, dirty work, and unchanged commits as blocked", () => {
  expect(classifyDelivery({ ...partial, steps: [{ number: 1, status: "blocked" }], authorizedStepsNotCompleted: [1] }, "a".repeat(40))).toBe("blocked");
  expect(classifyDelivery({ ...partial, dirtyState: "dirty" }, "a".repeat(40))).toBe("blocked");
  expect(classifyDelivery(partial, sha)).toBe("blocked");
});
