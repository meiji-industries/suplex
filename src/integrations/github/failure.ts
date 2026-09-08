export type GithubFailureCode = "authentication-required" | "invalid-provider-response" | "wrong-remote" | "local-revision-unavailable" | "provider-rate-limited" | "provider-unavailable";

export class GithubReleaseFailure extends Error {
  constructor(readonly code: GithubFailureCode, readonly summary = "GitHub release failed", readonly retryAt: string | null = null) {
    super(summary);
    this.name = "GithubReleaseFailure";
  }
}
