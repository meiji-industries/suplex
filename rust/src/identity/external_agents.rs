//! External agents: administration, pairing, credentials, and OAuth-provisioned identities.

use crate::identity::IdentityError;
use crate::shared::hash::sha256_hex;
use crate::shared::ids::{random_hex, random_hex_id, random_secret};
use crate::shared::time::rfc3339_millis;
use std::error::Error;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, Row, params, params_from_iter};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::platform::database::{DatabaseResult, SuplexDatabase};

use super::{
    auth::{self, js_trim},
    companies,
};

const PAIRING_TTL_MINUTES: i64 = 10;

fn not_found(code: &'static str) -> Box<dyn Error> {
    IdentityError::external_agent("Not found", 404, code).into()
}

fn pairing_failure() -> Box<dyn Error> {
    IdentityError::external_agent("Pairing failed", 401, "pairing_invalid").into()
}

pub fn authentication_failure() -> Box<dyn Error> {
    IdentityError::external_agent("Authentication failed", 401, "credential_invalid").into()
}

fn invalid_configuration(message: &str, status_code: u16, code: &'static str) -> Box<dyn Error> {
    IdentityError::external_agent(message, status_code, code).into()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub agent_id: String,
    pub company_id: String,
    pub profile_id: Option<String>,
    pub project_ids: Vec<String>,
    pub cursor_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminAgent {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub avatar_seed: String,
    pub company_id: String,
    pub client_profile_id: Option<String>,
    pub status: String,
    pub project_ids: Vec<String>,
    pub pairing_expires_at: Option<String>,
    pub paired_at: Option<String>,
    pub credential_created_at: Option<String>,
    pub connection_kind: String,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAgent {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub avatar_seed: String,
    pub company_id: String,
    pub profile_id: Option<String>,
    pub status: String,
    pub project_ids: Vec<String>,
    pub paired_at: Option<String>,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issued {
    pub agent: AdminAgent,
    pub pairing_code: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub pairing_code: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Exchanged {
    pub agent: PublicAgent,
    pub credential: String,
}

pub struct CreateInput<'a> {
    pub name: &'a str,
    pub company_id: &'a str,
    pub project_ids: &'a [String],
    pub avatar_seed: Option<&'a str>,
}

fn secret_shape(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 43
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

fn valid_id(value: &str) -> bool {
    (1..=128).contains(&value.encode_utf16().count())
}

fn valid_profile_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    value.encode_utf16().count() <= 128
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn sorted_unique(ids: &[String]) -> Vec<String> {
    let mut ids = ids.to_vec();
    ids.sort();
    ids.dedup();
    ids
}

fn is_constraint(error: &(dyn Error + 'static)) -> bool {
    matches!(
        error.downcast_ref::<rusqlite::Error>(),
        Some(rusqlite::Error::SqliteFailure(failure, _)) if failure.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

pub(crate) fn audit(
    database: &SuplexDatabase,
    actor: (Option<&str>, Option<&str>),
    action: &str,
    company_id: &str,
    metadata: Map<String, Value>,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    database.connection().execute(
        "INSERT INTO suplex_audit_events (id, actor_user_id, actor_agent_id, action, target_user_id, company_id, metadata_json, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)",
        params![random_hex_id("audit")?, actor.0, actor.1, action, company_id, Value::Object(metadata).to_string(), rfc3339_millis(now)],
    )?;
    Ok(())
}

fn metadata(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), json!(value)))
        .collect()
}

/// Admin authority is the live user row; a missing user and a member differ.
pub(crate) fn require_admin(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<()> {
    match auth::public_user(database, user_id)? {
        Some(user) if user.status == "active" && user.role == "admin" => Ok(()),
        Some(user) if user.status == "active" => Err(not_found("not_found")),
        _ => Err(IdentityError::external_agent(
            "Authentication required",
            401,
            "authentication_required",
        )
        .into()),
    }
}

fn matching_projects(
    database: &SuplexDatabase,
    company_id: &str,
    project_ids: &[String],
) -> DatabaseResult<usize> {
    let placeholders = vec!["?"; project_ids.len()].join(",");
    let mut statement = database.connection().prepare(&format!(
        "SELECT COUNT(*) FROM suplex_projects WHERE company_id = ? AND id IN ({placeholders})"
    ))?;
    let values = std::iter::once(company_id).chain(project_ids.iter().map(String::as_str));
    Ok(statement.query_row(params_from_iter(values), |row| row.get::<_, i64>(0))? as usize)
}

fn grants(database: &SuplexDatabase, agent_id: &str) -> DatabaseResult<Vec<String>> {
    let mut statement = database.connection().prepare(
        "SELECT project_id FROM suplex_external_agent_project_grants WHERE agent_id = ?1 ORDER BY project_id",
    )?;
    Ok(statement
        .query_map([agent_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?)
}

fn insert_grants(
    database: &SuplexDatabase,
    agent_id: &str,
    company_id: &str,
    project_ids: &[String],
    now: &str,
) -> DatabaseResult<()> {
    for project_id in project_ids {
        database.connection().execute(
            "INSERT INTO suplex_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![agent_id, company_id, project_id, now],
        )?;
    }
    Ok(())
}

fn insert_pairing(
    database: &SuplexDatabase,
    agent_id: &str,
    code: &str,
    purpose: &str,
    expires_at: &str,
    now: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "INSERT INTO suplex_external_agent_pairing_codes (id, agent_id, code_hash, purpose, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![random_hex_id("pairing")?, agent_id, sha256_hex(code), purpose, expires_at, now],
    )?;
    Ok(())
}

pub fn create(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    input: CreateInput<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<Issued> {
    require_admin(database, actor_user_id)?;
    let name = js_trim(input.name);
    let project_ids = sorted_unique(input.project_ids);
    if name.is_empty()
        || name.encode_utf16().count() > 80
        || !valid_id(input.company_id)
        || project_ids.is_empty()
        || project_ids.iter().any(|id| !valid_id(id))
    {
        return Err(invalid_configuration(
            "External agent configuration is invalid",
            400,
            "configuration_invalid",
        ));
    }
    let raw_code = random_secret("fhp")?;
    let now_iso = rfc3339_millis(now);
    let expires_at = rfc3339_millis(now + Duration::minutes(PAIRING_TTL_MINUTES));
    let agent_id = random_hex_id("agent")?;
    let avatar_seed = match input
        .avatar_seed
        .map(js_trim)
        .filter(|seed| !seed.is_empty())
    {
        Some(seed) => seed.to_owned(),
        None => random_hex(16)?,
    };
    if avatar_seed.encode_utf16().count() > 128 {
        return Err(invalid_configuration(
            "External agent configuration is invalid",
            400,
            "configuration_invalid",
        ));
    }
    let company_id = input.company_id;
    let result = database.transaction(false, |database| {
        let company: Option<String> = database
            .connection()
            .query_row(
                "SELECT id FROM suplex_companies WHERE id = ?1",
                [company_id],
                |row| row.get(0),
            )
            .optional()?;
        if company.is_none() || matching_projects(database, company_id, &project_ids)? != project_ids.len() {
            return Err(not_found("scope_not_found"));
        }
        let taken: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_agents WHERE name = ?1)",
            [name],
            |row| row.get(0),
        )?;
        if taken {
            return Err(invalid_configuration(
                "An agent with this name already exists",
                409,
                "configuration_conflict",
            ));
        }
        database.connection().execute(
            "INSERT INTO suplex_agents (id, kind, name, avatar_seed, created_at, updated_at) VALUES (?1, 'external', ?2, ?3, ?4, ?4)",
            params![agent_id, name, avatar_seed, now_iso],
        )?;
        database.connection().execute(
            "INSERT INTO suplex_external_agents (id, company_id, status, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, ?3)",
            params![agent_id, company_id, now_iso],
        )?;
        insert_grants(database, &agent_id, company_id, &project_ids, &now_iso)?;
        insert_pairing(database, &agent_id, &raw_code, "initial", &expires_at, &now_iso)?;
        let actor = (Some(actor_user_id), None);
        audit(database, actor, "external_agent_created", company_id, metadata(&[("agentId", &agent_id)]), now)?;
        audit(
            database,
            actor,
            "external_agent_pairing_issued",
            company_id,
            metadata(&[("agentId", &agent_id), ("purpose", "initial")]),
            now,
        )?;
        Ok(())
    });
    if let Err(error) = result {
        if matches!(
            error.downcast_ref(),
            Some(IdentityError::ExternalAgent { .. })
        ) || !is_constraint(error.as_ref())
        {
            return Err(error);
        }
        return Err(invalid_configuration(
            "External agent configuration is invalid",
            409,
            "configuration_conflict",
        ));
    }
    Ok(Issued {
        agent: admin_agent(database, &agent_id)?,
        pairing_code: raw_code,
        expires_at,
    })
}

const ADMIN_COLUMNS: &str = "SELECT e.id, ag.name, ag.avatar_seed, e.company_id, e.client_profile_id, e.status, \
    (SELECT p.expires_at FROM suplex_external_agent_pairing_codes p WHERE p.agent_id = e.id AND p.consumed_at IS NULL AND p.replaced_at IS NULL ORDER BY p.created_at DESC LIMIT 1) AS pairing_expires_at, \
    e.paired_at, \
    (SELECT c.created_at FROM suplex_external_agent_credentials c WHERE c.agent_id = e.id AND c.revoked_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS credential_created_at, \
    CASE WHEN EXISTS (SELECT 1 FROM suplex_oauth_grants og WHERE og.agent_id = e.id) THEN 'oauth' ELSE 'credential' END AS connection_kind, \
    e.last_used_at, e.revoked_at, e.created_at, e.updated_at \
    FROM suplex_external_agents e JOIN suplex_agents ag ON ag.id = e.id";

fn admin_row(row: &Row<'_>) -> rusqlite::Result<AdminAgent> {
    Ok(AdminAgent {
        id: row.get(0)?,
        kind: "external",
        name: row.get(1)?,
        avatar_seed: row.get(2)?,
        company_id: row.get(3)?,
        client_profile_id: row.get(4)?,
        status: row.get(5)?,
        project_ids: Vec::new(),
        pairing_expires_at: row.get(6)?,
        paired_at: row.get(7)?,
        credential_created_at: row.get(8)?,
        connection_kind: row.get(9)?,
        last_used_at: row.get(10)?,
        revoked_at: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

pub fn list(
    database: &SuplexDatabase,
    actor_user_id: &str,
    company_id: Option<&str>,
) -> DatabaseResult<Vec<AdminAgent>> {
    require_admin(database, actor_user_id)?;
    if let Some(company_id) = company_id.filter(|id| !id.is_empty()) {
        companies::require_company_access(database, actor_user_id, company_id)?;
    }
    let company_id = company_id.filter(|id| !id.is_empty());
    let condition = if company_id.is_some() {
        " WHERE e.company_id = ?1"
    } else {
        ""
    };
    let mut statement = database.connection().prepare(&format!(
        "{ADMIN_COLUMNS}{condition} ORDER BY e.created_at DESC, e.id"
    ))?;
    let mut agents = match company_id {
        Some(company_id) => statement
            .query_map([company_id], admin_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        None => statement
            .query_map([], admin_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };
    for agent in &mut agents {
        agent.project_ids = grants(database, &agent.id)?;
    }
    Ok(agents)
}

pub fn admin_agent(database: &SuplexDatabase, agent_id: &str) -> DatabaseResult<AdminAgent> {
    let mut agent = database
        .connection()
        .query_row(
            &format!("{ADMIN_COLUMNS} WHERE e.id = ?1"),
            [agent_id],
            admin_row,
        )
        .optional()?
        .ok_or_else(|| not_found("agent_not_found"))?;
    agent.project_ids = grants(database, agent_id)?;
    Ok(agent)
}

pub fn public_agent(database: &SuplexDatabase, agent_id: &str) -> DatabaseResult<PublicAgent> {
    let agent = admin_agent(database, agent_id)?;
    Ok(PublicAgent {
        id: agent.id,
        kind: "external",
        name: agent.name,
        avatar_seed: agent.avatar_seed,
        company_id: agent.company_id,
        profile_id: agent.client_profile_id,
        status: agent.status,
        project_ids: agent.project_ids,
        paired_at: agent.paired_at,
        last_used_at: agent.last_used_at,
        revoked_at: agent.revoked_at,
        created_at: agent.created_at,
        updated_at: agent.updated_at,
    })
}

fn agent_state(
    database: &SuplexDatabase,
    agent_id: &str,
) -> DatabaseResult<Option<(String, String)>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT company_id, status FROM suplex_external_agents WHERE id = ?1",
            [agent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub fn replace_projects(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    agent_id: &str,
    project_ids: &[String],
    now: DateTime<Utc>,
) -> DatabaseResult<AdminAgent> {
    require_admin(database, actor_user_id)?;
    if !valid_id(agent_id) {
        return Err(not_found("agent_not_found"));
    }
    let unique = sorted_unique(project_ids);
    if unique.iter().any(|id| !valid_id(id)) {
        return Err(invalid_configuration(
            "Project list is invalid",
            400,
            "configuration_invalid",
        ));
    }
    let now_iso = rfc3339_millis(now);
    database.transaction(false, |database| {
        let Some((company_id, status)) = agent_state(database, agent_id)? else {
            return Err(not_found("agent_not_found"));
        };
        if status == "revoked" {
            return Err(not_found("agent_not_found"));
        }
        if !unique.is_empty() && matching_projects(database, &company_id, &unique)? != unique.len()
        {
            return Err(not_found("scope_not_found"));
        }
        let existing = {
            let mut statement = database.connection().prepare(
                "SELECT project_id FROM suplex_external_agent_project_grants WHERE agent_id = ?1",
            )?;
            statement
                .query_map([agent_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let added = unique
            .iter()
            .filter(|id| !existing.contains(id))
            .cloned()
            .collect::<Vec<_>>();
        let removed = existing
            .iter()
            .filter(|id| !unique.contains(id))
            .cloned()
            .collect::<Vec<_>>();
        database.connection().execute(
            "DELETE FROM suplex_external_agent_project_grants WHERE agent_id = ?1",
            [agent_id],
        )?;
        insert_grants(database, agent_id, &company_id, &unique, &now_iso)?;
        database.connection().execute(
            "UPDATE suplex_external_agents SET updated_at = ?1 WHERE id = ?2",
            params![now_iso, agent_id],
        )?;
        audit(
            database,
            (Some(actor_user_id), None),
            "external_agent_scope_updated",
            &company_id,
            metadata(&[
                ("agentId", agent_id),
                ("addedProjects", &json!(added).to_string()),
                ("removedProjects", &json!(removed).to_string()),
            ]),
            now,
        )
    })?;
    admin_agent(database, agent_id)
}

fn issue_pairing(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    agent_id: &str,
    purpose: &str,
    required_status: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<PairingCode> {
    require_admin(database, actor_user_id)?;
    if !valid_id(agent_id) {
        return Err(not_found("agent_not_found"));
    }
    let raw_code = random_secret("fhp")?;
    let now_iso = rfc3339_millis(now);
    let expires_at = rfc3339_millis(now + Duration::minutes(PAIRING_TTL_MINUTES));
    database.transaction(false, |database| {
        let company_id = match agent_state(database, agent_id)? {
            Some((company_id, status)) if status == required_status => company_id,
            _ => return Err(not_found("agent_not_found")),
        };
        database.connection().execute(
            "UPDATE suplex_external_agent_pairing_codes SET replaced_at = ?1 WHERE agent_id = ?2 AND consumed_at IS NULL AND replaced_at IS NULL",
            params![now_iso, agent_id],
        )?;
        insert_pairing(database, agent_id, &raw_code, purpose, &expires_at, &now_iso)?;
        audit(
            database,
            (Some(actor_user_id), None),
            "external_agent_pairing_issued",
            &company_id,
            metadata(&[("agentId", agent_id), ("purpose", purpose)]),
            now,
        )
    })?;
    Ok(PairingCode {
        pairing_code: raw_code,
        expires_at,
    })
}

pub fn issue_initial_pairing(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    agent_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<PairingCode> {
    issue_pairing(database, actor_user_id, agent_id, "initial", "pending", now)
}

pub fn rotate(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    agent_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<PairingCode> {
    issue_pairing(database, actor_user_id, agent_id, "rotation", "paired", now)
}

pub fn exchange(
    database: &mut SuplexDatabase,
    pairing_code: &str,
    profile_id: Option<&str>,
    now: DateTime<Utc>,
) -> DatabaseResult<Exchanged> {
    if !secret_shape(pairing_code, "fhp_") {
        return Err(pairing_failure());
    }
    let profile_id = match profile_id.map(js_trim) {
        Some(profile) if !valid_profile_id(profile) => return Err(pairing_failure()),
        profile => profile.map(str::to_owned),
    };
    let raw_credential = random_secret("fha")?;
    let now_iso = rfc3339_millis(now);
    let result = database.transaction(false, |database| {
        let pairing = database
            .connection()
            .query_row(
                "SELECT id, agent_id, purpose, expires_at, consumed_at, replaced_at FROM suplex_external_agent_pairing_codes WHERE code_hash = ?1",
                [sha256_hex(pairing_code)],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?)),
            )
            .optional()?;
        let Some((pairing_id, agent_id, purpose, expires_at, consumed_at, replaced_at)) = pairing else {
            return Err(pairing_failure());
        };
        // `Date.parse` of an unparsable value is NaN, which is never expired.
        let expired = DateTime::parse_from_rfc3339(&expires_at).is_ok_and(|expires| expires <= now);
        if consumed_at.is_some() || replaced_at.is_some() || expired {
            return Err(pairing_failure());
        }
        let Some((company_id, status)) = agent_state(database, &agent_id)? else {
            return Err(pairing_failure());
        };
        if status == "revoked" || (purpose == "rotation" && status != "paired") {
            return Err(pairing_failure());
        }
        if database.connection().execute(
            "UPDATE suplex_external_agent_pairing_codes SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL AND replaced_at IS NULL",
            params![now_iso, pairing_id],
        )? != 1
        {
            return Err(pairing_failure());
        }
        if purpose == "rotation" {
            database.connection().execute(
                "UPDATE suplex_external_agent_credentials SET revoked_at = ?1 WHERE agent_id = ?2 AND revoked_at IS NULL",
                params![now_iso, agent_id],
            )?;
        }
        database.connection().execute(
            "INSERT INTO suplex_external_agent_credentials (id, agent_id, credential_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![random_hex_id("agent_credential")?, agent_id, sha256_hex(&raw_credential), now_iso],
        )?;
        database.connection().execute(
            "UPDATE suplex_external_agents SET client_profile_id = ?1, status = 'paired', paired_at = COALESCE(paired_at, ?2), revoked_at = NULL, updated_at = ?2 WHERE id = ?3",
            params![profile_id, now_iso, agent_id],
        )?;
        let action = if purpose == "rotation" { "external_agent_rotated" } else { "external_agent_paired" };
        let details = profile_id.as_deref().map(|profile| metadata(&[("profileId", profile)])).unwrap_or_default();
        audit(database, (None, Some(&agent_id)), action, &company_id, details, now)?;
        Ok(agent_id)
    });
    let agent_id = match result {
        Ok(agent_id) => agent_id,
        Err(error)
            if matches!(
                error.downcast_ref(),
                Some(IdentityError::ExternalAgent { .. })
            ) =>
        {
            return Err(error);
        }
        Err(_) => return Err(pairing_failure()),
    };
    Ok(Exchanged {
        agent: public_agent(database, &agent_id)?,
        credential: raw_credential,
    })
}

pub fn authenticate(
    database: &mut SuplexDatabase,
    raw_credential: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Principal> {
    if !secret_shape(raw_credential, "fha_") {
        return Err(authentication_failure());
    }
    let now_iso = rfc3339_millis(now);
    database.transaction(false, |database| {
        let row = database
            .connection()
            .query_row(
                "SELECT c.id, c.credential_hash, a.id, a.company_id, a.client_profile_id FROM suplex_external_agent_credentials c JOIN suplex_external_agents a ON a.id = c.agent_id WHERE c.credential_hash = ?1 AND c.revoked_at IS NULL AND a.status = 'paired' AND a.revoked_at IS NULL",
                [sha256_hex(raw_credential)],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?)),
            )
            .optional()?;
        let Some((credential_id, credential_hash, agent_id, company_id, profile_id)) = row else {
            return Err(authentication_failure());
        };
        let project_ids = grants(database, &agent_id)?;
        database.connection().execute(
            "UPDATE suplex_external_agent_credentials SET last_used_at = ?1 WHERE id = ?2",
            params![now_iso, credential_id],
        )?;
        database.connection().execute(
            "UPDATE suplex_external_agents SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now_iso, agent_id],
        )?;
        Ok(Principal {
            agent_id,
            company_id,
            profile_id,
            project_ids,
            cursor_key: credential_hash,
        })
    })
}

pub struct OAuthAgentInput<'a> {
    pub actor_user_id: &'a str,
    pub client_id: &'a str,
    pub client_name: &'a str,
    pub company_id: &'a str,
    pub project_ids: &'a [String],
    pub cursor_key: &'a str,
}

/// Runs inside the caller's OAuth approval transaction.
pub fn provision_oauth_agent(
    database: &SuplexDatabase,
    input: OAuthAgentInput<'_>,
    now: DateTime<Utc>,
) -> DatabaseResult<Principal> {
    require_admin(database, input.actor_user_id)?;
    companies::require_company_access(database, input.actor_user_id, input.company_id)?;
    let project_ids = sorted_unique(input.project_ids);
    if project_ids.is_empty() || project_ids.iter().any(|id| !valid_id(id)) {
        return Err(invalid_configuration(
            "Select at least one project",
            400,
            "configuration_invalid",
        ));
    }
    if matching_projects(database, input.company_id, &project_ids)? != project_ids.len() {
        return Err(not_found("scope_not_found"));
    }
    let now_iso = rfc3339_millis(now);
    let agent_id = random_hex_id("agent")?;
    let utf16 = |value: &str, count: usize| {
        String::from_utf16_lossy(&value.encode_utf16().take(count).collect::<Vec<_>>())
    };
    let client_units = input.client_id.encode_utf16().collect::<Vec<_>>();
    let suffix = String::from_utf16_lossy(&client_units[client_units.len().saturating_sub(8)..]);
    let base = utf16(js_trim(input.client_name), 60);
    let base = if base.is_empty() {
        "OAuth client".to_owned()
    } else {
        base
    };
    let mut name = utf16(&format!("{base} ({suffix})"), 80);
    let mut collision = 1;
    while database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_agents WHERE name = ?1)",
        [&name],
        |row| row.get::<_, bool>(0),
    )? {
        collision += 1;
        name = utf16(&format!("{} ({suffix}-{collision})", utf16(&base, 68)), 80);
    }
    database.connection().execute(
        "INSERT INTO suplex_agents (id, kind, name, avatar_seed, created_at, updated_at) VALUES (?1, 'external', ?2, ?3, ?4, ?4)",
        params![agent_id, name, random_hex(16)?, now_iso],
    )?;
    database.connection().execute(
        "INSERT INTO suplex_external_agents (id, company_id, status, paired_at, created_at, updated_at) VALUES (?1, ?2, 'paired', ?3, ?3, ?3)",
        params![agent_id, input.company_id, now_iso],
    )?;
    insert_grants(
        database,
        &agent_id,
        input.company_id,
        &project_ids,
        &now_iso,
    )?;
    audit(
        database,
        (Some(input.actor_user_id), None),
        "external_agent_oauth_authorized",
        input.company_id,
        metadata(&[("agentId", &agent_id), ("clientId", input.client_id)]),
        now,
    )?;
    Ok(Principal {
        agent_id,
        company_id: input.company_id.to_owned(),
        profile_id: None,
        project_ids,
        cursor_key: input.cursor_key.to_owned(),
    })
}

pub fn oauth_principal(
    database: &mut SuplexDatabase,
    agent_id: &str,
    cursor_key: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Principal> {
    let now_iso = rfc3339_millis(now);
    database.transaction(false, |database| {
        let row = database
            .connection()
            .query_row(
                "SELECT company_id, client_profile_id FROM suplex_external_agents WHERE id = ?1 AND status = 'paired' AND revoked_at IS NULL",
                [agent_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((company_id, profile_id)) = row else {
            return Err(authentication_failure());
        };
        let project_ids = grants(database, agent_id)?;
        database.connection().execute(
            "UPDATE suplex_external_agents SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now_iso, agent_id],
        )?;
        Ok(Principal {
            agent_id: agent_id.to_owned(),
            company_id,
            profile_id,
            project_ids,
            cursor_key: cursor_key.to_owned(),
        })
    })
}

pub fn oauth_agent_active(database: &SuplexDatabase, agent_id: &str) -> DatabaseResult<bool> {
    Ok(database.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM suplex_external_agents WHERE id = ?1 AND status = 'paired' AND revoked_at IS NULL)",
        [agent_id],
        |row| row.get(0),
    )?)
}

pub fn revoke(
    database: &mut SuplexDatabase,
    actor_user_id: &str,
    agent_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    require_admin(database, actor_user_id)?;
    let now_iso = rfc3339_millis(now);
    database.transaction(false, |database| {
        let company_id = match agent_state(database, agent_id)? {
            Some((company_id, status)) if status != "revoked" => company_id,
            _ => return Err(not_found("agent_not_found")),
        };
        for sql in [
            "UPDATE suplex_external_agents SET status = 'revoked', revoked_at = ?1, updated_at = ?1 WHERE id = ?2",
            "UPDATE suplex_external_agent_credentials SET revoked_at = ?1 WHERE agent_id = ?2 AND revoked_at IS NULL",
            "UPDATE suplex_external_agent_pairing_codes SET replaced_at = ?1 WHERE agent_id = ?2 AND consumed_at IS NULL AND replaced_at IS NULL",
            "UPDATE suplex_oauth_grants SET revoked_at = ?1, updated_at = ?1 WHERE agent_id = ?2 AND revoked_at IS NULL",
            "UPDATE suplex_oauth_token_families SET revoked_at = ?1 WHERE grant_id IN (SELECT id FROM suplex_oauth_grants WHERE agent_id = ?2) AND revoked_at IS NULL",
            "UPDATE suplex_oauth_access_tokens SET revoked_at = ?1 WHERE family_id IN (SELECT id FROM suplex_oauth_token_families WHERE grant_id IN (SELECT id FROM suplex_oauth_grants WHERE agent_id = ?2)) AND revoked_at IS NULL",
            "UPDATE suplex_oauth_authorization_codes SET consumed_at = ?1 WHERE grant_id IN (SELECT id FROM suplex_oauth_grants WHERE agent_id = ?2) AND consumed_at IS NULL",
        ] {
            database.connection().execute(sql, params![now_iso, agent_id])?;
        }
        audit(
            database,
            (Some(actor_user_id), None),
            "external_agent_revoked",
            &company_id,
            metadata(&[("agentId", agent_id)]),
            now,
        )
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::platform::database::OpenMode;

    pub(crate) struct Fixture {
        pub database: SuplexDatabase,
        pub path: std::path::PathBuf,
        pub admin: String,
        pub member: String,
        pub company: String,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.path.display()));
            }
        }
    }

    pub(crate) fn fixture() -> Fixture {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-external-agents-{}-{}.sqlite",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = auth::development_sign_in(&mut database, now)
            .unwrap()
            .user
            .id;
        let stamp = rfc3339_millis(now);
        let connection = database.connection();
        connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member_test_1', 'Member', 'member', 'member', 'active', ?1, ?1, 1)", [&stamp]).unwrap();
        for (id, name) in [
            ("company_main", "External Company"),
            ("company_other", "Other Company"),
        ] {
            connection.execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES (?1, ?2, 'active', ?3)", params![id, name, stamp]).unwrap();
        }
        for (id, company, identity) in [
            ("project_allowed", "company_main", "meiji/allowed"),
            ("project_second", "company_main", "meiji/second"),
            ("project_other", "company_other", "meiji/other"),
        ] {
            connection.execute("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, ?4, ?5, 'main', '', '', ?6, ?6)", params![id, company, format!("/tmp/{id}"), format!("/tmp/{id}-worktrees"), identity, stamp]).unwrap();
        }
        Fixture {
            database,
            path,
            admin,
            member: "member_test_1".into(),
            company: "company_main".into(),
        }
    }

    pub(crate) fn issue(fixture: &mut Fixture, name: &str, projects: &[&str]) -> Issued {
        let projects = projects
            .iter()
            .map(|id| (*id).to_owned())
            .collect::<Vec<_>>();
        create(
            &mut fixture.database,
            &fixture.admin.clone(),
            CreateInput {
                name,
                company_id: &fixture.company.clone(),
                project_ids: &projects,
                avatar_seed: None,
            },
            Utc::now(),
        )
        .unwrap()
    }

    fn failure(error: Box<dyn Error>) -> IdentityError {
        error
            .downcast_ref::<IdentityError>()
            .cloned()
            .expect("domain failure")
    }

    fn count(database: &SuplexDatabase, sql: &str) -> i64 {
        database
            .connection()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn canonical_identity_pairs_once_persists_only_hashes_and_audits_actors() {
        let mut fixture = fixture();
        let issued = issue(&mut fixture, "External Dev", &["project_allowed"]);
        assert!(issued.pairing_code.starts_with("fhp_"));
        assert_eq!(issued.agent.status, "pending");
        let (name, status): (String, String) = fixture.database.connection().query_row(
            "SELECT ag.name, e.status FROM suplex_agents ag JOIN suplex_external_agents e ON e.id = ag.id WHERE ag.id = ?1",
            [&issued.agent.id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(
            (name.as_str(), status.as_str()),
            ("External Dev", "pending")
        );

        let paired = exchange(
            &mut fixture.database,
            &issued.pairing_code,
            Some("dev"),
            Utc::now(),
        )
        .unwrap();
        assert!(paired.credential.starts_with("fha_"));
        let principal =
            authenticate(&mut fixture.database, &paired.credential, Utc::now()).unwrap();
        assert_eq!(
            (
                principal.agent_id.as_str(),
                principal.company_id.as_str(),
                principal.profile_id.as_deref(),
                principal.project_ids.as_slice()
            ),
            (
                issued.agent.id.as_str(),
                "company_main",
                Some("dev"),
                ["project_allowed".to_owned()].as_slice()
            )
        );
        let again = failure(
            exchange(
                &mut fixture.database,
                &issued.pairing_code,
                Some("dev"),
                Utc::now(),
            )
            .unwrap_err(),
        );
        assert_eq!((again.status(), again.code()), (401, "pairing_invalid"));

        let dump: String = fixture.database.connection().query_row(
            "SELECT json_group_array(x) FROM (SELECT code_hash AS x FROM suplex_external_agent_pairing_codes UNION ALL SELECT credential_hash FROM suplex_external_agent_credentials UNION ALL SELECT metadata_json FROM suplex_audit_events)",
            [], |row| row.get(0),
        ).unwrap();
        assert!(!dump.contains("fhp_") && !dump.contains("fha_"));
        let actors = |action: &str| -> (Option<String>, Option<String>) {
            fixture.database.connection().query_row("SELECT actor_user_id, actor_agent_id FROM suplex_audit_events WHERE action = ?1", [action], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
        };
        assert_eq!(
            actors("external_agent_paired"),
            (None, Some(issued.agent.id.clone()))
        );
        assert_eq!(
            actors("external_agent_created"),
            (Some(fixture.admin.clone()), None)
        );
    }

    #[test]
    fn duplicate_names_cross_company_grants_and_non_admins_are_rejected() {
        let mut fixture = fixture();
        issue(&mut fixture, "Duplicate", &["project_allowed"]);
        let admin = fixture.admin.clone();
        let company = fixture.company.clone();
        let projects = vec!["project_allowed".to_owned()];
        let input = |name| CreateInput {
            name,
            company_id: &company,
            project_ids: &projects,
            avatar_seed: None,
        };
        let duplicate = failure(
            create(
                &mut fixture.database,
                &admin,
                input("Duplicate"),
                Utc::now(),
            )
            .unwrap_err(),
        );
        assert_eq!(
            (duplicate.status(), duplicate.to_string().as_str()),
            (409, "An agent with this name already exists")
        );
        let other = vec!["project_other".to_owned()];
        let cross = failure(
            create(
                &mut fixture.database,
                &admin,
                CreateInput {
                    name: "Cross",
                    company_id: &company,
                    project_ids: &other,
                    avatar_seed: None,
                },
                Utc::now(),
            )
            .unwrap_err(),
        );
        assert_eq!((cross.status(), cross.code()), (404, "scope_not_found"));
        assert_eq!(
            count(
                &fixture.database,
                "SELECT COUNT(*) FROM suplex_external_agents"
            ),
            1
        );
        let member = fixture.member.clone();
        assert_eq!(
            failure(
                create(&mut fixture.database, &member, input("Member"), Utc::now()).unwrap_err()
            )
            .to_string(),
            "Not found"
        );
        assert_eq!(
            failure(
                create(
                    &mut fixture.database,
                    "missing_user",
                    input("Anon"),
                    Utc::now()
                )
                .unwrap_err()
            )
            .to_string(),
            "Authentication required"
        );
        assert_eq!(
            failure(list(&fixture.database, &member, None).unwrap_err()).to_string(),
            "Not found"
        );
        assert_eq!(
            failure(
                replace_projects(&mut fixture.database, &member, "any", &projects, Utc::now())
                    .unwrap_err()
            )
            .to_string(),
            "Not found"
        );
        assert_eq!(
            failure(
                issue_initial_pairing(&mut fixture.database, &member, "any", Utc::now())
                    .unwrap_err()
            )
            .to_string(),
            "Not found"
        );
        assert_eq!(
            failure(rotate(&mut fixture.database, &member, "any", Utc::now()).unwrap_err())
                .to_string(),
            "Not found"
        );
        assert_eq!(
            failure(revoke(&mut fixture.database, &member, "any", Utc::now()).unwrap_err())
                .to_string(),
            "Not found"
        );
        let issued = issue(&mut fixture, "Constraint", &["project_allowed"]);
        let error = fixture.database.connection().execute(
            "INSERT INTO suplex_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES (?1, ?2, 'project_other', 'now')",
            params![issued.agent.id, company],
        ).unwrap_err();
        assert!(error.to_string().to_lowercase().contains("foreign key"));
    }

    #[test]
    fn list_scope_replacement_and_initial_pairing_reissue() {
        let mut fixture = fixture();
        let first = issue(&mut fixture, "Agent 1", &["project_allowed"]);
        let second = issue(
            &mut fixture,
            "Agent 2",
            &["project_second", "project_allowed"],
        );
        let admin = fixture.admin.clone();
        let all = list(&fixture.database, &admin, None).unwrap();
        assert_eq!(all.len(), 2);
        let listed = all.iter().find(|agent| agent.id == first.agent.id).unwrap();
        assert_eq!(
            (
                listed.status.as_str(),
                listed.project_ids.as_slice(),
                listed.pairing_expires_at.is_some(),
                listed.credential_created_at.is_none()
            ),
            (
                "pending",
                ["project_allowed".to_owned()].as_slice(),
                true,
                true
            )
        );
        assert_eq!(
            all.iter()
                .find(|agent| agent.id == second.agent.id)
                .unwrap()
                .project_ids,
            ["project_allowed", "project_second"]
        );
        assert_eq!(
            list(&fixture.database, &admin, Some("company_main"))
                .unwrap()
                .len(),
            2
        );

        let both = vec!["project_allowed".to_owned(), "project_second".to_owned()];
        assert_eq!(
            replace_projects(
                &mut fixture.database,
                &admin,
                &first.agent.id,
                &both,
                Utc::now()
            )
            .unwrap()
            .project_ids,
            both
        );
        assert!(
            replace_projects(
                &mut fixture.database,
                &admin,
                &first.agent.id,
                &[],
                Utc::now()
            )
            .unwrap()
            .project_ids
            .is_empty()
        );
        let other = vec!["project_other".to_owned()];
        assert_eq!(
            failure(
                replace_projects(
                    &mut fixture.database,
                    &admin,
                    &first.agent.id,
                    &other,
                    Utc::now()
                )
                .unwrap_err()
            )
            .code(),
            "scope_not_found"
        );
        assert!(
            admin_agent(&fixture.database, &first.agent.id)
                .unwrap()
                .project_ids
                .is_empty()
        );

        let reissued =
            issue_initial_pairing(&mut fixture.database, &admin, &second.agent.id, Utc::now())
                .unwrap();
        assert_ne!(reissued.pairing_code, second.pairing_code);
        assert!(
            exchange(
                &mut fixture.database,
                &second.pairing_code,
                Some("profile-reissue"),
                Utc::now()
            )
            .is_err()
        );
        let paired = exchange(
            &mut fixture.database,
            &reissued.pairing_code,
            Some("profile-reissue"),
            Utc::now(),
        )
        .unwrap();
        assert_eq!(paired.agent.status, "paired");
        assert!(
            issue_initial_pairing(&mut fixture.database, &admin, &second.agent.id, Utc::now())
                .is_err()
        );
    }

    #[test]
    fn rotation_replaces_the_credential_and_revocation_is_immediate() {
        let mut fixture = fixture();
        let admin = fixture.admin.clone();
        let first = issue(&mut fixture, "Rotate", &["project_allowed"]);
        let original = exchange(
            &mut fixture.database,
            &first.pairing_code,
            Some("profile-stable"),
            Utc::now(),
        )
        .unwrap();
        let rotation = rotate(&mut fixture.database, &admin, &first.agent.id, Utc::now()).unwrap();
        assert_eq!(
            authenticate(&mut fixture.database, &original.credential, Utc::now())
                .unwrap()
                .agent_id,
            first.agent.id
        );
        let replacement = exchange(
            &mut fixture.database,
            &rotation.pairing_code,
            Some("recreated-client"),
            Utc::now(),
        )
        .unwrap();
        assert_eq!(
            failure(
                authenticate(&mut fixture.database, &original.credential, Utc::now()).unwrap_err()
            )
            .code(),
            "credential_invalid"
        );
        assert_eq!(
            authenticate(&mut fixture.database, &replacement.credential, Utc::now())
                .unwrap()
                .agent_id,
            first.agent.id
        );
        let rotated: (Option<String>, Option<String>) = fixture.database.connection().query_row("SELECT actor_user_id, actor_agent_id FROM suplex_audit_events WHERE action = 'external_agent_rotated'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(rotated, (None, Some(first.agent.id.clone())));
        revoke(&mut fixture.database, &admin, &first.agent.id, Utc::now()).unwrap();
        assert!(authenticate(&mut fixture.database, &replacement.credential, Utc::now()).is_err());
    }

    #[test]
    fn expired_consumed_malformed_codes_share_one_failure_and_profiles_repeat() {
        let mut fixture = fixture();
        let admin = fixture.admin.clone();
        let company = fixture.company.clone();
        let projects = vec!["project_allowed".to_owned()];
        let start = DateTime::parse_from_rfc3339("2026-08-14T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let issued = create(
            &mut fixture.database,
            &admin,
            CreateInput {
                name: "Expiring",
                company_id: &company,
                project_ids: &projects,
                avatar_seed: None,
            },
            start,
        )
        .unwrap();
        let later = start + Duration::minutes(PAIRING_TTL_MINUTES) + Duration::milliseconds(1);
        for code in [
            issued.pairing_code.as_str(),
            "not-a-code",
            "fhp_invalid0000000000000000000000000000000000",
        ] {
            let error = failure(
                exchange(&mut fixture.database, code, Some("profile-expired"), later).unwrap_err(),
            );
            assert_eq!(
                (error.status(), error.to_string().as_str(), error.code()),
                (401, "Pairing failed", "pairing_invalid")
            );
        }
        let one = issue(&mut fixture, "Profile 1", &["project_allowed"]);
        let two = issue(&mut fixture, "Profile 2", &["project_allowed"]);
        for issued in [one, two] {
            let paired = exchange(
                &mut fixture.database,
                &issued.pairing_code,
                Some("default"),
                Utc::now(),
            )
            .unwrap();
            assert_eq!(
                authenticate(&mut fixture.database, &paired.credential, Utc::now())
                    .unwrap()
                    .profile_id
                    .as_deref(),
                Some("default")
            );
        }
    }

    #[test]
    fn concurrent_exchanges_on_separate_connections_consume_one_code() {
        let mut fixture = fixture();
        let issued = issue(&mut fixture, "Concurrent", &["project_allowed"]);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let connections = (0..2)
            .map(|_| SuplexDatabase::open(&fixture.path, OpenMode::ReadWrite).unwrap())
            .collect::<Vec<_>>();
        let outcomes = connections
            .into_iter()
            .map(|mut database| {
                let code = issued.pairing_code.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    exchange(&mut database, &code, Some("profile-concurrent"), Utc::now())
                        .map_err(|error| failure(error).code())
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter_map(|outcome| outcome.as_ref().err())
                .collect::<Vec<_>>(),
            [&"pairing_invalid"]
        );
        assert_eq!(
            count(
                &fixture.database,
                "SELECT COUNT(*) FROM suplex_external_agent_credentials WHERE revoked_at IS NULL"
            ),
            1
        );
        assert_eq!(
            count(
                &fixture.database,
                "SELECT COUNT(*) FROM suplex_audit_events WHERE action = 'external_agent_paired'"
            ),
            1
        );
    }
}
