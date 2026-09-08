import { expect, test } from "vitest";

import { observerDimensionsChanged, observerViewport, reconnectDelayMs, terminalCloseStatus } from "../src/frontend/components/app/task-chat/live-pane-terminal.js";

test("live pane terminal reopens an observer only when its viewport changes", () => {
  expect(observerDimensionsChanged(undefined, { cols: 80, rows: 24 })).toBe(true);
  expect(observerDimensionsChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
  expect(observerDimensionsChanged({ cols: 80, rows: 24 }, { cols: 100, rows: 30 })).toBe(true);
});

test("live pane terminal clamps observer dimensions to the route contract", () => {
  expect(observerViewport({ cols: 2, rows: 1 })).toEqual({ cols: 20, rows: 5 });
  expect(observerViewport({ cols: 1_000, rows: 500 })).toEqual({ cols: 300, rows: 150 });
  expect(observerViewport({ cols: 80.4, rows: 23.6 })).toEqual({ cols: 80, rows: 24 });
});

test("live pane terminal caps reconnect backoff", () => {
  expect(reconnectDelayMs(0)).toBe(250);
  expect(reconnectDelayMs(4)).toBe(5_000);
  expect(reconnectDelayMs(9)).toBe(5_000);
});

test("terminal authorization and attachment closures do not enter a reconnect loop", () => {
  expect(terminalCloseStatus(4403)).toBe("ended");
  expect(terminalCloseStatus(4404)).toBe("ended");
  expect(terminalCloseStatus(1000)).toBe("ended");
  expect(terminalCloseStatus(1006)).toBeNull();
});
