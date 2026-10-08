//! Provider webhooks persist durable work before they acknowledge; the
//! processor refreshes affected accounts from source with retry backoff.

use serde_json::{Map, Value, json};

use super::{
    Hosted, HostedError, HostedResult, backoff_at, canonical_json, iso,
    store::{self, AccountKey, AccountRow, EventRow, NewEvent},
    stripe::verify_webhook,
};
use crate::{billing::wire::BillingEnvironment, shared::hash::sha256_hex};

const EVENT_PROCESS_LIMIT: i64 = 100;
const EVENT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

const STRIPE_EVENT_TYPES: [&str; 9] = [
    "checkout.session.completed",
    "checkout.session.expired",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.payment_action_required",
    "charge.refunded",
];

const REVENUECAT_EVENT_TYPES: [&str; 12] = [
    "INITIAL_PURCHASE",
    "RENEWAL",
    "CANCELLATION",
    "UNCANCELLATION",
    "EXPIRATION",
    "BILLING_ISSUE",
    "REFUND",
    "TRANSFER",
    "SUBSCRIPTION_PAUSED",
    "GRACE_PERIOD_STARTED",
    "GRACE_PERIOD_EXTENDED",
    "GRACE_PERIOD_ENDED",
];

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

/// A bounded, nonempty alias list on a RevenueCat TRANSFER event.
fn alias_array(value: &Value) -> Option<&Vec<Value>> {
    let aliases = value.as_array().filter(|aliases| aliases.len() <= 64)?;
    aliases
        .iter()
        .all(|alias| {
            alias
                .as_str()
                .is_some_and(|alias| !alias.is_empty() && alias.encode_utf16().count() <= 256)
        })
        .then_some(aliases)
}

impl Hosted {
    fn correlate_stripe_account(
        &self,
        object: &Map<String, Value>,
    ) -> HostedResult<Option<AccountRow>> {
        let metadata = object.get("metadata").and_then(Value::as_object);
        let candidates = [
            (
                AccountKey::AppUserId,
                metadata.and_then(|metadata| text(metadata, "app_user_id")),
            ),
            (AccountKey::StripeCustomerId, text(object, "customer")),
            (
                AccountKey::SubscriptionHint,
                text(object, "subscription").or_else(|| text(object, "id")),
            ),
        ];
        for (key, value) in candidates {
            if let Some(value) = value
                && let Some(account) = self.query(|db| store::find_account(db, key, value))?
            {
                return Ok(Some(account));
            }
        }
        Ok(None)
    }

    /// Environment is proved by the signed envelope: a wrong-environment
    /// event neither queues work nor touches account data.
    pub fn ingest_stripe_webhook(&self, raw: &[u8], signature: Option<&str>) -> HostedResult<()> {
        let event = verify_webhook(
            raw,
            signature.unwrap_or_default(),
            &self.config.stripe_webhook_secret,
            self.now_ms().div_euclid(1000),
        )
        .ok_or_else(|| HostedError::new(401, None, "Invalid webhook signature"))?;
        if event.livemode != (self.config.environment == BillingEnvironment::Production)
            || !STRIPE_EVENT_TYPES.contains(&event.event_type.as_str())
        {
            return Ok(());
        }
        let object = &event.object;
        let account = self.correlate_stripe_account(object)?;
        let object_id = text(object, "id");
        let mut minimal = Map::new();
        minimal.insert("id".into(), json!(object_id));
        for key in ["customer", "subscription"] {
            if let Some(value) = text(object, key) {
                minimal.insert(key.into(), json!(value));
            }
        }
        if let Some(app_user_id) = object
            .get("metadata")
            .and_then(Value::as_object)
            .and_then(|metadata| metadata.get("app_user_id"))
        {
            minimal.insert("app_user_id".into(), app_user_id.clone());
        }
        let payload = json!({"type": event.event_type, "object": minimal}).to_string();
        let now = self.now_iso();
        self.immediate(|db| {
            store::insert_event(
                db,
                &NewEvent {
                    provider: "stripe",
                    event_id: &event.id,
                    account_id: account.as_ref().map(|account| account.id.as_str()),
                    object_id,
                    payload_json: &payload,
                    now: &now,
                },
            )
        })?;
        // Billing durability wins over optional capture. A queue failure is
        // logged and cannot reject an authentic webhook after its billing
        // event was committed.
        if let Err(error) =
            self.immediate(|db| self.enqueue_stripe_telemetry(db, &event, account.as_ref(), &now))
        {
            eprintln!("billing: Stripe telemetry enqueue failed: {error}");
        }
        Ok(())
    }

