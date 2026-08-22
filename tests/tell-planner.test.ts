import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ISSUE_PHASES } from "../src/issue-phases.js";
import { SendPlannerNoteBodySchema, plannerNoteAvailable } from "../src/commands/definitions/planning.js";
import { TellPlannerForm } from "../src/frontend/components/app/tell-planner-form.js";
import { TaskActivity } from "../src/frontend/components/app/task-history.js";

describe("Tell the Planner command", () => {
  test("requires a current revision, note, and command ID", () => {
    expect(SendPlannerNoteBodySchema.parse({ expectedRevision: 4, note: "Undo the template change", commandId: "note-1" })).toEqual({ expectedRevision: 4, note: "Undo the template change", commandId: "note-1" });
    expect(() => SendPlannerNoteBodySchema.parse({ expectedRevision: 4, note: "", commandId: "note-1" })).toThrow();
  });

  test("is available in every phase that has not ended", () => {
    const availability = Object.fromEntries(ISSUE_PHASES.map((phase) => [phase, plannerNoteAvailable(phase)]));
    expect(Object.entries(availability).filter(([, allowed]) => !allowed).map(([phase]) => phase)).toEqual(["done", "cancelled"]);
    expect(availability.development).toBe(true);
    expect(availability.failed).toBe(true);
    expect(plannerNoteAvailable("failed", "successor-1")).toBe(false);
  });
});

test("renders the activity composer and optimistic feedback row", () => {
  const form = renderToStaticMarkup(createElement(TellPlannerForm, { disabled: false, onSubmit: async () => undefined }));
  expect(form).toContain("Tell the Planner");
  expect(form).toContain("Cmd/Ctrl+Enter to send");
  const feed = renderToStaticMarkup(createElement(TaskActivity, { taskId: "task-1", timeline: [], optimisticRows: [{ id: "note-1", at: "2026-08-22T12:00:00.000Z", role: "you", text: "You told the Planner: Undo that please" }] }));
  expect(feed).toContain("told the Planner: Undo that please");
});

test("renders a disabled terminal composer with a reason", () => {
  const html = renderToStaticMarkup(createElement(TellPlannerForm, { disabled: true, disabledReason: "Planner feedback is unavailable after this task has ended.", onSubmit: async () => undefined }));
  expect(html).toContain("Planner feedback is unavailable after this task has ended.");
  expect(html).toContain("disabled");
});
