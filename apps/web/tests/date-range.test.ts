import { expect, test } from "vitest";

import {
  changeDateRangeEnd,
  changeDateRangeStart,
  customRange,
  dateRangeIncludes,
  displayedDates,
  initialDateRange,
  presetRange,
  resolveDateRange,
} from "../components/app/date-range.js";

const now = new Date(2026, 7, 20, 15, 30);

test("presets cover whole local days that end after today", () => {
  expect(presetRange("today", now)).toEqual({ start: new Date(2026, 7, 20).getTime(), end: new Date(2026, 7, 21).getTime() });
  expect(presetRange("7-days", now).start).toBe(new Date(2026, 7, 14).getTime());
  expect(presetRange("30-days", now).start).toBe(new Date(2026, 6, 22).getTime());
  expect(customRange("2026-08-01", "2026-08-03")).toEqual({ start: new Date(2026, 7, 1).getTime(), end: new Date(2026, 7, 4).getTime() });
});

test("a new selection shows the preset days and keeps them as its custom days", () => {
  const selection = initialDateRange("7-days", now);
  expect(selection).toEqual({ preset: "7-days", customStart: "2026-08-14", customEnd: "2026-08-20" });
  expect(resolveDateRange({ ...selection, preset: "custom" }, "2026-08-20")).toEqual(resolveDateRange(selection, "2026-08-20"));
  expect(displayedDates(selection, resolveDateRange(selection, "2026-08-20"))).toEqual({ start: "2026-08-14", end: "2026-08-20" });
});

test("custom days reconcile a start after the end and an end before the start", () => {
  const displayed = { start: "2026-08-14", end: "2026-08-20" };
  expect(changeDateRangeStart(displayed, "2026-08-10")).toEqual({ preset: "custom", customStart: "2026-08-10", customEnd: "2026-08-20" });
  expect(changeDateRangeStart(displayed, "2026-08-22")).toEqual({ preset: "custom", customStart: "2026-08-22", customEnd: "2026-08-22" });
  expect(changeDateRangeEnd(displayed, "2026-08-16")).toEqual({ preset: "custom", customStart: "2026-08-14", customEnd: "2026-08-16" });
  expect(changeDateRangeEnd(displayed, "2026-08-01")).toEqual({ preset: "custom", customStart: "2026-08-01", customEnd: "2026-08-01" });
});

test("a range includes its start and excludes its end", () => {
  const range = customRange("2026-08-14", "2026-08-20");
  expect(dateRangeIncludes(range, range.start)).toBe(true);
  expect(dateRangeIncludes(range, range.end - 1)).toBe(true);
  expect(dateRangeIncludes(range, range.end)).toBe(false);
  expect(dateRangeIncludes(range, range.start - 1)).toBe(false);
});
