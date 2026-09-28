use crate::identity::IdentityError;
use crate::shared::time::rfc3339_millis;
use std::error::Error;

use chrono::{DateTime, Utc};
use getrandom::fill;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{
    http::contracts::typed::projects,
    platform::database::{DatabaseResult, SuplexDatabase},
};

const SELECTION: &str = "SELECT id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, provider_instance_id, archived_at, created_at, updated_at FROM suplex_profiles";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub role: String,
    pub avatar_seed: String,
    pub provider: String,
    pub model: String,
    pub reasoning_level: String,
    pub service_tier: String,
    pub provider_instance_id: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub name: String,
    pub role: String,
    pub avatar_seed: String,
    pub provider: String,
    pub model: String,
    pub reasoning_level: String,
    pub service_tier: String,
    pub provider_instance_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePatch {
    pub name: Option<String>,
    pub role: Option<String>,
    pub avatar_seed: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning_level: Option<String>,
    pub service_tier: Option<String>,
    #[serde(default, deserialize_with = "present_nullable_string")]
    pub provider_instance_id: Option<Option<String>>,
    pub archived: Option<bool>,
}

fn present_nullable_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(deserializer)?))
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ProfileFailure {
    pub message: String,
    pub status_code: u16,
}

impl ProfileFailure {
    fn new(message: impl Into<String>, status_code: u16) -> Box<Self> {
        Box::new(Self {
            message: message.into(),
            status_code,
        })
    }
}

impl From<ProfileFailure> for crate::shared::PublicFailure {
    fn from(failure: ProfileFailure) -> Self {
        Self::new(failure.status_code, failure.message)
    }
}

