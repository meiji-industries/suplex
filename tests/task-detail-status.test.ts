import { expect, test } from "vitest";

import { taskDetailNeedsRefresh } from "../src/frontend/lib/task-detail-status.js";

test("refreshes task detail when an agent-event status revision changes within one phase", () => {
  const current = { phase: "delivery_blocked", terminal: false, revision: 41 };

  expect(taskDetailNeedsRefresh(current, { ...current, revision: 42 })).toBe(true);
});

test("does not refresh while seeding the first agent-event status", () => {
  expect(taskDetailNeedsRefresh(undefined, { phase: "delivery_blocked", terminal: false, revision: 42 })).toBe(false);
});

test("does not refresh task detail for an identical agent-event status", () => {
  const status = { phase: "delivery_blocked", terminal: false, revision: 42 };

  expect(taskDetailNeedsRefresh(status, status)).toBe(false);
});
