import { expect, test } from "vitest";

import { runtimeIdentifiers } from "../src/runtime-identifiers.js";

test("new durable runtime identities are installation-scoped and neutral", () => {
  const identifiers = runtimeIdentifiers("a1b2c3d4e5f6");
  const otherInstallation = runtimeIdentifiers("b1c2d3e4f5a6");
  for (const value of Object.values(identifiers)) {
    expect(value).not.toMatch(/forge/i);
  }
  expect(identifiers.namespace).toBe("runtime-a1b2c3d4e5f6");
  expect(identifiers.namespace).not.toBe(otherInstallation.namespace);
  expect(identifiers.taskQueue).not.toBe(otherInstallation.taskQueue);
  expect(identifiers.namespace).not.toBe(otherInstallation.namespace);
});
