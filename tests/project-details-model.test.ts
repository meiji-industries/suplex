import { expect, test } from "vitest";

import { generalProjectPatch } from "../src/frontend/features/projects/project-details-model.js";

test("General saves send only edited project fields", () => {
  const saved = { name: "Forge", baseBranch: "main" };

  expect(generalProjectPatch(saved, { ...saved, name: "Forge renamed" })).toEqual({ name: "Forge renamed" });
  expect(generalProjectPatch(saved, { ...saved, baseBranch: "release" })).toEqual({ baseBranch: "release" });
  expect(generalProjectPatch(saved, saved)).toEqual({});
});