fn profile(row: &Row<'_>) -> rusqlite::Result<AgentProfile> {
    Ok(AgentProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        role: row.get(2)?,
        avatar_seed: row.get(3)?,
        provider: row.get(4)?,
        model: row.get(5)?,
        reasoning_level: row.get(6)?,
        service_tier: row.get(7)?,
        provider_instance_id: row.get(8)?,
        archived_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn profile_id() -> DatabaseResult<String> {
    let mut bytes = [0_u8; 16];
    fill(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "profile_{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn actor(database: &SuplexDatabase, user_id: &str, admin: bool) -> DatabaseResult<()> {
    let role: Option<String> = database
        .connection()
        .query_row(
            "SELECT role FROM suplex_users WHERE id = ?1 AND status = 'active'",
            [user_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(role) = role else {
        return Err(IdentityError::auth("Authentication required", 401, "auth_failure").into());
    };
    if admin && role != "admin" {
        return Err(
            IdentityError::auth("Administrator access required", 403, "auth_failure").into(),
        );
    }
    Ok(())
}

fn get(database: &SuplexDatabase, id: &str) -> DatabaseResult<AgentProfile> {
    find(database, id)?.ok_or_else(|| ProfileFailure::new("Not found", 404) as Box<dyn Error>)
}

fn find(database: &SuplexDatabase, id: &str) -> DatabaseResult<Option<AgentProfile>> {
    Ok(database
        .connection()
        .query_row(&format!("{SELECTION} WHERE id = ?1"), [id], profile)
        .optional()?)
}

fn assert_name(database: &SuplexDatabase, name: &str, id: &str) -> DatabaseResult<()> {
    let exists: bool = database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_profiles WHERE name = ?1 AND id <> ?2)",
        params![name, id],
        |row| row.get(0),
    )?;
    if exists {
        return Err(ProfileFailure::new(
            "This agent name is already in use",
            409,
        ));
    }
    Ok(())
}

fn assert_instance(database: &SuplexDatabase, input: &ProfileInput) -> DatabaseResult<()> {
    let Some(id) = &input.provider_instance_id else {
        return Ok(());
    };
    let provider: Option<String> = database
        .connection()
        .query_row(
            "SELECT provider FROM suplex_provider_instances WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    match provider {
        None => Err(ProfileFailure::new(
            "The selected provider instance does not exist",
            422,
        )),
        Some(provider) if provider != input.provider => Err(ProfileFailure::new(
            "The selected provider instance belongs to a different provider",
            422,
        )),
        Some(_) => Ok(()),
    }
}

fn audit(
    database: &SuplexDatabase,
    actor_id: &str,
    action: &str,
    profile_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    crate::identity::audit::record(
        database,
        &crate::identity::audit::AuditEvent {
            id: &crate::shared::ids::random_hex_id("audit")?,
            actor_user_id: Some(actor_id),
            actor_agent_id: None,
            action,
            target_user_id: None,
            company_id: None,
            metadata_json: &serde_json::json!({"profileId": profile_id}).to_string(),
            created_at: &rfc3339_millis(now),
        },
    )?;
    Ok(())
}

pub fn list(
    database: &SuplexDatabase,
    user_id: &str,
    include_archived: bool,
) -> DatabaseResult<Vec<AgentProfile>> {
    actor(database, user_id, false)?;
    let sql = format!(
        "{SELECTION}{} ORDER BY sort_order, name COLLATE NOCASE, id",
        if include_archived {
            ""
        } else {
            " WHERE archived_at IS NULL"
        }
    );
    let mut statement = database.connection().prepare(&sql)?;
    Ok(statement
        .query_map([], profile)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn create(
    database: &mut SuplexDatabase,
    user_id: &str,
    input: &ProfileInput,
    now: DateTime<Utc>,
) -> DatabaseResult<AgentProfile> {
    actor(database, user_id, true)?;
    let id = profile_id()?;
    let now_iso = rfc3339_millis(now);
    database.transaction(false, |database| {
        assert_name(database, &input.name, "")?;
        assert_instance(database, input)?;
        database.connection().execute(
            "INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, provider_instance_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![id, input.name, input.role, input.avatar_seed, input.provider, input.model, input.reasoning_level, input.service_tier, input.provider_instance_id, now_iso],
        )?;
        audit(database, user_id, "agent_profile_created", &id, now)?;
        Ok(())
    })?;
    get(database, &id)
}

pub fn update(
    database: &mut SuplexDatabase,
    user_id: &str,
    id: &str,
    changes: ProfilePatch,
    now: DateTime<Utc>,
) -> DatabaseResult<AgentProfile> {
    actor(database, user_id, true)?;
    database.transaction(false, |database| {
        let current = get(database, id)?;
        let input = ProfileInput {
            name: changes.name.unwrap_or_else(|| current.name.clone()),
            role: changes.role.unwrap_or_else(|| current.role.clone()),
            avatar_seed: changes.avatar_seed.unwrap_or_else(|| current.avatar_seed.clone()),
            provider: changes.provider.unwrap_or_else(|| current.provider.clone()),
            model: changes.model.unwrap_or_else(|| current.model.clone()),
            reasoning_level: changes.reasoning_level.unwrap_or_else(|| current.reasoning_level.clone()),
            service_tier: changes.service_tier.unwrap_or_else(|| current.service_tier.clone()),
            provider_instance_id: changes.provider_instance_id.unwrap_or_else(|| current.provider_instance_id.clone()),
        };
        assert_name(database, &input.name, id)?;
        if changes.archived == Some(true) || input.role != current.role {
            let used: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM suplex_projects WHERE root_profile_id = ?1 OR worker_profile_id = ?1 OR alt_profile_id = ?1)",
                [id],
                |row| row.get(0),
            )?;
            if used {
                return Err(ProfileFailure::new("Select another project default before changing this profile's role or archiving it", 409));
            }
        }
        assert_instance(database, &input)?;
        let now_iso = rfc3339_millis(now);
        let archived_at = match changes.archived {
            None => current.archived_at,
            Some(true) => Some(now_iso.clone()),
            Some(false) => None,
        };
        database.connection().execute(
            "UPDATE suplex_profiles SET name = ?1, role = ?2, avatar_seed = ?3, provider = ?4, model = ?5, reasoning_level = ?6, service_tier = ?7, provider_instance_id = ?8, archived_at = ?9, updated_at = ?10 WHERE id = ?11",
            params![input.name, input.role, input.avatar_seed, input.provider, input.model, input.reasoning_level, input.service_tier, input.provider_instance_id, archived_at, now_iso, id],
        )?;
        audit(database, user_id, "agent_profile_updated", id, now)?;
        get(database, id)
    })
}

pub fn duplicate(
    database: &mut SuplexDatabase,
    user_id: &str,
    id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<AgentProfile> {
    actor(database, user_id, true)?;
    let source = get(database, id)?;
    let names = list(database, user_id, true)?
        .into_iter()
        .map(|profile| profile.name)
        .collect::<std::collections::HashSet<_>>();
    let base = String::from_utf16_lossy(&source.name.encode_utf16().take(65).collect::<Vec<_>>());
    let mut name = format!("{base} (copy)");
    let mut copy = 2;
    while names.contains(&name) {
        name = format!("{base} (copy {copy})");
        copy += 1;
    }
    let mut seed = [0_u8; 16];
    fill(&mut seed)?;
    let input = ProfileInput {
        name,
        role: source.role,
        avatar_seed: seed.iter().map(|byte| format!("{byte:02x}")).collect(),
        provider: source.provider,
        model: source.model,
        reasoning_level: source.reasoning_level,
        service_tier: source.service_tier,
        provider_instance_id: source.provider_instance_id,
    };
    create(database, user_id, &input, now)
}

fn has_reference(database: &SuplexDatabase, sql: &str, id: &str) -> DatabaseResult<bool> {
    Ok(database
        .connection()
        .query_row(sql, [id], |_| Ok(true))
        .optional()?
        .unwrap_or(false))
}

fn referenced_profile_error(references: &[&str]) -> String {
    let names = match references {
        [one] => one.to_string(),
        [one, two] => format!("{one} and {two}"),
        [one, two, three] => format!("{one}, {two}, and {three}"),
        _ => references.join(", "),
    };
    format!("Select another agent for the {names} that use this agent before you delete it")
}

fn remove_id(values: &mut serde_json::Value, id: &str) {
    if let Some(items) = values.as_array_mut() {
        items.retain(|value| value.as_str() != Some(id));
    }
}

fn pruned_policy(
    raw: &str,
    id: &str,
    root_id: &str,
    worker_id: &str,
) -> DatabaseResult<Option<String>> {
    if raw == "{}" {
        return Ok(None);
    }
    let input: serde_json::Value = serde_json::from_str(raw)?;
    let Ok(policy) = projects::parse_agent_policy(Some(&input)) else {
        return Ok(None);
    };
    let mut parsed = serde_json::to_value(policy)?;
    let original = parsed.clone();
    let object = parsed.as_object_mut().expect("validated policy object");
    for (field, fallback) in [("rootProfileIds", root_id), ("workerProfileIds", worker_id)] {
        let values = object.get_mut(field).expect("validated policy field");
        remove_id(values, id);
        if values
            .as_array()
            .expect("validated policy array")
            .is_empty()
        {
            *values = serde_json::json!([fallback]);
        }
    }
    if let Some(advisors) = object
        .get_mut("advisorProfileIds")
        .and_then(|value| value.as_object_mut())
    {
        for values in advisors.values_mut() {
            remove_id(values, id);
        }
    }
    if parsed == original {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(&parsed)?))
}

pub fn delete(
    database: &mut SuplexDatabase,
    user_id: &str,
    id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    actor(database, user_id, true)?;
    database.transaction(false, |database| {
        get(database, id)?;
        let references = [
            ("projects", "SELECT 1 FROM suplex_projects WHERE root_profile_id = ?1 OR worker_profile_id = ?1 OR alt_profile_id = ?1 LIMIT 1"),
            ("workflows", "SELECT 1 FROM suplex_workflows WHERE json_extract(configuration_json, '$.rootProfileId') = ?1 OR json_extract(configuration_json, '$.workerProfileId') = ?1 OR EXISTS (SELECT 1 FROM json_each(configuration_json, '$.advisorProfileIds') WHERE value = ?1) LIMIT 1"),
            ("task templates", "SELECT 1 FROM suplex_task_templates WHERE json_extract(configuration_json, '$.rootProfileId') = ?1 OR json_extract(configuration_json, '$.workerProfileId') = ?1 OR EXISTS (SELECT 1 FROM json_each(configuration_json, '$.advisorProfileIds') WHERE value = ?1) LIMIT 1"),
        ];
        let mut used = Vec::new();
        for (name, sql) in references {
            if has_reference(database, sql, id)? {
                used.push(name);
            }
        }
        if !used.is_empty() {
            return Err(ProfileFailure::new(referenced_profile_error(&used), 409));
        }
        let mut statement = database.connection().prepare("SELECT id, root_profile_id, worker_profile_id, agent_task_policy_json FROM suplex_projects WHERE agent_task_policy_json <> '{}'")?;
        let projects = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for (project_id, root_id, worker_id, raw) in projects {
            if let Some(updated) = pruned_policy(&raw, id, &root_id, &worker_id)? {
                database.connection().execute("UPDATE suplex_projects SET agent_task_policy_json = ?1 WHERE id = ?2", params![updated, project_id])?;
            }
        }
        database.connection().execute("DELETE FROM suplex_avatars WHERE owner_id = ?1", [id])?;
        database.connection().execute("DELETE FROM suplex_profiles WHERE id = ?1", [id])?;
        audit(database, user_id, "agent_profile_deleted", id, now)?;
        Ok(())
    })
}

#[derive(Clone, Copy)]
struct Settings {
    provider: &'static str,
    model: &'static str,
    reasoning_level: &'static str,
    service_tier: &'static str,
}

#[derive(Clone, Copy)]
struct Defaults {
    root: Settings,
    worker: Settings,
}

const fn settings(
    provider: &'static str,
    model: &'static str,
    reasoning_level: &'static str,
) -> Settings {
    Settings {
        provider,
        model,
        reasoning_level,
        service_tier: "default",
    }
}

const PREFERRED_DEFAULTS: [Defaults; 3] = [
    Defaults {
        root: settings("claude-code", "claude-opus-5-5", "high"),
        worker: settings("claude-code", "claude-opus-5-5", "medium"),
    },
    Defaults {
        root: settings("codex", "gpt-6-astra", "medium"),
        worker: settings("codex", "gpt-6-sol", "medium"),
    },
    Defaults {
        root: settings("devin", "swe-2", "high"),
        worker: settings("devin", "swe-2", "medium"),
    },
];

const SEEDED_DEFAULTS: Defaults = Defaults {
    root: settings("codex", "gpt-5.6-sol", "medium"),
    worker: Settings {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoning_level: "max",
        service_tier: "priority",
    },
};

const PREVIOUS_DEFAULTS: Defaults = Defaults {
    root: settings("claude-code", "claude-fable-5-1", "medium"),
    worker: settings("claude-code", "claude-opus-5-5", "medium"),
};

fn same_settings(profile: &AgentProfile, settings: Settings) -> bool {
    profile.archived_at.is_none()
        && profile.provider_instance_id.is_none()
        && profile.provider == settings.provider
        && profile.model == settings.model
        && profile.reasoning_level == settings.reasoning_level
        && profile.service_tier == settings.service_tier
}

fn matching_defaults(root: &AgentProfile, worker: &AgentProfile, defaults: Defaults) -> bool {
    same_settings(root, defaults.root) && same_settings(worker, defaults.worker)
}

pub fn choose_defaults(
    database: &mut SuplexDatabase,
    user_id: &str,
    installed: impl Fn(&str) -> bool,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    actor(database, user_id, true)?;
    let Some(chosen) = PREFERRED_DEFAULTS
        .iter()
        .copied()
        .find(|defaults| installed(defaults.root.provider))
    else {
        return Ok(());
    };
    database.transaction(false, |database| {
        let has_tasks: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_tasks LIMIT 1)", [], |row| row.get(0)
        )?;
        if has_tasks {
            return Ok(());
        }
        let root = find(database, "profile_native_root")?;
        let worker = find(database, "profile_native_worker")?;
        let (Some(root), Some(worker)) = (root, worker) else {
            return Ok(());
        };
        let untouched = std::iter::once(SEEDED_DEFAULTS)
            .chain(PREFERRED_DEFAULTS)
            .chain(std::iter::once(PREVIOUS_DEFAULTS))
            .any(|defaults| matching_defaults(&root, &worker, defaults));
        if !untouched || matching_defaults(&root, &worker, chosen) {
            return Ok(());
        }
        let now_iso = rfc3339_millis(now);
        for (id, values) in [
            ("profile_native_root", chosen.root),
            ("profile_native_worker", chosen.worker),
        ] {
            database.connection().execute(
                "UPDATE suplex_profiles SET provider = ?1, model = ?2, reasoning_level = ?3, service_tier = ?4, updated_at = ?5 WHERE id = ?6",
                params![values.provider, values.model, values.reasoning_level, values.service_tier, now_iso, id],
            )?;
            audit(database, user_id, "agent_profile_updated", id, now)?;
        }
        Ok(())
    })
}

#[cfg(unix)]
pub(crate) fn executable(path: &std::path::Path) -> bool {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let Ok(path_bytes) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
        && unsafe { libc::access(path_bytes.as_ptr(), libc::X_OK) == 0 }
}

#[cfg(not(unix))]
pub(crate) fn executable(path: &std::path::Path) -> bool {
    path.is_file()
}

#[cfg(unix)]
pub(crate) fn home_directory() -> Option<std::path::PathBuf> {
    use std::{ffi::CStr, os::unix::ffi::OsStringExt};
    if let Some(home) = std::env::var_os("HOME") {
        return Some(home.into());
    }
    let mut record = unsafe { std::mem::zeroed::<libc::passwd>() };
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0_u8; 16 * 1024];
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut record,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || record.pw_dir.is_null() {
        return None;
    }
    let path = unsafe { CStr::from_ptr(record.pw_dir) };
    Some(std::ffi::OsString::from_vec(path.to_bytes().to_vec()).into())
}

