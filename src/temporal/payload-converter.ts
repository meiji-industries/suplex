import { defaultPayloadConverter } from "@temporalio/common";

import { encodedPayloadSize, PayloadPolicyViolation, WORKFLOW_PAYLOAD_LIMIT_BYTES } from "./policy.js";

export const payloadConverter = {
  toPayload<T>(value: T) {
    const payload = defaultPayloadConverter.toPayload(value);
    const size = encodedPayloadSize(payload);
    if (size > WORKFLOW_PAYLOAD_LIMIT_BYTES) throw new PayloadPolicyViolation("singlePayload", size, WORKFLOW_PAYLOAD_LIMIT_BYTES);
    return payload;
  },
  fromPayload<T>(payload: Parameters<typeof defaultPayloadConverter.fromPayload>[0]): T {
    return defaultPayloadConverter.fromPayload<T>(payload);
  },
};
