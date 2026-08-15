import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { taskPresentationPhase, taskStatusAppearance, TaskStatus } from "../src/frontend/components/app/task-status.js";

test("task status uses the shared phase icons", () => {
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "planning" }))).toContain("lucide-circle-dot-dashed");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "backlog" }))).toContain("lucide-circle-dashed");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "blocked" }))).toContain("lucide-circle-x");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "failed" }))).toContain("lucide-circle-x");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "done" }))).toContain("lucide-circle-check");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "delivery_blocked", presentationPhase: "ci_waiting" }))).toContain("Waiting for CI");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "manual_merge" }))).toContain("Ready to Merge");
  expect(taskStatusAppearance("cancelled")).toMatchObject({ iconClass: "text-foreground/70", badge: "secondary" });
  expect(taskStatusAppearance("blocked")).toMatchObject({ iconClass: "text-rose-500", badge: "destructive-light" });
  expect(taskPresentationPhase({ phase: "delivery_blocked", releaseStatus: "ready", ciOutcome: "missing_required" })).toBe("ci_waiting");
});
