import { expect, test } from "vitest";

import { releaseDeliveryProjection } from "../src/engine/activities/release.js";


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
