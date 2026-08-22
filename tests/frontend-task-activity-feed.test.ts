import { expect, test } from "vitest";

import { activityRole, activitySentence, compactActivityRows } from "../src/frontend/lib/task-activity-feed.js";

test("compacts live heartbeats, duplicate activity, and command labels", () => {
  const rows = compactActivityRows([
    { id: "heartbeat-1", at: "2026-08-21T12:00:00.000Z", role: "builder", text: "Builder is working", live: true },
    { id: "heartbeat-2", at: "2026-08-21T12:00:12.000Z", role: "builder", text: "Builder is working", live: true },
    { id: "duplicate-1", at: "2026-08-21T12:01:00.000Z", role: "you", text: "You retried development" },
    { id: "duplicate-2", at: "2026-08-21T12:01:01.000Z", role: "you", text: "You retried development" },
  ]);

  expect(rows).toMatchObject([
    { id: "heartbeat-1", at: "2026-08-21T12:00:12.000Z", live: true },
    { id: "duplicate-1", count: 2 },
  ]);
  expect(activitySentence({ eventType: "member_action", metadata: { command: "retry_development" }, actor: { id: "user" } }, activityRole({ eventType: "member_action", metadata: { command: "retry_development" }, actor: { id: "user" } }))).toBe("You retried development");
});
