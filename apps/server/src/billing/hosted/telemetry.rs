//! Privacy-bounded hosted billing telemetry. Verified Stripe events enqueue a
//! durable PostHog event; delivery retries are bounded and never affect the
//! billing event processor.

use std::time::Duration;

use rusqlite::params;
use serde_json::{Map, Value, json};

use super::{Hosted, iso, stripe::Event};
use crate::{billing::wire::BillingEnvironment, shared::hash::sha256_hex};

const DELIVERY_LIMIT: i64 = 100;
const MAX_ATTEMPTS: i64 = 5;
const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug)]
pub struct Config {
    pub key: String,
    pub host: String,
}

#[derive(Debug, PartialEq)]
struct Mapped {
    name: &'static str,
    properties: Map<String, Value>,
}

fn integer(object: &Map<String, Value>, key: &str) -> Option<i64> {
    object
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
}

fn currency(object: &Map<String, Value>) -> Option<&str> {
    object
        .get("currency")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_lowercase()))
}

fn allowed<'a>(object: &'a Map<String, Value>, key: &str, values: &[&str]) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| values.contains(value))
}

fn money(properties: &mut Map<String, Value>, object: &Map<String, Value>, key: &str) {
    if let Some(amount) = integer(object, key) {
        properties.insert(format!("{key}_minor"), json!(amount));
    }
    if let Some(currency) = currency(object) {
        properties.insert("currency".into(), json!(currency));
    }
}

fn map_stripe(event: &Event) -> Option<Mapped> {
    let object = &event.object;
    let mut properties = Map::new();
    let name = match event.event_type.as_str() {
        "checkout.session.completed" => {
            money(&mut properties, object, "amount_total");
            if let Some(status) = allowed(
                object,
                "payment_status",
                &["paid", "unpaid", "no_payment_required"],
            ) {
                properties.insert("payment_status".into(), json!(status));
            }
            "billing_checkout_completed"
        }
        "customer.subscription.created"
        | "customer.subscription.updated"
        | "customer.subscription.deleted" => {
            if let Some(status) = allowed(
                object,
                "status",
                &[
                    "incomplete",
                    "incomplete_expired",
                    "trialing",
                    "active",
                    "past_due",
                    "canceled",
                    "unpaid",
                    "paused",
                ],
            ) {
                properties.insert("status".into(), json!(status));
            }
            if let Some(cancel) = object.get("cancel_at_period_end").and_then(Value::as_bool) {
                properties.insert("cancel_at_period_end".into(), json!(cancel));
            }
            let quantity = object
                .get("items")
                .and_then(|items| items.get("data"))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("quantity").and_then(Value::as_i64))
                        .filter(|quantity| (0..=10_000).contains(quantity))
                        .sum::<i64>()
                });
            if let Some(quantity) = quantity {
                properties.insert("quantity".into(), json!(quantity));
            }
            match event.event_type.as_str() {
                "customer.subscription.created" => "billing_subscription_created",
                "customer.subscription.updated" => "billing_subscription_updated",
                _ => "billing_subscription_deleted",
            }
        }
        "invoice.paid" => {
            money(&mut properties, object, "amount_paid");
            "billing_invoice_paid"
        }
        "invoice.payment_failed" => {
            money(&mut properties, object, "amount_due");
            "billing_payment_failed"
        }
        "invoice.payment_action_required" => {
            money(&mut properties, object, "amount_due");
            "billing_payment_action_required"
        }
        "charge.refunded" => {
            if let Some((current, previous)) = integer(object, "amount_refunded").zip(
                event
                    .previous_attributes
                    .as_ref()
                    .and_then(|previous| integer(previous, "amount_refunded")),
            ) && current >= previous
            {
                properties.insert("refund_amount_minor".into(), json!(current - previous));
            }
            if let Some(currency) = currency(object) {
                properties.insert("currency".into(), json!(currency));
            }
            "billing_refund_issued"
        }
        _ => return None,
    };
    Some(Mapped { name, properties })
}

fn map_revenuecat(event_type: &str) -> Option<Mapped> {
    let name = match event_type {
        "INITIAL_PURCHASE" => "revenuecat_initial_purchase",
        "RENEWAL" => "revenuecat_subscription_renewed",
        "CANCELLATION" => "revenuecat_subscription_cancelled",
        "UNCANCELLATION" => "revenuecat_subscription_uncancelled",
        "EXPIRATION" => "revenuecat_subscription_expired",
        "BILLING_ISSUE" => "revenuecat_billing_issue",
        "REFUND" => "revenuecat_subscription_refunded",
        "TRANSFER" => "revenuecat_subscription_transferred",
        "SUBSCRIPTION_PAUSED" => "revenuecat_subscription_paused",
        "GRACE_PERIOD_STARTED" => "revenuecat_grace_period_started",
        "GRACE_PERIOD_EXTENDED" => "revenuecat_grace_period_extended",
        "GRACE_PERIOD_ENDED" => "revenuecat_grace_period_ended",
        _ => return None,
    };
    Some(Mapped {
        name,
        properties: Map::from_iter([("source".into(), json!("revenuecat"))]),
    })
}

