import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TaskQueueSchema } from "../src/frontend/contracts/tasks.js";
import { TaskQueueWaits, backlogText } from "../src/frontend/features/tasks/task-details.js";
import { TaskStatus, taskStatusLabel } from "../src/frontend/features/tasks/task-status.js";

const queue = TaskQueueSchema.parse({ waitingOn: [{
  id: "blocker", title: "Agent prerequisite", status: "backlog", deliveryTarget: "pull_request_draft",
  reason: "prerequisite_not_started", summary: "Agent prerequisite. Start it to unblock this task.",
}] });

test("queued task presentation links its blocker and explains the wait", () => {
  const task = { companyId: "company", status: "queued" as const, queue };
  expect(taskStatusLabel(task)).toBe("Queued");
  expect(renderToStaticMarkup(createElement(TaskStatus, { status: task.status }))).toContain("Queued");
  expect(backlogText(task)).toContain("Suplex starts");
  const waits = renderToStaticMarkup(createElement(TaskQueueWaits, { task }));
  expect(waits).toContain('data-task-queue-wait="blocker"');
  expect(waits).toContain('data-reason="prerequisite_not_started"');
  expect(waits).toContain("/tasks/blocker");
  expect(waits).toContain("Agent prerequisite");
  expect(backlogText({ ...task, status: "backlog" })).toContain("Start this task to queue it");
});
