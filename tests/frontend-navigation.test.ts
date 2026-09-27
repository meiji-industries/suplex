import { expect, test } from "vitest";

import { isApplicationPath } from "../src/frontend/shell/navigation-state.js";

test("only Suplex views are eligible for client-side navigation", () => {
  expect(isApplicationPath("/tasks/task-1")).toBe(true);
  expect(isApplicationPath("/admin/workflows")).toBe(true);
  expect(isApplicationPath("/admin/triggers")).toBe(true);
  expect(isApplicationPath("/admin/models")).toBe(false);
  expect(isApplicationPath("/workflows")).toBe(false);
  expect(isApplicationPath("/companies/company-1/settings")).toBe(true);
  expect(isApplicationPath("/templates")).toBe(true);
  expect(isApplicationPath("/projects/project-1/templates")).toBe(true);
  expect(isApplicationPath("/profile")).toBe(true);
  expect(isApplicationPath("/setup")).toBe(true);
  expect(isApplicationPath("/onboarding")).toBe(true);
  expect(isApplicationPath("/admin/onboarding")).toBe(true);
  expect(isApplicationPath("/admin/agents")).toBe(true);
  expect(isApplicationPath("/api/tasks/task-1/artifacts/artifact-1")).toBe(false);
  expect(isApplicationPath("/auth")).toBe(false);
});
