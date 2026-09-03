import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";

import { openHerdrTerminalBridge, parseBridgeRecord } from "../src/herdr-terminal-bridge.js";

test("parses Herdr terminal bridge records", () => {
  const frame = parseBridgeRecord('{"type":"terminal.frame","seq":1,"encoding":"ansi","full":true,"width":80,"height":24,"bytes":"G1s/MjAyNmgbWzJKG1sxOzFI"}');
  expect(frame).toMatchObject({ type: "frame", frame: { seq: 1, full: true, width: 80, height: 24 } });
  expect(frame?.type === "frame" && frame.frame.bytes.toString().startsWith("\x1b[?2026h")).toBe(true);
  expect(parseBridgeRecord('{"type":"terminal.closed","reason":"detached"}')).toEqual({ type: "closed", reason: "detached" });
  expect(parseBridgeRecord('{"type":"x"}')).toBeNull();
  expect(parseBridgeRecord("not json")).toBeNull();
});

test("writes bridge commands and only closes once", () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const output: string[] = [];
  child.stdin.on("data", (chunk) => output.push(chunk.toString()));
  const events: unknown[] = [];
  const bridge = openHerdrTerminalBridge({ paneId: "pane", cols: 80, rows: 24, onEvent: (event) => events.push(event), spawn: (() => child) as never });
  bridge.input(Buffer.from("a\r"));
  bridge.resize(100, 30);
  child.stdout.write('{"type":"terminal.closed","reason":"detached"}\n');
  child.emit("exit", 0, null);
  expect(output).toContain('{"type":"terminal.input","bytes":"YQ0="}\n');
  expect(output).toContain('{"type":"terminal.resize","cols":100,"rows":30}\n');
  expect(events).toEqual([{ type: "closed", reason: "detached" }]);
});
