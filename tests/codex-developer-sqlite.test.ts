import { expect, test } from "vitest";

import { asNonRetryableApplicationFailure } from "../src/temporal/activities.js";

test("SQLite failures become visible non-retryable Temporal application failures", () => {
  const error = new Error("FOREIGN KEY constraint failed");
  error.name = "SqliteError";

  expect(asNonRetryableApplicationFailure(error)).toMatchObject({
    type: "sqlite-error",
    nonRetryable: true,
    message: "FOREIGN KEY constraint failed",
    details: [{ code: "sqlite-error", summary: "FOREIGN KEY constraint failed" }],
  });
});
