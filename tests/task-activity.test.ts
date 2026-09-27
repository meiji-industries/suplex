import { expect, test } from "vitest";
import { TaskActivityResponseSchema } from "../src/frontend/contracts/task-responses.js";

test("task activity accepts a session without runtime display metadata", () => {
  expect(TaskActivityResponseSchema.safeParse({
    sessions: [{ id: "session", kind: "root", advisorRole: null, label: "Coordinator", profileId: "profile", generation: 1, nativeSessionId: null, paneId: null, current: true }],
    turns: [],
    shellPaneId: null,
  }).success).toBe(true);
});
