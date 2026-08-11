import { expect, test } from "vitest";

import { isLegacyDurableIdentifier, runtimeIdentifiers } from "../src/runtime-identifiers.js";

test("new durable runtime identities are installation-scoped and neutral", () => {
  const identifiers = runtimeIdentifiers("a1b2c3d4e5f6");
  for (const value of Object.values(identifiers)) {
    expect(value).not.toMatch(/forge/i);
  }
  expect(identifiers.namespace).toBe("runtime-a1b2c3d4e5f6");
  expect(isLegacyDurableIdentifier("forge-temporal")).toBe(true);
  expect(isLegacyDurableIdentifier("runtime-a1b2c3d4e5f6")).toBe(false);
});
