//! Hosted account rows. One function per SQL statement. Timestamps are
//! RFC 3339 UTC strings, so text comparison orders them.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::accounts::wire::{AuthProvider, HostedAccount};

pub const SCHEMA: &str = include_str!("schema.sql");

pub struct Attempt {
    pub challenge: String,
    pub installation_id: String,
    pub account_id: Option<String>,
}

pub fn insert_attempt(
    db: &Connection,
    id: &str,
    challenge: &str,
    installation_id: &str,
    now: &str,
    expires_at: &str,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO account_attempts (id, challenge, installation_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, challenge, installation_id, now, expires_at],
    )?;
    Ok(())
}

/// An attempt that has not expired.
pub fn find_attempt(db: &Connection, id: &str, now: &str) -> rusqlite::Result<Option<Attempt>> {
    db.query_row(
        "SELECT challenge, installation_id, account_id FROM account_attempts WHERE id = ?1 AND expires_at > ?2",
        params![id, now],
        |row| {
            Ok(Attempt {
                challenge: row.get(0)?,
                installation_id: row.get(1)?,
                account_id: row.get(2)?,
            })
        },
    )
    .optional()
}

/// Starts an OAuth round trip. A later start replaces the earlier state.
pub fn set_attempt_provider(
    db: &Connection,
    id: &str,
    provider: AuthProvider,
    state: &str,
    now: &str,
) -> rusqlite::Result<bool> {
    let changed = db.execute(
        "UPDATE account_attempts SET provider = ?2, provider_state = ?3 WHERE id = ?1 AND account_id IS NULL AND expires_at > ?4",
        params![id, provider, state, now],
    )?;
    Ok(changed == 1)
}

/// Consumes an OAuth state once, whatever the provider answers next.
pub fn find_attempt_by_state(
    db: &Connection,
    provider: AuthProvider,
    state: &str,
    now: &str,
) -> rusqlite::Result<Option<String>> {
    db.query_row(
        "UPDATE account_attempts SET provider_state = NULL WHERE provider_state = ?1 AND provider = ?2 AND account_id IS NULL AND expires_at > ?3 RETURNING id",
        params![state, provider, now],
        |row| row.get(0),
    )
    .optional()
}

pub fn complete_attempt(
    db: &Connection,
    id: &str,
    account_id: &str,
    provider: AuthProvider,
    now: &str,
) -> rusqlite::Result<bool> {
    let changed = db.execute(
        "UPDATE account_attempts SET account_id = ?2, provider = ?3, provider_state = NULL WHERE id = ?1 AND account_id IS NULL AND expires_at > ?4",
        params![id, account_id, provider, now],
    )?;
    Ok(changed == 1)
}

/// Removes a completed attempt and returns its account and installation.
pub fn delete_attempt(db: &Connection, id: &str) -> rusqlite::Result<Option<(String, String)>> {
    db.query_row(
        "DELETE FROM account_attempts WHERE id = ?1 AND account_id IS NOT NULL RETURNING account_id, installation_id",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

/// Deletes attempts, and their magic links, that expired before `cutoff`.
pub fn sweep(db: &Connection, cutoff: &str) -> rusqlite::Result<usize> {
    db.execute(
        "DELETE FROM account_attempts WHERE expires_at <= ?1",
        [cutoff],
    )
}

fn account(row: &rusqlite::Row<'_>) -> rusqlite::Result<HostedAccount> {
    Ok(HostedAccount {
        id: row.get(0)?,
        email: row.get(1)?,
        name: row.get(2)?,
    })
}

/// Inserts `id` or reuses the account with this email. `true` when inserted.
pub fn upsert_account(
    db: &Connection,
    id: &str,
    email: &str,
    name: Option<&str>,
    now: &str,
) -> rusqlite::Result<(HostedAccount, bool)> {
    let account = db.query_row(
        "INSERT INTO accounts (id, email, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, accounts.name), updated_at = excluded.updated_at RETURNING id, email, name",
        params![id, email, name, now],
        account,
    )?;
    let created = account.id == id;
    Ok((account, created))
}

pub fn find_account(db: &Connection, id: &str) -> rusqlite::Result<HostedAccount> {
    db.query_row(
        "SELECT id, email, name FROM accounts WHERE id = ?1",
        [id],
        account,
    )
}

pub fn insert_magic_link(
    db: &Connection,
    token_hash: &str,
    attempt_id: &str,
    email: &str,
    now: &str,
    expires_at: &str,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO account_magic_links (token_hash, attempt_id, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![token_hash, attempt_id, email, now, expires_at],
    )?;
    Ok(())
}

pub fn count_magic_links(db: &Connection, email: &str, since: &str) -> rusqlite::Result<i64> {
    db.query_row(
        "SELECT COUNT(*) FROM account_magic_links WHERE email = ?1 AND created_at > ?2",
        params![email, since],
        |row| row.get(0),
    )
}

/// Marks an unexpired link used once and returns its attempt and email.
pub fn consume_magic_link(
    db: &Connection,
    token_hash: &str,
    now: &str,
) -> rusqlite::Result<Option<(String, String)>> {
    db.query_row(
        "UPDATE account_magic_links SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING attempt_id, email",
        params![token_hash, now],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

pub fn delete_magic_link(db: &Connection, token_hash: &str) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM account_magic_links WHERE token_hash = ?1",
        [token_hash],
    )?;
    Ok(())
}

pub fn insert_token(
    db: &Connection,
    token_hash: &str,
    account_id: &str,
    installation_id: &str,
    now: &str,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO account_tokens (token_hash, account_id, installation_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![token_hash, account_id, installation_id, now],
    )?;
    Ok(())
}

pub fn delete_token(db: &Connection, token_hash: &str) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM account_tokens WHERE token_hash = ?1",
        [token_hash],
    )?;
    Ok(())
}

/// Queues one PostHog event for the hosted telemetry outbox.
// ponytail: account and site events share billing_telemetry_events with
// company_id = ''; give them their own outbox if the billing columns diverge.
pub fn enqueue_posthog(
    db: &Connection,
    event_name: &str,
    distinct_id: &str,
    timestamp: &str,
    properties: &Value,
) -> rusqlite::Result<()> {
    let insert_id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO billing_telemetry_events (source_event_id, event_name, distinct_id, company_id, insert_id, timestamp, properties_json) VALUES (?1, ?2, ?3, '', ?4, ?5, ?6)",
        params![
            format!("hosted:{insert_id}"),
            event_name,
            distinct_id,
            insert_id,
            timestamp,
            properties.to_string()
        ],
    )?;
    Ok(())
}
