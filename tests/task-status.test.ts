import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { LiveStatusDot, taskStatusAppearance, taskStatusLabel, TaskStatus } from "../src/frontend/components/app/task-status.js";
import { PHASE_LABELS } from "../src/issue-phases.js";

test("task status uses the shared phase icons", () => {
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "planning" }))).toContain("lucide-circle-dot-dashed");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "backlog" }))).toContain("lucide-circle-dashed");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "building", blocked: true }))).toContain("lucide-circle-x");
  expect(PHASE_LABELS.building).toBe("Building");
  expect(PHASE_LABELS.shipping).toBe("Shipping");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "done" }))).toContain("lucide-circle-check");
  expect(taskStatusLabel("done", "pull_request_draft")).toBe("Done");
  expect(taskStatusLabel("shipping", "Waiting for CI")).toBe("Shipping · Waiting for CI");
  const merged = renderToStaticMarkup(createElement(TaskStatus, { phase: "done", deliveryTarget: "pull_request_ready", pullRequestState: "merged" }));
  expect(merged).toContain("Done");
  expect(merged).toContain('data-task-status-icon="merged"');
  expect(merged).toContain("bg-emerald-500");
  expect(merged).toContain("text-white");
  expect(merged).toContain("lucide-check");
  expect(merged).not.toContain("lucide-circle-check");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "done", deliveryTarget: "pull_request_ready", pullRequestState: "open" }))).toContain("lucide-circle-check");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "shipping", pendingAction: "Waiting for CI" }))).toContain("Shipping · Waiting for CI");
  expect(taskStatusAppearance("cancelled")).toMatchObject({ iconClass: "text-foreground/70", badge: "secondary" });
  expect(taskStatusAppearance("shipping", true)).toMatchObject({ iconClass: "text-rose-500", badge: "destructive-light" });
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "reviewing", pendingAction: "Review delivery" }))).toContain("Reviewing · Review delivery");
});

test("live status dots show the current role state", () => {
  const working = renderToStaticMarkup(createElement(LiveStatusDot, { liveStatus: [{ role: "builder", status: "working" }] }));
  expect(working).toContain('data-live-status-dot="working"');
  expect(working).toContain("bg-emerald-500");
  expect(working).toContain("animate-pulse");
  expect(renderToStaticMarkup(createElement(LiveStatusDot, { liveStatus: [{ role: "planner", status: "awaiting_human" }] }))).toContain('data-live-status-dot="blocked"');
  expect(renderToStaticMarkup(createElement(LiveStatusDot, { liveStatus: [{ role: "reviewer", status: "failed" }] }))).toContain('data-live-status-dot="failed"');
  expect(renderToStaticMarkup(createElement(LiveStatusDot, { liveStatus: [{ role: "planner", status: "idle" }] }))).toBe("");
});