    pub fn ingest_revenuecat_event(&self, body: &Value) -> HostedResult<()> {
        let envelope = match body.get("event") {
            Some(Value::Object(envelope)) => envelope,
            // An array envelope carries no app id and is ignored.
            Some(Value::Array(_)) => return Ok(()),
            _ => return Err(HostedError::new(400, None, "Invalid RevenueCat event")),
        };
        let event_type = text(envelope, "type");
        let app_user_id = text(envelope, "app_user_id");
        let environment = text(envelope, "environment");
        if text(envelope, "app_id") != Some(&self.config.revenuecat_app_id) {
            return Ok(());
        }
        // The documented sandbox transaction environment is SANDBOX; TEST is not.
        let expected = match self.config.environment {
            BillingEnvironment::Sandbox => "SANDBOX",
            BillingEnvironment::Production => "PRODUCTION",
        };
        if environment != Some(expected) {
            return Ok(());
        }
        let Some(event_type) =
            event_type.filter(|event_type| REVENUECAT_EVENT_TYPES.contains(event_type))
        else {
            return Ok(());
        };
        let mut transfers = Vec::new();
        for key in ["transferred_from", "transferred_to"] {
            if let Some(value) = envelope.get(key) {
                let Some(aliases) = alias_array(value) else {
                    return Ok(());
                };
                transfers.push((key, aliases.clone()));
            }
        }
        let account = match app_user_id {
            Some(app_user_id) => {
                self.query(|db| store::find_account(db, AccountKey::AppUserId, app_user_id))?
            }
            None => None,
        };
        let event_id = match text(envelope, "id") {
            Some(id) => id.to_owned(),
            None => {
                let at = [
                    envelope.get("expiration_at_ms"),
                    envelope.get("event_timestamp_ms"),
                ]
                .into_iter()
                .flatten()
                .find(|value| !value.is_null())
                .cloned()
                .unwrap_or(Value::Null);
                let mut identity = Map::new();
                identity.insert("type".into(), json!(event_type));
                identity.insert("appId".into(), json!(self.config.revenuecat_app_id));
                if let Some(app_user_id) = app_user_id {
                    identity.insert("appUserId".into(), json!(app_user_id));
                }
                identity.insert("at".into(), at);
                format!(
                    "rc_{}",
                    sha256_hex(canonical_json(&Value::Object(identity)))
                )
            }
        };
        let mut minimal = Map::new();
        minimal.insert("type".into(), json!(event_type));
        minimal.insert("app_id".into(), json!(self.config.revenuecat_app_id));
        if let Some(app_user_id) = app_user_id {
            minimal.insert("app_user_id".into(), json!(app_user_id));
        }
        minimal.insert("environment".into(), json!(environment));
        minimal.insert("id".into(), json!(event_id));
        for (key, aliases) in transfers {
            minimal.insert(key.into(), Value::Array(aliases));
        }
        let payload = Value::Object(minimal).to_string();
        let now = self.now_iso();
        self.immediate(|db| {
            store::insert_event(
                db,
                &NewEvent {
                    provider: "revenuecat",
                    event_id: &event_id,
                    account_id: account.as_ref().map(|account| account.id.as_str()),
                    object_id: app_user_id,
                    payload_json: &payload,
                    now: &now,
                },
            )
        })?;
        let event_timestamp_ms = envelope.get("event_timestamp_ms").and_then(Value::as_i64);
        if let Err(error) = self.immediate(|db| {
            self.enqueue_revenuecat_telemetry(
                db,
                &event_id,
                event_type,
                account.as_ref(),
                &now,
                event_timestamp_ms,
            )
        }) {
            eprintln!("billing: RevenueCat telemetry enqueue failed: {error}");
        }
        Ok(())
    }

    fn adopt_event_account(&self, event: &EventRow, account: &AccountRow) -> HostedResult<()> {
        self.query(|db| {
            store::update_event_account(db, &event.provider, &event.event_id, &account.id)
        })?;
        Ok(())
    }

