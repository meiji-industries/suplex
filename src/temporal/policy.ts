import { defaultPayloadConverter, type Payload } from "@temporalio/common";

import { AuthorizedPlanSubjectSchema } from "../developer-contracts.js";

export const WORKFLOW_PAYLOAD_LIMIT_BYTES = 32 * 1024;
export const WORKFLOW_HISTORY_EVENT_LIMIT = 5_000;
// The continuation state rides inside the workflow start input, so it shares that limit.
// A lower gate here wedges a long-lived workflow at its continue-as-new point.
export const WORKFLOW_CONTINUE_STATE_LIMIT_BYTES = 16 * 1024;

export const PAYLOAD_POLICY = {
  workflowStartInput: 16 * 1024,
  updateOrSignalArguments: 8 * 1024,
  activityArguments: 24 * 1024,
  activityResult: 24 * 1024,
  // Update and query results carry the full issue state. A gate below the single-payload
  // limit wedges a long-lived workflow (every workflow task fails) once the state grows.
  workflowOrUpdateResult: WORKFLOW_PAYLOAD_LIMIT_BYTES,
  queryArguments: 2 * 1024,
  queryResult: WORKFLOW_PAYLOAD_LIMIT_BYTES,
  memo: 4 * 1024,
  searchAttributes: 4 * 1024,
  continueAsNewInput: WORKFLOW_CONTINUE_STATE_LIMIT_BYTES,
  singlePayload: WORKFLOW_PAYLOAD_LIMIT_BYTES,
} as const;

export type PayloadBoundary = keyof typeof PAYLOAD_POLICY;

const allowedIdentityKeys: Record<string, true> = { artifactId: true, requestHash: true, workflowId: true, issueId: true, companyId: true, projectId: true, projectRevisionId: true };
const forbiddenKey = /^(?:prompt|source|log|rawDiff|conflictDiff|taskBody|description|authorization|password|token|credential|secret|privateKey|apiKey)$/i;
const sourceIdentifier = /^[a-z_]+$/;
const forbiddenValue = /-----BEGIN [^-]+-----|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b|(?:bearer|basic)\s+[a-z0-9+/=_-]{16,}/i;
const authorizationKeys = new Set(["authorizationId", "taskId", "companyId", "projectId", "workflowId", "planRevision", "planArtifactId", "planSha256", "authorizationKind", "approvalDecisionId", "authorizedAt"]);

function approvedAuthorizationEnvelope(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !authorizationKeys.has(key))) return false;
  return AuthorizedPlanSubjectSchema.safeParse(record).success;
}

function byteLength(value: Uint8Array | string | null | undefined): number {
  return value == null ? 0 : typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}

export function encodedPayloadSize(payload: Payload): number {
  if (payload.externalPayloads?.length) throw new PayloadPolicyViolation("singlePayload", 0, 0);
  const metadata = Object.entries(payload.metadata ?? {}).reduce((size, [key, value]) => size + byteLength(key) + byteLength(value as Uint8Array | string | null | undefined), 0);
  return byteLength(payload.data) + metadata;
}

export class PayloadPolicyViolation extends Error {
  readonly code = "payload_policy_violation" as const;
  constructor(readonly boundary: string, readonly encodedBytes: number, readonly limit: number, readonly reference?: string) {
    super(`Payload policy violation at ${boundary}: ${encodedBytes} bytes exceeds ${limit}`);
    this.name = "PayloadPolicyViolation";
  }
}

function assertSafeValue(value: unknown, path = "value"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (forbiddenValue.test(value)) throw new PayloadPolicyViolation(path, 0, 0);
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "authorization" && approvedAuthorizationEnvelope(child)) { assertSafeValue(child, `${path}.${key}`); continue; }
    const sourceAllowed = key === "source" && (
      child !== null && typeof child === "object" && !Array.isArray(child)
      || typeof child === "string" && sourceIdentifier.test(child)
    );
    if (!sourceAllowed && !allowedIdentityKeys[key] && forbiddenKey.test(key)) throw new PayloadPolicyViolation(path, 0, 0);
    assertSafeValue(child, `${path}.${key}`);
  }
}

export function toEncodedPayload(value: unknown): Payload {
  assertSafeValue(value);
  const payload = defaultPayloadConverter.toPayload(value);
  const size = encodedPayloadSize(payload);
  if (size > WORKFLOW_PAYLOAD_LIMIT_BYTES) throw new PayloadPolicyViolation("singlePayload", size, WORKFLOW_PAYLOAD_LIMIT_BYTES);
  return payload;
}

export function assertEncodedPayloadBoundary(boundary: PayloadBoundary | string, values: readonly unknown[], limit = WORKFLOW_PAYLOAD_LIMIT_BYTES, reference?: string): number {
  let aggregate = 0;
  for (const value of values) {
    assertSafeValue(value);
    const payload = defaultPayloadConverter.toPayload(value);
    const size = encodedPayloadSize(payload);
    if (size > WORKFLOW_PAYLOAD_LIMIT_BYTES) throw new PayloadPolicyViolation(boundary, size, WORKFLOW_PAYLOAD_LIMIT_BYTES, reference);
    aggregate += size;
  }
  if (aggregate > limit) throw new PayloadPolicyViolation(boundary, aggregate, limit, reference);
  return aggregate;
}

export function assertPayloadWithinLimit(label: string, value: unknown, limit = WORKFLOW_PAYLOAD_LIMIT_BYTES): void {
  assertEncodedPayloadBoundary(label, [value], limit);
}

export function assertContinuationStateWithinLimit(value: unknown): void {
  assertEncodedPayloadBoundary("continueAsNewInput", [value], WORKFLOW_CONTINUE_STATE_LIMIT_BYTES);
}

export function assertHistoryEventCountWithinLimit(eventCount: number): void {
  if (!Number.isInteger(eventCount) || eventCount < 0 || eventCount > WORKFLOW_HISTORY_EVENT_LIMIT) throw new Error("Workflow history exceeds the configured event policy");
}
