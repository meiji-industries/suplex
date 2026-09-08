// eslint-disable-next-line no-restricted-imports -- the Herdr terminal bridge is a long-lived streaming child process, not a one-shot command.
import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import { json } from "./task-utils.js";

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

export interface HerdrTerminalBridge { release(): void }

type Spawn = typeof nodeSpawn;

export function openHerdrTerminalBridge(input: {
  paneId: string;
  cols: number;
  rows: number;
  onEvent: (event: BridgeEvent) => void;
  binary?: string;
  spawn?: Spawn;
}): HerdrTerminalBridge {
  const cols = clamp(input.cols, 20, 500);
  const rows = clamp(input.rows, 5, 200);
  const child = (input.spawn ?? nodeSpawn)(input.binary ?? "herdr", ["terminal", "session", "observe", input.paneId, "--cols", String(cols), "--rows", String(rows)], { stdio: ["ignore", "pipe", "pipe"], env: process.env }) as ChildProcessByStdio<null, Readable, Readable>;
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
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const event = parseBridgeRecord(line);
    if (event) emit(event);
    else console.debug("Ignored Herdr terminal bridge output", line.slice(0, 200));
  });
  const errors = createInterface({ input: child.stderr });
  errors.on("line", (message) => {
    if (message.trim()) emit({ type: "error", message });
  });
  child.once("error", (error) => {
    emit({ type: "error", message: `Herdr observer could not start: ${error.message}` });
    emit({ type: "closed", reason: "spawn error" });
    cleanup();
  });
  child.once("exit", (code, signal) => {
    emit({ type: "closed", reason: `exited:${signal ?? code ?? "unknown"}` });
    cleanup();
  });
  return {
    release() {
      if (released || settled) return;
      released = true;
      try { child.kill("SIGTERM"); } catch { cleanup(); return; }
      releaseTimer = setTimeout(() => {
        releaseTimer = undefined;
        try { child.kill("SIGKILL"); } catch { /* The observer already stopped. */ }
        cleanup();
      }, 500);
      releaseTimer.unref();
    },
  };
}
