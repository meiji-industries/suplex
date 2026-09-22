import type { SuplexDatabase } from "./database.js";

export const DEFAULT_MIN_FREE_DISK_GB = 5;
export const MAX_MIN_FREE_DISK_GB = 1024;
export const DEFAULT_TASK_BUDGET_USD = 15;
export const DEFAULT_TASK_MAX_TURNS = 40;

export interface EnvironmentSettings {
  minFreeDiskGb: number;
  defaultBudgetUsd: number;
  defaultMaxTurns: number;
}

export function readEnvironmentSettings(database: SuplexDatabase): EnvironmentSettings {
  const row = database.authQuery((db) => db.prepare("SELECT min_free_disk_gb AS minFreeDiskGb, default_budget_usd AS defaultBudgetUsd, default_max_turns AS defaultMaxTurns FROM suplex_environment_settings WHERE id = 'host'").get() as EnvironmentSettings | undefined);
  return row ?? { minFreeDiskGb: DEFAULT_MIN_FREE_DISK_GB, defaultBudgetUsd: DEFAULT_TASK_BUDGET_USD, defaultMaxTurns: DEFAULT_TASK_MAX_TURNS };
}

export function updateEnvironmentSettings(database: SuplexDatabase, settings: EnvironmentSettings): EnvironmentSettings {
  if (!Number.isFinite(settings.minFreeDiskGb) || settings.minFreeDiskGb < 0 || settings.minFreeDiskGb > MAX_MIN_FREE_DISK_GB) {
    throw new RangeError(`Minimum free disk space must be between 0 and ${MAX_MIN_FREE_DISK_GB} GB`);
  }
  if (!Number.isFinite(settings.defaultBudgetUsd) || settings.defaultBudgetUsd < 0) throw new RangeError("Default task budget must be greater than or equal to 0 USD");
  if (!Number.isInteger(settings.defaultMaxTurns) || settings.defaultMaxTurns < 0) throw new RangeError("Default maximum turns must be a whole number greater than or equal to 0");
  database.authTransaction((db) => db.prepare("INSERT INTO suplex_environment_settings (id, min_free_disk_gb, default_budget_usd, default_max_turns, updated_at) VALUES ('host', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET min_free_disk_gb = excluded.min_free_disk_gb, default_budget_usd = excluded.default_budget_usd, default_max_turns = excluded.default_max_turns, updated_at = excluded.updated_at").run(settings.minFreeDiskGb, settings.defaultBudgetUsd, settings.defaultMaxTurns, new Date().toISOString()));
  return readEnvironmentSettings(database);
}
