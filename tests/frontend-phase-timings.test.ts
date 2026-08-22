import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { PhaseTimings } from "../src/frontend/components/app/phase-timings.js";
import { phaseTimingDuration, phaseTimings } from "../src/frontend/lib/phase-timings.js";

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

test("renders proportional timing segments, the current pulse, and accessible timestamps", () => {
  const html = renderToStaticMarkup(createElement(PhaseTimings, { activity, phase: "reviewing_delivery", updatedAt: "2026-08-22T12:20:00.000Z" }));

  expect(html).toContain('data-phase-timings');
  expect(html).toContain('data-phase-timing="development"');
  expect(html).toContain("animate-pulse");
  expect(html).toContain("Total");
  expect(html).toContain("2026");
});
