import { expect, test } from "vitest";
import { blockedByLabel } from "../src/frontend/features/tasks/task-status.js";

test("Blocked by labels pull requests by number and observed state", () => {
  expect(blockedByLabel([{ kind: "pull_request", number: 41, title: "Pull 41", state: "closed", status: "backlog", queued: false }, { title: "Prepare release", status: "active", queued: false }])).toBe("Blocked by #41 Pull 41 · Closed, Prepare release · Active");
});
