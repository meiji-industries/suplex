import { expect, test } from "vitest";

import { bufferAtTail, nextReplayState, observerViewport, reconnectDelayMs, terminalCloseStatus, terminalMessageStatus, terminalScrollMode, viewportAtTail, wheelToScroll } from "../src/frontend/features/tasks/task-chat/live-pane-terminal.js";

test("interactive terminal dimensions stay within the route contract", () => {
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
  expect(terminalCloseStatus(4404)).toBeNull();
  expect(terminalCloseStatus(1000)).toBe("ended");
  expect(terminalCloseStatus(1006)).toBeNull();
});

test("read-only terminals become live only after their initial frame", () => {
  expect(terminalMessageStatus("connecting", "open")).toBe("connecting");
  expect(terminalMessageStatus("connecting", "frame")).toBe("live");
  expect(terminalMessageStatus("reconnecting", "open")).toBe("reconnecting");
});

test("local viewport tail detection tolerates sub-pixel layout rounding", () => {
  expect(viewportAtTail({ clientHeight: 400, scrollHeight: 800, scrollTop: 400 })).toBe(true);
  expect(viewportAtTail({ clientHeight: 400, scrollHeight: 800, scrollTop: 399.4 })).toBe(true);
  expect(viewportAtTail({ clientHeight: 400, scrollHeight: 800, scrollTop: 350 })).toBe(false);
  expect(viewportAtTail({ clientHeight: 400, scrollHeight: 800, scrollTop: 0 }, 0)).toBe(true);
  expect(viewportAtTail({ clientHeight: 400, scrollHeight: 800, scrollTop: 40 }, 0)).toBe(false);
});

test("a takeover closure is reported as taken over, not ended", () => {
  expect(terminalCloseStatus(4498)).toBe("taken_over");
});

test("wheel deltas convert to terminal scroll lines", () => {
  expect(wheelToScroll(-120, 16)).toEqual({ direction: "up", lines: 8 });
  expect(wheelToScroll(3, 16)).toEqual({ direction: "down", lines: 1 });
  expect(wheelToScroll(0.5, 16)).toBeNull();
  expect(wheelToScroll(-33, 0)).toBeNull();
  expect(wheelToScroll(48, 16)).toEqual({ direction: "down", lines: 3 });
});

test("open messages select local scroll only for the host PTY", () => {
  expect(terminalScrollMode("local")).toBe("local");
  expect(terminalScrollMode("remote")).toBe("remote");
  expect(terminalScrollMode(undefined)).toBe("remote");
  expect(terminalScrollMode("other")).toBe("remote");
});

test("replay holds terminal input until the snapshot is parsed", () => {
  expect(nextReplayState("idle", "start")).toBe("snapshot");
  expect(nextReplayState("parsing", "start")).toBe("snapshot");
  expect(nextReplayState("snapshot", "end")).toBe("parsing");
  expect(nextReplayState("parsing", "parsed")).toBe("idle");
  expect(nextReplayState("snapshot", "parsed")).toBe("snapshot");
  expect(nextReplayState("idle", "end")).toBe("idle");
  expect(nextReplayState("idle", "parsed")).toBe("idle");
});

test("native scrollback is at the tail when the viewport shows the last rows", () => {
  expect(bufferAtTail({ viewportY: 40, baseY: 40 })).toBe(true);
  expect(bufferAtTail({ viewportY: 12, baseY: 40 })).toBe(false);
  expect(bufferAtTail({ viewportY: 0, baseY: 0 })).toBe(true);
});
