import { expect, test } from "vitest";
import { PublishReleaseActivityResultSchema } from "../src/temporal/contracts/activities/release.js";

const sha = "a".repeat(40);

test("blocked release results retain the provider error without attention evidence", () => {
  const result = PublishReleaseActivityResultSchema.parse({
    outcome: "blocked",
    releaseId: null,
    repository: "newschoolfoods/rtd",
    branchName: "work/release-error",
    headSha: sha,
    headTree: sha,
    pullRequestNumber: null,
    pullRequestUrl: null,
    isDraft: true,
    reused: false,
    attempt: 3,
    code: "provider-unavailable",
    summary: "Could not open the pull request: gh: Branch not found (HTTP 404)",
    retryAt: null,
    attentionEvidenceArtifactId: "",
  });

  expect(result).toMatchObject({
    outcome: "blocked",
    code: "provider-unavailable",
    summary: "Could not open the pull request: gh: Branch not found (HTTP 404)",
  });
  expect(result).not.toHaveProperty("attentionEvidenceArtifactId");
});
