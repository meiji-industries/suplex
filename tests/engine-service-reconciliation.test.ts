import { beforeEach, expect, test, vi } from "vitest";

const { execute, run } = vi.hoisted(() => ({
  execute: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../src/engine/index.js", () => ({
  getIssueEngine: () => ({ run }),
}));

import { reconcileIssueDeveloperDelivery } from "../src/engine/service.js";

beforeEach(() => {
  execute.mockReset();
  run.mockReset();
  run.mockReturnValue({ execute });
  execute.mockResolvedValue({});
});

test("late Developer delivery reconciliation uses the supported retry command", async () => {
  await reconcileIssueDeveloperDelivery({} as never, "workflow-1", {
    expectedRevision: 7,
    actorUserId: "system",
    commandId: "late-result-turn-1",
    reconcileOnly: true,
  });

  expect(run).toHaveBeenCalledWith("workflow-1");
  expect(execute).toHaveBeenCalledWith("retryDevelopment", {
    expectedRevision: 7,
    actorUserId: "system",
    commandId: "late-result-turn-1",
    reconcileOnly: true,
  }, "late-result-turn-1");
});
