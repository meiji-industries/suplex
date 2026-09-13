import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

import { openHerdrTerminalBridge, parseBridgeRecord } from "../src/integrations/herdr/terminal-bridge.js";

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

function controlFixture() {
  const stdin = new PassThrough();
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), kill });
  const written: string[] = [];
  stdin.on("data", chunk => written.push(chunk.toString()));
  const events: unknown[] = [];
  const spawn = vi.fn(() => child) as never;
  const bridge = openHerdrTerminalBridge({ paneId: "pane", cols: 80, rows: 24, mode: "control", onEvent: event => events.push(event), spawn });
  return { bridge, child, events, kill, spawn, stdin, written };
}

test("control mode spawns the Herdr controller with piped stdin and takeover", () => {
  const f = controlFixture();
  expect(f.spawn).toHaveBeenCalledWith("herdr", ["terminal", "session", "control", "pane", "--takeover", "--cols", "80", "--rows", "24"], expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"], env: process.env }));
});

test("control mode writes terminal commands as NDJSON on stdin", () => {
  const f = controlFixture();
  f.bridge.input(Buffer.from("ls -la\n"));
  f.bridge.resize(120, 40);
  f.bridge.scroll("up", 12);
  expect(f.written).toHaveLength(3);
  expect(f.written[0]).toBe(`${JSON.stringify({ type: "terminal.input", bytes: Buffer.from("ls -la\n").toString("base64") })}\n`);
  expect(f.written[1]).toBe('{"type":"terminal.resize","cols":120,"rows":40}\n');
  expect(f.written[2]).toBe('{"type":"terminal.scroll","direction":"up","lines":12}\n');
});

test("control mode release sends terminal.release then escalates to SIGTERM", async () => {
  vi.useFakeTimers();
  try {
    const f = controlFixture();
    f.bridge.release();
    f.bridge.release();
    expect(f.written).toEqual(['{"type":"terminal.release"}\n']);
    expect(f.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(f.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(600);
    expect(f.kill).toHaveBeenCalledWith("SIGKILL");
  } finally { vi.useRealTimers(); }
});

test("control mode reports takeover closures to the caller", () => {
  const f = controlFixture();
  f.child.stdout.write('{"type":"terminal.closed","reason":"terminal attach taken over"}\n');
  expect(f.events).toEqual([{ type: "closed", reason: "terminal attach taken over" }]);
  f.bridge.input(Buffer.from("ignored"));
  expect(f.written).toEqual([]);
});
