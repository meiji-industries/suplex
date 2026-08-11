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
}

export class StructuredLogger {
  constructor(private readonly sink: (line: string) => void = console.log) {}

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
    const record = redact({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    });
    this.sink(JSON.stringify(record));
  }
}
