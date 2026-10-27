//! Resend contacts for product update emails. `account_email_updates` is the
//! record of consent; Resend gets a copy so an Automation can email only the
//! people who opted in.
//!
//! Each choice queues its Resend change in `account_resend_outbox` in the same
//! transaction. A pass sends the queue in order per email, right after the
//! choice and every 30 seconds, and retries a failure with backoff. A Resend
//! failure never changes the stored choice. Rows are keyed by email, so a
//! contact deletion is still sent after its account row is gone.
//!
//! `POST /webhooks/resend` brings back unsubscribes made with the
//! `{{{RESEND_UNSUBSCRIBE_URL}}}` link. A webhook never records an opt-in.

use std::collections::HashSet;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::post,
};
use base64::Engine;
use chrono::DateTime;
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use super::{AccountConfig, Accounts};
use crate::{
    accounts::wire::EmailUpdatesSource,
    billing::hosted::{HostedError, HostedResult, backoff_at, parse_ms},
    shared::encode_uri_component,
};

/// The Resend event for a change from not subscribed to subscribed. A Resend
/// Automation triggers on it. Its payload is `{source}`.
pub const SUBSCRIBED_EVENT: &str = "email_updates.subscribed";

/// The wording of a choice recorded from the Resend unsubscribe link.
pub const UNSUBSCRIBE_LINK_WORDING: &str = "Unsubscribed with the link in a Suplex email.";

/// Svix refuses signatures older or newer than five minutes.
const WEBHOOK_TOLERANCE_SECONDS: i64 = 5 * 60;
const WEBHOOK_BODY_LIMIT: usize = 64 * 1024;
const BATCH: i64 = 500;

crate::shared::wire_enum! {
    /// One queued Resend change.
    pub enum OutboxKind { Contact = "contact", Event = "event", Delete = "delete" }
}

/// True when the account ever subscribed. Only then can Resend have a contact
/// for it, so a choice or a deletion without one sends nothing.
fn ever_subscribed(db: &Connection, account_id: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS (SELECT 1 FROM account_email_updates WHERE account_id = ?1 AND subscribed = 1)",
        [account_id],
        |row| row.get(0),
    )
}

