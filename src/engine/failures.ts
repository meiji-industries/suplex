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
  return error instanceof CancelledFailure || (error instanceof Error && (error.name === "AbortError" || error.name === "CancelledFailure"));
}
