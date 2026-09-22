import { expect, test } from "vitest";
import { checkRunLabel, checkRunName, checkRunStatus, type CheckRun } from "../src/frontend/features/tasks/lib/task-checks.js";

const run = (overrides: Partial<CheckRun>): CheckRun => ({ name: "build", status: "successful", url: null, ...overrides });

test("check run status prefers the conclusion over the rollup status", () => {
  expect(checkRunStatus(run({ status: "successful" }))).toBe("passed");
  expect(checkRunStatus(run({ status: "failing" }))).toBe("failed");
  expect(checkRunStatus(run({ status: "pending" }))).toBe("pending");
  expect(checkRunStatus(run({ status: "successful", conclusion: "SKIPPED" }))).toBe("skipped");
  expect(checkRunStatus(run({ status: "successful", conclusion: "NEUTRAL" }))).toBe("neutral");
});

test("check run names add the workflow unless the name already qualifies itself", () => {
  expect(checkRunName(run({ workflow: "CI" }))).toBe("CI / build");
  expect(checkRunName(run({ name: "Tests / DB-free", workflow: "CI" }))).toBe("Tests / DB-free");
  expect(checkRunName(run({}))).toBe("build");
});

test("check run labels report completed durations when both timestamps are present", () => {
  expect(checkRunLabel(run({ startedAt: "2026-09-13T04:57:33Z", completedAt: "2026-09-13T04:58:33Z" }))).toBe("Passed in 1m");
  expect(checkRunLabel(run({ status: "failing", startedAt: "2026-09-13T04:57:33Z", completedAt: "2026-09-13T04:58:11Z" }))).toBe("Failed in 38s");
  expect(checkRunLabel(run({}))).toBe("Passed");
  expect(checkRunLabel(run({ conclusion: "SKIPPED" }))).toBe("Skipped");
});

test("pending check run labels show elapsed time from their start", () => {
  const startedAt = "2026-09-13T04:57:33Z";
  expect(checkRunLabel(run({ status: "pending", startedAt }), Date.parse("2026-09-13T05:01:40Z"))).toBe("Running 4m 07s");
  expect(checkRunLabel(run({ status: "pending", startedAt }), Date.parse("2026-09-13T04:58:15Z"))).toBe("Running 42s");
  expect(checkRunLabel(run({ status: "pending", startedAt }), Date.parse("2026-09-13T06:01:33Z"))).toBe("Running 1h 04m");
  expect(checkRunLabel(run({ status: "pending", startedAt }), Date.parse("2026-09-13T04:57:32Z"))).toBe("Running 0s");
});

test("pending check runs without a usable start stay pending", () => {
  expect(checkRunLabel(run({ status: "pending" }))).toBe("Pending");
  expect(checkRunLabel(run({ status: "pending", startedAt: "not a date" }))).toBe("Pending");
});
