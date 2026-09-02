import { expect, test } from "vitest";

import { advanceMilestones, emptyMilestones, formatFailureDump, type SmokeTask } from "../../scripts/smoke.mjs";

function task(phase: string, owner = "lead"): SmokeTask {
  return { id: "task-smoke", phase, owner, pendingAction: "Working", revision: 1 };
}

test("smoke phase state machine accepts the auto-approved happy path and requires a Builder PID", () => {
  let milestones = emptyMilestones();
  for (const [phase, pid] of [["planning", null], ["ready_for_development", null], ["development", 421], ["reviewing_delivery", null], ["releasing", null]] as const) {
    const next = advanceMilestones(task(phase), milestones, pid);
    expect(next.error).toBeUndefined();
    milestones = next.milestones;
  }
  expect(milestones).toEqual({ planning: true, approval: true, development: true, builderPid: true, reviewingDelivery: true, releasing: true });
});

test("smoke phase state machine stops on unexpected human intervention", () => {
  expect(advanceMilestones(task("development", "human"), emptyMilestones(), 123).error).toMatch(/requires human action/);
  expect(advanceMilestones(task("approval", "human"), emptyMilestones(), null).error).toBeUndefined();
});

test("failure dump includes the task and limits activity to 40 rows", () => {
  const dump = formatFailureDump({ error: "timed out", task: task("planning"), activity: { events: Array.from({ length: 45 }, (_, index) => ({ text: `event-${index}` })) } });
  expect(dump).toContain("SMOKE FAILURE: timed out");
  expect(dump).toContain('"id": "task-smoke"');
  expect(dump).toContain("event-44");
  expect(dump).not.toContain("event-0");
});
