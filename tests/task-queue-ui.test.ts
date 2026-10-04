import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TaskQueueSchema, type Task } from "../src/frontend/contracts/tasks.js";
import { TaskQueueStatus, TaskQueueWaits, backlogText } from "../src/frontend/features/tasks/task-details.js";
import { TaskStatus, taskStatusLabel } from "../src/frontend/features/tasks/task-status.js";

const queue: Task["queue"] = { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [{
  kind: "task", id: "blocker", title: "Agent prerequisite", status: "backlog", deliveryTarget: "pull_request_draft",
  reason: "prerequisite_not_started", summary: "Agent prerequisite. Start it to unblock this task.",
}] };
TaskQueueSchema.parse(queue);

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

test("queued task explains project capacity and preserves prerequisite reasons", () => {
  expect(backlogText({ status: "queued", queue: { waitingOn: [], projectConcurrencyLimited: true, planConcurrencyLimited: false } })).toBe("Queued. Project concurrency limit reached.");
  expect(backlogText({ status: "queued", queue: { ...queue, projectConcurrencyLimited: true } })).toBe("Queued. Prerequisites incomplete and project concurrency limit reached.");
  expect(backlogText({ status: "queued", queue: { waitingOn: [], projectConcurrencyLimited: false, planConcurrencyLimited: false } })).toBe("Queued. Suplex will start this task.");
  expect(backlogText({ status: "queued", queue: { waitingOn: [], projectConcurrencyLimited: false, planConcurrencyLimited: true } })).toContain("Free runs 3 tasks at a time.");
});

test("queued task status offers Start anyway beside Send to backlog", () => {
  const props = { editable: true, busy: false, onEdit: () => {}, onAction: () => {} };
  const queued = renderToStaticMarkup(createElement(TaskQueueStatus, { ...props, task: { companyId: "company", status: "queued", queue } }));
  expect(queued).toContain('data-slot="alert"');
  expect(queued).toContain("Start anyway");
  expect(queued).toContain("Send to backlog");
  expect(queued).toContain('data-task-queue-wait="blocker"');
  const backlog = renderToStaticMarkup(createElement(TaskQueueStatus, { ...props, task: { companyId: "company", status: "backlog", queue } }));
  expect(backlog).not.toContain("Start anyway");
  expect(backlog).toContain("Queue task");
});
