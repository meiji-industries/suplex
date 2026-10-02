// Loopback provider fakes and the hosted-service fixture. FakeStripe and
// FakeRevenueCat speak the provider wire formats over real HTTP on
// 127.0.0.1:0, keep in-memory state, replay idempotency keys, inject
// failures, and record calls. Tests change state through `with`.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
};

use axum::{
    Json, Router,
    body::Bytes,

    http::{HeaderMap, Method, StatusCode, Uri},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use indexmap::IndexMap;
use serde_json::{Value, json};

use super::{
    Hosted, HostedConfig, revenuecat::RevenueCatClient, server::router, store,
    stripe::{StripeClient, webhook_signature},
};
use crate::billing::wire::BillingEnvironment;

pub const PRICE_ID: &str = "price_pro_monthly";
pub const WEBHOOK_SECRET: &str = "whsec_fake";
pub const RC_AUTHORIZATION: &str = "rc-hook-auth";
pub const RC_APP_ID: &str = "app_suplex";
pub const ORIGIN: &str = "http://localhost:4211";

pub type Pairs = Vec<(String, String)>;
pub type TestClock = Arc<AtomicI64>;

fn pairs(raw: &[u8]) -> Pairs {
    url::form_urlencoded::parse(raw).into_owned().collect()
}

pub fn field<'a>(pairs: &'a Pairs, key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

/// Starts `router` on a loopback port and returns its base URL.
pub async fn spawn(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(axum::serve(listener, router).into_future());
    format!("http://{address}")
}

/// A running fake with shared, directly mutable state.
pub struct Fake<S> {
    pub url: String,
    state: Arc<Mutex<S>>,
}

impl<S> Fake<S> {
    pub fn with<T>(&self, change: impl FnOnce(&mut S) -> T) -> T {
        change(&mut self.state.lock().unwrap())
    }
}

/// One request as a fake received it.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: Method,
    pub path: String,
    pub query: Pairs,
    pub form: Pairs,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Recorded {
    pub fn segments(&self) -> Vec<&str> {
        self.path.trim_matches('/').split('/').collect()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

/// Serves every request through `respond` with the shared state locked.
async fn start<S: Send + 'static>(
    state: S,
    respond: impl Fn(&mut S, &Recorded) -> (u16, Value) + Send + Sync + 'static,
) -> Fake<S> {
    let state = Arc::new(Mutex::new(state));
    let shared = state.clone();
    let respond = Arc::new(respond);
    let router = Router::new().fallback(
        move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let (state, respond) = (shared.clone(), respond.clone());
            async move {
                let call = Recorded {
                    method,
                    path: uri.path().to_owned(),
                    query: pairs(uri.query().unwrap_or_default().as_bytes()),
                    form: pairs(&body),
                    headers,
                    body,
                };
                let (status, value) = respond(&mut state.lock().unwrap(), &call);
                (StatusCode::from_u16(status).unwrap(), Json(value))
            }
        },
    );
    Fake {
        url: spawn(router).await,
        state,
    }
}

// ---------------------------------------------------------------------------
// A recording stub for adapter wire tests
// ---------------------------------------------------------------------------

pub type Stub = Fake<Vec<Recorded>>;

impl Stub {
    pub fn calls(&self) -> Vec<Recorded> {
        self.with(|calls| calls.clone())
    }
}

/// Records every request and answers with `respond`.
pub async fn stub(respond: impl Fn(&Recorded) -> (u16, Value) + Send + Sync + 'static) -> Stub {
    start(Vec::new(), move |calls: &mut Vec<Recorded>, call| {
        calls.push(call.clone());
        respond(call)
    })
    .await
}

// ---------------------------------------------------------------------------
// FakeStripe
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct FakeCustomer {
    pub id: String,
    pub account_id: String,
}

#[derive(Clone, Debug)]
pub struct FakeItem {
    pub id: String,
    pub price_id: String,
    pub quantity: i64,
    pub period_start: i64,
    pub period_end: i64,
}

#[derive(Clone, Debug)]
pub struct FakeSubscription {
    pub id: String,
    pub customer_id: String,
    pub status: String,
    pub created: i64,
    pub cancel_at_period_end: bool,
    pub latest_invoice_id: Option<String>,
    pub pending_update: Option<Vec<FakeItem>>,
    pub items: Vec<FakeItem>,
}

#[derive(Clone, Debug)]
pub struct FakeCharge {
    pub amount: i64,
    pub amount_refunded: i64,
    pub refunded: bool,
}

#[derive(Clone, Debug)]
pub struct FakePayment {
    pub status: String,
    pub charge: Option<FakeCharge>,
    pub settled_without_charge: bool,
}

impl FakePayment {
    pub fn charge(amount: i64, amount_refunded: i64) -> Self {
        Self {
            status: "paid".into(),
            charge: Some(FakeCharge {
                amount,
                amount_refunded,
                refunded: amount_refunded >= amount,
            }),
            settled_without_charge: false,
        }
    }

    pub fn credit() -> Self {
        Self {
            status: "paid".into(),
            charge: None,
            settled_without_charge: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct FakeLine {
    pub price_id: String,
    pub subscription_item_id: String,
    pub subscription_id: String,
    pub amount: i64,
    pub period_start: i64,
    pub period_end: i64,
}

#[derive(Clone, Debug)]
pub struct FakeInvoice {
    pub id: String,
    pub status: String,
    pub created: i64,
    pub amount_due: i64,
    pub amount_paid: i64,
    pub hosted_invoice_url: String,
    pub subscription_id: Option<String>,
    pub payments: Vec<FakePayment>,
    pub lines: Vec<FakeLine>,
}

#[derive(Clone, Debug)]
pub struct FakeSession {
    pub id: String,
    pub status: String,
    pub payment_status: String,
    pub url: String,
    pub customer_id: String,
    pub subscription_id: Option<String>,
    pub metadata: IndexMap<String, String>,
    pub line_items: Vec<(String, i64)>,
}

/// One seat update request as Stripe received it.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateCall {
    pub key: String,
    pub subscription_id: String,
    pub item_id: String,
    pub quantity: i64,
    pub proration_behavior: String,
    pub proration_date: Option<i64>,
    pub payment_behavior: Option<String>,
}

pub struct StripeState {
    clock: TestClock,
    pub price: Value,
    pub customers: IndexMap<String, FakeCustomer>,
    pub subscriptions: IndexMap<String, FakeSubscription>,
    pub sessions: IndexMap<String, FakeSession>,
    pub invoices: IndexMap<String, FakeInvoice>,
    pub portal_requests: Vec<String>,
    pub create_customer_keys: Vec<String>,
    pub create_session_keys: Vec<String>,
    pub expire_calls: Vec<String>,
    pub update_calls: Vec<UpdateCall>,
    pub preview_calls: Vec<Pairs>,
    pub preview_amount_due: i64,
    pub preview_currency: String,
    pub fail_reads: bool,
    /// An increase opens an unpaid invoice and a pending update instead of
    /// applying.
    pub pending_increase: bool,
    /// The next update fails before any mutation: it never landed.
    pub fail_next_update: bool,
    /// The next update mutates and records its key, then loses the
    /// response.
    pub drop_next_update_result: bool,
    sequences: HashMap<&'static str, i64>,
    session_replays: HashMap<String, (Pairs, Value)>,
    update_replays: HashMap<String, (UpdateCall, Value)>,
}

fn stripe_error(code: &str) -> Value {
    json!({"error": {"type": "invalid_request_error", "code": code}})
}

fn missing() -> (u16, Value) {
    (404, stripe_error("resource_missing"))
}

fn page(data: Vec<Value>) -> Value {
    json!({"object": "list", "data": data, "has_more": false})
}

impl StripeState {
    fn new(clock: TestClock) -> Self {
        Self {
            clock,
            price: json!({
                "id": PRICE_ID,
                "object": "price",
                "currency": "usd",
                "unit_amount": 2000,
                "billing_scheme": "per_unit",
                "livemode": false,
                "transform_quantity": null,
                "recurring": {"interval": "month", "interval_count": 1, "usage_type": "licensed"},
            }),
            customers: IndexMap::new(),
            subscriptions: IndexMap::new(),
            sessions: IndexMap::new(),
            invoices: IndexMap::new(),
            portal_requests: Vec::new(),
            create_customer_keys: Vec::new(),
            create_session_keys: Vec::new(),
            expire_calls: Vec::new(),
            update_calls: Vec::new(),
            preview_calls: Vec::new(),
            preview_amount_due: 1300,
            preview_currency: "usd".into(),
            fail_reads: false,
            pending_increase: false,
            fail_next_update: false,
            drop_next_update_result: false,
            sequences: HashMap::new(),
            session_replays: HashMap::new(),
            update_replays: HashMap::new(),
        }
    }

    pub fn now_seconds(&self) -> i64 {
        self.clock.load(Ordering::SeqCst).div_euclid(1000)
    }

    fn next(&mut self, prefix: &'static str) -> String {
        let sequence = self.sequences.entry(prefix).or_insert(0);
        *sequence += 1;
        format!("{prefix}_{sequence}")
    }

    pub fn subscription(&mut self, id: &str) -> &mut FakeSubscription {
        self.subscriptions.get_mut(id).unwrap()
    }

    pub fn invoice(&mut self, id: &str) -> &mut FakeInvoice {
        self.invoices.get_mut(id).unwrap()
    }

    /// The first invoice recorded for a subscription.
    pub fn first_invoice(&self, subscription_id: &str) -> String {
        self.invoices
            .values()
            .find(|invoice| invoice.subscription_id.as_deref() == Some(subscription_id))
            .unwrap()
            .id
            .clone()
    }

    pub fn open_invoice(&self) -> String {
        self.invoices
            .values()
            .find(|invoice| invoice.status == "open")
            .unwrap()
            .id
            .clone()
    }

    pub fn create_customer(&mut self, account_id: &str) -> String {
        if let Some(existing) = self
            .customers
            .values()
            .find(|customer| customer.account_id == account_id)
        {
            return existing.id.clone();
        }
        let id = self.next("cus");
        self.customers.insert(
            id.clone(),
            FakeCustomer {
                id: id.clone(),
                account_id: account_id.into(),
            },
        );
        id
    }

    /// A normal purchase: an active subscription with a settled invoice
    /// whose service-period line covers the item period.
    pub fn add_subscription(&mut self, customer_id: &str, quantity: i64) -> String {
        let id = self.add_unsettled_subscription(customer_id, quantity);
        let amount = quantity * 2000;
        let mut invoice = self.new_invoice(Some(&id));
        invoice.amount_due = amount;
        invoice.amount_paid = amount;
        invoice.payments = vec![if amount > 0 {
            FakePayment::charge(amount, 0)
        } else {
            FakePayment::credit()
        }];
        invoice.lines = vec![self.cover_line(&id)];
        let invoice_id = self.insert_invoice(invoice);
        self.subscription(&id).latest_invoice_id = Some(invoice_id);
        id
    }

    /// An active subscription with no settlement evidence.
    pub fn add_unsettled_subscription(&mut self, customer_id: &str, quantity: i64) -> String {
        let now = self.now_seconds();
        let id = self.next("sub");
        let item = FakeItem {
            id: format!("si_{}", self.subscriptions.len() + 1),
            price_id: PRICE_ID.into(),
            quantity,
            period_start: now - 1000,
            period_end: now + 2_000_000,
        };
        self.subscriptions.insert(
            id.clone(),
            FakeSubscription {
                id: id.clone(),
                customer_id: customer_id.into(),
                status: "active".into(),
                created: now,
                cancel_at_period_end: false,
                latest_invoice_id: None,
                pending_update: None,
                items: vec![item],
            },
        );
        id
    }

    /// A recurring service-period line for the subscription's item.
    pub fn cover_line(&self, subscription_id: &str) -> FakeLine {
        let item = &self.subscriptions[subscription_id].items[0];
        FakeLine {
            price_id: item.price_id.clone(),
            subscription_item_id: item.id.clone(),
            subscription_id: subscription_id.into(),
            amount: item.quantity * 2000,
            period_start: item.period_start,
            period_end: item.period_end,
        }
    }

    /// A paid $20 invoice with a fresh id; adjust it, then `insert_invoice`.
    pub fn new_invoice(&mut self, subscription_id: Option<&str>) -> FakeInvoice {
        let id = self.next("in");
        FakeInvoice {
            hosted_invoice_url: format!("https://invoice.stripe.com/i/{id}"),
            id,
            status: "paid".into(),
            created: self.now_seconds(),
            amount_due: 2000,
            amount_paid: 2000,
            subscription_id: subscription_id.map(str::to_owned),
            payments: Vec::new(),
            lines: Vec::new(),
        }
    }

    pub fn insert_invoice(&mut self, invoice: FakeInvoice) -> String {
        let id = invoice.id.clone();
        self.invoices.insert(id.clone(), invoice);
        id
    }

    /// Marks an open session paid, as a real payment would.
    pub fn complete_checkout_session(&mut self, session_id: &str) -> String {
        let session = self.sessions[session_id].clone();
        assert_eq!(session.status, "open", "no open checkout session {session_id}");
        let quantity = session.metadata["suplex_quantity"].parse().unwrap();
        let subscription_id = self.add_subscription(&session.customer_id, quantity);
        let session = self.sessions.get_mut(session_id).unwrap();
        session.status = "complete".into();
        session.payment_status = "paid".into();
        session.subscription_id = Some(subscription_id.clone());
        subscription_id
    }

    pub fn expire_checkout_session(&mut self, session_id: &str) {
        self.expire_calls.push(session_id.into());
        let Some(session) = self.sessions.get_mut(session_id) else {
            return;
        };
        if session.status != "open" {
            return;
        }
        if session.metadata.get("suplex_complete_on_expire").map(String::as_str) == Some("true") {
            self.complete_checkout_session(session_id);
        } else {
            session.status = "expired".into();
        }
    }

    fn customer_json(customer: &FakeCustomer) -> Value {
        json!({"id": customer.id, "object": "customer", "metadata": {"account_id": customer.account_id}})
    }

    fn item_json(item: &FakeItem) -> Value {
        json!({
            "id": item.id,
            "price": {"id": item.price_id},
            "quantity": item.quantity,
            "current_period_start": item.period_start,
            "current_period_end": item.period_end,
        })
    }

    fn subscription_json(subscription: &FakeSubscription) -> Value {
        json!({
            "id": subscription.id,
            "object": "subscription",
            "customer": subscription.customer_id,
            "status": subscription.status,
            "created": subscription.created,
            "cancel_at_period_end": subscription.cancel_at_period_end,
            "latest_invoice": subscription.latest_invoice_id,
            "pending_update": subscription.pending_update.as_ref().map(|items| json!({
                "subscription_items": items.iter().map(Self::item_json).collect::<Vec<_>>(),
            })),
            "items": page(subscription.items.iter().map(Self::item_json).collect()),
            "metadata": {},
        })
    }

    fn payment_json(invoice_id: &str, index: usize, payment: &FakePayment) -> Value {
        let attached = match (&payment.charge, payment.settled_without_charge) {
            (Some(charge), _) => json!({"type": "charge", "charge": {
                "id": format!("ch_{invoice_id}_{index}"),
                "amount": charge.amount,
                "amount_refunded": charge.amount_refunded,
                "refunded": charge.refunded,
            }}),
            (None, true) => json!({"type": "payment_intent", "payment_intent": {
                "id": format!("pi_{invoice_id}_{index}"),
                "status": "succeeded",
                "latest_charge": null,
            }}),
            (None, false) => {
                json!({"type": "payment_intent", "payment_intent": format!("pi_{invoice_id}_{index}")})
            }
        };
        json!({"id": format!("ip_{invoice_id}_{index}"), "status": payment.status, "payment": attached})
    }

    fn invoice_json(invoice: &FakeInvoice) -> Value {
        json!({
            "id": invoice.id,
            "object": "invoice",
            "status": invoice.status,
            "created": invoice.created,
            "amount_due": invoice.amount_due,
            "amount_paid": invoice.amount_paid,
            "currency": "usd",
            "hosted_invoice_url": invoice.hosted_invoice_url,
            "parent": {"subscription_details": {"subscription": invoice.subscription_id}},
            "payments": page(invoice.payments.iter().enumerate().map(|(index, payment)| Self::payment_json(&invoice.id, index + 1, payment)).collect()),
            "lines": page(invoice.lines.iter().enumerate().map(|(index, line)| json!({
                "id": format!("il_{}_{}", invoice.id, index + 1),
                "amount": line.amount,
                "currency": "usd",
                "period": {"start": line.period_start, "end": line.period_end},
                "pricing": {"price_details": {"price": line.price_id, "product": "prod_pro"}},
                "parent": {"subscription_item_details": {
                    "subscription_item": line.subscription_item_id,
                    "subscription": line.subscription_id,
                    "proration": false,
                }},
            })).collect()),
        })
    }

    fn session_json(session: &FakeSession) -> Value {
        json!({
            "id": session.id,
            "object": "checkout.session",
            "status": session.status,
            "payment_status": session.payment_status,
            "url": session.url,
            "customer": session.customer_id,
            "subscription": session.subscription_id,
            "metadata": session.metadata,
            "line_items": page(session.line_items.iter().map(|(price, quantity)| json!({"price": {"id": price}, "quantity": quantity})).collect()),
        })
    }

    fn create_checkout_session(&mut self, form: &Pairs, key: String) -> (u16, Value) {
        self.create_session_keys.push(key.clone());
        let compared = ["customer", "line_items[0][price]", "line_items[0][quantity]", "success_url", "cancel_url"]
            .iter()
            .map(|name| ((*name).to_owned(), field(form, name).unwrap_or_default().to_owned()))
            .collect::<Pairs>();
        if let Some((params, response)) = self.session_replays.get(&key) {
            if *params != compared {
                return (400, stripe_error("idempotency_key_in_use"));
            }
            return (200, response.clone());
        }
        let id = self.next("cs");
        let metadata = form
            .iter()
            .filter_map(|(name, value)| {
                let key = name.strip_prefix("metadata[")?.strip_suffix(']')?;
                Some((key.to_owned(), value.clone()))
            })
            .collect();
        let session = FakeSession {
            url: format!("https://checkout.stripe.com/c/pay/{id}"),
            id: id.clone(),
            status: "open".into(),
            payment_status: "unpaid".into(),
            customer_id: field(form, "customer").unwrap_or_default().into(),
            subscription_id: None,
            metadata,
            line_items: vec![(
                field(form, "line_items[0][price]").unwrap_or_default().into(),
                field(form, "line_items[0][quantity]").unwrap_or("0").parse().unwrap(),
            )],
        };
        let response = Self::session_json(&session);
        self.sessions.insert(id, session);
        self.session_replays.insert(key, (compared, response.clone()));
        (200, response)
    }

    fn update_subscription(&mut self, subscription_id: &str, form: &Pairs, key: String) -> (u16, Value) {
        let call = UpdateCall {
            key: key.clone(),
            subscription_id: subscription_id.into(),
            item_id: field(form, "items[0][id]").unwrap_or_default().into(),
            quantity: field(form, "items[0][quantity]").unwrap_or("0").parse().unwrap(),
            proration_behavior: field(form, "proration_behavior").unwrap_or_default().into(),
            proration_date: field(form, "proration_date").map(|date| date.parse().unwrap()),
            payment_behavior: field(form, "payment_behavior").map(str::to_owned),
        };
        self.update_calls.push(call.clone());
        if let Some((recorded, response)) = self.update_replays.get(&key) {
            if *recorded != call {
                return (400, stripe_error("idempotency_key_in_use"));
            }
            return (200, response.clone());
        }
        let now = self.now_seconds();
        let Some(subscription) = self.subscriptions.get(subscription_id) else {
            return missing();
        };
        let Some(item) = subscription.items.iter().find(|item| item.id == call.item_id).cloned() else {
            return missing();
        };
        if self.fail_next_update {
            self.fail_next_update = false;
            return (503, json!({"error": {"type": "api_error"}}));
        }
        let increase = call.proration_behavior == "always_invoice";
        if increase && call.proration_date.is_none() {
            return (400, stripe_error("parameter_missing"));
        }
        if self.pending_increase && increase && call.quantity > item.quantity {
            let mut invoice = self.new_invoice(Some(subscription_id));
            invoice.status = "open".into();
            invoice.created = now;
            invoice.amount_due = self.preview_amount_due;
            invoice.amount_paid = 0;
            let invoice_id = self.insert_invoice(invoice);
            let subscription = self.subscription(subscription_id);
            subscription.latest_invoice_id = Some(invoice_id);
            subscription.pending_update = Some(vec![FakeItem {
                quantity: call.quantity,
                ..item
            }]);
        } else {
            let subscription = self.subscription(subscription_id);
            subscription
                .items
                .iter_mut()
                .find(|candidate| candidate.id == call.item_id)
                .unwrap()
                .quantity = call.quantity;
        }
        let response = Self::subscription_json(&self.subscriptions[subscription_id]);
        self.update_replays.insert(key, (call, response.clone()));
        if self.drop_next_update_result {
            // The mutation landed and the key is recorded; only the response
            // is lost. A replay must deduplicate, not mutate again.
            self.drop_next_update_result = false;
            return (503, json!({"error": {"type": "api_error"}}));
        }
        (200, response)
    }

    fn handle(&mut self, call: &Recorded) -> (u16, Value) {
        let (query, form) = (&call.query, &call.form);
        let key = call.header("idempotency-key").unwrap_or_default().to_owned();
        let get = call.method == Method::GET;
        if get && self.fail_reads {
            return (503, json!({"error": {"type": "api_error"}}));
        }
        match call.segments().as_slice() {
            ["v1", "prices", _] if get => (200, self.price.clone()),
            ["v1", "customers"] => {
                self.create_customer_keys.push(key);
                let account_id = field(form, "metadata[account_id]").unwrap_or_default().to_owned();
                let id = self.create_customer(&account_id);
                (200, Self::customer_json(&self.customers[&id]))
            }
            ["v1", "customers", "search"] => {
                let account_id = field(query, "query")
                    .and_then(|query| query.strip_prefix("metadata[\"account_id\"]:\""))
                    .and_then(|query| query.strip_suffix('"'))
                    .unwrap_or_default();
                let found: Vec<_> = self
                    .customers
                    .values()
                    .filter(|customer| customer.account_id == account_id)
                    .map(Self::customer_json)
                    .collect();
                (200, json!({"object": "search_result", "data": found, "has_more": false, "next_page": null}))
            }
            ["v1", "customers", id] => self
                .customers
                .get(*id)
                .map_or_else(missing, |customer| (200, Self::customer_json(customer))),
            ["v1", "subscriptions"] => {
                let customer = field(query, "customer").unwrap_or_default();
                let found = self
                    .subscriptions
                    .values()
                    .filter(|subscription| subscription.customer_id == customer)
                    .map(Self::subscription_json)
                    .collect();
                (200, page(found))
            }
            ["v1", "subscriptions", id] => self.update_subscription(id, form, key),
            ["v1", "invoices"] => {
                let customer = field(query, "customer").unwrap_or_default();
                let found = self
                    .invoices
                    .values()
                    .filter(|invoice| {
                        invoice.subscription_id.as_ref().is_some_and(|subscription| {
                            self.subscriptions
                                .get(subscription)
                                .is_some_and(|subscription| subscription.customer_id == customer)
                        })
                    })
                    .map(Self::invoice_json)
                    .collect();
                (200, page(found))
            }
            ["v1", "invoices", "create_preview"] => {
                self.preview_calls.push(form.clone());
                (200, json!({"amount_due": self.preview_amount_due, "currency": self.preview_currency}))
            }
            ["v1", "invoices", id] => self
                .invoices
                .get(*id)
                .map_or_else(missing, |invoice| (200, Self::invoice_json(invoice))),
            ["v1", "checkout", "sessions"] if get => {
                let customer = field(query, "customer").unwrap_or_default();
                let found = self
                    .sessions
                    .values()
                    .filter(|session| session.customer_id == customer && session.status == "open")
                    .map(Self::session_json)
                    .collect();
                (200, page(found))
            }
            ["v1", "checkout", "sessions"] => self.create_checkout_session(form, key),
            ["v1", "checkout", "sessions", id, "expire"] => {
                self.expire_checkout_session(id);
                self.sessions
                    .get(*id)
                    .map_or_else(missing, |session| (200, Self::session_json(session)))
            }
            ["v1", "checkout", "sessions", id] => self
                .sessions
                .get(*id)
                .map_or_else(missing, |session| (200, Self::session_json(session))),
            ["v1", "billing_portal", "sessions"] => {
                self.portal_requests.push(format!(
                    "{}:{}:{}",
                    field(form, "customer").unwrap_or_default(),
                    field(form, "configuration").unwrap_or_default(),
                    field(form, "return_url").unwrap_or_default(),
                ));
                let url = format!("https://billing.stripe.com/p/session_{}", self.portal_requests.len());
                (200, json!({"id": "bps_1", "url": url}))
            }
            _ => missing(),
        }
    }
}

pub async fn fake_stripe(clock: TestClock) -> Fake<StripeState> {
    start(StripeState::new(clock), StripeState::handle).await
}

// ---------------------------------------------------------------------------
// FakeRevenueCat
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct RevenueCatState {
    /// `(app_user_id, fetch_token)` per accepted import.
    pub imports: Vec<(String, String)>,
    /// The subscriber object every read returns; `None` is a 404.
    pub subscriber: Option<Value>,
    pub fail_import: bool,
    pub fail_get: bool,
}

pub async fn fake_revenuecat() -> Fake<RevenueCatState> {
    start(RevenueCatState::default(), |state: &mut RevenueCatState, call| {
        match (call.method.as_str(), call.segments().as_slice()) {
            ("POST", ["v1", "receipts"]) if state.fail_import => (503, json!({})),
            ("POST", ["v1", "receipts"]) => {
                let body = call.json();
                let text = |key: &str| body[key].as_str().unwrap_or_default().to_owned();
                state.imports.push((text("app_user_id"), text("fetch_token")));
                (200, json!({"subscriber": {}}))
            }
            ("GET", ["v1", "subscribers", _]) if state.fail_get => (503, json!({})),
            ("GET", ["v1", "subscribers", _]) => state
                .subscriber
                .clone()
                .map_or((404, json!({})), |subscriber| {
                    (200, json!({"subscriber": subscriber}))
                }),
            _ => (404, json!({})),
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// Hosted service fixture
// ---------------------------------------------------------------------------

pub fn start_ms() -> i64 {
    chrono::DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
        .unwrap()
        .timestamp_millis()
}

pub fn random_credential() -> String {
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret).unwrap();
    URL_SAFE_NO_PAD.encode(secret)
}

pub struct Account {
    pub id: String,
    pub credential: String,
    pub registration: Value,
}

pub struct Provisioned {
    pub account: Account,
    pub customer: String,
    pub subscription: String,
}

pub struct Fixture {
    pub url: String,
    pub hosted: Hosted,
    pub stripe: Fake<StripeState>,
    pub revenuecat: Fake<RevenueCatState>,
    pub clock: TestClock,
    pub path: PathBuf,
    directory: PathBuf,
    http: reqwest::Client,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

pub fn hosted_config(environment: BillingEnvironment) -> HostedConfig {
    HostedConfig {
        origin: ORIGIN.into(),
        environment,
        stripe_price_id: PRICE_ID.into(),
        stripe_portal_configuration_id: "bpc_fake".into(),
        stripe_webhook_secret: WEBHOOK_SECRET.into(),
        revenuecat_app_id: RC_APP_ID.into(),
        revenuecat_webhook_authorization: RC_AUTHORIZATION.into(),
    }
}

impl Fixture {
    pub async fn new() -> Self {
        Self::with_environment(BillingEnvironment::Sandbox).await
    }

    pub async fn with_environment(environment: BillingEnvironment) -> Self {
        let clock = Arc::new(AtomicI64::new(start_ms()));
        let directory = std::env::temp_dir().join(format!("suplex-billing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("billing.sqlite");
        let stripe = fake_stripe(clock.clone()).await;
        let revenuecat = fake_revenuecat().await;
        let hosted = Self::hosted(&path, environment, &stripe.url, &revenuecat.url, &clock);
        let url = spawn(router(hosted.clone())).await;
        Self {
            url,
            hosted,
            stripe,
            revenuecat,
            clock,
            path,
            directory,
            http: reqwest::Client::new(),
        }
    }

    /// A service instance on `path`, as after a restart.
    pub fn hosted(
        path: &std::path::Path,
        environment: BillingEnvironment,
        stripe: &str,
        revenuecat: &str,
        clock: &TestClock,
    ) -> Hosted {
        let clock = clock.clone();
        Hosted::new(
            hosted_config(environment),
            store::open(path).unwrap(),
            StripeClient::new(stripe, "sk_test_fake"),
            RevenueCatClient::new(revenuecat, "rc_secret", "rc_stripe_public"),
            Arc::new(move || clock.load(Ordering::SeqCst)),
        )
    }

    pub fn now_ms(&self) -> i64 {
        self.clock.load(Ordering::SeqCst)
    }

    pub fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn sql<T>(&self, query: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> T {
        self.hosted.query(query).unwrap()
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.sql(|db| db.query_row(sql, [], |row| row.get(0)))
    }

    pub async fn send(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> reqwest::Response {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.url));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        request.send().await.unwrap()
    }

    pub async fn post_raw(&self, path: &str, content_type: &str, body: &str) -> (u16, Value) {
        let response = self
            .http
            .post(format!("{}{path}", self.url))
            .header("content-type", content_type)
            .body(body.to_owned())
            .send()
            .await
            .unwrap();
        Self::reply(response).await
    }

    async fn reply(response: reqwest::Response) -> (u16, Value) {
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    pub async fn get(&self, path: &str, credential: Option<&str>) -> (u16, Value) {
        let authorization = credential.map(|credential| format!("Bearer {credential}"));
        let headers = authorization
            .as_deref()
            .map(|value| vec![("authorization", value)])
            .unwrap_or_default();
        Self::reply(self.send(Method::GET, path, &headers, None).await).await
    }

    /// POST with an optional bearer credential and Idempotency-Key.
    pub async fn post(
        &self,
        path: &str,
        credential: Option<&str>,
        key: Option<&str>,
        body: &Value,
    ) -> (u16, Value) {
        let authorization = credential.map(|credential| format!("Bearer {credential}"));
        let mut headers = Vec::new();
        if let Some(value) = &authorization {
            headers.push(("authorization", value.as_str()));
        }
        if let Some(key) = key {
            headers.push(("idempotency-key", key));
        }
        Self::reply(self.send(Method::POST, path, &headers, Some(body)).await).await
    }

    pub async fn state(&self, credential: &str) -> Value {
        let (status, body) = self.get("/v1/billing", Some(credential)).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    pub fn registration_body() -> Value {
        json!({
            "registrationId": uuid::Uuid::new_v4().to_string(),
            "credential": random_credential(),
            "installationId": "install-test01",
            "companyId": "company_1",
        })
    }

    pub async fn register(&self) -> Account {
        let registration = Self::registration_body();
        let (status, body) = self.post("/v1/accounts", None, None, &registration).await;
        assert_eq!(status, 200, "{body}");
        Account {
            id: body["accountId"].as_str().unwrap().into(),
            credential: registration["credential"].as_str().unwrap().into(),
            registration,
        }
    }

    /// A registered account with a Stripe customer and a paid subscription.
    pub async fn provisioned(&self, quantity: i64) -> Provisioned {
        let account = self.register().await;
        let (customer, subscription) = self.stripe.with(|stripe| {
            let customer = stripe.create_customer(&account.id);
            (customer.clone(), stripe.add_subscription(&customer, quantity))
        });
        Provisioned {
            account,
            customer,
            subscription,
        }
    }

    /// Delivers a Stripe event; `signature` overrides a valid signature.
    pub async fn stripe_event(&self, event: &Value, signature: Option<&str>) -> u16 {
        let payload = event.to_string();
        let timestamp = self.now_ms() / 1000;
        let header = signature.map_or_else(
            || format!("t={timestamp},v1={}", webhook_signature(payload.as_bytes(), WEBHOOK_SECRET, timestamp)),
            str::to_owned,
        );
        self.http
            .post(format!("{}/webhooks/stripe", self.url))
            .header("content-type", "application/json")
            .header("stripe-signature", header)
            .body(payload)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    pub async fn revenuecat_event(&self, authorization: &str, event: &Value) -> u16 {
        let response = self
            .send(
                Method::POST,
                "/webhooks/revenuecat",
                &[("authorization", authorization)],
                Some(&json!({"event": event})),
            )
            .await;
        response.status().as_u16()
    }

    pub async fn process_events(&self) {
        self.hosted.run_processor_pass().await.unwrap();
    }
}
