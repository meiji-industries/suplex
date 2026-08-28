import { expect, test } from "vitest";

import { taskDeliveryTargetOptions } from "../src/frontend/components/app/task-delivery-target.js";

test("task template settings shares the task delivery target choices", () => {
  expect(taskDeliveryTargetOptions).toEqual([
    { value: "local_worktree", label: "Keep in worktree" },
    { value: "remote_branch", label: "Push branch" },
    { value: "pull_request_draft", label: "Draft pull request" },
    { value: "pull_request_ready", label: "Ready for review" },
    { value: "merged", label: "Fully merged" },
  ]);
});
