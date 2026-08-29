import type { ForgeDatabase } from "./database.js";

export const DEFAULT_MIN_FREE_DISK_GB = 5;
export const MAX_MIN_FREE_DISK_GB = 1024;

export interface EnvironmentSettings {
  minFreeDiskGb: number;
}

export function readEnvironmentSettings(database: ForgeDatabase): EnvironmentSettings {
  const row = database.authQuery((db) => db.prepare("SELECT min_free_disk_gb AS minFreeDiskGb FROM forge_environment_settings WHERE id = 'host'").get() as { minFreeDiskGb: number } | undefined);
  return { minFreeDiskGb: row?.minFreeDiskGb ?? DEFAULT_MIN_FREE_DISK_GB };
}

export function updateEnvironmentSettings(database: ForgeDatabase, settings: EnvironmentSettings): EnvironmentSettings {
  if (!Number.isFinite(settings.minFreeDiskGb) || settings.minFreeDiskGb < 0 || settings.minFreeDiskGb > MAX_MIN_FREE_DISK_GB) {
    throw new RangeError(`Minimum free disk space must be between 0 and ${MAX_MIN_FREE_DISK_GB} GB`);
  }
  database.authTransaction((db) => db.prepare("INSERT INTO forge_environment_settings (id, min_free_disk_gb, updated_at) VALUES ('host', ?, ?) ON CONFLICT(id) DO UPDATE SET min_free_disk_gb = excluded.min_free_disk_gb, updated_at = excluded.updated_at").run(settings.minFreeDiskGb, new Date().toISOString()));
  return readEnvironmentSettings(database);
}
