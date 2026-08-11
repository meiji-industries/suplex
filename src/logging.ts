import { Context } from "@temporalio/activity";
import pino, { type Logger } from "pino";

const sensitiveKey = /(?:authorization|cookie|credential|password|private.?key|secret|token|api.?key)/i;
const sensitiveValue = /Bearer\s+[^\s,;]+|(?:gho_|github_pat_|sk-)[A-Za-z0-9_-]+|\b(?:token|password|secret|api[_-]?key)=[^\s,;]+/gi;

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

export function createFastifyLogger(sink?: (line: string) => void): Logger {
  return pino(fastifyLoggerOptions, sink ? { write: sink } : process.stdout);
}

export class StructuredLogger {
  private logger: Logger;

  constructor(sink?: (line: string) => void) {
    this.logger = pino(loggerOptions, sink ? { write: sink } : process.stdout);
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

  warn(message: string, context: LogContext = {}): void {
    this.write("warn", message, context);
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
