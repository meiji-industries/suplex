import { expect, test } from "vitest";

test("turn result modules import in activity-first order", async () => {
  await expect(import("../src/engine/activities/herdr-liveness.js")).resolves.toBeDefined();
  await expect(import("../src/active-turn-recovery.js")).resolves.toBeDefined();
});
