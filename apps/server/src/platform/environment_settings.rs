//! Host environment settings from `platform/environment-settings.ts`.

use crate::shared::time::now_millis_rfc3339;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::database::{DatabaseResult, SuplexDatabase};

pub const DEFAULT_MIN_FREE_DISK_GB: f64 = 5.0;
pub const MAX_MIN_FREE_DISK_GB: f64 = 1024.0;
pub const DEFAULT_TASK_BUDGET_USD: f64 = 15.0;
pub const DEFAULT_TASK_MAX_TURNS: i64 = 40;
/// Days after its last activity that a delivered task is archived automatically.
pub const DEFAULT_AUTO_ARCHIVE_AFTER_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EnvironmentSettings {
    pub min_free_disk_gb: f64,
    pub default_budget_usd: f64,
    pub default_max_turns: i64,
    /// Experiment: show the Today page. Off by default.
    pub today_page_enabled: bool,
    /// The host owns task and sign-in terminals instead of Herdr.
    /// Off by default. Set on the Terminal settings page.
    pub host_terminal_enabled: bool,
    /// Experiment: use libgit2 for Git network operations. Off by default.
    pub git2_enabled: bool,
    /// Send product telemetry. On by default. docs/telemetry.md lists it.
    pub telemetry_enabled: bool,
    /// Archive delivered tasks this many days after their last
    /// activity. 0 turns automatic archiving off.
    pub auto_archive_after_days: i64,
}

/// JSON number as JavaScript prints it: whole numbers without a fraction.
pub fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

pub fn read(database: &SuplexDatabase) -> DatabaseResult<EnvironmentSettings> {
    Ok(database
        .connection()
        .query_row(
            "SELECT min_free_disk_gb, default_budget_usd, default_max_turns, today_page_enabled, host_terminal_enabled, git2_enabled, telemetry_enabled, auto_archive_after_days FROM suplex_environment_settings WHERE id = 'host'",
            [],
            |row| {
                Ok(EnvironmentSettings {
                    min_free_disk_gb: row.get(0)?,
                    default_budget_usd: row.get(1)?,
                    default_max_turns: row.get(2)?,
                    today_page_enabled: row.get(3)?,
                    host_terminal_enabled: row.get(4)?,
                    git2_enabled: row.get(5)?,
                    telemetry_enabled: row.get(6)?,
                    auto_archive_after_days: row.get(7)?,
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
            git2_enabled: false,
            telemetry_enabled: true,
            auto_archive_after_days: DEFAULT_AUTO_ARCHIVE_AFTER_DAYS,
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
    if settings.auto_archive_after_days < 0 {
        return Err(
            "Automatic archive days must be a whole number greater than or equal to 0".into(),
        );
    }
    database.transaction(false, |database| {
        database.connection().execute(
            "INSERT INTO suplex_environment_settings (id, min_free_disk_gb, default_budget_usd, default_max_turns, today_page_enabled, host_terminal_enabled, git2_enabled, telemetry_enabled, auto_archive_after_days, updated_at) VALUES ('host', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(id) DO UPDATE SET min_free_disk_gb = excluded.min_free_disk_gb, default_budget_usd = excluded.default_budget_usd, default_max_turns = excluded.default_max_turns, today_page_enabled = excluded.today_page_enabled, host_terminal_enabled = excluded.host_terminal_enabled, git2_enabled = excluded.git2_enabled, telemetry_enabled = excluded.telemetry_enabled, auto_archive_after_days = excluded.auto_archive_after_days, updated_at = excluded.updated_at",
            params![
                settings.min_free_disk_gb,
                settings.default_budget_usd,
                settings.default_max_turns,
                settings.today_page_enabled,
                settings.host_terminal_enabled,
                settings.git2_enabled,
                settings.telemetry_enabled,
                settings.auto_archive_after_days,
                now_millis_rfc3339()
            ],
        )?;
        Ok(())
    })?;
    read(database)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::OpenMode;

    fn database() -> (std::path::PathBuf, SuplexDatabase) {
        let directory =
            std::env::temp_dir().join(format!("suplex-environment-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database =
            SuplexDatabase::open(&directory.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        (directory, database)
    }

    #[test]
    fn automatic_archive_defaults_to_30_days_and_rejects_negative_days() {
        let (directory, mut database) = database();
        assert_eq!(
            read(&database).unwrap().auto_archive_after_days,
            DEFAULT_AUTO_ARCHIVE_AFTER_DAYS
        );
        let current = read(&database).unwrap();
        // Saving the other settings keeps the default.
        update(&mut database, current).unwrap();
        assert_eq!(read(&database).unwrap().auto_archive_after_days, 30);
        for days in [0, 7, 365] {
            let updated = update(
                &mut database,
                EnvironmentSettings {
                    auto_archive_after_days: days,
                    ..current
                },
            )
            .unwrap();
            assert_eq!(updated.auto_archive_after_days, days);
            assert_eq!(read(&database).unwrap().auto_archive_after_days, days);
        }
        assert!(
            update(
                &mut database,
                EnvironmentSettings {
                    auto_archive_after_days: -1,
                    ..current
                },
            )
            .is_err()
        );
        assert_eq!(read(&database).unwrap().auto_archive_after_days, 365);
        // The schema rejects a negative value written past the validation too.
        assert!(
            database
                .connection()
                .execute(
                    "UPDATE suplex_environment_settings SET auto_archive_after_days = -1",
                    []
                )
                .is_err()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
