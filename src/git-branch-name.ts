import { createHash } from "node:crypto";

import { GitPresentationSchema } from "./git-presentation.js";

export function buildGitBranchName(input: { branchSlug: string; taskId: string }): string {
  const branchSlug = GitPresentationSchema.shape.branchSlug.parse(input.branchSlug);
  const fingerprint = createHash("sha256").update(input.taskId, "utf8").digest("hex").slice(0, 8);
  return `work/${branchSlug}-${fingerprint}`;
}
