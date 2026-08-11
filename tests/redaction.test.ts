import assert from "node:assert/strict";
import { test } from "vitest";

import { redact, StructuredLogger } from "../src/logging.js";

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

test("emits Pino JSON with correlation fields and redacted values", () => {
  const lines: string[] = [];
  new StructuredLogger((line) => lines.push(line)).child({ workflowId: "workflow-1", runId: "run-1" }).error("provider failed", {}, {
    authorization: "Bearer secret-token",
  });

  const record = JSON.parse(lines[0] ?? "{}");
  assert.equal(record.message, "provider failed");
  assert.equal(record.workflowId, "workflow-1");
  assert.equal(record.runId, "run-1");
  assert.equal(record.authorization, "[REDACTED]");
  assert.doesNotMatch(lines[0] ?? "", /secret-token/);
});
