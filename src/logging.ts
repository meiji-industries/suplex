import { Context } from "@temporalio/activity";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import pino, { type DestinationStream, type Logger } from "pino";

const sensitiveKey = /(?:authorization|cookie|credential|password|private.?key|secret|token|api.?key|thread[_-]?id|threadId)/i;
const sensitiveValue = /(?:Bearer|Basic)\s+[^\s,;]+|\b(?:gho_|github_pat_|sk-|fh[ap]_)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[a-z][a-z0-9+.-]*:\/\/[^:\s/]+:[^@\s/]+@|\b(?:access[_-]?token|token|password|secret|api[_-]?key|authorization)=[^\s,;]+|\b(?:authorization|x-api-key)\s*:\s*[^\r\n,;]+/gi;

export function redact(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value.replace(sensitiveValue, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]));
  }
  return value;
}

export interface LogContext {
  taskId?: string;
  correlationId?: string;
  workflowId?: string;
  runId?: string;
  issueId?: string;
  companyId?: string;
  projectId?: string;
  activityId?: string;
  turnId?: string;
  installationId?: string;
}

const loggerOptions = {
  base: null,
  timestamp: false,
  redact: {
    paths: [
      "authorization",
      "cookie",
      "credential",
      "password",
      "privateKey",
      "secret",
      "token",
      "apiKey",
      "*.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
};

const fastifyLoggerOptions = {
  ...loggerOptions,
  // Keep debug access records in the JSON log. The interactive destinations
  // and log viewer hide them unless request logging is explicitly enabled.
  level: "debug",
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    ...loggerOptions.redact,
    paths: [
      ...loggerOptions.redact.paths,
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-api-key",
    ],
  },
  serializers: {
    req(request: { method: string; url: string; headers: Record<string, unknown>; host?: string; ip?: string; socket?: { remotePort?: number } }) {
      return {
        method: request.method,
        url: request.url.split("?", 1)[0],
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      };
    },
  },
};

type DevLogRecord = Record<string, unknown>;

const maxDevLogBytes = 50 * 1024 * 1024;

/**
 * Creates the durable half of a development logger. The synchronous writes
 * preserve Pino's record order and deliberately never take down the process
 * when an operator's disk is full or unavailable.
 */
export function createDevLogFileSink(component: "api" | "worker", directory = join(process.cwd(), ".forge", "logs")): (line: string) => void {
  const currentPath = join(directory, `${component}.log`);
  const previousPath = `${currentPath}.1`;
  return (line: string): void => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const bytes = Buffer.byteLength(line);
      try {
        if (statSync(currentPath).size + bytes > maxDevLogBytes) {
          rmSync(previousPath, { force: true });
          renameSync(currentPath, previousPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      appendFileSync(currentPath, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Logging must not affect API or worker availability.
    }
  };
}

const ansi = {
  dim: "\u001B[2m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
  reset: "\u001B[0m",
};

function logComponent(): "api" | "worker" | "supervisor" {
  const argv = process.argv.join(" ");
  if (argv.includes("worker")) return "worker";
  if (argv.includes("server")) return "api";
  return "supervisor";
}

function short(value: unknown): string {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  if (!text) return "";
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function field(record: DevLogRecord, name: string): unknown {
  return record[name];
}

function requestStatus(record: DevLogRecord): number | undefined {
  const value = field(record, "statusCode") ?? (field(record, "res") as DevLogRecord | undefined)?.statusCode;
  return typeof value === "number" ? value : undefined;
}

function timestamp(record: DevLogRecord): string {
  const value = field(record, "timestamp") ?? field(record, "time");
  const date = typeof value === "number" || typeof value === "string" ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toTimeString().slice(0, 8) : date.toTimeString().slice(0, 8);
}

function errorDetails(record: DevLogRecord): { message?: string | undefined; stack?: string | undefined } {
  const err = field(record, "err");
  if (err && typeof err === "object") {
    const value = err as DevLogRecord;
    return {
      ...(typeof value.message === "string" ? { message: value.message } : {}),
      ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
    };
  }
  return typeof field(record, "error") === "string" ? { message: field(record, "error") as string } : {};
}

function includeDebugLogs(all?: boolean): boolean {
  return all ?? process.env.FORGE_LOG_REQUESTS === "1";
}

/** Formats one Pino record for interactive development output. */
export function formatDevLogLine(input: DevLogRecord, options: { color?: boolean; component?: string; all?: boolean } = {}): string | null {
  const record = redact(input) as DevLogRecord;
  const message = short(field(record, "msg") ?? field(record, "message")) || "log";
  const request = field(record, "req") as DevLogRecord | undefined;
  const status = requestStatus(record);

  if (typeof field(record, "level") === "number" && (field(record, "level") as number) < 30 && !includeDebugLogs(options.all)) return null;

  const levelName = field(record, "level") === 50 ? "ERROR" : field(record, "level") === 40 ? "WARN" : "INFO";
  const color = options.color ?? (!process.env.NO_COLOR && Boolean(process.stdout.isTTY));
  const component = short(options.component ?? field(record, "component") ?? logComponent());
  const requestLine = request && message === "request"
    ? `${short(request.method)} ${short(request.url)}${status === undefined ? "" : ` ${status}`}${typeof field(record, "responseTime") === "number" ? ` ${Math.round(field(record, "responseTime") as number)}ms` : ""}`
    : message;
  const fields: string[] = [];
  for (const name of ["reqId", "taskId", "executionId", "activityType", "workflowId", "activityId", "correlationId"]) {
    const value = field(record, name);
    if (value !== undefined && value !== null) fields.push(`${name}=${short(value)}`);
  }
  const error = errorDetails(record);
  if (error.message) fields.push(`error=${short(error.message)}`);

  const level = color
    ? `${levelName === "ERROR" ? ansi.red : levelName === "WARN" ? ansi.yellow : ansi.dim}${levelName.padEnd(5)}${ansi.reset}`
    : levelName.padEnd(5);
  let line = `${timestamp(record)}  ${level} ${component.padEnd(10)} ${requestLine}${fields.length ? `  ${fields.join(" ")}` : ""}`;
  if (color && status !== undefined && status >= 500) line = `${ansi.red}${line}${ansi.reset}`;
  if (error.stack) line += `\n    ${short(error.stack).replace(/\n/g, "\n    ")}`;
  return line;
}

function usePrettyLogs(): boolean {
  return process.env.FORGE_PRETTY_LOGS === "1" || (process.env.NODE_ENV === "development" && Boolean(process.stdout.isTTY));
}

function prettyDestination(): DestinationStream {
  return {
    write(raw: string): void {
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          // task-utils imports redact from this module, so using its json helper here would create a cycle.
          // eslint-disable-next-line no-restricted-syntax
          const formatted = formatDevLogLine(JSON.parse(line) as DevLogRecord);
          if (formatted) process.stdout.write(`${formatted}\n`);
        } catch {
          process.stdout.write(`${line}\n`);
        }
      }
    },
  };
}

function infoConsoleDestination(): DestinationStream {
  return {
    write(raw: string): void {
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          // task-utils imports redact from this module, so parsing locally avoids a cycle.
          // eslint-disable-next-line no-restricted-syntax
          const record = JSON.parse(line) as DevLogRecord;
          if (typeof record.level === "number" && record.level < 30 && !includeDebugLogs()) continue;
        } catch {
          // Preserve output Pino did not produce rather than dropping it.
        }
        process.stdout.write(`${line}\n`);
      }
    },
  };
}

