//! Hosted billing rows. One function per SQL statement; callers hold the
//! service connection lock only for the duration of one call.

use std::{path::Path, time::Duration};

use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, Row, params};
use serde_json::{Map, Value};

const SCHEMA: &str = include_str!("schema.sql");

/// Opens (and creates) the service database with the Suplex pragmas and
/// applies the hosted schema.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let connection = open_with(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
}

/// Opens an existing service database without touching its schema.
pub fn open_existing(path: &Path) -> rusqlite::Result<Connection> {
    open_with(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
}

fn open_with(path: &Path, flags: OpenFlags) -> rusqlite::Result<Connection> {
    let connection = Connection::open_with_flags(path, flags)?;
    connection.busy_timeout(Duration::from_millis(5_000))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    )?;
    Ok(connection)
}

pub fn is_constraint_violation(error: &rusqlite::Error) -> bool {
    matches!(error, rusqlite::Error::SqliteFailure(failure, _) if failure.code == ErrorCode::ConstraintViolation)
}

fn object(raw: &str) -> Map<String, Value> {
    match serde_json::from_str(raw) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

// ---------------------------------------------------------------------------
// billing_accounts
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct AccountRow {
    pub id: String,
    pub credential_hash: String,
    pub installation_id: String,
    pub company_id: String,
    pub revenuecat_app_user_id: String,
    pub stripe_customer_id: Option<String>,
    pub subscription_hint: Option<String>,
    pub revenuecat_fingerprint: Option<String>,
    pub next_sync_at: Option<String>,
    pub sync_attempt_count: i64,
}

const ACCOUNT_COLUMNS: &str = "id, credential_hash, installation_id, company_id, revenuecat_app_user_id, stripe_customer_id, subscription_hint, revenuecat_fingerprint, next_sync_at, sync_attempt_count";

fn account(row: &Row<'_>) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        id: row.get(0)?,
        credential_hash: row.get(1)?,
        installation_id: row.get(2)?,
        company_id: row.get(3)?,
        revenuecat_app_user_id: row.get(4)?,
        stripe_customer_id: row.get(5)?,
        subscription_hint: row.get(6)?,
        revenuecat_fingerprint: row.get(7)?,
        next_sync_at: row.get(8)?,
        sync_attempt_count: row.get(9)?,
    })
}

/// The unique account columns an account is looked up by.
#[derive(Clone, Copy, Debug)]
pub enum AccountKey {
    Id,
    CredentialHash,
    RegistrationId,
    AppUserId,
    StripeCustomerId,
    SubscriptionHint,
}

pub fn find_account(
    connection: &Connection,
    key: AccountKey,
    value: &str,
) -> rusqlite::Result<Option<AccountRow>> {
    let column = match key {
        AccountKey::Id => "id",
        AccountKey::CredentialHash => "credential_hash",
        AccountKey::RegistrationId => "registration_id",
        AccountKey::AppUserId => "revenuecat_app_user_id",
        AccountKey::StripeCustomerId => "stripe_customer_id",
        AccountKey::SubscriptionHint => "subscription_hint",
    };
    connection
        .query_row(
            &format!("SELECT {ACCOUNT_COLUMNS} FROM billing_accounts WHERE {column} = ?1 LIMIT 1"),
            [value],
            account,
        )
        .optional()
}

pub struct NewAccount<'a> {
    pub id: &'a str,
    pub registration_id: &'a str,
    pub credential_hash: &'a str,
    pub installation_id: &'a str,
    pub company_id: &'a str,
    pub app_user_id: &'a str,
    pub now: &'a str,
}

pub fn insert_account(connection: &Connection, account: &NewAccount<'_>) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO billing_accounts (id, registration_id, credential_hash, installation_id, company_id, revenuecat_app_user_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            account.id,
            account.registration_id,
            account.credential_hash,
            account.installation_id,
            account.company_id,
            account.app_user_id,
            account.now
        ],
    )?;
    Ok(())
}

pub fn update_stripe_customer(
    connection: &Connection,
    account_id: &str,
    customer_id: Option<&str>,
    now: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE billing_accounts SET stripe_customer_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![customer_id, now, account_id],
    )?;
    Ok(())
}

