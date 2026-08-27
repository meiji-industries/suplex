import { expect, test } from "vitest";

// BUG: src/codex-lead.ts:851 starts a second review turn before checking
// forge_delivery_reviews for the matching (workflow_id, subject_commit).
test.skip("adopts an existing delivery review before starting another Lead turn", () => {
  expect(true).toBe(true);
});
