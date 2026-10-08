//! The hosted billing service. Stripe is the source of subscription
//! evidence; RevenueCat supplies a validated grace window and a synced
//! entitlement. Private Suplex installations reach it through
//! `billing::BillingClient` with the shared `billing::wire` contract.

use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex, PoisonError, atomic::AtomicBool},
};

use chrono::DateTime;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde_json::Value;
use subtle::ConstantTimeEq;

use crate::{
    billing::wire::{BillingEnvironment, HostedSeatPreview, RegistrationBody},
    shared::{hash::sha256_hex, js_json, time::rfc3339_millis},
};
use revenuecat::RevenueCatClient;
use store::{AccountKey, AccountRow, NewAccount};
use stripe::StripeClient;

pub mod commands;
pub mod events;
pub mod plan;
pub mod revenuecat;
pub mod server;
pub mod source;
pub mod store;
pub mod stripe;
pub mod telemetry;

#[cfg(test)]
pub(crate) mod fakes {
    include!("../../../tests/billing/fakes.rs");
}

const RETRY_DELAYS_MS: [i64; 3] = [30_000, 120_000, 600_000];
const RETRY_STEADY_MS: i64 = 60 * 60 * 1000;

/// Epoch milliseconds. Tests inject a controlled clock.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct HostedConfig {
    pub origin: String,
    pub environment: BillingEnvironment,
    pub stripe_price_id: String,
    pub stripe_portal_configuration_id: String,
    pub stripe_webhook_secret: String,
    pub automatic_tax: bool,
    pub revenuecat_app_id: String,
    pub revenuecat_webhook_authorization: String,
    /// Hosted telemetry is a separate service-level opt-in. It is never
    /// inferred from a registered installation or billing request.
    pub telemetry: Option<telemetry::Config>,
}

/// A failure with a public status, optional code, and extra body fields.
/// Status 500 without a code is an internal failure with a generic message.
#[derive(Debug)]
pub struct HostedError {
    pub status: u16,
    pub code: Option<String>,
    pub message: String,
    /// A replacement quote on `billing_quote_changed`.
    pub preview: Option<Box<HostedSeatPreview>>,
}

impl HostedError {
    pub fn new(status: u16, code: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.map(str::to_owned),
            message: message.into(),
            preview: None,
        }
    }

    pub fn unavailable() -> Self {
        Self::new(
            503,
            Some("billing_unavailable"),
            "The billing provider cannot be reached",
        )
    }

    pub fn internal() -> Self {
        Self::new(500, None, "Internal error")
    }

    pub fn is_internal(&self) -> bool {
        self.status == 500 && self.code.is_none()
    }

    pub fn invalid_seat_quantity(message: &str) -> Self {
        Self::new(422, Some("invalid_seat_quantity"), message)
    }

    pub fn operation_not_applied(message: &str) -> Self {
        Self::new(409, Some("billing_operation_not_applied"), message)
    }

    pub fn payment_pending(message: &str) -> Self {
        Self::new(409, Some("billing_payment_pending"), message)
    }

    pub fn quote_changed(message: &str, preview: Option<HostedSeatPreview>) -> Self {
        Self {
            preview: preview.map(Box::new),
            ..Self::new(409, Some("billing_quote_changed"), message)
        }
    }

    pub fn has_code(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }
}

impl From<rusqlite::Error> for HostedError {
    fn from(error: rusqlite::Error) -> Self {
        eprintln!("billing: database failure: {error}");
        Self::internal()
    }
}

pub type HostedResult<T> = Result<T, HostedError>;

pub const NOT_APPLIED: &str = "The change was not applied. Review a new quote and try again.";
pub const PAYMENT_PENDING: &str = "A billing payment is still pending for this account";

/// A provider failure. The text never carries provider messages, bodies,
/// URLs, or credentials.
#[derive(Clone, Copy, Debug)]
pub struct ProviderError {
    pub provider: &'static str,
    pub status: Option<u16>,
    /// Stripe `resource_missing` or 404.
    pub missing: bool,
}

impl ProviderError {
    pub fn new(provider: &'static str, status: Option<u16>) -> Self {
        Self {
            provider,
            status,
            missing: false,
        }
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "{} error {status}", self.provider),
            None => write!(formatter, "{} error", self.provider),
        }
    }
}

impl std::error::Error for ProviderError {}

/// `JSON.stringify` with object keys sorted at every depth.
pub fn canonical_json(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            Value::Object(map) => {
                let mut entries = map.iter().collect::<Vec<_>>();
                entries.sort_by(|left, right| left.0.cmp(right.0));
                Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key.clone(), sorted(value)))
                        .collect(),
                )
            }
            other @ Value::Null
            | other @ Value::Bool(_)
            | other @ Value::Number(_)
            | other @ Value::String(_) => other.clone(),
        }
    }
    js_json::stringify(&sorted(value))
}

