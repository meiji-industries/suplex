import { expect, test } from "vitest";

import { reconnectDelayMs, wheelToScroll } from "../src/frontend/components/app/task-chat/live-pane-terminal.js";

test("live pane terminal translates wheel deltas into Herdr scroll commands", () => {
  expect(wheelToScroll(-120, 16)).toEqual({ direction: "up", lines: 8 });
  expect(wheelToScroll(3, 16)).toEqual({ direction: "down", lines: 1 });
  expect(wheelToScroll(0.5, 16)).toBeNull();
});

test("live pane terminal caps reconnect backoff", () => {
  expect(reconnectDelayMs(0)).toBe(250);
  expect(reconnectDelayMs(4)).toBe(5_000);
  expect(reconnectDelayMs(9)).toBe(5_000);
});
