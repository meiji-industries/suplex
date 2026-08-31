import { expect, test } from "vitest";

import { taskCommandDescriptors } from "../src/task-commands.js";
import { attentionActionBody } from "../src/frontend/views/attention.js";
import { taskAttentionAction } from "../src/frontend/views/task-details.js";

const idempotencyKey = "7a3b7e84-c32b-46ac-96df-b5688935a121";

test("task attention actions preserve required idempotency metadata", () => {
  const commands = taskCommandDescriptors(["approve_plan", "cancel_issue"], 8);

  expect(taskAttentionAction(commands, "approve_plan", "LGTM", idempotencyKey)).toEqual({
    path: "approve-plan",
    note: "LGTM",
    payload: { idempotencyKey },
  });
  expect(taskAttentionAction(commands, "cancel_issue")).toEqual({ path: "cancel" });
});

test("attention API actions include an idempotency key only when required", () => {
  const common = { label: "Approve plan", expectedRevision: 8, requiresNote: true, destructive: false };

  expect(attentionActionBody({ ...common, command: "approve_plan", idempotency: "required" }, "LGTM", idempotencyKey)).toEqual({ expectedRevision: 8, note: "LGTM", idempotencyKey });
  expect(attentionActionBody({ ...common, command: "cancel_issue", idempotency: "none" }, undefined, idempotencyKey)).toEqual({ expectedRevision: 8 });
});