    /// The account an event affects. Local hints first; then the owning
    /// provider, so an event that arrived before any local observation
    /// still reaches its account. A transient provider failure propagates
    /// and the event is retried.
    async fn account_for_event(&self, event: &EventRow) -> HostedResult<Option<AccountRow>> {
        if let Some(account_id) = &event.account_id
            && let Some(account) =
                self.query(|db| store::find_account(db, AccountKey::Id, account_id))?
        {
            return Ok(Some(account));
        }
        if let Some(object_id) = &event.object_id {
            for key in [
                AccountKey::StripeCustomerId,
                AccountKey::SubscriptionHint,
                AccountKey::AppUserId,
            ] {
                if let Some(account) = self.query(|db| store::find_account(db, key, object_id))? {
                    return Ok(Some(account));
                }
            }
        }
        let payload = serde_json::from_str::<Value>(&event.payload_json).unwrap_or(Value::Null);
        let object = payload.get("object").and_then(Value::as_object);
        let app_user_id = object
            .and_then(|object| text(object, "app_user_id"))
            .or_else(|| payload.get("app_user_id").and_then(Value::as_str));
        if let Some(app_user_id) = app_user_id
            && let Some(account) =
                self.query(|db| store::find_account(db, AccountKey::AppUserId, app_user_id))?
        {
            self.adopt_event_account(event, &account)?;
            return Ok(Some(account));
        }
        if event.provider == "stripe"
            && let Some(customer_id) = object.and_then(|object| text(object, "customer"))
        {
            let customer = self
                .stripe
                .get_customer(customer_id)
                .await
                .map_err(|error| self.provider_failure("stripe read", error))?;
            if let Some(account_id) = customer.and_then(|customer| customer.account_id)
                && let Some(account) =
                    self.query(|db| store::find_account(db, AccountKey::Id, &account_id))?
            {
                self.adopt_event_account(event, &account)?;
                return Ok(Some(account));
            }
        }
        Ok(None)
    }

    /// A TRANSFER refreshes the known accounts on both sides once each;
    /// unknown aliases grant nothing and no identity moves from the payload.
    async fn accounts_for_event(&self, event: &EventRow) -> HostedResult<Vec<AccountRow>> {
        let payload = serde_json::from_str::<Value>(&event.payload_json).unwrap_or(Value::Null);
        if event.provider == "revenuecat"
            && payload.get("type").and_then(Value::as_str) == Some("TRANSFER")
        {
            let mut accounts = Vec::<AccountRow>::new();
            let aliases = ["transferred_from", "transferred_to"]
                .into_iter()
                .filter_map(|key| payload.get(key).and_then(Value::as_array))
                .flatten()
                .filter_map(Value::as_str);
            for alias in aliases {
                if let Some(account) =
                    self.query(|db| store::find_account(db, AccountKey::AppUserId, alias))?
                    && !accounts.iter().any(|known| known.id == account.id)
                {
                    accounts.push(account);
                }
            }
            return Ok(accounts);
        }
        Ok(self.account_for_event(event).await?.into_iter().collect())
    }

    async fn process_event(&self, event: &EventRow) -> HostedResult<()> {
        // Each affected account is refreshed once; a failure leaves the
        // event retryable while finished refreshes stay harmless.
        for mut account in self.accounts_for_event(event).await? {
            self.read_state(&mut account).await?;
        }
        let now = self.now_iso();
        self.query(|db| store::mark_event_processed(db, &event.provider, &event.event_id, &now))?;
        Ok(())
    }

    /// One processor pass; passes never overlap.
    pub async fn run_processor_pass(&self) -> HostedResult<()> {
        let _serial = self.processing.lock().await;
        let now = self.now_iso();
        let due = self.query(|db| store::list_due_events(db, &now, EVENT_PROCESS_LIMIT))?;
        for event in due {
            if let Err(error) = self.process_event(&event).await {
                let message = error
                    .code
                    .as_deref()
                    .unwrap_or("processing failed")
                    .to_owned();
                eprintln!(
                    "billing: event {}:{} processing failed: {message}",
                    event.provider, event.event_id
                );
                let next = backoff_at(event.attempt_count, self.now_ms());
                self.query(|db| {
                    store::record_event_failure(
                        db,
                        &event.provider,
                        &event.event_id,
                        &next,
                        &message,
                    )
                })?;
            }
        }
        // Drain RevenueCat import repairs in the same loop.
        let now = self.now_iso();
        for mut account in self.query(|db| store::list_accounts_due_for_sync(db, &now))? {
            if let Err(error) = self.read_state(&mut account).await {
                eprintln!(
                    "billing: revenuecat sync repair failed for {}: {}",
                    account.id,
                    error.code.as_deref().unwrap_or("internal")
                );
            }
        }
        let cutoff = iso(self.now_ms() - EVENT_RETENTION_MS);
        self.query(|db| store::delete_processed_events_before(db, &cutoff))?;
        // Delivery is isolated: it has its own bounded queue and cannot
        // change the outcome of billing event processing.
        self.run_telemetry_pass().await;
        Ok(())
    }
}

#[cfg(test)]
include!("../../../tests/billing/events.rs");