/// A deterministic UUID-shaped PostHog insert id for one Stripe mapping.
fn insert_id(provider: &str, source_event_id: &str, event_name: &str) -> String {
    let hash = sha256_hex(format!("{provider}\0{source_event_id}\0{event_name}"));
    let mut bytes = hash.as_bytes()[..32].to_vec();
    bytes[12] = b'5';
    bytes[16] = match bytes[16] {
        b'0'..=b'3' => b'8',
        b'4'..=b'7' => b'9',
        b'8'..=b'b' => b'a',
        _ => b'b',
    };
    let hex = String::from_utf8(bytes).expect("hex is utf-8");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

impl Hosted {
    fn enqueue_telemetry(
        &self,
        transaction: &rusqlite::Transaction<'_>,
        provider: &str,
        source_event_id: &str,
        account: Option<&super::store::AccountRow>,
        mapped: Option<Mapped>,
        now: &str,
    ) -> rusqlite::Result<()> {
        let (Some(_), Some(account), Some(mapped)) = (&self.config.telemetry, account, mapped)
        else {
            return Ok(());
        };
        let environment = match self.config.environment {
            BillingEnvironment::Sandbox => "sandbox",
            BillingEnvironment::Production => "production",
        };
        let mut properties = mapped.properties;
        properties.insert("$lib".into(), json!("suplex-billing"));
        properties.insert("billing_environment".into(), json!(environment));
        properties.insert(
            "$groups".into(),
            json!({"host": account.installation_id, "company": account.company_id}),
        );
        let insert_id = insert_id(provider, source_event_id, mapped.name);
        properties.insert("$insert_id".into(), json!(insert_id));
        let source_key = format!("{provider}:{source_event_id}");
        transaction.execute(
            "INSERT OR IGNORE INTO billing_telemetry_events (source_event_id, event_name, distinct_id, company_id, insert_id, timestamp, properties_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                source_key,
                mapped.name,
                account.installation_id,
                account.company_id,
                insert_id,
                now,
                Value::Object(properties).to_string(),
            ],
        )?;
        Ok(())
    }

    /// Enqueues only when the service operator explicitly opted in. The
    /// account supplies Suplex installation/company identities; Stripe ids
    /// and billing personal data never enter this row.
    pub(super) fn enqueue_stripe_telemetry(
        &self,
        transaction: &rusqlite::Transaction<'_>,
        event: &Event,
        account: Option<&super::store::AccountRow>,
        received_at: &str,
    ) -> rusqlite::Result<()> {
        let timestamp = event
            .created
            .filter(|created| *created >= 0)
            .map(|created| iso(created.saturating_mul(1000)))
            .unwrap_or_else(|| received_at.to_owned());
        self.enqueue_telemetry(
            transaction,
            "stripe",
            &event.id,
            account,
            map_stripe(event),
            &timestamp,
        )
    }

    pub(super) fn enqueue_revenuecat_telemetry(
        &self,
        transaction: &rusqlite::Transaction<'_>,
        event_id: &str,
        event_type: &str,
        account: Option<&super::store::AccountRow>,
        received_at: &str,
        event_timestamp_ms: Option<i64>,
    ) -> rusqlite::Result<()> {
        let timestamp = event_timestamp_ms
            .filter(|timestamp| *timestamp >= 0)
            .map(iso)
            .unwrap_or_else(|| received_at.to_owned());
        self.enqueue_telemetry(
            transaction,
            "revenuecat",
            event_id,
            account,
            map_revenuecat(event_type),
            &timestamp,
        )
    }

    /// Sends one bounded batch. Every failure is contained here: billing
    /// events keep processing, while telemetry retries at most five times.
    pub(super) async fn run_telemetry_pass(&self) {
        let Some(config) = self.config.telemetry.clone() else {
            return;
        };
        let now = self.now_iso();
        let cutoff = iso(self.now_ms() - RETENTION_MS);
        if let Err(error) = self.query(|db| {
            db.execute(
                "DELETE FROM billing_telemetry_events WHERE COALESCE(sent_at, dropped_at) < ?1",
                [cutoff],
            )?;
            Ok(())
        }) {
            eprintln!("billing: telemetry retention failed: {error}");
        }
        let rows = match self.query(|db| {
            let mut statement = db.prepare(
                "SELECT source_event_id,event_name,distinct_id,insert_id,timestamp,properties_json,attempt_count FROM billing_telemetry_events WHERE sent_at IS NULL AND dropped_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?1) ORDER BY timestamp LIMIT ?2",
            )?;
            statement
                .query_map(params![now, DELIVERY_LIMIT], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        }) {
            Ok(rows) if !rows.is_empty() => rows,
            Ok(_) => return,
            Err(error) => {
                eprintln!("billing: telemetry queue read failed: {error}");
                return;
            }
        };
        let batch = rows
            .iter()
            .map(|(_, name, distinct_id, insert_id, timestamp, raw, _)| {
                json!({
                    "event": name,
                    "distinct_id": distinct_id,
                    "timestamp": timestamp,
                    "uuid": insert_id,
                    "properties": serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({})),
                })
            })
            .collect::<Vec<_>>();
        let delivered = reqwest::Client::new()
            .post(format!("{}/batch/", config.host.trim_end_matches('/')))
            .timeout(Duration::from_secs(10))
            .json(&json!({"api_key": config.key, "batch": batch}))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .is_ok();
        let finished = self.now_iso();
        for (source_id, _, _, _, _, _, attempts) in rows {
            let result = self.query(|db| {
                if delivered {
                    db.execute(
                        "UPDATE billing_telemetry_events SET sent_at = ?1,last_error = NULL WHERE source_event_id = ?2",
                        params![finished, source_id],
                    )?;
                } else if attempts + 1 >= MAX_ATTEMPTS {
                    db.execute(
                        "UPDATE billing_telemetry_events SET attempt_count = attempt_count + 1,dropped_at = ?1,last_error = 'delivery_failed' WHERE source_event_id = ?2",
                        params![finished, source_id],
                    )?;
                } else {
                    let next = iso(self.now_ms() + 30_000 * (attempts + 1));
                    db.execute(
                        "UPDATE billing_telemetry_events SET attempt_count = attempt_count + 1,next_attempt_at = ?1,last_error = 'delivery_failed' WHERE source_event_id = ?2",
                        params![next, source_id],
                    )?;
                }
                Ok(())
            });
            if let Err(error) = result {
                eprintln!("billing: telemetry queue update failed: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(event_type: &str, object: Value) -> Event {
        Event {
            id: "evt_private_123".into(),
            event_type: event_type.into(),
            livemode: false,
            created: Some(1_796_083_200),
            object: object.as_object().unwrap().clone(),
            previous_attributes: None,
        }
    }

    #[test]
    fn maps_only_explicit_money_and_allowlisted_properties() {
        let invoice = map_stripe(&event(
            "invoice.paid",
            json!({"id":"in_secret","customer_email":"private@example.test","amount_paid":4200,"amount_due":9000,"currency":"cad"}),
        ))
        .unwrap();
        assert_eq!(invoice.name, "billing_invoice_paid");
        assert_eq!(
            invoice.properties,
            json!({"amount_paid_minor":4200,"currency":"cad"})
                .as_object()
                .unwrap()
                .clone()
        );

        let failed = map_stripe(&event(
            "invoice.payment_failed",
            json!({"amount_due":4200,"amount_paid":100,"currency":"cad"}),
        ))
        .unwrap();
        assert_eq!(
            failed.properties,
            json!({"amount_due_minor":4200,"currency":"cad"})
                .as_object()
                .unwrap()
                .clone()
        );
        assert!(!failed.properties.contains_key("amount_paid_minor"));
    }

    #[test]
    fn insert_ids_are_stable_valid_uuids_and_change_by_event() {
        let first = insert_id("stripe", "evt_1", "billing_invoice_paid");
        assert_eq!(first, insert_id("stripe", "evt_1", "billing_invoice_paid"));
        assert_ne!(first, insert_id("stripe", "evt_2", "billing_invoice_paid"));
        assert_ne!(
            first,
            insert_id("revenuecat", "evt_1", "billing_invoice_paid")
        );
        assert!(uuid::Uuid::parse_str(&first).is_ok());
    }

    #[test]
    fn refund_money_is_only_the_verified_increment() {
        let mut first = event(
            "charge.refunded",
            json!({"amount_refunded":100,"currency":"usd"}),
        );
        first.previous_attributes = Some(json!({"amount_refunded":0}).as_object().unwrap().clone());
        let mut second = event(
            "charge.refunded",
            json!({"amount_refunded":200,"currency":"usd"}),
        );
        second.previous_attributes =
            Some(json!({"amount_refunded":100}).as_object().unwrap().clone());
        let first_amount = map_stripe(&first).unwrap().properties["refund_amount_minor"]
            .as_i64()
            .unwrap();
        let second_amount = map_stripe(&second).unwrap().properties["refund_amount_minor"]
            .as_i64()
            .unwrap();
        assert_eq!(first_amount + second_amount, 200);
        assert_eq!(
            map_stripe(&second).unwrap().properties,
            json!({"refund_amount_minor":100,"currency":"usd"})
                .as_object()
                .unwrap()
                .clone()
        );
        second.previous_attributes = None;
        assert_eq!(
            map_stripe(&second).unwrap().properties,
            json!({"currency":"usd"}).as_object().unwrap().clone()
        );
    }
}
