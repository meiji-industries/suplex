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

test("projects only public delivery fields from receipt-free reconciled Developer evidence", () => {
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
    independentVerification: {
      outcome: "passed",
      summary: "Pinned verification passed",
      commands: [{ command: "pnpm test", argv: ["pnpm", "test"], exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" }],
    },
    git: { changedPaths: ["src/github-release.ts"] },
  });

  expect(projection).toEqual({
    summary: "Improved the Git publishing experience.",
    changes: ["Generate readable branch names and useful pull request copy."],
    filesChanged: ["src/github-release.ts"],
  });
});

test("keeps historical receipt-bearing reconciled artifacts readable", () => {
  expect(releaseDeliveryProjection({
    kind: "developer-reconciliation",
    report: {
      kind: "delivery",
      summary: "Historical delivery",
      steps: [{ number: 1, status: "completed", filesChanged: ["src/legacy.ts"], notes: "Preserve existing releases." }],
      authorizedStepsNotCompleted: [],
      resultCommit: "b".repeat(40),
      resultTree: "c".repeat(40),
      dirtyState: "clean",
      blocker: null,
    },
    receipts: [receipt(1, "command_finished", "pnpm test", 0)],
    git: { changedPaths: ["src/legacy.ts"] },
  })).toEqual({
    summary: "Historical delivery",
    changes: ["Preserve existing releases."],
    filesChanged: ["src/legacy.ts"],
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
