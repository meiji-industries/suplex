import { expect, test } from "vitest";

import { isApplicationPath } from "../src/frontend/lib/navigation.js";

test("only Forge views are eligible for client-side navigation", () => {
  expect(isApplicationPath("/tasks/task-1")).toBe(true);
  expect(isApplicationPath("/companies/company-1/settings")).toBe(true);
  expect(isApplicationPath("/profile")).toBe(true);
  expect(isApplicationPath("/api/tasks/task-1/artifacts/artifact-1")).toBe(false);
  expect(isApplicationPath("/auth")).toBe(false);
});
