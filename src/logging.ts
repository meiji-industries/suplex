import { Context } from "@temporalio/activity";
import pino, { type DestinationStream, type Logger } from "pino";

const sensitiveKey = /(?:authorization|cookie|credential|password|private.?key|secret|token|api.?key|thread[_-]?id|threadId)/i;
const sensitiveValue = /(?:Bearer|Basic)\s+[^\s,;]+|(?:gho_|github_pat_|sk-|fh[ap]_)[A-Za-z0-9_-]+|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[a-z][a-z0-9+.-]*:\/\/[^:\s/]+:[^@\s/]+@|\b(?:access[_-]?token|token|password|secret|api[_-]?key|authorization)=[^\s,;]+|\b(?:authorization|x-api-key)\s*:\s*[^\r\n,;]+/gi;

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

/** Formats one Pino record for interactive development output. Returns null for request-start records. */
export function formatDevLogLine(input: DevLogRecord, options: { color?: boolean; component?: string } = {}): string | null {
  const record = redact(input) as DevLogRecord;
  const message = short(field(record, "msg") ?? field(record, "message")) || "log";
  const request = field(record, "req") as DevLogRecord | undefined;
  const status = requestStatus(record);

  // Fastify emits a start and completion line for each request. The completion
  // has all of the useful information, so keeping only it makes the pane scannable.
  if (message === "incoming request" && request) return null;

  const levelName = field(record, "level") === 50 ? "ERROR" : field(record, "level") === 40 ? "WARN" : "INFO";
  const color = options.color ?? (!process.env.NO_COLOR && Boolean(process.stdout.isTTY));
  const component = short(options.component ?? field(record, "component") ?? logComponent());
  const requestLine = request && message === "request completed"
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

export function createFastifyLogger(sink?: (line: string) => void): Logger {
  return pino(fastifyLoggerOptions, sink ? { write: sink } : usePrettyLogs() ? prettyDestination() : process.stdout);
}

export class StructuredLogger {
  private logger: Logger;

  constructor(sink?: (line: string) => void) {
    this.logger = pino(loggerOptions, sink ? { write: sink } : usePrettyLogs() ? prettyDestination() : process.stdout);
  }

  private static fromLogger(logger: Logger): StructuredLogger {
    const instance = Object.create(StructuredLogger.prototype) as StructuredLogger;
    instance.logger = logger;
    return instance;
  }

  child(context: LogContext): StructuredLogger {
    return StructuredLogger.fromLogger(this.logger.child(redact(context) as LogContext));
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

  private write(level: "info" | "warn" | "error", message: string, context: object): void {
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
