//! The `subscribe` conversion on `/checkout/return`. Stripe adds the Checkout
//! Session id to the success URL; the page reads that session from Stripe
//! when it renders and pushes one GTM dataLayer event for a confirmed
//! session. `billing_checkout_conversions` makes the push once only. Any
//! doubt (no id, Stripe unavailable, an unpaid or foreign session, a repeat)
//! renders the static page without an event.

use axum::http::HeaderMap;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::{Hosted, stripe::CheckoutSession};
use crate::{
    accounts::hosted::{attribution::Attribution, store as accounts},
    shared::page,
};

/// Stripe amounts in these currencies have no minor unit.
const ZERO_DECIMAL: [&str; 16] = [
    "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv",
    "xaf", "xof", "xpf",
];
/// Stripe amounts in these currencies are in thousandths.
const THREE_DECIMAL: [&str; 5] = ["bhd", "jod", "kwd", "omr", "tnd"];
const MAX_SESSION_ID: usize = 255;

/// A Checkout Session id: `cs_` and then letters, digits, or `_`.
pub fn valid_session_id(id: &str) -> bool {
    id.len() <= MAX_SESSION_ID
        && id.strip_prefix("cs_").is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
}

/// `amount` minor units of the lowercase ISO `currency` in major units: an
/// integer when exact, else a decimal.
pub fn major_units(amount: i64, currency: &str) -> Value {
    let divisor = if ZERO_DECIMAL.contains(&currency) {
        1
    } else if THREE_DECIMAL.contains(&currency) {
        1000
    } else {
        100
    };
    if amount % divisor == 0 {
        json!(amount / divisor)
    } else {
        json!(amount as f64 / divisor as f64)
    }
}

fn currency(session: &CheckoutSession) -> Option<&str> {
    session
        .currency
        .as_deref()
        .filter(|code| code.len() == 3 && code.bytes().all(|b| b.is_ascii_lowercase()))
}

/// The event for a session that Stripe reports complete and paid (or that
/// needs no payment) and that this service created. `None` otherwise.
pub fn subscribe_event(hosted: &Hosted, session: &CheckoutSession) -> Option<Map<String, Value>> {
    let confirmed = session.status.as_deref() == Some("complete")
        && matches!(
            session.payment_status.as_deref(),
            Some("paid" | "no_payment_required")
        )
        && session.metadata.contains_key("suplex_operation_id");
    if !confirmed || !valid_session_id(&session.id) {
        return None;
    }
    let plan = session
        .line_items
        .iter()
        .find_map(|line| hosted.config.price_plan(&line.price_id))?;
    let currency = currency(session)?;
    let amount = session.amount_total.filter(|amount| *amount >= 0)?;
    let mut event = Map::new();
    event.insert("event".into(), json!("subscribe"));
    event.insert("value".into(), major_units(amount, currency));
    event.insert("currency".into(), json!(currency.to_ascii_uppercase()));
    event.insert("transaction_id".into(), json!(session.id));
    event.insert("plan".into(), json!(plan));
    Some(event)
}

/// The Suplex account email and its first-touch attribution, for the
/// billing account of a Stripe customer. `None` for a billing account
/// without a Suplex account.
fn signup_identity(
    db: &Connection,
    customer_id: &str,
) -> rusqlite::Result<Option<(String, Option<Attribution>)>> {
    let user: Option<String> = db
        .query_row(
            "SELECT registration_id FROM billing_accounts WHERE stripe_customer_id = ?1",
            [customer_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(user) = user else {
        return Ok(None);
    };
    let email: Option<String> = db
        .query_row("SELECT email FROM accounts WHERE id = ?1", [&user], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(email) = email else {
        return Ok(None);
    };
    Ok(Some((email, accounts::find_account_attribution(db, &user)?)))
}

/// Records the session once. `true` only for the first request.
fn record(db: &Connection, session_id: &str, now: &str) -> rusqlite::Result<bool> {
    Ok(db.execute(
        "INSERT INTO billing_checkout_conversions (session_id, created_at) VALUES (?1, ?2) ON CONFLICT(session_id) DO NOTHING",
        params![session_id, now],
    )? == 1)
}

impl Hosted {
    /// The `subscribe` push for the return page, or an empty string.
    pub async fn checkout_conversion(&self, session_id: Option<&str>, headers: &HeaderMap) -> String {
        let Some(session_id) = session_id.filter(|id| valid_session_id(id)) else {
            return String::new();
        };
        let Ok(Some(session)) = self.stripe.get_checkout_session(session_id).await else {
            return String::new();
        };
        if session.id != session_id {
            return String::new();
        }
        let Some(mut event) = subscribe_event(self, &session) else {
            return String::new();
        };
        let now = self.now_iso();
        let Ok(true) = self.immediate(|db| record(db, session_id, &now)) else {
            return String::new();
        };
        // Best effort: without a Suplex account the event has no gclid or hash.
        let identity = session
            .customer_id
            .as_deref()
            .and_then(|customer| self.query(|db| signup_identity(db, customer)).ok().flatten());
        let (email, attribution) = identity.unzip();
        // The account keeps the consented first touch; else this browser's cookie.
        let gclid = attribution
            .flatten()
            .and_then(|kept| kept.get("gclid").map(str::to_owned))
            .or_else(|| {
                Attribution::for_signup(headers).and_then(|cookie| cookie.get("gclid").map(str::to_owned))
            });
        if let Some(gclid) = gclid {
            event.insert("gclid".into(), json!(gclid));
        }
        page::conversion_script(
            &Value::Object(event),
            email.as_deref().map(page::email_hash).as_deref(),
        )
    }
}

#[cfg(test)]
include!("../../../tests/billing/conversion.rs");
