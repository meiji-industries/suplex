export class AgentFailure extends Error {
  readonly code: string;
  readonly nonRetryable: boolean;
  readonly retryAt: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: string, message: string, options: { nonRetryable?: boolean; retryAt?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "AgentFailure";
    this.code = code;
    this.nonRetryable = options.nonRetryable ?? false;
    this.retryAt = options.retryAt;
    this.retryAfterMs = options.retryAfterMs;
  }
}
