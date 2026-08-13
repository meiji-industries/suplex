import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { TaskStatus } from "../src/frontend/components/app/task-status.js";

test("task status uses the shared phase icons", () => {
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "planning" }))).toContain("lucide-circle-dot-dashed");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "backlog" }))).toContain("lucide-circle-dashed");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "blocked" }))).toContain("lucide-circle-x");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "failed" }))).toContain("lucide-circle-x");
  expect(renderToStaticMarkup(createElement(TaskStatus, { phase: "done" }))).toContain("lucide-circle-check");
});
