import assert from "node:assert/strict";
import { test } from "vitest";

import { redact } from "../src/logging.js";

test("redacts credential-shaped keys and values before serialization", () => {
  const result = redact({
    correlationId: "corr-123",
    authorization: "Bearer super-secret-token",
    nested: {
      password: "hunter2",
      message: "gho_1234567890abcdef and token=another-secret",
    },
  });

  assert.deepEqual(result, {
    correlationId: "corr-123",
    authorization: "[REDACTED]",
    nested: {
      password: "[REDACTED]",
      message: "[REDACTED] and [REDACTED]",
    },
  });
});

test("does not mutate the object supplied by a caller", () => {
  const input = { token: "secret", safe: "value" };

  redact(input);

  assert.deepEqual(input, { token: "secret", safe: "value" });
});
