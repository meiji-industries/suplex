import { describe, expect, it } from "vitest";
import { classifyRepairFailure } from "../src/temporal/workflow/runtime.js";

describe("classifyRepairFailure", () => {
  it.each([
    ["login-expired", undefined, "ci", "credential_missing"],
    [null, "provider_authentication", "review", "credential_missing"],
    ["rate-limited", undefined, "local_check", "rate_limited"],
    ["provider-unavailable", undefined, "merge", "transient_infrastructure"],
    ["product-decision-required", undefined, "merge", "product_ambiguity"],
    ["merge-conflict", undefined, "merge", "merge_conflict_mechanical"],
    ["unknown", undefined, "ci", "ci_failure"],
    ["unknown", undefined, "local_check", "code_failure"],
  ] as const)("maps %s", (code, category, source, expected) => {
    expect(classifyRepairFailure({ code, ...(category ? { category } : {}), source, summary: "failure" })).toBe(expected);
  });
});
