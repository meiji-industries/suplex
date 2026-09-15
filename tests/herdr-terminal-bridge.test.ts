import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

import { openHerdrTerminalBridge, parseBridgeRecord, type BridgeEvent } from "../src/integrations/herdr/terminal-bridge.js";

test("parses Herdr terminal bridge records", () => {
  const frame = parseBridgeRecord('{"type":"terminal.frame","seq":1,"encoding":"ansi","full":true,"width":80,"height":24,"bytes":"G1s/MjAyNmgbWzJKG1sxOzFI"}');
  expect(frame).toMatchObject({ type: "frame", frame: { seq: 1, full: true, width: 80, height: 24 } });
  expect(frame?.type === "frame" && frame.frame.bytes.toString().startsWith("\x1b[?2026h")).toBe(true);
  expect(parseBridgeRecord('{"type":"terminal.closed","reason":"detached"}')).toEqual({ type: "closed", reason: "detached" });
  expect(parseBridgeRecord('{"type":"x"}')).toBeNull();
  expect(parseBridgeRecord("not json")).toBeNull();
});

test("opens an observer with no command input and releases only that process", async () => {
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill });
  const events: unknown[] = [];
  const spawn = vi.fn(() => child) as never;
  const bridge = openHerdrTerminalBridge({ paneId: "pane", onEvent: (event) => events.push(event), readViewport: async () => ({ ansi: "screen", cols: 80, rows: 24 }), spawn });
  await Promise.resolve();
  expect(spawn).toHaveBeenCalledWith("herdr", ["terminal", "session", "observe", "pane", "--cols", "80", "--rows", "24"], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
  const eventCount = events.length;
  bridge.release();
  bridge.release();
  expect(kill).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith("SIGTERM");
  child.emit("exit", 0, null);
  expect(events).toHaveLength(eventCount);
});

test("read-only observation keeps native rows and replaces its child when later content becomes wider", async () => {
  vi.useFakeTimers();
  try {
    const allChildren = Array.from({ length: 2 }, () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) }));
    const children = [...allChildren];
    const spawn = vi.fn(() => children.shift()!) as never;
    const initialLines = Array.from({ length: 49 }, (_, index) => index === 48 ? "bottom reply" : index === 1 ? "a".repeat(80) : `row ${index + 1}`);
    const snapshots = [
      { ansi: `${initialLines.join("\n")}\n`, cols: 80, rows: 49 },
      { ansi: `top\r\n${"b".repeat(139)}界\r\nnew bottom reply`, cols: 141, rows: 49 },
    ];
    const events: BridgeEvent[] = [];
    const bridge = openHerdrTerminalBridge({
      paneId: "pane",
      onEvent: event => events.push(event),
      readViewport: async () => snapshots.shift() ?? { ansi: "", cols: 141, rows: 49 },
      observerRefreshMs: 1_000,
      spawn,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledWith("herdr", ["terminal", "session", "observe", "pane", "--cols", "80", "--rows", "49"], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
    expect(events[0]).toMatchObject({ type: "frame", frame: { width: 80, height: 49 } });
    expect(events[0]?.type === "frame" && events[0].frame?.bytes.toString()).toContain("bottom reply");
    expect(events[0]?.type === "frame" && events[0].frame?.bytes.toString().match(/\r\n/g)?.length).toBe(48);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenLastCalledWith("herdr", ["terminal", "session", "observe", "pane", "--cols", "141", "--rows", "49"], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
    const latest = events.at(-1);
    expect(latest).toMatchObject({ type: "frame", frame: { width: 141, height: 49 } });
    expect(latest?.type === "frame" && latest.frame.bytes.toString()).toContain("new bottom reply");
    const eventCount = events.length;
    allChildren[0]!.stdout.write(`${JSON.stringify({ type: "terminal.frame", seq: 9, encoding: "ansi", full: false, width: 80, height: 49, bytes: Buffer.from("late old frame").toString("base64") })}\n`);
    expect(events).toHaveLength(eventCount);

    bridge.release();
  } finally { vi.useRealTimers(); }
});

test("an unexpected observer exit recovers without closing the read-only bridge", async () => {
  vi.useFakeTimers();
  try {
    const children = Array.from({ length: 2 }, () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) }));
    const spawnMock = vi.fn(() => children.shift()!);
    const events: unknown[] = [];
    const bridge = openHerdrTerminalBridge({
      paneId: "pane",
      onEvent: event => events.push(event),
      readViewport: async () => ({ ansi: "complete screen", cols: 120, rows: 49 }),
      observerRefreshMs: 5_000,
      spawn: spawnMock as never,
    });
    await vi.advanceTimersByTimeAsync(0);
    const first = spawnMock.mock.results[0]!.value;
    first.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(250);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "closed" }));
    bridge.release();
  } finally { vi.useRealTimers(); }
});

test("release during asynchronous viewport discovery cannot spawn a late observer", async () => {
  let resolveViewport: ((value: { ansi: string; cols: number; rows: number }) => void) | undefined;
  const readViewport = () => new Promise<{ ansi: string; cols: number; rows: number }>(resolve => { resolveViewport = resolve; });
  const spawn = vi.fn() as never;
  const bridge = openHerdrTerminalBridge({ paneId: "pane", onEvent: vi.fn(), readViewport, spawn });

  bridge.release();
  resolveViewport?.({ ansi: "late", cols: 120, rows: 49 });
  await Promise.resolve();
  await Promise.resolve();

  expect(spawn).not.toHaveBeenCalled();
});

test("reports child spawn errors without ending recoverable observation", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  const events: unknown[] = [];
  const bridge = openHerdrTerminalBridge({ paneId: "pane", onEvent: event => events.push(event), readViewport: async () => ({ ansi: "screen", cols: 80, rows: 24 }), spawn: (() => child) as never });
  await Promise.resolve();
  child.emit("error", new Error("ENOENT"));
  expect(events).toEqual(expect.arrayContaining([{ type: "error", message: "Herdr observer could not start: ENOENT" }]));
  expect(events).not.toContainEqual(expect.objectContaining({ type: "closed" }));
  bridge.release();
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