pub fn update_subscription_hint(
    connection: &Connection,
    account_id: &str,
    subscription_id: &str,
    now: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE billing_accounts SET subscription_hint = ?1, updated_at = ?2 WHERE id = ?3",
        params![subscription_id, now, account_id],
    )?;
    Ok(())
}

pub fn update_credential_hash(
    connection: &Connection,
    account_id: &str,
    credential_hash: &str,
    now: &str,
) -> rusqlite::Result<usize> {
    connection.execute(
        "UPDATE billing_accounts SET credential_hash = ?1, updated_at = ?2 WHERE id = ?3",
        params![credential_hash, now, account_id],
    )
}

pub fn record_sync_success(
    connection: &Connection,
    account_id: &str,
    fingerprint: &str,
    now: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE billing_accounts SET revenuecat_fingerprint = ?1, next_sync_at = NULL, sync_attempt_count = 0, last_sync_error = NULL, updated_at = ?2 WHERE id = ?3",
        params![fingerprint, now, account_id],
    )?;
    Ok(())
}

/// An accepted-but-unverified import keeps a repair scheduled until a
/// subscriber read confirms the subscription is represented.
pub fn record_sync_pending(
    connection: &Connection,
    account_id: &str,
    fingerprint: &str,
    next_sync_at: &str,
    error: &str,
    now: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE billing_accounts SET revenuecat_fingerprint = ?1, next_sync_at = ?2, sync_attempt_count = sync_attempt_count + 1, last_sync_error = ?3, updated_at = ?4 WHERE id = ?5",
        params![fingerprint, next_sync_at, error, now, account_id],
    )?;
    Ok(())
}

pub fn list_accounts_due_for_sync(
    connection: &Connection,
    now: &str,
) -> rusqlite::Result<Vec<AccountRow>> {
    connection
        .prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS} FROM billing_accounts WHERE next_sync_at IS NOT NULL AND next_sync_at <= ?1"
        ))?
        .query_map([now], account)?
        .collect()
}

// ---------------------------------------------------------------------------
// billing_operations
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct OperationRow {
    pub id: String,
    pub account_id: String,
    pub kind: String,
    pub input: Map<String, Value>,
    pub input_hash: String,
    pub state: String,
    /// Mutable provider-side correlation; untyped on purpose.
    pub data: Map<String, Value>,
    pub expires_at: Option<String>,
    pub created_at: String,
}

const OPERATION_COLUMNS: &str = "id, account_id, kind, input_json, input_hash, state, provider_data_json, expires_at, created_at";

fn operation(row: &Row<'_>) -> rusqlite::Result<OperationRow> {
    Ok(OperationRow {
        id: row.get(0)?,
        account_id: row.get(1)?,
        kind: row.get(2)?,
        input: object(&row.get::<_, String>(3)?),
        input_hash: row.get(4)?,
        state: row.get(5)?,
        data: object(&row.get::<_, String>(6)?),
        expires_at: row.get(7)?,
        created_at: row.get(8)?,
    })
}

pub fn find_operation_by_key(
    connection: &Connection,
    account_id: &str,
    idempotency_key: &str,
) -> rusqlite::Result<Option<OperationRow>> {
    connection
        .query_row(
            &format!("SELECT {OPERATION_COLUMNS} FROM billing_operations WHERE account_id = ?1 AND idempotency_key = ?2"),
            [account_id, idempotency_key],
            operation,
        )
        .optional()
}

pub fn find_operation_by_id(
    connection: &Connection,
    id: &str,
) -> rusqlite::Result<Option<OperationRow>> {
    connection
        .query_row(
            &format!("SELECT {OPERATION_COLUMNS} FROM billing_operations WHERE id = ?1"),
            [id],
            operation,
        )
        .optional()
}

/// At most one checkout or seat_change row per account may be prepared or
/// provider_pending.
pub fn find_pending_mutation(
    connection: &Connection,
    account_id: &str,
) -> rusqlite::Result<Option<OperationRow>> {
    connection
        .query_row(
            &format!(
                "SELECT {OPERATION_COLUMNS} FROM billing_operations WHERE account_id = ?1 AND kind IN ('checkout', 'seat_change') AND state IN ('prepared', 'provider_pending') ORDER BY created_at ASC LIMIT 1"
            ),
            [account_id],
            operation,
        )
        .optional()
}

