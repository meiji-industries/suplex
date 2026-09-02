import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { PhaseTimings } from "../src/frontend/components/app/phase-timings.js";
import { phaseTimingDuration, phaseTimingLanes, phaseTimings } from "../src/frontend/lib/phase-timings.js";

const activity = [
  { eventType: "phase_planning", createdAt: "2026-08-22T12:00:00.000Z" },
  { eventType: "phase_approval", createdAt: "2026-08-22T12:04:00.000Z" },
  { eventType: "phase_building", createdAt: "2026-08-22T12:05:00.000Z" },
  { eventType: "member_action", createdAt: "2026-08-22T12:06:00.000Z" },
  { eventType: "phase_reviewing", createdAt: "2026-08-22T12:17:00.000Z" },
];

test("derives chronological phase visits and duration labels from activity-feed phase changes", () => {
  const timings = phaseTimings(activity, "reviewing", "2026-08-22T12:20:00.000Z");

  expect(timings).toEqual([
    expect.objectContaining({ phase: "planning", label: "Planning", durationMs: 240_000, current: false }),
    expect.objectContaining({ phase: "approval", label: "Needs approval", durationMs: 60_000, current: false }),
    expect.objectContaining({ phase: "building", label: "Building", durationMs: 720_000, current: false }),
    expect.objectContaining({ phase: "reviewing", label: "Reviewing", durationMs: 180_000, current: true }),
  ]);
  expect(phaseTimingDuration(7_260_000)).toBe("2h 1m");
});

test("derives planning and approval visits from legacy planning activity", () => {
  const timings = phaseTimings([
    { eventType: "planning_started", createdAt: "2026-08-22T12:00:00.000Z" },
    { eventType: "planning_started", metadata: { planningStage: "completed" }, createdAt: "2026-08-22T12:04:00.000Z" },
    { eventType: "phase_building", createdAt: "2026-08-22T12:10:00.000Z" },
  ], "building", "2026-08-22T12:15:00.000Z");

  expect(timings).toEqual([
    expect.objectContaining({ phase: "planning", durationMs: 240_000 }),
    expect.objectContaining({ phase: "approval", durationMs: 360_000 }),
    expect.objectContaining({ phase: "building", durationMs: 300_000, current: true }),
  ]);
});

test("renders proportional timing segments, an active accessible current bar, and timestamps", () => {
  const html = renderToStaticMarkup(createElement(PhaseTimings, { activity, phase: "reviewing", updatedAt: "2026-08-22T12:20:00.000Z" }));

  expect(html).toContain('data-phase-timings');
  expect(html).toContain("Timeline");
  expect(html).toContain('data-phase-timing="building"');
  expect(html).toContain("phase-timing-active");
  expect(html).toContain('data-phase-timing-active="true"');
  expect(html).toContain('role="listitem"');
  expect(html).toContain("In progress.");
  expect(html).toContain("motion-reduce:animate-none");
  expect(html).toContain("Total");
  expect(html).toContain("2026");
  expect(html).toContain('data-phase-time-axis');
  expect(html).toContain('data-phase-lane="building"');
});

test("renders the active shipping visit", () => {
  const html = renderToStaticMarkup(createElement(PhaseTimings, {
    activity: [
      { eventType: "phase_planning", createdAt: "2026-08-22T12:00:00.000Z" },
      { eventType: "phase_shipping", createdAt: "2026-08-22T12:04:00.000Z" },
    ],
    phase: "shipping",
    updatedAt: "2026-08-22T12:20:00.000Z",
  }));

  expect(html).toContain('data-phase-timing="shipping"');
  expect(html).toContain("phase-timing-active");
  expect(html).toContain("Shipping");
});

const thirtySegmentFixture = [
  ["building", 1], ["building", 1], ["building", 11], ["reviewing", 1], ["reviewing", 1], ["reviewing", 2],
  ["building", 1], ["building", 1], ["building", 1], ["reviewing", 1], ["shipping", 1], ["shipping", 63],
  ["shipping", 80], ["shipping", 4], ["reviewing", 1], ["building", 3], ["building", 2], ["reviewing", 1],
  ["reviewing", 2], ["reviewing", 1], ["shipping", 3], ["shipping", 5], ["reviewing", 1], ["building", 2],
  ["building", 4], ["reviewing", 1], ["reviewing", 1], ["reviewing", 1], ["shipping", 1], ["reviewing", 1],
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
  const timings = phaseTimings(thirtySegmentActivity, "reviewing", asOf);
  const lanes = phaseTimingLanes(timings);

  expect(thirtySegmentActivity).toHaveLength(30);
  expect(timings.find((timing) => timing.phase === "building")).toMatchObject({ durationMs: 13 * 60_000 });
  expect(lanes.map((lane) => lane.label)).toEqual(["Building", "Reviewing", "Shipping"]);
  expect(lanes.find((lane) => lane.phase === "building")?.timings).toHaveLength(4);
});
