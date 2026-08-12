const { defaultPayloadConverter } = require("@temporalio/common");

const HARD_LIMIT = 32 * 1024;
const forbiddenKey = /^(?:prompt|source|log|rawDiff|conflictDiff|taskBody|description|authorization|password|token|credential|secret|privateKey|apiKey)$/i;
const forbiddenValue = /-----BEGIN [^-]+-----|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b|(?:bearer|basic)\s+[a-z0-9+/=_-]{16,}/i;

class PayloadPolicyViolation extends Error {
  code = "payload_policy_violation";
  constructor(boundary, encodedBytes, limit) {
    super(`Payload policy violation at ${boundary}: ${encodedBytes} bytes exceeds ${limit}`);
    this.name = "PayloadPolicyViolation";
  }
}

function scan(value) {
  if (typeof value === "string") {
    if (forbiddenValue.test(value)) throw new PayloadPolicyViolation("singlePayload", 0, HARD_LIMIT);
    return;
  }
  if (Array.isArray(value)) return value.forEach(scan);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey.test(key)) throw new PayloadPolicyViolation("singlePayload", 0, HARD_LIMIT);
    scan(child);
  }
}

function size(payload) {
  if (payload.externalPayloads?.length) throw new PayloadPolicyViolation("singlePayload", 0, HARD_LIMIT);
  let total = payload.data?.byteLength ?? 0;
  for (const [key, value] of Object.entries(payload.metadata ?? {})) total += Buffer.byteLength(key) + (value?.byteLength ?? Buffer.byteLength(String(value)));
  return total;
}

const payloadConverter = {
  toPayload(value) {
    scan(value);
    const payload = defaultPayloadConverter.toPayload(value);
    const encodedBytes = size(payload);
    if (encodedBytes > HARD_LIMIT) throw new PayloadPolicyViolation("singlePayload", encodedBytes, HARD_LIMIT);
    return payload;
  },
  fromPayload(payload) {
    return defaultPayloadConverter.fromPayload(payload);
  },
};

module.exports = { payloadConverter, PayloadPolicyViolation };
