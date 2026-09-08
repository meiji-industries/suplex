import { expect, test } from "vitest";

import { canonicalJson } from "../src/shared/canonical-json.js";

test("omits undefined properties like JSON.stringify and still rejects a bare undefined", () => {
  expect(canonicalJson({ b: 1, a: undefined, c: { d: undefined, e: [1] } })).toBe('{"b":1,"c":{"e":[1]}}');
  expect(() => canonicalJson(undefined)).toThrow("Cannot canonicalize undefined");
});
