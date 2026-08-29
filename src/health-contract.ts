export const HEALTH_CHECK_IDS = [
  "engine",
  "database",
  "artifact-root",
  "worker",
  "codex-auth",
  "claude-auth",
  "openrouter-auth",
  "herdr-readiness",
  "gh-auth",
  "backup",
] as const;

export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number];

export const OWNED_HEALTH_CHECK_IDS = ["engine", "database", "artifact-root", "worker"] as const satisfies readonly HealthCheckId[];

export function isOwnedHealthCheck(id: HealthCheckId): boolean {
  return (OWNED_HEALTH_CHECK_IDS as readonly string[]).includes(id);
}
