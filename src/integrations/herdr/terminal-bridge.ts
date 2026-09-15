// eslint-disable-next-line no-restricted-imports -- the Herdr terminal bridge is a long-lived streaming child process, not a one-shot command.
import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { json } from "../../shared/json.js";
import { CliHerdrClient, type ReadOnlyTerminalViewport } from "./client.js";

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
type BridgeChild = ChildProcessByStdio<Writable | null, Readable, Readable>;
type ObserverChild = {
  child: BridgeChild;
  cols: number;
  errors: Interface;
  expectedStop: boolean;
  output: Interface;
  rows: number;
  stopTimer?: NodeJS.Timeout;
};

export interface HerdrTerminalBridgeOptions {
  paneId: string;
  cols?: number;
  rows?: number;
  mode?: "observe" | "control";
  onEvent: (event: BridgeEvent) => void;
  binary?: string;
  spawn?: Spawn;
  readViewport?: () => Promise<ReadOnlyTerminalViewport>;
  observerRefreshMs?: number;
}

function openControlBridge(input: HerdrTerminalBridgeOptions): HerdrTerminalBridge {
  const cols = clamp(input.cols ?? 80, 20, 500);
  const rows = clamp(input.rows ?? 24, 5, 200);
  const child = (input.spawn ?? nodeSpawn)(input.binary ?? "herdr", ["terminal", "session", "control", input.paneId, "--takeover", "--cols", String(cols), "--rows", String(rows)], { stdio: ["pipe", "pipe", "pipe"], env: process.env }) as BridgeChild;
  let settled = false;
  let released = false;
  let releaseTimer: NodeJS.Timeout | undefined;
  const emit = (event: BridgeEvent): void => {
    if (settled || released) return;
    if (event.type === "closed") settled = true;
    input.onEvent(event);
  };
  const output = createInterface({ input: child.stdout });
  const errors = createInterface({ input: child.stderr });
  const cleanup = (): void => {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = undefined;
    output.close();
    errors.close();
  };
  const write = (record: Record<string, unknown>): void => {
    if (settled || released) return;
    try { child.stdin?.write(`${JSON.stringify(record)}\n`); } catch { /* stdin already closed */ }
  };
  output.on("line", (line) => {
    const event = parseBridgeRecord(line);
    if (event) emit(event);
    else console.debug("Ignored Herdr terminal bridge output", line.slice(0, 200));
  });
  errors.on("line", (message) => { if (message.trim() && /input ignored|error/i.test(message)) emit({ type: "error", message }); });
  child.once("error", (error) => {
    emit({ type: "error", message: `Herdr terminal controller could not start: ${error.message}` });
    emit({ type: "closed", reason: "spawn error" });
    cleanup();
  });
  child.once("exit", (code, signal) => {
    emit({ type: "closed", reason: `exited:${signal ?? code ?? "unknown"}` });
    cleanup();
  });
  return {
    input(bytes: Buffer) { write({ type: "terminal.input", bytes: bytes.toString("base64") }); },
    resize(nextCols: number, nextRows: number) { write({ type: "terminal.resize", cols: clamp(nextCols, 20, 500), rows: clamp(nextRows, 5, 200) }); },
    scroll(direction: "up" | "down", lines: number) { if (direction === "up" || direction === "down") write({ type: "terminal.scroll", direction, lines: clamp(lines, 1, 65_535) }); },
    release() {
      if (released || settled) return;
      released = true;
      try { child.stdin?.write('{"type":"terminal.release"}\n'); child.stdin?.end(); } catch { /* stdin already closed */ }
      releaseTimer = setTimeout(() => {
        releaseTimer = undefined;
        try { child.kill("SIGTERM"); } catch { cleanup(); return; }
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

function snapshotBytes(ansi: string): Buffer {
  const normalized = ansi.replace(/\r?\n$/, "").replace(/\r?\n/g, "\r\n");
  return Buffer.from(`\x1b[?2026h\x1b[0m\x1b[2J\x1b[H${normalized}\x1b[0m\x1b[?2026l`);
}

function openObserverBridge(input: HerdrTerminalBridgeOptions): HerdrTerminalBridge {
  const spawn = input.spawn ?? nodeSpawn;
  const binary = input.binary ?? "herdr";
  const readViewport = input.readViewport ?? (() => new CliHerdrClient(binary).readPaneViewport(input.paneId));
  const refreshMs = Math.max(100, input.observerRefreshMs ?? 1_000);
  const observers = new Set<ObserverChild>();
  let current: ObserverChild | undefined;
  let released = false;
  let refreshing = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let maximumCols = 1;
  let sequence = 0;
  let hasSnapshot = false;

  const cleanupObserver = (observer: ObserverChild): void => {
    observer.output.close();
    observer.errors.close();
    if (observer.stopTimer) clearTimeout(observer.stopTimer);
    delete observer.stopTimer;
    observers.delete(observer);
  };
  const stopObserver = (observer: ObserverChild): void => {
    if (observer.expectedStop) return;
    observer.expectedStop = true;
    if (current === observer) current = undefined;
    try { observer.child.kill("SIGTERM"); } catch { cleanupObserver(observer); return; }
    observer.stopTimer = setTimeout(() => {
      delete observer.stopTimer;
      try { observer.child.kill("SIGKILL"); } catch { /* The observer already stopped. */ }
      cleanupObserver(observer);
    }, 500);
    observer.stopTimer.unref();
  };
  const scheduleRefresh = (delay = 250): void => {
    if (released || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void refresh();
    }, delay);
    retryTimer.unref();
  };
  const startObserver = (cols: number, rows: number): void => {
    if (released) return;
    let child: BridgeChild;
    try {
      child = spawn(binary, ["terminal", "session", "observe", input.paneId, "--cols", String(cols), "--rows", String(rows)], { stdio: ["ignore", "pipe", "pipe"], env: process.env }) as BridgeChild;
    } catch (error) {
      input.onEvent({ type: "error", message: `Herdr observer could not start: ${error instanceof Error ? error.message : String(error)}` });
      scheduleRefresh();
      return;
    }
    const observer: ObserverChild = {
      child,
      cols,
      errors: createInterface({ input: child.stderr }),
      expectedStop: false,
      output: createInterface({ input: child.stdout }),
      rows,
    };
    observers.add(observer);
    current = observer;
    observer.output.on("line", (line) => {
      if (released || current !== observer) return;
      const event = parseBridgeRecord(line);
      if (event?.type === "frame") input.onEvent({ type: "frame", frame: { ...event.frame, seq: sequence++ } });
      else if (event?.type === "closed") {
        stopObserver(observer);
        scheduleRefresh(0);
      } else if (!event) console.debug("Ignored Herdr terminal bridge output", line.slice(0, 200));
    });
    observer.errors.on("line", (message) => {
      if (!released && current === observer && message.trim()) input.onEvent({ type: "error", message });
    });
    child.once("error", (error) => {
      if (!released && current === observer) {
        current = undefined;
        input.onEvent({ type: "error", message: `Herdr observer could not start: ${error.message}` });
        scheduleRefresh();
      }
      cleanupObserver(observer);
    });
    child.once("exit", () => {
      const replace = !released && !observer.expectedStop && current === observer;
      if (current === observer) current = undefined;
      cleanupObserver(observer);
      if (replace) scheduleRefresh();
    });
  };
  const applySnapshot = (snapshot: ReadOnlyTerminalViewport): void => {
    maximumCols = Math.max(maximumCols, snapshot.cols);
    if (current?.cols === maximumCols && current.rows === snapshot.rows) return;
    if (current) stopObserver(current);
    input.onEvent({ type: "frame", frame: { seq: sequence++, full: true, width: maximumCols, height: snapshot.rows, bytes: snapshotBytes(snapshot.ansi) } });
    hasSnapshot = true;
    startObserver(maximumCols, snapshot.rows);
  };
  async function refresh(): Promise<void> {
    if (released || refreshing) return;
    refreshing = true;
    try {
      const snapshot = await readViewport();
      if (!released) applySnapshot(snapshot);
    } catch (error) {
      if (!released && !hasSnapshot) input.onEvent({ type: "error", message: `Herdr could not read this pane: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      refreshing = false;
    }
  }

  const refreshTimer = setInterval(() => { void refresh(); }, refreshMs);
  refreshTimer.unref();
  void refresh();
  return {
    input() {},
    resize() {},
    scroll() {},
    release() {
      if (released) return;
      released = true;
      clearInterval(refreshTimer);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      for (const observer of [...observers]) stopObserver(observer);
    },
  };
}

export function openHerdrTerminalBridge(input: HerdrTerminalBridgeOptions): HerdrTerminalBridge {
  return input.mode === "control" ? openControlBridge(input) : openObserverBridge(input);
}
