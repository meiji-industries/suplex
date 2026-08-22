import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { formatDevLogLine } from "./logging.js";
import { json } from "./task-utils.js";

type LogRecord = Record<string, unknown>;

interface LogEntry {
  component: "api" | "worker";
  record: LogRecord;
  timestamp: number;
}

export interface LogViewerOptions {
  directory?: string;
  taskId?: string;
  errors?: boolean;
  since?: string;
  follow?: boolean;
  color?: boolean;
  output?: Pick<NodeJS.WriteStream, "write">;
  pollIntervalMs?: number;
}

function entryTimestamp(record: LogRecord): number {
  const value = record.timestamp ?? record.time;
  const parsed = typeof value === "number" || typeof value === "string" ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function parseSince(value: string): number {
  const match = /^(\d+)([smhd])$/i.exec(value);
  if (!match) throw new Error(`Invalid --since value: ${value}. Use a duration such as 10m or 2h.`);
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  return Number(match[1]) * multiplier;
}

function matchesTask(record: LogRecord, taskId: string): boolean {
  const request = record.req;
  const requestUrl = request && typeof request === "object" ? (request as LogRecord).url : undefined;
  return [record.taskId, record.workflowId, record.url, requestUrl].some((value) => typeof value === "string" && value.includes(taskId));
}

function matches(entry: LogEntry, options: LogViewerOptions, now: number): boolean {
  if (options.errors && (typeof entry.record.level !== "number" || entry.record.level < 40)) return false;
  if (options.taskId && !matchesTask(entry.record, options.taskId)) return false;
  return !options.since || entry.timestamp >= now - parseSince(options.since);
}

async function readEntries(path: string, component: "api" | "worker"): Promise<LogEntry[]> {
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error));
  return source.split(/\r?\n/).flatMap((line): LogEntry[] => {
    if (!line) return [];
    const record = json<LogRecord | null>(line, null);
    return record && typeof record === "object" ? [{ component, record, timestamp: entryTimestamp(record) }] : [];
  });
}

async function readAllEntries(directory: string): Promise<LogEntry[]> {
  const components = ["api", "worker"] as const;
  const entries = await Promise.all(components.flatMap((component) => [readEntries(join(directory, `${component}.log.1`), component), readEntries(join(directory, `${component}.log`), component)]));
  return entries.flat().sort((left, right) => left.timestamp - right.timestamp);
}

function print(entries: LogEntry[], options: LogViewerOptions): void {
  const output = options.output ?? process.stdout;
  for (const entry of entries) {
    const line = formatDevLogLine(entry.record, { component: entry.component, ...(options.color === undefined ? {} : { color: options.color }) });
    if (line) output.write(`${line}\n`);
  }
}

/** Prints the merged tail. With follow enabled, polls the two active files for new JSON records. */
export async function runLogViewer(options: LogViewerOptions = {}): Promise<void> {
  const directory = options.directory ?? join(process.cwd(), ".forge", "logs");
  const now = Date.now();
  const initial = (await readAllEntries(directory)).filter((entry) => matches(entry, options, now));
  print(initial.slice(-200), options);
  if (!options.follow) return;

  const offsets = new Map<string, number>();
  for (const component of ["api", "worker"] as const) {
    const path = join(directory, `${component}.log`);
    offsets.set(path, (await stat(path).catch(() => ({ size: 0 }))).size);
  }
  const interval = options.pollIntervalMs ?? 250;
  await new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      const fresh: LogEntry[] = [];
      for (const component of ["api", "worker"] as const) {
        const path = join(directory, `${component}.log`);
        const size = (await stat(path).catch(() => ({ size: 0 }))).size;
        const offset = offsets.get(path) ?? 0;
        const nextOffset = size < offset ? 0 : offset;
        if (size > nextOffset) {
          const source = await readFile(path, "utf8").catch(() => "");
          for (const line of source.slice(nextOffset).split(/\r?\n/)) {
            const record = json<LogRecord | null>(line, null);
            if (record && typeof record === "object") fresh.push({ component, record, timestamp: entryTimestamp(record) });
          }
        }
        offsets.set(path, size);
      }
      print(fresh.sort((left, right) => left.timestamp - right.timestamp).filter((entry) => matches(entry, options, Date.now())), options);
    }, interval);
    const stop = (): void => { clearInterval(timer); resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
