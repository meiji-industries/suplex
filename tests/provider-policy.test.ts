import { expect, test } from "vitest";

import { isProfileAllowed, ProjectProviderPolicySchema } from "../src/projects/provider-policy.js";

const system = { provider: "claude-code" as const, providerInstanceId: null };
const scoped = { provider: "claude-code" as const, providerInstanceId: "instance_a" };

test("a system login follows its provider row", () => {
  expect(isProfileAllowed({ allowedProviders: ["claude-code"], allowedInstanceIds: [] }, system)).toBe(true);
  expect(isProfileAllowed({ allowedProviders: ["codex"], allowedInstanceIds: ["instance_a"] }, system)).toBe(false);
});

test("a dedicated login follows its own row, independent of the provider row", () => {
  expect(isProfileAllowed({ allowedProviders: [], allowedInstanceIds: ["instance_a"] }, scoped)).toBe(true);
  expect(isProfileAllowed({ allowedProviders: ["claude-code"], allowedInstanceIds: [] }, scoped)).toBe(false);
});

test("a policy may allow only dedicated logins", () => {
  expect(ProjectProviderPolicySchema.safeParse({ allowedProviders: [], allowedInstanceIds: ["instance_a"] }).success).toBe(true);
});
