import { expect, test } from "vitest";

import { redact, StructuredLogger } from "../src/logging.js";

test("redacts credential-shaped keys and values before serialization", () => {
  const result = redact({
    correlationId: "corr-123",
    authorization: "Bearer super-secret-token",
    nested: {
      password: "hunter2",
      message: "gho_1234567890abcdef and token=another-secret",
      hermes: "pair fhp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12 with fha_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12",
    },
  });

  expect(result).toEqual({
    correlationId: "corr-123",
    authorization: "[REDACTED]",
    nested: {
      password: "[REDACTED]",
      message: "[REDACTED] and [REDACTED]",
      hermes: "pair [REDACTED] with [REDACTED]",
    },
  });
});

test("does not mutate the object supplied by a caller", () => {
  const input = { token: "secret", safe: "value" };

  redact(input);

  expect(input).toEqual({ token: "secret", safe: "value" });
});

test("emits Pino JSON with correlation fields and redacted values", () => {
  const lines: string[] = [];
  new StructuredLogger((line) => lines.push(line)).child({ workflowId: "workflow-1", runId: "run-1" }).error("provider failed", {}, {
    authorization: "Bearer secret-token",
  });

  const record = JSON.parse(lines[0] ?? "{}");
  expect(record.message).toBe("provider failed");
  expect(record.workflowId).toBe("workflow-1");
  expect(record.runId).toBe("run-1");
  expect(record.authorization).toBe("[REDACTED]");
  expect(lines[0] ?? "").not.toMatch(/secret-token/);
});
