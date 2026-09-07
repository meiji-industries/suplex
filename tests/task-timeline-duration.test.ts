import { describe, expect, test } from "vitest";
import { taskTimelineDuration } from "../src/frontend/lib/task-timeline-duration.js";

describe("taskTimelineDuration", () => {
  test("formats zero and rounded seconds", () => {
    expect(taskTimelineDuration(0)).toBe("0s");
    expect(taskTimelineDuration(17_499)).toBe("17s");
    expect(taskTimelineDuration(17_500)).toBe("18s");
  });

  test("normalizes the seconds-to-minutes rounding boundary", () => {
    expect(taskTimelineDuration(59_499)).toBe("59s");
    expect(taskTimelineDuration(59_500)).toBe("1m");
  });

  test("formats rounded total minutes as hours and minutes", () => {
    expect(taskTimelineDuration(89 * 60_000)).toBe("1h 29m");
    expect(taskTimelineDuration(59 * 60_000 + 30_000)).toBe("1h");
    expect(taskTimelineDuration(119 * 60_000 + 30_000)).toBe("2h");
  });
});
