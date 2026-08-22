import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { PhaseTimings } from "../src/frontend/components/app/phase-timings.js";
import { phaseTimingDuration, phaseTimingLanes, phaseTimings } from "../src/frontend/lib/phase-timings.js";

const activity = [
  { eventType: "phase_planning", createdAt: "2026-08-22T12:00:00.000Z" },
  { eventType: "phase_approval", createdAt: "2026-08-22T12:04:00.000Z" },
  { eventType: "phase_development", createdAt: "2026-08-22T12:05:00.000Z" },
  { eventType: "member_action", createdAt: "2026-08-22T12:06:00.000Z" },
  { eventType: "phase_reviewing_delivery", createdAt: "2026-08-22T12:17:00.000Z" },
];

test("derives chronological phase visits and duration labels from activity-feed phase changes", () => {
  const timings = phaseTimings(activity, "reviewing_delivery", "2026-08-22T12:20:00.000Z");

  expect(timings).toEqual([
    expect.objectContaining({ phase: "planning", label: "Planning", durationMs: 240_000, current: false }),
    expect.objectContaining({ phase: "approval", label: "Approval", durationMs: 60_000, current: false }),
    expect.objectContaining({ phase: "development", label: "In Development", durationMs: 720_000, current: false }),
    expect.objectContaining({ phase: "reviewing_delivery", label: "In Review", durationMs: 180_000, current: true }),
  ]);
  expect(phaseTimingDuration(7_260_000)).toBe("2h 1m");
});

test("renders proportional timing segments, an active accessible current bar, and timestamps", () => {
  const html = renderToStaticMarkup(createElement(PhaseTimings, { activity, phase: "reviewing_delivery", updatedAt: "2026-08-22T12:20:00.000Z" }));

  expect(html).toContain('data-phase-timings');
  expect(html).toContain("Timeline");
  expect(html).toContain('data-phase-timing="development"');
  expect(html).toContain("phase-timing-active");
  expect(html).toContain('data-phase-timing-active="true"');
  expect(html).toContain('role="listitem"');
  expect(html).toContain("In progress.");
  expect(html).toContain("motion-reduce:animate-none");
  expect(html).toContain("Total");
  expect(html).toContain("2026");
  expect(html).toContain('data-phase-time-axis');
  expect(html).toContain('data-phase-lane="development"');
});

test("keeps the active Needs attention visit green-striped while retaining its destructive indicator", () => {
  const html = renderToStaticMarkup(createElement(PhaseTimings, {
    activity: [
      { eventType: "phase_planning", createdAt: "2026-08-22T12:00:00.000Z" },
      { eventType: "phase_delivery_blocked", createdAt: "2026-08-22T12:04:00.000Z" },
    ],
    phase: "delivery_blocked",
    updatedAt: "2026-08-22T12:20:00.000Z",
  }));

  expect(html).toContain('data-phase-timing="delivery_blocked"');
  expect(html).toContain("phase-timing-active");
  expect(html).toContain("bg-destructive");
  expect(html).toContain("Needs attention");
});

const thirtySegmentFixture = [
  ["ready_for_development", 1], ["development", 1], ["development", 11], ["delivery_ready", 1], ["reviewing_delivery", 1], ["reviewing_delivery", 2],
  ["repair_required", 1], ["repair_required", 1], ["repair_required", 1], ["delivery_reviewed", 1], ["releasing", 1], ["delivery_blocked", 63],
  ["releasing", 80], ["ci_waiting", 4], ["final_review", 1], ["repair_required", 3], ["development", 2], ["delivery_ready", 1],
  ["reviewing_delivery", 2], ["delivery_reviewed", 1], ["releasing", 3], ["ci_waiting", 5], ["final_review", 1], ["repair_required", 2],
  ["development", 4], ["delivery_ready", 1], ["reviewing_delivery", 1], ["delivery_reviewed", 1], ["releasing", 1], ["final_review", 1],
] as const;

const fixtureStart = Date.parse("2026-08-22T12:00:00.000Z");
const thirtySegmentActivity = (() => {
  let elapsed = fixtureStart;
  return thirtySegmentFixture.map(([phase, minutes]) => {
    const activity = { eventType: `phase_${phase}`, createdAt: new Date(elapsed).toISOString() };
    elapsed += minutes * 60_000;
    return activity;
  });
})();

test("merges consecutive visits and groups the thirty-segment history into first-seen lanes", () => {
  const asOf = new Date(fixtureStart + (thirtySegmentFixture.reduce((total, [, minutes]) => total + minutes, 0) * 60_000)).toISOString();
  const timings = phaseTimings(thirtySegmentActivity, "final_review", asOf);
  const lanes = phaseTimingLanes(timings);

  expect(thirtySegmentActivity).toHaveLength(30);
  expect(timings.find((timing) => timing.phase === "development")).toMatchObject({ durationMs: 12 * 60_000 });
  expect(lanes.map((lane) => lane.label)).toEqual(["Ready", "In Development", "Delivered", "In Review", "Fixing review findings", "Reviewed", "Opening PR", "Needs attention", "Waiting for CI", "Final review"]);
  expect(lanes.find((lane) => lane.phase === "repair_required")?.timings).toHaveLength(3);
});
