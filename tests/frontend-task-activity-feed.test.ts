import { expect, test } from "vitest";

import { activityRole, activitySentence, compactActivityRows, withoutLegacyMaterialitySummary } from "../src/frontend/lib/task-activity-feed.js";

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

test("removes legacy materiality suffixes from plan summaries", () => {
  expect(withoutLegacyMaterialitySummary("Plan the update (Material plan: user_visible_behavior)")).toBe("Plan the update");
  expect(withoutLegacyMaterialitySummary("Plan the update (Routine plan)")).toBe("Plan the update");
  expect(activitySentence({ eventType: "planner_note_revised", metadata: { summary: "Plan the update (Material plan: user_visible_behavior)" } }, "planner")).toBe("Planner revised the plan: Plan the update");
});

test("keeps separate Tell-the-Planner rounds when planner lifecycle text repeats", () => {
  const rows = compactActivityRows([
    { id: "planner-note-1", at: "2026-08-23T03:32:26.513Z", role: "you", text: "You told the Planner: Update the pack terms" },
    { id: "planner-start-1", at: "2026-08-23T03:32:26.537Z", role: "planner", text: "Planner started the plan" },
    { id: "planner-revised-execution-1", at: "2026-08-23T03:34:06.677Z", role: "planner", text: "Planner revised the plan: First summary" },
    { id: "planner-note-2", at: "2026-08-23T04:01:54.446Z", role: "you", text: "You told the Planner: Update the pack terms" },
    { id: "planner-start-2", at: "2026-08-23T04:01:54.464Z", role: "planner", text: "Planner started the plan" },
    { id: "planner-revised-execution-2", at: "2026-08-23T04:03:01.061Z", role: "planner", text: "Planner revised the plan: Second summary" },
  ]);

  expect(rows.map((row) => row.id)).toEqual([
    "planner-note-1",
    "planner-start-1",
    "planner-revised-execution-1",
    "planner-note-2",
    "planner-start-2",
    "planner-revised-execution-2",
  ]);
  expect(compactActivityRows([
    { id: "planner-start-1", at: "2026-08-23T03:32:26.537Z", role: "planner", text: "Planner started the plan" },
    { id: "planner-start-2", at: "2026-08-23T04:01:54.464Z", role: "planner", text: "Planner started the plan" },
  ]).map((row) => row.id)).toEqual(["planner-start-1", "planner-start-2"]);
});

test("renders GitHub-adopted pull request changes as durable feed rows", () => {
  const entry = (eventType: string, metadata: Record<string, string | number | boolean> = { pullRequestNumber: 42 }) => ({ eventType, metadata });
  expect(activitySentence(entry("github_pr_ready"), activityRole(entry("github_pr_ready")))).toBe("PR #42 was marked ready on GitHub");
  expect(activitySentence(entry("github_pr_merged", { pullRequestNumber: 42, githubLogin: "octocat" }), activityRole(entry("github_pr_merged", { pullRequestNumber: 42, githubLogin: "octocat" })))).toBe("PR #42 was merged on GitHub by octocat");
  expect(activitySentence(entry("github_pr_closed"), activityRole(entry("github_pr_closed")))).toBe("PR #42 was closed on GitHub");
  expect(activitySentence(entry("github_pr_draft"), activityRole(entry("github_pr_draft")))).toBe("PR #42 was converted to draft on GitHub");
  expect(activitySentence(entry("github_pr_auto_merge_enabled"), activityRole(entry("github_pr_auto_merge_enabled")))).toBe("Auto-merge enabled on #42");
  const done = entry("phase_done", { deliveryTarget: "pull_request_draft" });
  expect(activitySentence(done, activityRole(done))).toBe("Integrator completed the task · Draft PR");
});
