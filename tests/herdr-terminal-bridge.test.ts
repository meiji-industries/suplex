import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

import { openHerdrTerminalBridge, parseBridgeRecord } from "../src/herdr-terminal-bridge.js";

test("parses Herdr terminal bridge records", () => {
  const frame = parseBridgeRecord('{"type":"terminal.frame","seq":1,"encoding":"ansi","full":true,"width":80,"height":24,"bytes":"G1s/MjAyNmgbWzJKG1sxOzFI"}');
  expect(frame).toMatchObject({ type: "frame", frame: { seq: 1, full: true, width: 80, height: 24 } });
  expect(frame?.type === "frame" && frame.frame.bytes.toString().startsWith("\x1b[?2026h")).toBe(true);
  expect(parseBridgeRecord('{"type":"terminal.closed","reason":"detached"}')).toEqual({ type: "closed", reason: "detached" });
  expect(parseBridgeRecord('{"type":"x"}')).toBeNull();
  expect(parseBridgeRecord("not json")).toBeNull();
});

test("opens an observer with no command input and releases only that process", () => {
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill });
  const events: unknown[] = [];
  const spawn = vi.fn(() => child) as never;
  const bridge = openHerdrTerminalBridge({ paneId: "pane", cols: 80, rows: 24, onEvent: (event) => events.push(event), spawn });
  expect(spawn).toHaveBeenCalledWith("herdr", ["terminal", "session", "observe", "pane", "--cols", "80", "--rows", "24"], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
  bridge.release();
  bridge.release();
  expect(kill).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith("SIGTERM");
  child.emit("exit", 0, null);
  expect(events).toEqual([]);
});

test("reports child spawn errors without an unhandled process error", () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  const events: unknown[] = [];
  openHerdrTerminalBridge({ paneId: "pane", cols: 80, rows: 24, onEvent: event => events.push(event), spawn: (() => child) as never });
  child.emit("error", new Error("ENOENT"));
  expect(events).toEqual([
    { type: "error", message: "Herdr observer could not start: ENOENT" },
    { type: "closed", reason: "spawn error" },
  ]);
});
