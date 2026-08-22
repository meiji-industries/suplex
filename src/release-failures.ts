import { z } from "zod";

export const ReleaseFailureCodeSchema = z.enum(["authentication-required", "invalid-provider-response", "wrong-remote", "stale-reviewed-revision", "pinned-configuration-incomplete", "target-base-drift", "remote-head-conflict", "ambiguous-provider-state", "provider-rate-limited", "provider-unavailable", "public-projection-unsafe"]);
export type ReleaseFailureCode = z.infer<typeof ReleaseFailureCodeSchema>;

export const releaseFailureCopy: Record<ReleaseFailureCode, string> = {
  "authentication-required": "GitHub authentication is required. Re-authenticate the host CLI and retry.",
  "invalid-provider-response": "GitHub returned an invalid release observation. Retry after verifying provider availability.",
  "wrong-remote": "The local origin does not match the pinned repository.",
  "stale-reviewed-revision": "The approved review no longer matches the exact Developer revision. Run a fresh review.",
  "pinned-configuration-incomplete": "The accepted project revision is missing release configuration.",
  "target-base-drift": "The target base moved. Reconcile the guarded forward merge before publishing.",
  "remote-head-conflict": "The remote issue branch points to another commit. Inspect it before retrying.",
  "ambiguous-provider-state": "GitHub returned contradictory pull-request state. Inspect it before retrying.",
  "provider-rate-limited": "GitHub rate-limited this release. Forge will retry at the recorded reset time.",
  "provider-unavailable": "GitHub release state could not be confirmed. Retry after checking provider availability.",
  "public-projection-unsafe": "A historical release projection needs attention.",
};
