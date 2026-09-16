import type { ForgeConfig } from "./config.js";
import { HealthSnapshotSchema } from "./schemas.js";
import { providerCheckId, providerCheckLabel, OWNED_HEALTH_CHECK_IDS, type HealthCheckId, type ProviderHarnessKind } from "./health-contract.js";

export { HEALTH_CHECK_IDS, OWNED_HEALTH_CHECK_IDS, REQUIRED_HEALTH_CHECK_IDS, PROVIDER_HEALTH_CHECK_IDS, isOwnedHealthCheck, isProviderHealthCheck, isRequiredHealthCheck, providerCheckId, providerCheckLabel } from "./health-contract.js";
export type { HealthCheckId } from "./health-contract.js";

export type HealthStatus = "healthy" | "warning" | "unhealthy";

export interface HealthCheck {
  id: HealthCheckId;
  label: string;
  status: HealthStatus;
  summary: string;
  /** A repair command or documentation address. */
  remedy?: string | undefined;
  /** "link" renders the remedy as a documentation address instead of a host command. */
  remedyKind?: "command" | "link" | undefined;
  /** The agent runtime a contextual provider check reports on. */
  provider?: ProviderHarnessKind | undefined;
  details: Record<string, string | number | boolean>;
}

export interface HealthSnapshot {
  generatedAt: string;
  reachableAddress: string;
  ready: boolean;
  checks: HealthCheck[];
  herdr?: { reachable: boolean; socketPath: string } | undefined;
}

export interface HostHealthDependencies {
  database: () => Promise<HealthCheck>;
  artifactRoot: () => Promise<HealthCheck>;
  diskSpace?: () => Promise<HealthCheck>;
  git?: () => Promise<HealthCheck>;
  herdrReadiness?: () => Promise<HealthCheck>;
  ghAuth: () => Promise<HealthCheck>;
  pnpm?: () => Promise<HealthCheck>;
  tailscale?: () => Promise<HealthCheck>;
  backup?: () => Promise<HealthCheck>;
  /** Contextual provider readiness, resolved fresh per call for one runtime kind. */
  provider?: (kind: ProviderHarnessKind) => Promise<HealthCheck>;
}

async function safelyCheck(id: HealthCheckId, label: string, check: () => Promise<HealthCheck>): Promise<HealthCheck> {
  try {
    return await check();
  } catch {
    return {
      id,
      label,
      status: "unhealthy",
      summary: "Health check failed before it could report a state",
      details: {},
    };
  }
}

/** Provider readiness is probed on demand for an authorized context and is never part of the cached base snapshot. */
export async function inspectProviderChecks(dependencies: HostHealthDependencies, kinds: readonly ProviderHarnessKind[]): Promise<HealthCheck[]> {
  const readiness = dependencies.provider;
  if (!readiness) return [];
  const distinct = [...new Set(kinds)];
  return Promise.all(distinct.map((kind) => safelyCheck(providerCheckId(kind), providerCheckLabel(kind), () => readiness(kind))));
}

export async function inspectHostHealth(config: ForgeConfig, dependencies: HostHealthDependencies, providers: readonly ProviderHarnessKind[] = []): Promise<HealthSnapshot> {
  const checks = await Promise.all([
    safelyCheck("database", "SQLite database", dependencies.database),
    safelyCheck("artifact-root", "Artifact root", dependencies.artifactRoot),
    ...(dependencies.diskSpace ? [safelyCheck("disk-space", "Disk space", dependencies.diskSpace)] : []),
    ...(dependencies.git ? [safelyCheck("git", "Git", dependencies.git)] : []),
    ...(dependencies.herdrReadiness ? [safelyCheck("herdr-readiness", "Herdr", dependencies.herdrReadiness)] : []),
    safelyCheck("gh-auth", "GitHub CLI", dependencies.ghAuth),
    ...(dependencies.pnpm ? [safelyCheck("pnpm", "pnpm", dependencies.pnpm)] : []),
    ...(dependencies.tailscale ? [safelyCheck("tailscale", "Tailscale", dependencies.tailscale)] : []),
    ...(dependencies.backup ? [safelyCheck("backup", "Backup verification", dependencies.backup)] : []),
  ]);
  checks.push(...await inspectProviderChecks(dependencies, providers));
  return HealthSnapshotSchema.parse({
    generatedAt: new Date().toISOString(),
    reachableAddress: config.reachableAddress,
    // An owned check that never reported is a failed probe, not a healthy host.
    ready: OWNED_HEALTH_CHECK_IDS.every((id) => checks.some((check) => check.id === id && check.status !== "unhealthy")),
    checks,
  });
}