pub fn iso(ms: i64) -> String {
    rfc3339_millis(DateTime::from_timestamp_millis(ms).unwrap_or_default())
}

/// Unparseable timestamps are `None`; callers decide which way that fails.
pub fn parse_ms(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp_millis())
}

pub fn backoff_at(attempt_count: i64, now_ms: i64) -> String {
    let delay = usize::try_from(attempt_count)
        .ok()
        .and_then(|index| RETRY_DELAYS_MS.get(index).copied())
        .unwrap_or(RETRY_STEADY_MS);
    iso(now_ms + delay)
}

fn credential_shape(credential: &str) -> bool {
    credential.len() == 43
        && credential
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Clone)]
pub struct Hosted(Arc<Inner>);

pub struct Inner {
    pub config: HostedConfig,
    database: Mutex<Connection>,
    stripe: StripeClient,
    revenuecat: RevenueCatClient,
    clock: Clock,
    // ponytail: lock map never shrinks; evict when account count matters
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    price_verified: AtomicBool,
    processing: tokio::sync::Mutex<()>,
}

impl std::ops::Deref for Hosted {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl Hosted {
    pub fn new(
        config: HostedConfig,
        database: Connection,
        stripe: StripeClient,
        revenuecat: RevenueCatClient,
        clock: Clock,
    ) -> Self {
        Self(Arc::new(Inner {
            config,
            database: Mutex::new(database),
            stripe,
            revenuecat,
            clock,
            locks: Mutex::default(),
            price_verified: AtomicBool::new(false),
            processing: tokio::sync::Mutex::new(()),
        }))
    }

    pub fn now_ms(&self) -> i64 {
        (self.clock)()
    }

    pub fn now_iso(&self) -> String {
        iso(self.now_ms())
    }

    /// One short database call. Never held across an `.await`.
    pub fn query<T>(
        &self,
        operation: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        let connection = self.database.lock().unwrap_or_else(PoisonError::into_inner);
        operation(&connection)
    }

    pub fn immediate<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        let mut connection = self.database.lock().unwrap_or_else(PoisonError::into_inner);
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = operation(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }

    /// Serializes money commands per account. Lock order: account, then
    /// database.
    async fn account_lock(&self, account_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self
            .locks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(account_id.to_owned())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    pub fn account_for_credential(
        &self,
        authorization: Option<&str>,
    ) -> HostedResult<Option<AccountRow>> {
        let Some(credential) = authorization
            .and_then(|header| header.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|credential| credential_shape(credential))
        else {
            return Ok(None);
        };
        let digest = sha256_hex(credential);
        let row = self.query(|db| store::find_account(db, AccountKey::CredentialHash, &digest))?;
        Ok(row.filter(|row| bool::from(row.credential_hash.as_bytes().ct_eq(digest.as_bytes()))))
    }

    pub fn register(&self, body: &Value) -> HostedResult<String> {
        let input = serde_json::from_value::<RegistrationBody>(body.clone())
            .ok()
            .filter(RegistrationBody::valid)
            .ok_or_else(|| HostedError::new(400, None, "Invalid registration request"))?;
        let credential_hash = sha256_hex(&input.credential);
        let now = self.now_iso();
        enum Outcome {
            Created(String),
            Existing(Box<AccountRow>),
        }
        let outcome = self.immediate(|db| {
            let existing =
                |db| store::find_account(db, AccountKey::RegistrationId, &input.registration_id);
            if let Some(existing) = existing(db)? {
                return Ok(Outcome::Existing(Box::new(existing)));
            }
            let id = format!("account_{}", uuid::Uuid::new_v4());
            let inserted = store::insert_account(
                db,
                &NewAccount {
                    id: &id,
                    registration_id: &input.registration_id,
                    credential_hash: &credential_hash,
                    installation_id: &input.installation_id,
                    company_id: &input.company_id,
                    app_user_id: &format!("suplex_company_{id}"),
                    now: &now,
                },
            );
            match inserted {
                Ok(()) => Ok(Outcome::Created(id)),
                // A concurrent registration of the same identity won the
                // unique index; re-read and validate below.
                Err(error) if store::is_constraint_violation(&error) => existing(db)?
                    .map(|raced| Outcome::Existing(Box::new(raced)))
                    .ok_or(error),
                Err(error) => Err(error),
            }
        })?;
        let existing = match outcome {
            Outcome::Created(id) => return Ok(id),
            Outcome::Existing(existing) => existing,
        };
        let credential_matches = bool::from(
            existing
                .credential_hash
                .as_bytes()
                .ct_eq(credential_hash.as_bytes()),
        );
        let namespace_matches = existing.installation_id == input.installation_id
            && existing.company_id == input.company_id;
        if !credential_matches || !namespace_matches {
            return Err(HostedError::new(401, None, "Unauthorized"));
        }
        Ok(existing.id)
    }
}
