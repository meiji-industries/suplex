import assert from "node:assert/strict";
import { test } from "vitest";

import { isLegacyDurableIdentifier, runtimeIdentifiers } from "../src/runtime-identifiers.js";

test("new durable runtime identities are installation-scoped and neutral", () => {
  const identifiers = runtimeIdentifiers("a1b2c3d4e5f6");
  for (const value of Object.values(identifiers)) {
    assert.doesNotMatch(value, /forge/i);
  }
  assert.equal(identifiers.namespace, "runtime-a1b2c3d4e5f6");
  assert.equal(isLegacyDurableIdentifier("forge-temporal"), true);
  assert.equal(isLegacyDurableIdentifier("runtime-a1b2c3d4e5f6"), false);
});
