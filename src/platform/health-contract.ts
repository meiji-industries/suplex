import type { HarnessKind } from "../runtimes/task-harness.js";

export const PROVIDER_HARNESS_KINDS = ["opencode", "claude-code", "codex"] as const satisfies readonly HarnessKind[];

export type ProviderHarnessKind = (typeof PROVIDER_HARNESS_KINDS)[number];

export const HEALTH_CHECK_IDS = [
  "database",
  "artifact-root",
  "disk-space",
  "git",
  "herdr-readiness",
  "gh-auth",
  "pnpm",
  "tailscale",
  "backup",
  "provider:opencode",
  "provider:claude-code",
  "provider:codex",
] as const;

export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number];

export const OWNED_HEALTH_CHECK_IDS = ["database", "artifact-root"] as const satisfies readonly HealthCheckId[];

// Host prerequisites: tools every Forge host needs regardless of the selected
// task profiles. Provider readiness is contextual, not a host prerequisite.
export const REQUIRED_HEALTH_CHECK_IDS = ["git", "herdr-readiness"] as const satisfies readonly HealthCheckId[];

export const PROVIDER_HEALTH_CHECK_IDS = ["provider:opencode", "provider:claude-code", "provider:codex"] as const satisfies readonly HealthCheckId[];

export function isOwnedHealthCheck(id: HealthCheckId): boolean {
  return (OWNED_HEALTH_CHECK_IDS as readonly string[]).includes(id);
}

export function isRequiredHealthCheck(id: HealthCheckId): boolean {
  return (REQUIRED_HEALTH_CHECK_IDS as readonly string[]).includes(id);
}

export function isProviderHealthCheck(id: HealthCheckId): boolean {
  return (PROVIDER_HEALTH_CHECK_IDS as readonly string[]).includes(id);
}

export function providerCheckId(kind: ProviderHarnessKind): HealthCheckId {
  return `provider:${kind}` as HealthCheckId;
}

const PROVIDER_CHECK_LABELS: Record<ProviderHarnessKind, string> = { opencode: "OpenCode", "claude-code": "Claude Code", codex: "Codex CLI" };

export function providerCheckLabel(kind: ProviderHarnessKind): string {
  return PROVIDER_CHECK_LABELS[kind];
}
