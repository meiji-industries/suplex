export class ApplicationFailure extends Error {
  readonly type: string;
  readonly nonRetryable: boolean;
  readonly details: unknown[];

  constructor(message: string, type = "application-failure", nonRetryable = false, details: unknown[] = []) {
    super(message);
    this.name = "ApplicationFailure";
    this.type = type;
    this.nonRetryable = nonRetryable;
    this.details = details;
  }

  static nonRetryable(message: string, type?: string, ...details: unknown[]): ApplicationFailure {
    return new ApplicationFailure(message, type, true, details);
  }

  static retryable(message: string, type?: string, ...details: unknown[]): ApplicationFailure {
    return new ApplicationFailure(message, type, false, details);
  }

  static create(options: { message: string; type?: string; nonRetryable?: boolean; details?: unknown[] }): ApplicationFailure {
    return new ApplicationFailure(options.message, options.type, options.nonRetryable, options.details);
  }
}

export class CancelledFailure extends Error {
  constructor(message = "Cancelled") { super(message); this.name = "CancelledFailure"; }
}

export class ActivityFailure extends Error {
  constructor(message: string, override readonly cause?: unknown) { super(message); this.name = "ActivityFailure"; }
}

export function isCancellation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof CancelledFailure || current instanceof Error && (current.name === "AbortError" || current.name === "CancelledFailure")) return true;
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