#[cfg(not(unix))]
pub(crate) fn home_directory() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE").map(Into::into)
}

pub fn provider_installed(provider: &str) -> bool {
    let (binary, variable, home_paths): (&str, &str, &[&str]) = match provider {
        "claude-code" => (
            "claude",
            "SUPLEX_CLAUDE_COMMAND",
            &[".local/bin/claude", ".claude/local/claude"],
        ),
        "codex" => (
            "codex",
            "SUPLEX_CODEX_COMMAND",
            &[".local/bin/codex", ".codex/bin/codex"],
        ),
        "devin" => (
            "devin",
            "SUPLEX_DEVIN_COMMAND",
            &[".local/bin/devin", ".devin/bin/devin"],
        ),
        _ => return false,
    };
    provider_installed_with(
        binary,
        std::env::var_os(variable),
        std::env::var_os("PATH"),
        home_paths,
        home_directory(),
    )
}

fn provider_installed_with(
    binary: &str,
    configured: Option<std::ffi::OsString>,
    search_path: Option<std::ffi::OsString>,
    home_paths: &[&str],
    home: Option<std::path::PathBuf>,
) -> bool {
    if let Some(configured) = configured {
        let path = std::path::PathBuf::from(configured);
        return path.is_absolute() && executable(&path);
    }
    if std::env::split_paths(&search_path.unwrap_or_default())
        .filter(|directory| directory.is_absolute())
        .any(|directory| executable(&directory.join(binary)))
    {
        return true;
    }
    home.is_some_and(|home| {
        home_paths
            .iter()
            .any(|relative| executable(&home.join(relative)))
    })
}

