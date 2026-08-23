import { expect, test } from "vitest";

import { materialityCriteria, materialityMode } from "../src/frontend/lib/plan-materiality.js";

test("materiality criteria have stable labels and checks", () => {
  const criteria = materialityCriteria(["security_permissions", "user_visible_behavior"]);
  expect(criteria.map((criterion) => criterion.label)).toEqual([
    "Architecture or dependencies",
    "Schema or data migration",
    "Security or permissions",
    "External integration",
    "Production operation",
    "End-user-visible behavior",
  ]);
  expect(criteria.filter((criterion) => criterion.checked).map((criterion) => criterion.category)).toEqual(["security_permissions", "user_visible_behavior"]);
  expect(materialityMode(false)).toBe("Trivial");
  expect(materialityMode(true)).toBe("Non-Trivial");
  expect(materialityMode(null)).toBe("—");
});
