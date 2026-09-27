import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { TaskControlStatusSchema } from "../src/frontend/contracts/task-control.js";
import { blockedByLabel, TaskStatus, TaskStatusIcon, taskStatusLabels, taskStatusTones } from "../src/frontend/features/tasks/task-status.js";

test("Blocked by labels pull requests by number and observed state", () => {
  expect(blockedByLabel([{ kind: "pull_request", number: 41, title: "Pull 41", state: "closed", status: "backlog" }, { title: "Prepare release", status: "active" }])).toBe("Blocked by #41 Pull 41 · Closed, Prepare release · Active");
});

test("task status bubbles use one tone per status, matched by the status icon", () => {
  expect(taskStatusTones).toEqual({ backlog: "neutral", queued: "sky", active: "teal", waiting_human: "amber", cancelled: "neutral", delivered: "green" });
  const iconColors = { neutral: "text-muted-foreground", sky: "text-sky-500", teal: "text-teal-500", amber: "text-amber-500", green: "text-green-500" };

  for (const status of TaskControlStatusSchema.options) {
    const tone = taskStatusTones[status];
    const bubble = renderToStaticMarkup(createElement(TaskStatus, { status }));
    expect(bubble).toContain(`>${taskStatusLabels[status]}</span>`);
    expect(bubble).not.toContain("<svg");
    if (tone !== "neutral") expect(bubble).toMatch(new RegExp(`border-${tone}-300 bg-${tone}-50 text-${tone}-600`));
    expect(renderToStaticMarkup(createElement(TaskStatusIcon, { status }))).toContain(iconColors[tone]);
  }
  expect(renderToStaticMarkup(createElement(TaskStatus, { status: "backlog" }))).toContain("border-zinc-300 bg-zinc-50 text-zinc-600");
});

test("a delivered bubble keeps the merged state for assistive technology", () => {
  expect(renderToStaticMarkup(createElement(TaskStatus, { status: "delivered", pullRequestState: "merged" }))).toContain('Delivered<span class="sr-only">, merged</span>');
  expect(renderToStaticMarkup(createElement(TaskStatusIcon, { status: "delivered", pullRequestState: "merged" }))).toContain('aria-label="Delivered, merged"');
});