function developmentDestination(component: "api" | "worker"): DestinationStream {
  const fileSink = createDevLogFileSink(component);
  const consoleSink = usePrettyLogs() ? prettyDestination() : infoConsoleDestination();
  return {
    write(raw: string): void {
      fileSink(raw);
      consoleSink.write(raw);
    },
  };
}

export function createFastifyLogger(sink?: (line: string) => void): Logger {
  return pino(fastifyLoggerOptions, sink ? { write: sink } : developmentDestination("api"));
}

export class StructuredLogger {
  private logger: Logger;

  constructor(sink?: (line: string) => void) {
    this.logger = pino(loggerOptions, sink ? { write: sink } : developmentDestination(logComponent() === "api" ? "api" : "worker"));
  }

  private static fromLogger(logger: Logger): StructuredLogger {
    const instance = Object.create(StructuredLogger.prototype) as StructuredLogger;
    instance.logger = logger;
    return instance;
  }

  child(context: LogContext): StructuredLogger {
    return StructuredLogger.fromLogger(this.logger.child(redact(context) as LogContext));
  }

  debug(message: string, context: LogContext = {}): void {
    this.write("debug", message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.write("info", message, context);
  }

  warn(message: string, context: LogContext = {}, details: Record<string, unknown> = {}): void {
    this.write("warn", message, { ...context, ...details });
  }

  error(message: string, context: LogContext = {}, details: Record<string, unknown> = {}): void {
    this.write("error", message, { ...context, ...details });
  }

  private write(level: "debug" | "info" | "warn" | "error", message: string, context: object): void {
    this.logger[level](redact({
      timestamp: new Date().toISOString(),
      message,
      ...context,
    }));
  }
}

export function activityLogContext(): LogContext {
  try {
    const info = Context.current().info;
    return {
      activityId: info.activityId,
      ...(info.workflowExecution ? {
        workflowId: info.workflowExecution.workflowId,
        runId: info.workflowExecution.runId,
      } : {}),
    };
  } catch {
    return {};
  }
}
