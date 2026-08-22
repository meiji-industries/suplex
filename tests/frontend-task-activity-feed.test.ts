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

test("renders GitHub-adopted pull request changes as durable feed rows", () => {
  const entry = (eventType: string, metadata: Record<string, string | number | boolean> = { pullRequestNumber: 42 }) => ({ eventType, metadata });
  expect(activitySentence(entry("github_pr_ready"), activityRole(entry("github_pr_ready")))).toBe("PR #42 was marked ready on GitHub");
  expect(activitySentence(entry("github_pr_merged", { pullRequestNumber: 42, githubLogin: "octocat" }), activityRole(entry("github_pr_merged", { pullRequestNumber: 42, githubLogin: "octocat" })))).toBe("PR #42 was merged on GitHub by octocat");
  expect(activitySentence(entry("github_pr_closed"), activityRole(entry("github_pr_closed")))).toBe("PR #42 was closed on GitHub");
  expect(activitySentence(entry("github_pr_draft"), activityRole(entry("github_pr_draft")))).toBe("PR #42 was converted to draft on GitHub");
  expect(activitySentence(entry("github_pr_auto_merge_enabled"), activityRole(entry("github_pr_auto_merge_enabled")))).toBe("Auto-merge enabled on #42");
});
