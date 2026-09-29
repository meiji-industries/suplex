//! Host environment settings from `platform/environment-settings.ts`.

use crate::shared::time::now_millis_rfc3339;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::database::{DatabaseResult, SuplexDatabase};

pub const DEFAULT_MIN_FREE_DISK_GB: f64 = 5.0;
pub const MAX_MIN_FREE_DISK_GB: f64 = 1024.0;
pub const DEFAULT_TASK_BUDGET_USD: f64 = 15.0;
pub const DEFAULT_TASK_MAX_TURNS: i64 = 40;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EnvironmentSettings {
    pub min_free_disk_gb: f64,
    pub default_budget_usd: f64,
    pub default_max_turns: i64,
    /// Experiment: show the Today page. Off by default.
    pub today_page_enabled: bool,
    /// Experiment: the host owns task and sign-in terminals instead of Herdr.
    /// Off by default.
    pub host_terminal_enabled: bool,
}

/// JSON number as JavaScript prints it: whole numbers without a fraction.
pub fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

impl EnvironmentSettings {
    pub fn to_json(self) -> Value {
        json!({
            "minFreeDiskGb": js_number(self.min_free_disk_gb),
            "defaultBudgetUsd": js_number(self.default_budget_usd),
            "defaultMaxTurns": self.default_max_turns,
            "todayPageEnabled": self.today_page_enabled,
            "hostTerminalEnabled": self.host_terminal_enabled,
        })
    }
}

pub fn read(database: &SuplexDatabase) -> DatabaseResult<EnvironmentSettings> {
    Ok(database
        .connection()
        .query_row(
            "SELECT min_free_disk_gb, default_budget_usd, default_max_turns, today_page_enabled, host_terminal_enabled FROM suplex_environment_settings WHERE id = 'host'",
            [],
            |row| {
                Ok(EnvironmentSettings {
                    min_free_disk_gb: row.get(0)?,
                    default_budget_usd: row.get(1)?,
                    default_max_turns: row.get(2)?,
                    today_page_enabled: row.get(3)?,
                    host_terminal_enabled: row.get(4)?,
                })
            },
        )
        .optional()?
        .unwrap_or(EnvironmentSettings {
            min_free_disk_gb: DEFAULT_MIN_FREE_DISK_GB,
            default_budget_usd: DEFAULT_TASK_BUDGET_USD,
            default_max_turns: DEFAULT_TASK_MAX_TURNS,
            today_page_enabled: false,
            host_terminal_enabled: false,
        }))
}

pub fn update(
    database: &mut SuplexDatabase,
    settings: EnvironmentSettings,
) -> DatabaseResult<EnvironmentSettings> {
    if !settings.min_free_disk_gb.is_finite()
        || !(0.0..=MAX_MIN_FREE_DISK_GB).contains(&settings.min_free_disk_gb)
    {
        return Err(format!(
            "Minimum free disk space must be between 0 and {MAX_MIN_FREE_DISK_GB} GB"
        )
        .into());
    }
    if !settings.default_budget_usd.is_finite() || settings.default_budget_usd < 0.0 {
        return Err("Default task budget must be greater than or equal to 0 USD".into());
    }
    if settings.default_max_turns < 0 {
        return Err(
            "Default maximum turns must be a whole number greater than or equal to 0".into(),
        );
    }
    database.transaction(false, |database| {
        database.connection().execute(
            "INSERT INTO suplex_environment_settings (id, min_free_disk_gb, default_budget_usd, default_max_turns, today_page_enabled, host_terminal_enabled, updated_at) VALUES ('host', ?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO UPDATE SET min_free_disk_gb = excluded.min_free_disk_gb, default_budget_usd = excluded.default_budget_usd, default_max_turns = excluded.default_max_turns, today_page_enabled = excluded.today_page_enabled, host_terminal_enabled = excluded.host_terminal_enabled, updated_at = excluded.updated_at",
            params![
                settings.min_free_disk_gb,
                settings.default_budget_usd,
                settings.default_max_turns,
                settings.today_page_enabled,
                settings.host_terminal_enabled,
                now_millis_rfc3339()
            ],
        )?;
        Ok(())
    })?;
    read(database)
}
