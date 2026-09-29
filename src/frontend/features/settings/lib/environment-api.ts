import { readJsonUnchecked } from "../../../lib/api.js";

export type EnvironmentSettings = { minFreeDiskGb: number; defaultBudgetUsd: number; defaultMaxTurns: number; todayPageEnabled: boolean; hostTerminalEnabled: boolean; git2Enabled: boolean };

export function getEnvironmentSettings(): Promise<EnvironmentSettings> {
  return readJsonUnchecked<EnvironmentSettings>("/api/admin/environment");
}

export function updateEnvironmentSettings(patch: Partial<EnvironmentSettings>): Promise<EnvironmentSettings> {
  return readJsonUnchecked<EnvironmentSettings>("/api/admin/environment", { method: "PATCH", body: JSON.stringify(patch) });
}
