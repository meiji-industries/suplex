//! Stripe REST adapter for API version 2025-09-30.clover. Billing periods
//! live on subscription items and invoice settlement on invoice payments;
//! the normalized types hide that layout from the rest of the service.

use std::{collections::HashMap, time::Duration};

use hmac::{Hmac, Mac};
use reqwest::Method;
use serde_json::{Map, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use super::ProviderError;

pub const STRIPE_API_BASE: &str = "https://api.stripe.com";
pub const STRIPE_VERSION: &str = "2025-09-30.clover";
const WEBHOOK_TOLERANCE_SECONDS: i64 = 300;

#[derive(Clone, Debug, PartialEq)]
pub struct Recurring {
    pub interval: String,
    pub interval_count: i64,
    pub usage_type: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Price {
    pub currency: String,
    pub unit_amount: Option<i64>,
    pub billing_scheme: Option<String>,
    pub livemode: bool,
    pub transform_quantity: bool,
    pub recurring: Option<Recurring>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Customer {
    pub id: String,
    pub deleted: bool,
    pub account_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub price_id: String,
    pub quantity: i64,
    pub period_start: i64,
    pub period_end: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Subscription {
    pub id: String,
    pub status: String,
    pub created: i64,
    pub cancel_at_period_end: bool,
    pub latest_invoice_id: Option<String>,
    /// The items of a pending update, when one exists.
    pub pending_update: Option<Vec<Item>>,
    pub items: Vec<Item>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceLine {
    pub price_id: Option<String>,
    pub subscription_item_id: Option<String>,
    pub period_start: i64,
    pub period_end: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InvoicePayment {
    pub status: String,
    /// Refunded amount of the card charge; `None` when the payment has no
    /// charge.
    pub charge_refunded: Option<i64>,
    /// Verified settlement with no card charge, for example a $0 invoice
    /// covered by credit. An unreadable charge is a `ProviderError` instead.
    pub settled_without_charge: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Invoice {
    pub id: String,
    pub status: Option<String>,
    pub created: i64,
    pub amount_due: i64,
    pub amount_paid: i64,
    pub hosted_invoice_url: Option<String>,
    pub subscription_id: Option<String>,
    pub payments: Vec<InvoicePayment>,
    pub lines: Vec<InvoiceLine>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CheckoutLine {
    pub price_id: String,
    pub quantity: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CheckoutSession {
    pub id: String,
    pub status: Option<String>,
    pub url: Option<String>,
    pub metadata: HashMap<String, String>,
    pub line_items: Vec<CheckoutLine>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub id: String,
    pub event_type: String,
    /// Environment proof from the signed envelope.
    pub livemode: bool,
    /// Provider event time in epoch seconds, when supplied.
    pub created: Option<i64>,
    pub object: Map<String, Value>,
    pub previous_attributes: Option<Map<String, Value>>,
}

pub struct CheckoutParams<'a> {
    pub customer_id: &'a str,
    pub price_id: &'a str,
    pub quantity: i64,
    pub automatic_tax: bool,
    pub success_url: &'a str,
    pub cancel_url: &'a str,
    pub metadata: &'a [(&'a str, String)],
    pub subscription_metadata: &'a [(&'a str, String)],
}

/// An increase carries the preview's proration timestamp so the charge
/// describes exactly the quoted operation; a decrease never prorates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeatDirection {
    Increase { proration_date: i64 },
    Decrease,
}

pub struct SeatUpdate<'a> {
    pub subscription_id: &'a str,
    pub item_id: &'a str,
    pub quantity: i64,
    pub direction: SeatDirection,
}

pub struct InvoicePreviewParams<'a> {
    pub subscription_id: &'a str,
    pub item_id: &'a str,
    pub price_id: &'a str,
    pub quantity: i64,
    pub proration_date: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvoicePreview {
    pub amount_due: i64,
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// An expandable field: an id string or an object with an id.
fn expandable_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(id) => Some(id.clone()),
        object => text(object, "id"),
    }
}

fn data(page: &Value) -> &[Value] {
    page.get("data")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn metadata(value: &Value) -> HashMap<String, String> {
    value
        .get("metadata")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
        .collect()
}

pub fn normalize_price(price: &Value) -> Price {
    Price {
        currency: text(price, "currency").unwrap_or_default(),
        unit_amount: price.get("unit_amount").and_then(Value::as_i64),
        billing_scheme: text(price, "billing_scheme"),
        livemode: flag(price, "livemode"),
        transform_quantity: price
            .get("transform_quantity")
            .is_some_and(|value| !value.is_null()),
        recurring: price
            .get("recurring")
            .filter(|value| value.is_object())
            .map(|recurring| Recurring {
                interval: text(recurring, "interval").unwrap_or_default(),
                interval_count: number(recurring, "interval_count"),
                usage_type: text(recurring, "usage_type").unwrap_or_default(),
            }),
    }
}

pub fn normalize_customer(customer: &Value) -> Customer {
    let deleted = flag(customer, "deleted");
    Customer {
        id: text(customer, "id").unwrap_or_default(),
        deleted,
        account_id: (!deleted)
            .then(|| metadata(customer).remove("account_id"))
            .flatten(),
    }
}

pub fn normalize_item(item: &Value) -> Item {
    Item {
        id: text(item, "id").unwrap_or_default(),
        price_id: expandable_id(item.get("price")).unwrap_or_default(),
        quantity: number(item, "quantity"),
        period_start: number(item, "current_period_start"),
        period_end: number(item, "current_period_end"),
    }
}

pub fn normalize_subscription(subscription: &Value) -> Subscription {
    Subscription {
        id: text(subscription, "id").unwrap_or_default(),
        status: text(subscription, "status").unwrap_or_default(),
        created: number(subscription, "created"),
        // The customer portal schedules a period-end cancellation through
        // `cancel_at` and leaves `cancel_at_period_end` false.
        cancel_at_period_end: flag(subscription, "cancel_at_period_end")
            || subscription
                .get("cancel_at")
                .is_some_and(|at| !at.is_null()),
        latest_invoice_id: expandable_id(subscription.get("latest_invoice")),
        pending_update: subscription
            .get("pending_update")
            .filter(|value| value.is_object())
            .map(|update| {
                update
                    .get("subscription_items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(normalize_item)
                    .collect()
            }),
        items: subscription
            .get("items")
            .map(data)
            .unwrap_or_default()
            .iter()
            .map(normalize_item)
            .collect(),
    }
}

pub fn normalize_invoice_line(line: &Value) -> InvoiceLine {
    let period = line.get("period");
    InvoiceLine {
        price_id: line
            .pointer("/pricing/price_details/price")
            .and_then(Value::as_str)
            .map(str::to_owned),
        subscription_item_id: line
            .pointer("/parent/subscription_item_details/subscription_item")
            .and_then(Value::as_str)
            .map(str::to_owned),
        period_start: period.map_or(0, |period| number(period, "start")),
        period_end: period.map_or(0, |period| number(period, "end")),
    }
}

pub fn normalize_checkout_session(session: &Value) -> CheckoutSession {
    CheckoutSession {
        id: text(session, "id").unwrap_or_default(),
        status: text(session, "status"),
        url: text(session, "url"),
        metadata: metadata(session),
        line_items: session
            .get("line_items")
            .map(data)
            .unwrap_or_default()
            .iter()
            .map(|line| CheckoutLine {
                price_id: expandable_id(line.get("price")).unwrap_or_default(),
                quantity: number(line, "quantity"),
            })
            .collect(),
    }
}

/// Lowercase hex HMAC-SHA256 of `{timestamp}.{payload}`.
pub fn webhook_signature(payload: &[u8], secret: &str, timestamp: i64) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(format!("{timestamp}.").as_bytes());
    mac.update(payload);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Verifies a Stripe webhook signature header (`t=…,v1=…`) over the raw
/// body and returns the event. Timestamps older than five minutes on the
/// injected clock are refused.
pub fn verify_webhook(
    payload: &[u8],
    header: &str,
    secret: &str,
    now_seconds: i64,
) -> Option<Event> {
    let mut timestamp = None;
    let mut signatures = Vec::new();
    for part in header.split(',') {
        match part.split_once('=') {
            Some(("t", value)) => timestamp = value.parse::<i64>().ok(),
            Some(("v1", value)) => signatures.push(value),
            _ => {}
        }
    }
    let timestamp = timestamp?;
    let expected = webhook_signature(payload, secret, timestamp);
    let matched = signatures
        .iter()
        .any(|signature| bool::from(signature.as_bytes().ct_eq(expected.as_bytes())));
    if !matched || now_seconds - timestamp > WEBHOOK_TOLERANCE_SECONDS {
        return None;
    }
    let event = serde_json::from_slice::<Value>(payload).ok()?;
    Some(Event {
        id: text(&event, "id")?,
        event_type: text(&event, "type")?,
        livemode: flag(&event, "livemode"),
        created: event.get("created").and_then(Value::as_i64),
        object: event.pointer("/data/object")?.as_object()?.clone(),
        previous_attributes: event
            .pointer("/data/previous_attributes")
            .and_then(Value::as_object)
            .cloned(),
    })
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Pairs = Vec<(String, String)>;

fn pairs<const N: usize>(entries: [(&str, String); N]) -> Pairs {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

#[derive(Clone)]
pub struct StripeClient {
    base: String,
    key: String,
    http: reqwest::Client,
}

impl StripeClient {
    /// No redirects and no retries: a retry belongs to the caller's
    /// idempotent command, not the transport.
    pub fn new(base: &str, key: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_owned(),
            key: key.to_owned(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Stripe HTTP client builds"),
        }
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        params: &Pairs,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let mut request = self
            .http
            .request(method.clone(), format!("{}{path}", self.base))
            .bearer_auth(&self.key)
            .header("stripe-version", STRIPE_VERSION);
        request = if method == Method::GET {
            request.query(params)
        } else {
            request.form(params)
        };
        if let Some(key) = idempotency_key {
            request = request.header("idempotency-key", key);
        }
        let failure = |status| ProviderError::new("stripe", status);
        let response = request.send().await.map_err(|_| failure(None))?;
        let status = response.status();
        let body = response.json::<Value>().await;
        if !status.is_success() {
            let missing = status == reqwest::StatusCode::NOT_FOUND
                || body.as_ref().is_ok_and(|body| {
                    body.pointer("/error/code").and_then(Value::as_str) == Some("resource_missing")
                });
            return Err(ProviderError {
                missing,
                ..failure(Some(status.as_u16()))
            });
        }
        body.map_err(|_| failure(Some(status.as_u16())))
    }

    async fn get(&self, path: &str, params: &Pairs) -> Result<Value, ProviderError> {
        self.request(Method::GET, path, params, None).await
    }

    async fn post(
        &self,
        path: &str,
        params: &Pairs,
        idempotency_key: Option<&str>,
    ) -> Result<Value, ProviderError> {
        self.request(Method::POST, path, params, idempotency_key)
            .await
    }

    /// A missing resource is `None`; every other failure propagates.
    async fn get_optional(
        &self,
        path: &str,
        params: &Pairs,
    ) -> Result<Option<Value>, ProviderError> {
        match self.get(path, params).await {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.missing => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Follows `has_more` with `starting_after` from `first` (or a fresh
    /// first page) so conclusions see every record.
    async fn list_all(
        &self,
        path: &str,
        params: &Pairs,
        first: Option<Value>,
    ) -> Result<Vec<Value>, ProviderError> {
        let mut page = match first {
            Some(page) => page,
            None => self.get(path, params).await?,
        };
        let mut all = data(&page).to_vec();
        while page.get("has_more").and_then(Value::as_bool) == Some(true) {
            let Some(last) = data(&page).last().and_then(|last| text(last, "id")) else {
                break;
            };
            let mut next = params.clone();
            next.push(("starting_after".into(), last));
            page = self.get(path, &next).await?;
            all.extend_from_slice(data(&page));
        }
        Ok(all)
    }

    pub async fn retrieve_price(&self, price_id: &str) -> Result<Price, ProviderError> {
        Ok(normalize_price(
            &self
                .get(&format!("/v1/prices/{price_id}"), &Pairs::new())
                .await?,
        ))
    }

    pub async fn create_customer(
        &self,
        account_id: &str,
        idempotency_key: &str,
    ) -> Result<Customer, ProviderError> {
        let params = pairs([("metadata[account_id]", account_id.to_owned())]);
        Ok(normalize_customer(
            &self
                .post("/v1/customers", &params, Some(idempotency_key))
                .await?,
        ))
    }

    pub async fn get_customer(&self, customer_id: &str) -> Result<Option<Customer>, ProviderError> {
        Ok(self
            .get_optional(&format!("/v1/customers/{customer_id}"), &Pairs::new())
            .await?
            .as_ref()
            .map(normalize_customer))
    }

    /// Stripe search paginates with its own `next_page` token.
    pub async fn search_customers_by_account_id(
        &self,
        account_id: &str,
    ) -> Result<Vec<Customer>, ProviderError> {
        let base = pairs([
            (
                "query",
                format!("metadata[\"account_id\"]:\"{account_id}\""),
            ),
            ("limit", "100".into()),
        ]);
        let mut page = self.get("/v1/customers/search", &base).await?;
        let mut customers = data(&page)
            .iter()
            .map(normalize_customer)
            .collect::<Vec<_>>();
        while page.get("has_more").and_then(Value::as_bool) == Some(true) {
            let Some(token) = text(&page, "next_page") else {
                break;
            };
            let mut next = base.clone();
            next.push(("page".into(), token));
            page = self.get("/v1/customers/search", &next).await?;
            customers.extend(data(&page).iter().map(normalize_customer));
        }
        Ok(customers)
    }

    pub async fn list_subscriptions(
        &self,
        customer_id: &str,
    ) -> Result<Vec<Subscription>, ProviderError> {
        let params = pairs([
            ("customer", customer_id.to_owned()),
            ("status", "all".into()),
            ("limit", "100".into()),
        ]);
        Ok(self
            .list_all("/v1/subscriptions", &params, None)
            .await?
            .iter()
            .map(normalize_subscription)
            .collect())
    }

    pub async fn list_invoices(&self, customer_id: &str) -> Result<Vec<Invoice>, ProviderError> {
        let params = pairs([
            ("customer", customer_id.to_owned()),
            ("limit", "25".into()),
            ("expand[0]", "data.payments".into()),
        ]);
        let mut invoices = Vec::new();
        for invoice in self.list_all("/v1/invoices", &params, None).await? {
            invoices.push(self.normalize_invoice(&invoice).await?);
        }
        Ok(invoices)
    }

    /// Payment and line reads propagate failures instead of mapping them to
    /// a missing invoice.
    pub async fn retrieve_invoice(
        &self,
        invoice_id: &str,
    ) -> Result<Option<Invoice>, ProviderError> {
        let params = pairs([("expand[0]", "payments".into())]);
        match self
            .get_optional(&format!("/v1/invoices/{invoice_id}"), &params)
            .await?
        {
            Some(invoice) => Ok(Some(self.normalize_invoice(&invoice).await?)),
            None => Ok(None),
        }
    }

    /// The embedded payments and lines lists are truncated first pages.
    async fn normalize_invoice(&self, invoice: &Value) -> Result<Invoice, ProviderError> {
        let id = text(invoice, "id").unwrap_or_default();
        let payments_params = pairs([("invoice", id.clone()), ("limit", "100".into())]);
        let embedded_payments = invoice.get("payments").filter(|value| value.is_object());
        let raw_payments = self
            .list_all(
                "/v1/invoice_payments",
                &payments_params,
                embedded_payments.cloned(),
            )
            .await?;
        let lines = match invoice.get("lines").filter(|value| value.is_object()) {
            Some(first) => {
                self.list_all(
                    &format!("/v1/invoices/{id}/lines"),
                    &pairs([("limit", "100".into())]),
                    Some(first.clone()),
                )
                .await?
            }
            None => Vec::new(),
        };
        let mut payments = Vec::new();
        for payment in &raw_payments {
            payments.push(self.resolve_payment(payment).await?);
        }
        Ok(Invoice {
            subscription_id: expandable_id(
                invoice.pointer("/parent/subscription_details/subscription"),
            ),
            status: text(invoice, "status"),
            created: number(invoice, "created"),
            amount_due: number(invoice, "amount_due"),
            amount_paid: number(invoice, "amount_paid"),
            hosted_invoice_url: text(invoice, "hosted_invoice_url"),
            payments,
            lines: lines.iter().map(normalize_invoice_line).collect(),
            id,
        })
    }

    /// Charge and refund evidence for one invoice payment. Payment-intent
    /// and charge reads propagate: an unreadable record is never "no
    /// charge". Only a settled payment carries refund evidence.
    async fn resolve_payment(&self, payment: &Value) -> Result<InvoicePayment, ProviderError> {
        let status = text(payment, "status").unwrap_or_default();
        let attached = payment.get("payment").filter(|value| !value.is_null());
        let payment_type = attached.and_then(|attached| text(attached, "type"));
        if status != "paid" {
            return Ok(InvoicePayment {
                status,
                charge_refunded: None,
                settled_without_charge: false,
            });
        }
        let malformed = || ProviderError::new("stripe", None);
        fn truthy(value: Option<&Value>) -> Option<&Value> {
            value.filter(|value| !matches!(value, Value::Null | Value::Bool(false)))
        }
        let mut intent_status = None;
        let mut charge = None;
        match payment_type.as_deref() {
            Some("charge") => {
                charge = Some(
                    truthy(attached.and_then(|attached| attached.get("charge")))
                        .ok_or_else(malformed)?
                        .clone(),
                );
            }
            Some("payment_intent") => {
                let mut intent =
                    truthy(attached.and_then(|attached| attached.get("payment_intent")))
                        .ok_or_else(malformed)?
                        .clone();
                if let Some(intent_id) = intent.as_str() {
                    intent = self
                        .get(
                            &format!("/v1/payment_intents/{intent_id}"),
                            &pairs([("expand[0]", "latest_charge".into())]),
                        )
                        .await?;
                }
                intent_status = Some(text(&intent, "status").ok_or_else(malformed)?);
                charge = intent
                    .get("latest_charge")
                    .filter(|value| !value.is_null())
                    .cloned();
            }
            _ => {}
        }
        if let Some(charge_id) = charge.as_ref().and_then(Value::as_str) {
            charge = Some(
                self.get(&format!("/v1/charges/{charge_id}"), &Pairs::new())
                    .await?,
            );
        }
        let charge_refunded = match charge {
            Some(charge) => {
                if charge.get("amount").and_then(Value::as_i64).is_none()
                    || charge.get("refunded").and_then(Value::as_bool).is_none()
                {
                    return Err(malformed());
                }
                Some(
                    charge
                        .get("amount_refunded")
                        .and_then(Value::as_i64)
                        .ok_or_else(malformed)?,
                )
            }
            None => None,
        };
        let settled_without_charge = charge_refunded.is_none()
            && payment_type.as_deref() != Some("charge")
            && (payment_type.as_deref() != Some("payment_intent")
                || intent_status.as_deref() == Some("succeeded"));
        Ok(InvoicePayment {
            status,
            charge_refunded,
            settled_without_charge,
        })
    }

    pub async fn list_open_checkout_sessions(
        &self,
        customer_id: &str,
    ) -> Result<Vec<CheckoutSession>, ProviderError> {
        let params = pairs([
            ("customer", customer_id.to_owned()),
            ("status", "open".into()),
            ("limit", "100".into()),
            ("expand[0]", "data.line_items".into()),
        ]);
        Ok(self
            .list_all("/v1/checkout/sessions", &params, None)
            .await?
            .iter()
            .map(normalize_checkout_session)
            .collect())
    }

    pub async fn create_checkout_session(
        &self,
        params: &CheckoutParams<'_>,
        idempotency_key: &str,
    ) -> Result<CheckoutSession, ProviderError> {
        let mut form = pairs([
            ("mode", "subscription".into()),
            ("customer", params.customer_id.to_owned()),
            ("line_items[0][price]", params.price_id.to_owned()),
            ("line_items[0][quantity]", params.quantity.to_string()),
            ("automatic_tax[enabled]", params.automatic_tax.to_string()),
            ("allow_promotion_codes", "true".into()),
            ("billing_address_collection", "auto".into()),
            ("customer_update[address]", "auto".into()),
            ("customer_update[name]", "auto".into()),
            ("success_url", params.success_url.to_owned()),
            ("cancel_url", params.cancel_url.to_owned()),
        ]);
        for (key, value) in params.metadata {
            form.push((format!("metadata[{key}]"), value.clone()));
        }
        for (key, value) in params.subscription_metadata {
            form.push((format!("subscription_data[metadata][{key}]"), value.clone()));
        }
        Ok(normalize_checkout_session(
            &self
                .post("/v1/checkout/sessions", &form, Some(idempotency_key))
                .await?,
        ))
    }

    /// Expiring a session that no longer exists is a no-op.
    pub async fn expire_checkout_session(&self, session_id: &str) -> Result<(), ProviderError> {
        match self
            .post(
                &format!("/v1/checkout/sessions/{session_id}/expire"),
                &Pairs::new(),
                None,
            )
            .await
        {
            Err(error) if !error.missing => Err(error),
            _ => Ok(()),
        }
    }

    pub async fn get_checkout_session(
        &self,
        session_id: &str,
    ) -> Result<Option<CheckoutSession>, ProviderError> {
        Ok(self
            .get_optional(
                &format!("/v1/checkout/sessions/{session_id}"),
                &pairs([("expand[0]", "line_items".into())]),
            )
            .await?
            .as_ref()
            .map(normalize_checkout_session))
    }

    /// The response is not returned: the caller settles from a fresh read.
    pub async fn update_subscription_quantity(
        &self,
        update: &SeatUpdate<'_>,
        idempotency_key: &str,
    ) -> Result<(), ProviderError> {
        let mut form = pairs([
            ("items[0][id]", update.item_id.to_owned()),
            ("items[0][quantity]", update.quantity.to_string()),
        ]);
        match update.direction {
            SeatDirection::Increase { proration_date } => form.extend(pairs([
                ("proration_behavior", "always_invoice".into()),
                ("proration_date", proration_date.to_string()),
                ("payment_behavior", "pending_if_incomplete".into()),
            ])),
            SeatDirection::Decrease => form.extend(pairs([("proration_behavior", "none".into())])),
        }
        self.post(
            &format!("/v1/subscriptions/{}", update.subscription_id),
            &form,
            Some(idempotency_key),
        )
        .await?;
        Ok(())
    }

    /// Same immediate-invoice behavior as the mutation; Stripe's default
    /// `create_prorations` would understate the charge.
    pub async fn create_invoice_preview(
        &self,
        params: &InvoicePreviewParams<'_>,
    ) -> Result<InvoicePreview, ProviderError> {
        let form = pairs([
            ("subscription", params.subscription_id.to_owned()),
            (
                "subscription_details[items][0][id]",
                params.item_id.to_owned(),
            ),
            (
                "subscription_details[items][0][quantity]",
                params.quantity.to_string(),
            ),
            (
                "subscription_details[items][0][price]",
                params.price_id.to_owned(),
            ),
            (
                "subscription_details[proration_date]",
                params.proration_date.to_string(),
            ),
            (
                "subscription_details[proration_behavior]",
                "always_invoice".into(),
            ),
        ]);
        let invoice = self
            .post("/v1/invoices/create_preview", &form, None)
            .await?;
        match invoice.get("amount_due").and_then(Value::as_i64) {
            Some(amount_due)
                if amount_due >= 0 && text(&invoice, "currency").as_deref() == Some("usd") =>
            {
                Ok(InvoicePreview { amount_due })
            }
            _ => Err(ProviderError::new("stripe", None)),
        }
    }

    pub async fn create_portal_session(
        &self,
        customer_id: &str,
        configuration_id: &str,
        return_url: &str,
    ) -> Result<Option<String>, ProviderError> {
        let form = pairs([
            ("customer", customer_id.to_owned()),
            ("configuration", configuration_id.to_owned()),
            ("return_url", return_url.to_owned()),
        ]);
        Ok(text(
            &self
                .post("/v1/billing_portal/sessions", &form, None)
                .await?,
            "url",
        ))
    }
}

#[cfg(test)]
include!("../../../tests/billing/stripe.rs");
