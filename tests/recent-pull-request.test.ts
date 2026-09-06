import { expect, test } from "vitest";
import { canQuickArchive, pullRequestColor } from "../src/frontend/components/app/recent-pull-request.js";
import { TaskChecksResponseSchema } from "../src/http/contracts/tasks.js";

test.each([
  ["merged", "ready", ["failing", "pending"], "purple"],
  ["open", "merged", ["failing"], "purple"],
  ["open", "ready", ["failing", "pending"], "red"],
  ["draft", "draft", ["successful", "failing"], "red"],
  ["open", "ready", ["successful", "pending"], "yellow"],
  ["draft", "draft", ["successful", "successful"], "green"],
  ["open", "ready", [], "green"],
  ["draft", "draft", [], "grey"],
  ["closed", "closed", ["successful"], "grey"],
])("PR %s observed as %s with %j is %s", (state, observed, statuses, expected) => {
  const checks = TaskChecksResponseSchema.parse({ available: true, pullRequestState: observed, runs: Array.from(statuses, status => ({ name: status, status, url: null })) });
  expect(pullRequestColor(state, checks)).toBe(expected);
});

test("missing or unavailable CI is not all-passing CI", () => {
  expect(pullRequestColor("open", null)).toBe("grey");
  expect(pullRequestColor("draft", { available: false, runs: [{ name: "old", status: "successful", url: null }] })).toBe("grey");
});

test.each([
  ["purple", "delivered", null, true],
  ["purple", "delivered", "2026-09-06T00:00:00.000Z", false],
  ["purple", "active", null, false],
  ["red", "delivered", null, false],
])("quick archive is %s for %s %s tasks", (color, status, archivedAt, expected) => {
  expect(canQuickArchive(color as Parameters<typeof canQuickArchive>[0], status as Parameters<typeof canQuickArchive>[1], archivedAt)).toBe(expected);
});