/// Queues the Resend change for a new choice. Call it in the transaction that
/// inserts the choice, before the insert. Opting in also queues
/// [`SUBSCRIBED_EVENT`], after the contact change.
pub fn enqueue_choice(
    db: &Connection,
    account_id: &str,
    subscribed: bool,
    source: EmailUpdatesSource,
    now: &str,
) -> rusqlite::Result<()> {
    let previous: bool = db
        .query_row(
            "SELECT subscribed FROM account_email_updates WHERE account_id = ?1 ORDER BY id DESC LIMIT 1",
            [account_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if !subscribed && !ever_subscribed(db, account_id)? {
        return Ok(());
    }
    let (email, name): (String, Option<String>) = db.query_row(
        "SELECT email, name FROM accounts WHERE id = ?1",
        [account_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let first_name = name
        .as_deref()
        .and_then(|name| name.split_whitespace().next());
    db.execute(
        "INSERT INTO account_resend_outbox (email, kind, unsubscribed, first_name, created_at) VALUES (?1, 'contact', ?2, ?3, ?4)",
        params![email, !subscribed, first_name, now],
    )?;
    if subscribed && !previous {
        db.execute(
            "INSERT INTO account_resend_outbox (email, kind, event, payload_json, created_at) VALUES (?1, 'event', ?2, ?3, ?4)",
            params![
                email,
                SUBSCRIBED_EVENT,
                json!({"source": source}).to_string(),
                now
            ],
        )?;
    }
    Ok(())
}

/// Queues the contact deletion for an account that is about to be deleted,
/// and drops its unsent contact changes and events.
pub fn enqueue_delete(db: &Connection, account_id: &str, now: &str) -> rusqlite::Result<()> {
    if !ever_subscribed(db, account_id)? {
        return Ok(());
    }
    let email: String = db.query_row(
        "SELECT email FROM accounts WHERE id = ?1",
        [account_id],
        |row| row.get(0),
    )?;
    db.execute(
        "DELETE FROM account_resend_outbox WHERE email = ?1 AND sent_at IS NULL",
        [&email],
    )?;
    db.execute(
        "INSERT INTO account_resend_outbox (email, kind, created_at) VALUES (?1, 'delete', ?2)",
        params![email, now],
    )?;
    Ok(())
}

struct Pending {
    id: i64,
    email: String,
    kind: OutboxKind,
    unsubscribed: bool,
    first_name: Option<String>,
    event: Option<String>,
    payload: Option<String>,
    attempt_count: i64,
    next_attempt_at: Option<String>,
}

fn pending(db: &Connection) -> rusqlite::Result<Vec<Pending>> {
    db.prepare(
        "SELECT id, email, kind, COALESCE(unsubscribed, 0), first_name, event, payload_json, attempt_count, next_attempt_at
         FROM account_resend_outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?1",
    )?
    .query_map([BATCH], |row| {
        Ok(Pending {
            id: row.get(0)?,
            email: row.get(1)?,
            kind: row.get(2)?,
            unsubscribed: row.get(3)?,
            first_name: row.get(4)?,
            event: row.get(5)?,
            payload: row.get(6)?,
            attempt_count: row.get(7)?,
            next_attempt_at: row.get(8)?,
        })
    })?
    .collect()
}

/// A sent contact change stays as the latest one sent for its email; the
/// webhook compares against it. A sent deletion removes every earlier row.
fn mark_sent(db: &Connection, row: &Pending, now: &str) -> rusqlite::Result<()> {
    match row.kind {
        OutboxKind::Contact => {
            db.execute(
                "DELETE FROM account_resend_outbox WHERE email = ?1 AND id < ?2 AND sent_at IS NOT NULL",
                params![row.email, row.id],
            )?;
            db.execute(
                "UPDATE account_resend_outbox SET sent_at = ?2, last_error = NULL WHERE id = ?1",
                params![row.id, now],
            )?;
        }
        OutboxKind::Event => {
            db.execute("DELETE FROM account_resend_outbox WHERE id = ?1", [row.id])?;
        }
        OutboxKind::Delete => {
            db.execute(
                "DELETE FROM account_resend_outbox WHERE email = ?1 AND id <= ?2",
                params![row.email, row.id],
            )?;
        }
    }
    Ok(())
}

/// Nothing is dropped: a failed change waits and blocks the later changes
/// for its email.
fn retry_later(db: &Connection, row: &Pending, now_ms: i64, error: &str) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE account_resend_outbox SET attempt_count = attempt_count + 1, next_attempt_at = ?2, last_error = ?3 WHERE id = ?1",
        params![row.id, backoff_at(row.attempt_count, now_ms), error],
    )?;
    Ok(())
}

/// The HTTP status, or `None` when Resend cannot be reached.
async fn status(request: reqwest::RequestBuilder) -> Option<u16> {
    request
        .send()
        .await
        .ok()
        .map(|response| response.status().as_u16())
}

fn success(status: Option<u16>) -> bool {
    status.is_some_and(|status| (200..300).contains(&status))
}

impl Accounts {
    /// Sends the due Resend changes, oldest first. A change for an email
    /// waits until the earlier changes for that email are sent.
    pub async fn sync_resend(&self) -> HostedResult<()> {
        let Some(config) = self.config.as_ref() else {
            return Ok(());
        };
        let _pass = self.resend_sync.lock().await;
        let now = self.hosted.now_iso();
        let rows = self.hosted.query(pending)?;
        let mut blocked = HashSet::new();
        for row in rows {
            if blocked.contains(&row.email) {
                continue;
            }
            if row
                .next_attempt_at
                .as_deref()
                .is_some_and(|due| due > now.as_str())
            {
                blocked.insert(row.email);
                continue;
            }
            match self.deliver(config, &row).await {
                Ok(()) => {
                    let sent = self.hosted.now_iso();
                    self.hosted.query(|db| mark_sent(db, &row, &sent))?;
                }
                Err(status) => {
                    let error = status.map_or("unreachable".to_owned(), |status| {
                        format!("status_{status}")
                    });
                    eprintln!("accounts: resend {} error {error}", row.kind);
                    let now_ms = self.hosted.now_ms();
                    self.hosted
                        .query(|db| retry_later(db, &row, now_ms, &error))?;
                    blocked.insert(row.email);
                }
            }
        }
        Ok(())
    }

    /// Sends one change. A missing contact is already unsubscribed or
    /// deleted; a subscribe for a missing contact creates it.
    async fn deliver(&self, config: &AccountConfig, row: &Pending) -> Result<(), Option<u16>> {
        let base = &self.endpoints.resend;
        let key = &config.resend_api_key;
        let contact = format!("{base}/contacts/{}", encode_uri_component(&row.email));
        let result = match row.kind {
            OutboxKind::Contact => {
                let mut body = json!({"unsubscribed": row.unsubscribed});
                if let Some(first_name) = &row.first_name {
                    body["first_name"] = first_name.as_str().into();
                }
                let updated = status(self.http.patch(&contact).bearer_auth(key).json(&body)).await;
                if updated == Some(404) && !row.unsubscribed {
                    body["email"] = row.email.as_str().into();
                    status(
                        self.http
                            .post(format!("{base}/contacts"))
                            .bearer_auth(key)
                            .json(&body),
                    )
                    .await
                } else if updated == Some(404) {
                    Some(200)
                } else {
                    updated
                }
            }
            OutboxKind::Event => {
                let payload = row
                    .payload
                    .as_deref()
                    .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
                    .unwrap_or_else(|| json!({}));
                status(
                    self.http
                        .post(format!("{base}/events/send"))
                        .bearer_auth(key)
                        .json(&json!({
                            "event": row.event.as_deref().unwrap_or(SUBSCRIBED_EVENT),
                            "email": row.email,
                            "payload": payload,
                        })),
                )
                .await
            }
            OutboxKind::Delete => match status(self.http.delete(&contact).bearer_auth(key)).await {
                Some(404) => Some(200),
                deleted => deleted,
            },
        };
        if success(result) { Ok(()) } else { Err(result) }
    }
}

/// The HMAC key in a `whsec_` secret.
pub fn signing_key(secret: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(secret.strip_prefix("whsec_")?)
        .ok()
        .filter(|key| !key.is_empty())
}

/// The base64 Svix signature of `{id}.{timestamp}.{body}`.
pub fn webhook_signature(key: &[u8], id: &str, timestamp: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(format!("{id}.{timestamp}.").as_bytes());
    mac.update(body);
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// Verifies the Svix headers over the raw body and returns the signed time in
/// seconds. `svix-signature` lists `v1,<signature>` entries separated by spaces.
pub fn verify_webhook(
    secret: &str,
    headers: &HeaderMap,
    body: &[u8],
    now_seconds: i64,
) -> Option<i64> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let key = signing_key(secret)?;
    let id = header("svix-id").filter(|id| !id.is_empty())?;
    let timestamp = header("svix-timestamp")?;
    let seconds = timestamp.parse::<i64>().ok()?;
    if (now_seconds - seconds).abs() > WEBHOOK_TOLERANCE_SECONDS {
        return None;
    }
    let expected = webhook_signature(&key, id, timestamp, body);
    header("svix-signature")?
        .split(' ')
        .filter_map(|entry| entry.strip_prefix("v1,"))
        .any(|signature| bool::from(signature.as_bytes().ct_eq(expected.as_bytes())))
        .then_some(seconds)
}

/// Resend sends RFC 3339 times; also accept `2025-01-01 00:00:00.000+00`.
fn event_ms(text: &str) -> Option<i64> {
    parse_ms(text).or_else(|| {
        DateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f%#z")
            .ok()
            .map(|time| time.timestamp_millis())
    })
}

/// Records an unsubscribe made in Resend at `at_ms`, when it is the newest
/// word on the account. Returns true when a row was added.
///
/// It is ignored when the latest choice is not subscribed, when the choice
/// is newer, or when it is older than the last contact change Suplex sent.
/// When Suplex last sent an unsubscribe, the event is the echo of that change.
pub fn record_unsubscribe(
    db: &Connection,
    email: &str,
    at_ms: i64,
    now: &str,
) -> rusqlite::Result<bool> {
    let latest: Option<(String, Option<bool>, Option<String>)> = db
        .query_row(
            "SELECT a.id, u.subscribed, u.created_at FROM accounts a
             LEFT JOIN account_email_updates u
               ON u.id = (SELECT MAX(id) FROM account_email_updates WHERE account_id = a.id)
             WHERE a.email = ?1",
            [email],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((account_id, Some(true), Some(chosen_at))) = latest else {
        return Ok(false);
    };
    if parse_ms(&chosen_at).is_none_or(|chosen| at_ms < chosen) {
        return Ok(false);
    }
    let sent: Option<(bool, String)> = db
        .query_row(
            "SELECT unsubscribed, sent_at FROM account_resend_outbox
             WHERE email = ?1 AND kind = 'contact' AND sent_at IS NOT NULL ORDER BY id DESC LIMIT 1",
            [email],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((unsubscribed, sent_at)) = sent
        && (unsubscribed || parse_ms(&sent_at).is_none_or(|sent| at_ms < sent))
    {
        return Ok(false);
    }
    db.execute(
        "INSERT INTO account_email_updates (account_id, subscribed, source, wording, created_at) VALUES (?1, 0, ?2, ?3, ?4)",
        params![
            account_id,
            EmailUpdatesSource::Email.as_str(),
            UNSUBSCRIBE_LINK_WORDING,
            now
        ],
    )?;
    // Resend already has the unsubscribe. An unsent subscribe must not undo it.
    db.execute(
        "UPDATE account_resend_outbox SET unsubscribed = 1 WHERE email = ?1 AND kind = 'contact' AND sent_at IS NULL",
        [email],
    )?;
    db.execute(
        "DELETE FROM account_resend_outbox WHERE email = ?1 AND kind = 'event' AND sent_at IS NULL",
        [email],
    )?;
    Ok(true)
}

/// Signature verification needs the raw request bytes. Unknown events,
/// unknown addresses, and repeats answer 200 and change nothing.
async fn webhook(State(accounts): State<Accounts>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(secret) = accounts
        .config
        .as_ref()
        .and_then(|config| config.resend_webhook_secret.as_deref())
    else {
        return HostedError::new(
            503,
            Some("webhook_unavailable"),
            "The Resend webhook is not configured",
        )
        .into_response();
    };
    let now_ms = accounts.hosted.now_ms();
    let Some(signed_seconds) = verify_webhook(secret, &headers, &body, now_ms / 1000) else {
        return HostedError::new(401, None, "Unauthorized").into_response();
    };
    let Ok(event) = serde_json::from_slice::<Value>(&body) else {
        return HostedError::new(400, None, "Invalid request").into_response();
    };
    let unsubscribed = event["type"] == "contact.updated" && event["data"]["unsubscribed"] == true;
    let email = event["data"]["email"]
        .as_str()
        .map(|email| email.trim().to_ascii_lowercase());
    if let (true, Some(email)) = (unsubscribed, email) {
        let at_ms = event["data"]["updated_at"]
            .as_str()
            .and_then(event_ms)
            .unwrap_or(signed_seconds * 1000);
        let now = accounts.hosted.now_iso();
        let recorded: HostedResult<bool> = accounts
            .hosted
            .immediate(|db| record_unsubscribe(db, &email, at_ms, &now))
            .map_err(Into::into);
        if let Err(error) = recorded {
            return error.into_response();
        }
    }
    Json(json!({"received": true})).into_response()
}

pub fn router(accounts: Accounts) -> Router {
    Router::new()
        .route("/webhooks/resend", post(webhook))
        .layer(DefaultBodyLimit::max(WEBHOOK_BODY_LIMIT))
        .with_state(accounts)
}

#[cfg(test)]
include!("../../../tests/accounts/resend.rs");
