import type { HarnessKind } from "./harness-kind.js";

export const PROVIDER_HARNESS_KINDS = ["opencode", "claude-code", "codex", "pi", "omp"] as const satisfies readonly HarnessKind[];

export type ProviderHarnessKind = (typeof PROVIDER_HARNESS_KINDS)[number];

export const HEALTH_CHECK_IDS = [
  "database",
  "artifact-root",
  "disk-space",
  "git",
  "herdr-readiness",
  "gh-auth",
  "gh-cli",
  "pnpm",
  "tailscale",
  "backup",
  "provider:opencode",
  "provider:claude-code",
  "provider:codex",
  "provider:pi",
  "provider:omp",
] as const;

export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number];

export const OWNED_HEALTH_CHECK_IDS = ["database", "artifact-root"] as const satisfies readonly HealthCheckId[];

export const REQUIRED_HEALTH_CHECK_IDS = ["git", "herdr-readiness"] as const satisfies readonly HealthCheckId[];

export function isOwnedHealthCheck(id: HealthCheckId): boolean {
  return (OWNED_HEALTH_CHECK_IDS as readonly string[]).includes(id);
}

export function isRequiredHealthCheck(id: HealthCheckId): boolean {
  return (REQUIRED_HEALTH_CHECK_IDS as readonly string[]).includes(id);
}
