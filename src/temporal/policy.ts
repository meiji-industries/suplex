export const WORKFLOW_PAYLOAD_LIMIT_BYTES = 32 * 1024;
export const WORKFLOW_HISTORY_EVENT_LIMIT = 5_000;
export const WORKFLOW_CONTINUE_STATE_LIMIT_BYTES = 8 * 1024;

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertPayloadWithinLimit(label: string, value: unknown, limit = WORKFLOW_PAYLOAD_LIMIT_BYTES): void {
  const size = encodedSize(value);
  if (size > limit) throw new Error(`${label} exceeds the ${limit}-byte Workflow payload policy`);
}

export function assertContinuationStateWithinLimit(value: unknown): void {
  assertPayloadWithinLimit("Continue-As-New state", value, WORKFLOW_CONTINUE_STATE_LIMIT_BYTES);
}

export function assertHistoryEventCountWithinLimit(eventCount: number): void {
  if (!Number.isInteger(eventCount) || eventCount < 0 || eventCount > WORKFLOW_HISTORY_EVENT_LIMIT) throw new Error("Workflow history exceeds the configured event policy");
}
