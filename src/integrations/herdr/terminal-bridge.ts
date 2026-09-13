// eslint-disable-next-line no-restricted-imports -- the Herdr terminal bridge is a long-lived streaming child process, not a one-shot command.
import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { json } from "../../shared/json.js";

export type BridgeFrame = { seq: number; full: boolean; width: number; height: number; bytes: Buffer };
export type BridgeEvent =
  | { type: "frame"; frame: BridgeFrame }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string };

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, Math.round(value)));

export function parseBridgeRecord(line: string): BridgeEvent | null {
  const value = json<Record<string, unknown> | null>(line, null);
  if (!value || typeof value !== "object") return null;
  if (value.type === "terminal.frame" && typeof value.bytes === "string") {
    return { type: "frame", frame: { seq: Number(value.seq), full: Boolean(value.full), width: Number(value.width), height: Number(value.height), bytes: Buffer.from(value.bytes, "base64") } };
  }
  if (value.type === "terminal.closed") return { type: "closed", reason: String(value.reason ?? "closed") };
  return null;
}

export interface HerdrTerminalBridge {
  input(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  scroll(direction: "up" | "down", lines: number): void;
  release(): void;
}

type Spawn = typeof nodeSpawn;

export function openHerdrTerminalBridge(input: {
  paneId: string;
  cols: number;
  rows: number;
  mode?: "observe" | "control";
  onEvent: (event: BridgeEvent) => void;
  binary?: string;
  spawn?: Spawn;
}): HerdrTerminalBridge {
  const cols = clamp(input.cols, 20, 500);
  const rows = clamp(input.rows, 5, 200);
  const control = input.mode === "control";
  const child = (input.spawn ?? nodeSpawn)(input.binary ?? "herdr", control
    ? ["terminal", "session", "control", input.paneId, "--takeover", "--cols", String(cols), "--rows", String(rows)]
    : ["terminal", "session", "observe", input.paneId, "--cols", String(cols), "--rows", String(rows)], { stdio: [control ? "pipe" : "ignore", "pipe", "pipe"], env: process.env }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
  let settled = false;
  let released = false;
  let releaseTimer: NodeJS.Timeout | undefined;
  const emit = (event: BridgeEvent): void => {
    if (settled || released) return;
    if (event.type === "closed") settled = true;
    input.onEvent(event);
  };
  const cleanup = (): void => {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = undefined;
    output.close();
    errors.close();
  };
  const write = (record: Record<string, unknown>): void => {
    if (settled || released || !control) return;
    try { child.stdin?.write(`${JSON.stringify(record)}\n`); } catch { /* stdin already closed */ }
  };
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const event = parseBridgeRecord(line);
    if (event) emit(event);
    else console.debug("Ignored Herdr terminal bridge output", line.slice(0, 200));
  });
  const errors = createInterface({ input: child.stderr });
  errors.on("line", (message) => {
    if (message.trim() && (!control || /input ignored|error/i.test(message))) emit({ type: "error", message });
  });
  child.once("error", (error) => {
    emit({ type: "error", message: `Herdr ${control ? "terminal controller" : "observer"} could not start: ${error.message}` });
    emit({ type: "closed", reason: "spawn error" });
    cleanup();
  });
  child.once("exit", (code, signal) => {
    emit({ type: "closed", reason: `exited:${signal ?? code ?? "unknown"}` });
    cleanup();
  });
  return {
    input(bytes: Buffer) { write({ type: "terminal.input", bytes: bytes.toString("base64") }); },
    resize(cols: number, rows: number) { write({ type: "terminal.resize", cols: clamp(cols, 20, 500), rows: clamp(rows, 5, 200) }); },
    scroll(direction: "up" | "down", lines: number) { if (direction === "up" || direction === "down") write({ type: "terminal.scroll", direction, lines: clamp(lines, 1, 65_535) }); },
    release() {
      if (released || settled) return;
      released = true;
      if (control) {
        try { child.stdin?.write('{"type":"terminal.release"}\n'); child.stdin?.end(); } catch { /* stdin already closed */ }
      } else {
        try { child.kill("SIGTERM"); } catch { cleanup(); return; }
      }
      releaseTimer = setTimeout(() => {
        releaseTimer = undefined;
        try { child.kill(control ? "SIGTERM" : "SIGKILL"); } catch { /* The bridge already stopped. */ }
        if (!control) { cleanup(); return; }
        releaseTimer = setTimeout(() => {
          releaseTimer = undefined;
          try { child.kill("SIGKILL"); } catch { /* The bridge already stopped. */ }
          cleanup();
        }, 500);
        releaseTimer.unref();
      }, 500);
      releaseTimer.unref();
    },
  };
}
