// eslint-disable-next-line no-restricted-imports -- the Herdr terminal bridge is a long-lived streaming child process, not a one-shot command.
import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

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
  onEvent: (event: BridgeEvent) => void;
  binary?: string;
  spawn?: Spawn;
}): HerdrTerminalBridge {
  const cols = clamp(input.cols, 20, 500);
  const rows = clamp(input.rows, 5, 200);
  const child = (input.spawn ?? nodeSpawn)(input.binary ?? "herdr", ["terminal", "session", "control", input.paneId, "--takeover", "--cols", String(cols), "--rows", String(rows)], { stdio: ["pipe", "pipe", "pipe"], env: process.env }) as ChildProcessWithoutNullStreams;
  let closed = false;
  let releaseTimer: NodeJS.Timeout | undefined;
  const emit = (event: BridgeEvent): void => {
    if (closed) return;
    if (event.type === "closed") closed = true;
    input.onEvent(event);
  };
  const write = (command: Record<string, unknown>): void => {
    if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
  };
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const event = parseBridgeRecord(line);
    if (event) emit(event);
    else console.debug("Ignored Herdr terminal bridge output", line.slice(0, 200));
  });
  const errors = createInterface({ input: child.stderr });
  errors.on("line", (message) => {
    if (/input ignored|error/i.test(message)) emit({ type: "error", message });
  });
  child.once("exit", (code, signal) => {
    if (releaseTimer) clearTimeout(releaseTimer);
    emit({ type: "closed", reason: `exited:${signal ?? code ?? "unknown"}` });
  });
  return {
    input(bytes) { write({ type: "terminal.input", bytes: bytes.toString("base64") }); },
    resize(nextCols, nextRows) { write({ type: "terminal.resize", cols: clamp(nextCols, 20, 500), rows: clamp(nextRows, 5, 200) }); },
    scroll(direction, lines) { write({ type: "terminal.scroll", direction, lines: clamp(lines, 1, 65_535) }); },
    release() {
      write({ type: "terminal.release" });
      releaseTimer = setTimeout(() => { if (!closed) child.kill("SIGTERM"); }, 500);
    },
  };
}
