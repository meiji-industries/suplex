import { readJsonUnchecked } from "../../../lib/api.js";
import type { EnvironmentSettingsResponse } from "../../../contracts/generated/EnvironmentSettingsResponse.js";

export type EnvironmentSettings = EnvironmentSettingsResponse;

export function getEnvironmentSettings(): Promise<EnvironmentSettings> {
  return readJsonUnchecked<EnvironmentSettings>("/api/admin/environment");
}

export function updateEnvironmentSettings(patch: Partial<EnvironmentSettings>): Promise<EnvironmentSettings> {
  return readJsonUnchecked<EnvironmentSettings>("/api/admin/environment", { method: "PATCH", body: JSON.stringify(patch) });
}
