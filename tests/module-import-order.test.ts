import { expect, test } from "vitest";

test("native controller and runtime modules import without initialization cycles", async () => {
  await expect(import("../src/runtimes/opencode/task-runtime.js")).resolves.toBeDefined();
  await expect(import("../src/coordination/root-controller.js")).resolves.toBeDefined();
});