pub fn list_operations_for_account(
    connection: &Connection,
    account_id: &str,
) -> rusqlite::Result<Vec<OperationRow>> {
    connection
        .prepare(&format!(
            "SELECT {OPERATION_COLUMNS} FROM billing_operations WHERE account_id = ?1 ORDER BY created_at ASC"
        ))?
        .query_map([account_id], operation)?
        .collect()
}

pub struct NewOperation<'a> {
    pub id: &'a str,
    pub account_id: &'a str,
    pub idempotency_key: &'a str,
    pub kind: &'a str,
    pub input_json: &'a str,
    pub input_hash: &'a str,
    pub expires_at: Option<&'a str>,
    pub now: &'a str,
}

pub fn insert_operation(
    connection: &Connection,
    operation: &NewOperation<'_>,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO billing_operations (id, account_id, idempotency_key, kind, input_json, input_hash, state, provider_data_json, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', '{}', ?7, ?8, ?8)",
        params![
            operation.id,
            operation.account_id,
            operation.idempotency_key,
            operation.kind,
            operation.input_json,
            operation.input_hash,
            operation.expires_at,
            operation.now
        ],
    )?;
    Ok(())
}

/// One statement for both fields: a reader never sees a new state with old
/// provider data.
pub fn update_operation(
    connection: &Connection,
    id: &str,
    state: Option<&str>,
    data_json: Option<&str>,
    now: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE billing_operations SET state = COALESCE(?1, state), provider_data_json = COALESCE(?2, provider_data_json), updated_at = ?3 WHERE id = ?4",
        params![state, data_json, now, id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// billing_events
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct EventRow {
    pub provider: String,
    pub event_id: String,
    pub account_id: Option<String>,
    pub object_id: Option<String>,
    pub payload_json: String,
    pub attempt_count: i64,
}

pub struct NewEvent<'a> {
    pub provider: &'a str,
    pub event_id: &'a str,
    pub account_id: Option<&'a str>,
    pub object_id: Option<&'a str>,
    pub payload_json: &'a str,
    pub now: &'a str,
}

/// A repeated event id is a no-op.
pub fn insert_event(connection: &Connection, event: &NewEvent<'_>) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO billing_events (provider, event_id, account_id, object_id, payload_json, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            event.provider,
            event.event_id,
            event.account_id,
            event.object_id,
            event.payload_json,
            event.now
        ],
    )?;
    Ok(())
}

pub fn list_due_events(
    connection: &Connection,
    now: &str,
    limit: i64,
) -> rusqlite::Result<Vec<EventRow>> {
    connection
        .prepare(
            "SELECT provider, event_id, account_id, object_id, payload_json, attempt_count FROM billing_events WHERE processed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?1) ORDER BY received_at ASC LIMIT ?2",
        )?
        .query_map(params![now, limit], |row| {
            Ok(EventRow {
                provider: row.get(0)?,
                event_id: row.get(1)?,
                account_id: row.get(2)?,
                object_id: row.get(3)?,
                payload_json: row.get(4)?,
                attempt_count: row.get(5)?,
            })
        })?
        .collect()
}

pub fn mark_event_processed(
    connection: &Connection,
    provider: &str,
    event_id: &str,
    now: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE billing_events SET processed_at = ?1, last_error = NULL WHERE provider = ?2 AND event_id = ?3",
        params![now, provider, event_id],
    )?;
    Ok(())
}

pub fn record_event_failure(
    connection: &Connection,
    provider: &str,
    event_id: &str,
    next_attempt_at: &str,
    error: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE billing_events SET attempt_count = attempt_count + 1, next_attempt_at = ?1, last_error = ?2 WHERE provider = ?3 AND event_id = ?4",
        params![next_attempt_at, error, provider, event_id],
    )?;
    Ok(())
}

pub fn update_event_account(
    connection: &Connection,
    provider: &str,
    event_id: &str,
    account_id: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE billing_events SET account_id = ?1 WHERE provider = ?2 AND event_id = ?3 AND account_id IS NULL",
        params![account_id, provider, event_id],
    )?;
    Ok(())
}

pub fn delete_processed_events_before(
    connection: &Connection,
    cutoff: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM billing_events WHERE processed_at IS NOT NULL AND processed_at < ?1",
        [cutoff],
    )?;
    Ok(())
}

pub fn count_pending_events(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COUNT(*) FROM billing_events WHERE processed_at IS NULL",
        [],
        |row| row.get(0),
    )
}
