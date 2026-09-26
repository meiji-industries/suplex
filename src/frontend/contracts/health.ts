import type { HealthCheckId, ProviderHarnessKind } from "./health-checks.js";

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

