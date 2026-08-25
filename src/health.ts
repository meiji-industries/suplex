import type { ForgeConfig } from "./config.js";
import { HealthSnapshotSchema } from "./schemas.js";
import { isOwnedHealthCheck, type HealthCheckId } from "./health-contract.js";

export { HEALTH_CHECK_IDS, OWNED_HEALTH_CHECK_IDS, isOwnedHealthCheck } from "./health-contract.js";
export type { HealthCheckId } from "./health-contract.js";

export type HealthStatus = "healthy" | "warning" | "unhealthy";

export interface HealthCheck {
  id: HealthCheckId;
  label: string;
  status: HealthStatus;
  summary: string;
  details: Record<string, string | number | boolean>;
}

export interface HealthSnapshot {
  generatedAt: string;
  reachableAddress: string;
  ready: boolean;
  checks: HealthCheck[];
}

export interface HostHealthDependencies {
  temporal: () => Promise<HealthCheck>;
  database: () => Promise<HealthCheck>;
  artifactRoot: () => Promise<HealthCheck>;
  worker: () => Promise<HealthCheck>;
  codexAuth: () => Promise<HealthCheck>;
  herdrReadiness?: () => Promise<HealthCheck>;
  ghAuth: () => Promise<HealthCheck>;
  backup?: () => Promise<HealthCheck>;
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

export async function inspectHostHealth(config: ForgeConfig, dependencies: HostHealthDependencies): Promise<HealthSnapshot> {
  const checks = await Promise.all([
    safelyCheck("temporal", "Temporal", dependencies.temporal),
    safelyCheck("database", "SQLite database", dependencies.database),
    safelyCheck("artifact-root", "Artifact root", dependencies.artifactRoot),
    safelyCheck("worker", "Worker and task queue", dependencies.worker),
    safelyCheck("codex-auth", "Codex authentication", dependencies.codexAuth),
    ...(dependencies.herdrReadiness ? [safelyCheck("herdr-readiness", "Herdr readiness", dependencies.herdrReadiness)] : []),
    safelyCheck("gh-auth", "GitHub CLI authentication", dependencies.ghAuth),
    ...(dependencies.backup ? [safelyCheck("backup", "Backup verification", dependencies.backup)] : []),
  ]);
  return HealthSnapshotSchema.parse({
    generatedAt: new Date().toISOString(),
    reachableAddress: config.reachableAddress,
    ready: checks.filter((check) => isOwnedHealthCheck(check.id)).every((check) => check.status !== "unhealthy"),
    checks,
  });
}
