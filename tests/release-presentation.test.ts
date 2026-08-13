import { expect, test } from "vitest";

import { releaseDeliveryProjection } from "../src/temporal/activities/release.js";

const occurredAt = "2026-08-12T00:00:00.000Z";

function receipt(sequence: number, kind: "command_finished" | "test_result", summary: string, exitCode: number | null) {
  return {
    eventId: `receipt_${sequence}`,
    executionId: "developer_1",
    attempt: 1,
    sequence,
    kind,
    stepNumber: 1,
    sourceItemId: `item_${sequence}`,
    occurredAt,
    summary,
    exitCode,
    artifactId: null,
    artifactSha256: null,
    idempotencyKey: `developer_1:1:${sequence}`,
  };
}

test("projects only public delivery fields from reconciled Developer evidence", () => {
  const projection = releaseDeliveryProjection({
    kind: "developer-reconciliation",
    report: {
      kind: "delivery",
      summary: "Improved the Git publishing experience.",
      steps: [{ number: 1, status: "completed", filesChanged: ["src/github-release.ts"], notes: "Generate readable branch names and useful pull request copy." }],
      authorizedStepsNotCompleted: [],
      resultCommit: "b".repeat(40),
      resultTree: "c".repeat(40),
      dirtyState: "clean",
      blocker: null,
    },
    receipts: [
      receipt(1, "command_finished", "pnpm test", 0),
      receipt(2, "command_finished", "pnpm lint", 1),
      receipt(3, "test_result", "12 tests passed", null),
    ],
    git: { changedPaths: ["src/github-release.ts"] },
  });

  expect(projection).toEqual({
    summary: "Improved the Git publishing experience.",
    changes: ["Generate readable branch names and useful pull request copy."],
    filesChanged: ["src/github-release.ts"],
  });
});

test("keeps historical direct delivery artifacts readable", () => {
  expect(releaseDeliveryProjection({
    summary: "Historical delivery",
    filesChanged: ["src/legacy.ts"],
    commandsRun: ["pnpm test"],
    testResults: ["passed"],
    steps: [{ notes: "Preserve existing releases.", filesChanged: ["tests/legacy.test.ts"], commandsRun: ["pnpm lint"], testResults: ["clean"] }],
  })).toEqual({
    summary: "Historical delivery",
    changes: ["Preserve existing releases."],
    filesChanged: ["src/legacy.ts", "tests/legacy.test.ts"],
    commandsRun: ["pnpm test", "pnpm lint"],
    testResults: ["passed", "clean"],
  });
});
