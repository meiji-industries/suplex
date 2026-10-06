//! Web push key, browser subscriptions, and the record of waiting episodes already sent.

use chrono::{DateTime, Utc};
use rusqlite::params;

use crate::{
    identity::companies,
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::time::rfc3339_millis,
};

use super::keys::VapidKey;

#[derive(Clone, Debug, PartialEq)]
pub struct Subscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, PartialEq)]
pub struct Due {
    pub task_id: String,
    pub company_id: String,
    pub title: String,
    pub recipients: Vec<Subscription>,
}

/// Reads the installation key; creates it on first use. Safe when several processes call it at once.
pub fn vapid_key(database: &SuplexDatabase) -> DatabaseResult<VapidKey> {
    let connection = database.connection();
    connection.execute(
        "INSERT OR IGNORE INTO suplex_web_push_keys (id, private_key, created_at) VALUES (1, ?1, ?2)",
        params![VapidKey::generate().to_base64url(), rfc3339_millis(Utc::now())],
    )?;
    let stored: String = connection.query_row(
        "SELECT private_key FROM suplex_web_push_keys WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    VapidKey::from_base64url(&stored)
}

pub fn save_subscription(
    database: &SuplexDatabase,
    user_id: &str,
    subscription: &Subscription,
    now: DateTime<Utc>,
) -> DatabaseResult<()> {
    let now = rfc3339_millis(now);
    database.connection().execute(
        "INSERT INTO suplex_web_push_subscriptions (endpoint, user_id, p256dh, auth, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at",
        params![subscription.endpoint, user_id, subscription.p256dh, subscription.auth, now],
    )?;
    Ok(())
}

pub fn delete_subscription(
    database: &SuplexDatabase,
    user_id: &str,
    endpoint: &str,
) -> DatabaseResult<()> {
    database.connection().execute(
        "DELETE FROM suplex_web_push_subscriptions WHERE endpoint = ?1 AND user_id = ?2",
        params![endpoint, user_id],
    )?;
    Ok(())
}

pub fn delete_endpoint(database: &SuplexDatabase, endpoint: &str) -> DatabaseResult<()> {
    database.connection().execute(
        "DELETE FROM suplex_web_push_subscriptions WHERE endpoint = ?1",
        [endpoint],
    )?;
    Ok(())
}

/// Claims each new waiting episode (status_changed_at >= since) and returns it with its recipients.
pub fn claim_due(
    database: &SuplexDatabase,
    since: DateTime<Utc>,
    now: DateTime<Utc>,
) -> DatabaseResult<Vec<Due>> {
    let connection = database.connection();
    let candidates = connection
        .prepare(
            "SELECT t.id, t.company_id, t.title, t.creator_user_id, c.status_changed_at \
             FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id \
             WHERE c.status = 'waiting_human' AND t.archived_at IS NULL AND c.status_changed_at >= ?1 \
               AND NOT EXISTS (SELECT 1 FROM suplex_web_push_sent s \
                               WHERE s.task_id = c.task_id AND s.status_changed_at = c.status_changed_at)",
        )?
        .query_map([rfc3339_millis(since)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut due = Vec::new();
    for (task_id, company_id, title, creator, status_changed_at) in candidates {
        // Another process that claimed this episode first sends it.
        if connection.execute(
            "INSERT OR IGNORE INTO suplex_web_push_sent (task_id, status_changed_at, sent_at) VALUES (?1, ?2, ?3)",
            params![task_id, status_changed_at, rfc3339_millis(now)],
        )? == 0
        {
            continue;
        }
        let rows = connection
            .prepare(
                "SELECT s.user_id, s.endpoint, s.p256dh, s.auth FROM suplex_web_push_subscriptions s \
                 JOIN suplex_users u ON u.id = s.user_id WHERE s.user_id = ?1 OR u.role = 'admin' ORDER BY s.endpoint",
            )?
            .query_map([creator.as_deref()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Subscription { endpoint: row.get(1)?, p256dh: row.get(2)?, auth: row.get(3)? },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let recipients = rows
            .into_iter()
            .filter(|(user_id, _)| {
                companies::require_company_access(database, user_id, &company_id).is_ok()
            })
            .map(|(_, subscription)| subscription)
            .collect();
        due.push(Due {
            task_id,
            company_id,
            title,
            recipients,
        });
    }
    Ok(due)
}

include!("../../tests/web_push/store.rs");
