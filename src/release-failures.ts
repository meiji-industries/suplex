import { z } from "zod";

export const ReleaseFailureCodeSchema = z.enum(["authentication-required", "invalid-provider-response", "wrong-remote", "stale-reviewed-revision", "pinned-configuration-incomplete", "target-base-drift", "remote-head-conflict", "ambiguous-provider-state", "provider-rate-limited", "provider-unavailable", "public-projection-unsafe"]);
export type ReleaseFailureCode = z.infer<typeof ReleaseFailureCodeSchema>;

export const releaseFailureOwner: Record<ReleaseFailureCode, "git" | "GitHub" | "Forge"> = {
  "authentication-required": "GitHub",
  "invalid-provider-response": "GitHub",
  "wrong-remote": "git",
  "stale-reviewed-revision": "Forge",
  "pinned-configuration-incomplete": "Forge",
  "target-base-drift": "git",
  "remote-head-conflict": "git",
  "ambiguous-provider-state": "GitHub",
  "provider-rate-limited": "GitHub",
  "provider-unavailable": "GitHub",
  "public-projection-unsafe": "Forge",
};

export const releaseFailureCopy: Record<ReleaseFailureCode, string> = {
  "authentication-required": "GitHub could not authenticate this request.",
  "invalid-provider-response": "GitHub returned an invalid release response.",
  "wrong-remote": "git found a remote that does not match the pinned repository.",
  "stale-reviewed-revision": "Forge could not match the reviewed commit to a build.",
  "pinned-configuration-incomplete": "Forge could not find the accepted release configuration.",
  "target-base-drift": "git found that the target base changed.",
  "remote-head-conflict": "git found that the remote branch points to another commit.",
  "ambiguous-provider-state": "GitHub returned conflicting pull request details.",
  "provider-rate-limited": "GitHub limited release requests.",
  "provider-unavailable": "GitHub did not answer the release request.",
  "public-projection-unsafe": "Forge cannot safely project the release history.",
};
