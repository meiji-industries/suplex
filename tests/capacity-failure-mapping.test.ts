import { expect, test } from "vitest";

import { CapacityFailure } from "../src/capacity.js";
import { asNonRetryableCapacityFailure } from "../src/temporal/activities/context.js";

test("maps unwinnable capacity binds to explicit non-retryable retry failures", () => {
  for (const code of ["invalid-status", "stale-owner"] as const) {
    expect(asNonRetryableCapacityFailure(new CapacityFailure(code))).toMatchObject({
      type: code,
      nonRetryable: true,
      message: "The previous Developer turn was interrupted and its capacity request cannot be reused — retry development.",
      details: [{ code, summary: "The previous Developer turn was interrupted and its capacity request cannot be reused — retry development." }],
    });
  }
});
