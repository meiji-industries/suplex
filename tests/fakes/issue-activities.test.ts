import { expect, test } from "vitest";
import { createIssueActivitiesFake } from "./issue-activities.js";

test("fake exposes exactly the overridden activities", () => {
  const fake = createIssueActivitiesFake({
    projectIssueState: async () => {
      throw new Error("unused");
    },
  });
  expect(Object.keys(fake)).toEqual(["projectIssueState"]);
});
