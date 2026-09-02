import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ISSUE_PHASES } from "../src/issue-phases.js";
import { SendPlannerNoteBodySchema, plannerNoteAvailable } from "../src/commands/definitions/planning.js";
import { ChatComposer } from "../src/frontend/components/app/task-chat/chat-composer.js";
import { TaskActivity } from "../src/frontend/components/app/task-history.js";

describe("Tell the Planner command", () => {
  test("requires a current revision, note, and command ID", () => {
    expect(SendPlannerNoteBodySchema.parse({ expectedRevision: 4, note: "Undo the template change", commandId: "note-1" })).toEqual({ expectedRevision: 4, note: "Undo the template change", commandId: "note-1" });
    expect(() => SendPlannerNoteBodySchema.parse({ expectedRevision: 4, note: "", commandId: "note-1" })).toThrow();
  });

  test("is available in every phase that has not ended", () => {
    const availability = Object.fromEntries(ISSUE_PHASES.map((phase) => [phase, plannerNoteAvailable(phase)]));
    expect(Object.entries(availability).filter(([, allowed]) => !allowed).map(([phase]) => phase)).toEqual(["done", "cancelled"]);
    expect(availability.building).toBe(true);
  });
});

test("renders the chat composer and optimistic feedback row", () => {
  const form = renderToStaticMarkup(createElement(ChatComposer, { taskId: "task-1", phase: "planning", disabled: false, plannerAvailable: true, onSubmit: async () => undefined }));
  expect(form).toContain("Planner (plan note)");
  expect(form).toContain("Send");
  expect(form).toContain("Cmd/Ctrl+Enter to send");
  const feed = renderToStaticMarkup(createElement(TaskActivity, { taskId: "task-1", timeline: [], optimisticRows: [{ id: "note-1", at: "2026-08-22T12:00:00.000Z", role: "you", text: "You told the Planner: Undo that please" }] }));
  expect(feed).toContain("told the Planner: Undo that please");
});

test("hides the composer after the task ends", () => {
  const html = renderToStaticMarkup(createElement(ChatComposer, { taskId: "task-1", phase: "done", disabled: false, plannerAvailable: false, onSubmit: async () => undefined }));
  expect(html).toBe("");
});
