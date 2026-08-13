import { describe, expect, it } from "vitest";

import { nextPullRequestReviewAction } from "../src/frontend/views/task-details.js";

describe("nextPullRequestReviewAction", () => {
  it("uses delivery review before final review", () => {
    expect(nextPullRequestReviewAction(["final_review"])).toBe("final-review");
    expect(nextPullRequestReviewAction(["review_delivery", "final_review"])).toBe("review-delivery");
    expect(nextPullRequestReviewAction([])).toBeUndefined();
  });
});