use crate::projects::ProjectProviderPolicy;
use crate::tasks::control::TaskProfile;
pub(crate) fn allowed_profile(
    policy: Option<&ProjectProviderPolicy>,
    profile: &TaskProfile,
) -> bool {
    let Some(policy) = policy else {
        return true;
    };
    match profile.provider_instance_id().filter(|id| !id.is_empty()) {
        Some(instance) => policy.allowed_instance_ids.iter().any(|id| id == instance),
        None => policy
            .allowed_providers
            .iter()
            .any(|allowed| allowed == &profile.provider),
    }
}

pub(crate) fn read_profile(
    database: &SuplexDatabase,
    id: &str,
    role: &str,
) -> DatabaseResult<Option<TaskProfile>> {
    let profile = database.connection().query_row(
            "SELECT p.id, p.provider, p.model, p.reasoning_level, p.service_tier, p.provider_instance_id, i.home_directory FROM suplex_profiles p LEFT JOIN suplex_provider_instances i ON i.id = p.provider_instance_id WHERE p.id = ?1 AND p.role = ?2 AND p.archived_at IS NULL",
            params![id, role],
            |row| Ok(TaskProfile {
                profile_id: row.get(0)?,
                provider: row.get(1)?,
                model: row.get(2)?,
                reasoning_level: row.get(3)?,
                service_tier: row.get(4)?,
                provider_instance_id: Some(row.get(5)?),
                instance_home_directory: Some(row.get(6)?),
            }),
        ).optional()?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::{identity::auth, platform::database::OpenMode};

    #[test]
    fn provider_policy_selects_system_and_dedicated_logins_independently() {
        let system: TaskProfile = serde_json::from_value(serde_json::json!({
            "profileId":"system", "provider":"claude-code", "model":"haiku",
            "reasoningLevel":"medium", "serviceTier":"default", "providerInstanceId":null
        }))
        .unwrap();
        let dedicated: TaskProfile = serde_json::from_value(serde_json::json!({
            "profileId":"dedicated", "provider":"claude-code", "model":"haiku",
            "reasoningLevel":"medium", "serviceTier":"default", "providerInstanceId":"instance_a"
        }))
        .unwrap();
        let providers = ProjectProviderPolicy {
            allowed_providers: vec![crate::tasks::control::HarnessKind::ClaudeCode],
            allowed_instance_ids: vec![],
        };
        let instances = ProjectProviderPolicy {
            allowed_providers: vec![],
            allowed_instance_ids: vec!["instance_a".into()],
        };
        assert!(allowed_profile(Some(&providers), &system));
        assert!(!allowed_profile(Some(&providers), &dedicated));
        assert!(!allowed_profile(Some(&instances), &system));
        assert!(allowed_profile(Some(&instances), &dedicated));
    }

    #[cfg(unix)]
    #[test]
    fn executable_resolution_matches_override_path_and_home_precedence() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "suplex-profile-bin-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let bin = root.join("bin");
        let home_bin = root.join("home/.local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&home_bin).unwrap();
        let on_path = bin.join("codex");
        let at_home = home_bin.join("codex");
        std::fs::write(&on_path, b"#!/bin/sh\n").unwrap();
        std::fs::write(&at_home, b"#!/bin/sh\n").unwrap();
        let mut permissions = std::fs::metadata(&on_path).unwrap().permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(&on_path, permissions).unwrap();
        let search = Some(bin.as_os_str().to_owned());
        let home = Some(root.join("home"));
        let installed = |configured, path, home| {
            provider_installed_with("codex", configured, path, &[".local/bin/codex"], home)
        };
        assert!(!installed(
            Some("relative/codex".into()),
            search.clone(),
            home.clone()
        ));
        assert!(!installed(
            Some(on_path.as_os_str().to_owned()),
            search.clone(),
            home.clone()
        ));
        assert!(!installed(None, search.clone(), None));
        assert!(!installed(None, Some("relative/bin".into()), home.clone()));
        permissions = std::fs::metadata(&at_home).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&at_home, permissions).unwrap();
        assert!(installed(None, search.clone(), home));
        permissions = std::fs::metadata(&on_path).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&on_path, permissions).unwrap();
        assert!(installed(None, search, None));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn deletion_prunes_valid_policy_references_and_keeps_invalid_policies() {
        let policy = serde_json::json!({
            "workflowIds": ["workflow_native_standard"],
            "defaultWorkflowId": "workflow_native_standard",
            "rootProfileIds": ["removed"],
            "workerProfileIds": ["worker", "removed"],
            "advisorProfileIds": { "reviewer": ["removed", "worker"] }
        })
        .to_string();
        let pruned = pruned_policy(&policy, "removed", "root", "worker")
            .unwrap()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&pruned).unwrap();
        assert_eq!(value["rootProfileIds"], serde_json::json!(["root"]));
        assert_eq!(value["workerProfileIds"], serde_json::json!(["worker"]));
        assert_eq!(
            value["advisorProfileIds"]["reviewer"],
            serde_json::json!(["worker"])
        );
        assert_eq!(value["deliveryTarget"], "pull_request_draft");
        assert!(
            pruned_policy(&policy, "absent", "root", "worker")
                .unwrap()
                .is_none()
        );
        assert!(pruned_policy("{bad json", "removed", "root", "worker").is_err());
    }

    #[test]
    fn default_selection_only_changes_untouched_fresh_install_profiles() {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(10_000);
        let path = std::env::temp_dir().join(format!(
            "suplex-profile-defaults-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = auth::development_sign_in(&mut database, now).unwrap();
        let seeded = get(&database, "profile_native_root").unwrap();
        choose_defaults(&mut database, &admin.user.id, |_| false, now).unwrap();
        assert_eq!(
            get(&database, "profile_native_root").unwrap().model,
            seeded.model
        );
        choose_defaults(
            &mut database,
            &admin.user.id,
            |provider| provider == "codex",
            now,
        )
        .unwrap();
        assert_eq!(
            get(&database, "profile_native_root").unwrap().model,
            "gpt-6-astra"
        );
        assert_eq!(
            get(&database, "profile_native_worker").unwrap().model,
            "gpt-6-sol"
        );
        database.connection().execute("UPDATE suplex_profiles SET model = 'custom/model' WHERE id = 'profile_native_root'", []).unwrap();
        choose_defaults(
            &mut database,
            &admin.user.id,
            |provider| provider == "claude-code",
            now,
        )
        .unwrap();
        assert_eq!(
            get(&database, "profile_native_root").unwrap().model,
            "custom/model"
        );
        let audit_count: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'agent_profile_updated'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 2);
        drop(database);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn profile_commands_keep_role_visibility_references_and_audit_atomic() {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-profiles-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = auth::development_sign_in(&mut database, now).unwrap();
        let input = ProfileInput {
            name: "New Worker".to_owned(),
            role: "worker".to_owned(),
            avatar_seed: "0123456789abcdef0123456789abcdef".to_owned(),
            provider: "codex".to_owned(),
            model: "gpt-6-sol".to_owned(),
            reasoning_level: "medium".to_owned(),
            service_tier: "priority".to_owned(),
            provider_instance_id: None,
        };
        let created = create(&mut database, &admin.user.id, &input, now).unwrap();
        assert!(created.id.starts_with("profile_"));
        let ordered = list(&database, &admin.user.id, false).unwrap();
        assert_eq!(
            ordered
                .iter()
                .map(|profile| profile.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "profile_native_root",
                "profile_native_independent",
                "profile_native_worker",
                created.id.as_str()
            ]
        );
        assert!(
            list(&database, &admin.user.id, false)
                .unwrap()
                .iter()
                .any(|profile| profile.id == created.id)
        );
        let duplicate = duplicate(&mut database, &admin.user.id, &created.id, now).unwrap();
        assert_eq!(duplicate.name, "New Worker (copy)");
        assert_ne!(duplicate.avatar_seed, created.avatar_seed);
        delete(&mut database, &admin.user.id, &duplicate.id, now).unwrap();
        assert!(
            !list(&database, &admin.user.id, true)
                .unwrap()
                .iter()
                .any(|profile| profile.id == duplicate.id)
        );
        let archived = update(
            &mut database,
            &admin.user.id,
            &created.id,
            ProfilePatch {
                archived: Some(true),
                ..Default::default()
            },
            now,
        )
        .unwrap();
        assert!(archived.archived_at.is_some());
        assert!(
            !list(&database, &admin.user.id, false)
                .unwrap()
                .iter()
                .any(|profile| profile.id == created.id)
        );
        assert!(
            list(&database, &admin.user.id, true)
                .unwrap()
                .iter()
                .any(|profile| profile.id == created.id)
        );
        let conflict = create(&mut database, &admin.user.id, &input, now).unwrap_err();
        assert_eq!(
            conflict
                .downcast_ref::<ProfileFailure>()
                .unwrap()
                .status_code,
            409
        );
        let audit_count: i64 = database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action LIKE 'agent_profile_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 4);
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('profile_member', 'Member', 'user_v1_profile_member', 'member', 'active', ?1, ?1, 1)",
            [rfc3339_millis(now)],
        ).unwrap();
        assert!(!list(&database, "profile_member", false).unwrap().is_empty());
        let forbidden = create(&mut database, "profile_member", &input, now).unwrap_err();
        assert_eq!(
            forbidden.downcast_ref::<IdentityError>().unwrap().status(),
            403
        );
        let patch: ProfilePatch =
            serde_json::from_value(serde_json::json!({"providerInstanceId": null})).unwrap();
        assert_eq!(patch.provider_instance_id, Some(None));
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, created_at) VALUES ('profile_test_company', 'Profile test', ?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('profile_test_project', 'profile_test_company', 'Profile test', '/tmp/profile-repo', '/tmp/profile-worktrees', 'main', '', '', 'profile_native_root', 'profile_native_worker', '{broken', ?1, ?1)",
            [rfc3339_millis(now)],
        ).unwrap();
        assert!(delete(&mut database, &admin.user.id, &created.id, now).is_err());
        assert!(
            get(&database, &created.id).is_ok(),
            "bad stored JSON must roll back deletion"
        );
        let policy = serde_json::json!({
            "workflowIds": ["workflow_native_standard"],
            "defaultWorkflowId": "workflow_native_standard",
            "rootProfileIds": ["profile_native_root", created.id],
            "workerProfileIds": ["profile_native_worker"],
        });
        database.connection().execute(
            "UPDATE suplex_projects SET agent_task_policy_json = ?1 WHERE id = 'profile_test_project'",
            [policy.to_string()],
        ).unwrap();
        delete(&mut database, &admin.user.id, &created.id, now).unwrap();
        assert!(find(&database, &created.id).unwrap().is_none());
        let stored: String = database.connection().query_row(
            "SELECT agent_task_policy_json FROM suplex_projects WHERE id = 'profile_test_project'",
            [],
            |row| row.get(0),
        ).unwrap();
        let stored: serde_json::Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(
            stored["rootProfileIds"],
            serde_json::json!(["profile_native_root"])
        );
        assert_eq!(
            stored["advisorProfileIds"]["reviewer"],
            serde_json::json!([])
        );
        drop(database);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
