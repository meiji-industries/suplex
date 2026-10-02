//! RevenueCat REST adapter (no SDK exists for server-side receipt imports)
//! and the strict `pro` entitlement check.

use std::{collections::HashMap, time::Duration};

use serde_json::{Map, Value, json};

use super::{ProviderError, parse_ms};
use crate::billing::wire::BillingEnvironment;

pub const REVENUECAT_API_BASE: &str = "https://api.revenuecat.com";

#[derive(Clone, Debug, PartialEq)]
pub struct Entitlement {
    pub product_identifier: String,
    pub expires_date: Option<String>,
    pub grace_period_expires_date: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SubscriptionRecord {
    pub store: Option<String>,
    pub is_sandbox: Option<bool>,
    pub expires_date: Option<String>,
    pub grace_period_expires_date: Option<String>,
    pub refunded_at: Option<String>,
}

impl SubscriptionRecord {
    pub fn refunded(&self) -> bool {
        self.refunded_at.as_deref().is_some_and(|at| !at.is_empty())
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Subscriber {
    pub entitlements: HashMap<String, Entitlement>,
    pub subscriptions: HashMap<String, SubscriptionRecord>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProWindow {
    pub expires_at: String,
    pub grace_until: Option<String>,
}

fn text(entry: &Map<String, Value>, key: &str) -> Option<String> {
    entry.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub fn parse_subscriber(raw: &Value) -> Result<Subscriber, ProviderError> {
    let subscriber = raw
        .get("subscriber")
        .and_then(Value::as_object)
        .or_else(|| raw.as_object())
        .ok_or(ProviderError::new("revenuecat", Some(200)))?;
    let records = |key: &str| {
        subscriber
            .get(key)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(name, value)| Some((name.clone(), value.as_object()?)))
    };
    let entitlements = records("entitlements")
        .filter_map(|(name, entry)| {
            Some((
                name,
                Entitlement {
                    product_identifier: text(entry, "product_identifier")?,
                    expires_date: text(entry, "expires_date"),
                    grace_period_expires_date: text(entry, "grace_period_expires_date"),
                },
            ))
        })
        .collect();
    let subscriptions = records("subscriptions")
        .map(|(name, entry)| {
            (
                name,
                SubscriptionRecord {
                    store: text(entry, "store"),
                    is_sandbox: entry.get("is_sandbox").and_then(Value::as_bool),
                    expires_date: text(entry, "expires_date"),
                    grace_period_expires_date: text(entry, "grace_period_expires_date"),
                    refunded_at: text(entry, "refunded_at"),
                },
            )
        })
        .collect();
    Ok(Subscriber {
        entitlements,
        subscriptions,
    })
}

/// The `pro` entitlement window, or `None` when the proof is absent or
/// invalid. Required: the expected product (the Stripe price id for
/// Stripe-imported receipts), store `stripe`, a matching transaction
/// environment, parseable timestamps, and no refund. `None` never erases
/// Stripe-paid access; the caller combines the two.
pub fn pro_entitlement_window(
    subscriber: &Subscriber,
    environment: BillingEnvironment,
    expected_product: &str,
) -> Option<ProWindow> {
    let entitlement = subscriber
        .entitlements
        .get("pro")
        .filter(|entitlement| entitlement.product_identifier == expected_product)?;
    let record = subscriber
        .subscriptions
        .get(&entitlement.product_identifier)?;
    if record.store.as_deref() != Some("stripe")
        || record.is_sandbox != Some(environment == BillingEnvironment::Sandbox)
        || record.refunded()
    {
        return None;
    }
    let expires_at = entitlement
        .expires_date
        .clone()
        .or_else(|| record.expires_date.clone())
        .filter(|at| parse_ms(at).is_some())?;
    let grace_until = entitlement
        .grace_period_expires_date
        .clone()
        .or_else(|| record.grace_period_expires_date.clone());
    if grace_until
        .as_deref()
        .is_some_and(|at| parse_ms(at).is_none())
    {
        return None;
    }
    Some(ProWindow {
        expires_at,
        grace_until,
    })
}

/// `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut encoded = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[derive(Clone)]
pub struct RevenueCatClient {
    base: String,
    secret_api_key: String,
    stripe_public_api_key: String,
    http: reqwest::Client,
}

impl RevenueCatClient {
    pub fn new(base: &str, secret_api_key: &str, stripe_public_api_key: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_owned(),
            secret_api_key: secret_api_key.to_owned(),
            stripe_public_api_key: stripe_public_api_key.to_owned(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("RevenueCat HTTP client builds"),
        }
    }

    fn failure(status: Option<reqwest::StatusCode>) -> ProviderError {
        ProviderError::new("revenuecat", status.map(|status| status.as_u16()))
    }

    pub async fn import_receipt(
        &self,
        app_user_id: &str,
        fetch_token: &str,
    ) -> Result<(), ProviderError> {
        let response = self
            .http
            .post(format!("{}/v1/receipts", self.base))
            .bearer_auth(&self.stripe_public_api_key)
            .header("x-platform", "stripe")
            .json(&json!({"app_user_id": app_user_id, "fetch_token": fetch_token}))
            .send()
            .await
            .map_err(|_| Self::failure(None))?;
        if !response.status().is_success() {
            return Err(Self::failure(Some(response.status())));
        }
        Ok(())
    }

    pub async fn get_subscriber(
        &self,
        app_user_id: &str,
    ) -> Result<Option<Subscriber>, ProviderError> {
        let response = self
            .http
            .get(format!(
                "{}/v1/subscribers/{}",
                self.base,
                encode_component(app_user_id)
            ))
            .bearer_auth(&self.secret_api_key)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|_| Self::failure(None))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(Self::failure(Some(status)));
        }
        let body = response
            .json::<Value>()
            .await
            .map_err(|_| Self::failure(Some(status)))?;
        parse_subscriber(&body).map(Some)
    }
}
