import type { ForgeConfig } from "./config.js";

export type HealthStatus = "healthy" | "unhealthy";

export interface HealthCheck {
  id: string;
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
  ghAuth: () => Promise<HealthCheck>;
}

async function safelyCheck(id: string, label: string, check: () => Promise<HealthCheck>): Promise<HealthCheck> {
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
    safelyCheck("gh-auth", "GitHub CLI authentication", dependencies.ghAuth),
  ]);
  const ownedServiceIds = new Set(["temporal", "database", "artifact-root", "worker"]);
  return {
    generatedAt: new Date().toISOString(),
    reachableAddress: config.reachableAddress,
    ready: checks.filter((check) => ownedServiceIds.has(check.id)).every((check) => check.status === "healthy"),
    checks,
  };
}
