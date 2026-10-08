//! Money commands: durable operations, checkout, seat preview and change,
//! seat command recovery, and the customer portal.

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

use super::{
    Hosted, HostedError, HostedResult, NOT_APPLIED, PAYMENT_PENDING, canonical_json, iso, parse_ms,
    source::{SourceInspection, latest, require_stripe_url, safe_stripe_url, terminal, unpaid},
    store::{self, AccountRow, NewOperation, OperationRow},
    stripe::{
        CheckoutParams, CheckoutSession, Invoice, InvoicePreviewParams, Item, SeatDirection,
        SeatUpdate, Subscription,
    },
};
use crate::{
    billing::wire::{
        BillingInterval, HostedCheckoutResult, HostedPortalResult, HostedSeatChangeBody,
        HostedSeatChangeResult, HostedSeatPreview, SEAT_CURRENCY, SEAT_UNIT_AMOUNT,
    },
    shared::hash::sha256_hex,
};

const SEAT_PREVIEW_TTL_MS: i64 = 5 * 60 * 1000;
/// Stripe retains idempotency keys for about 24 hours; beyond that a
/// recorded key no longer proves a replay is deduplicated.
const STRIPE_IDEMPOTENCY_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
const CHECKOUT_EXPIRED: &str = "The checkout session expired before payment. Start a new checkout.";
const QUOTE_REQUIRED: &str = "The seat change needs a new confirmed preview";

pub fn input_hash(kind: &str, input: &Value) -> String {
    sha256_hex(canonical_json(&json!({"kind": kind, "input": input})))
}

fn idempotency_conflict() -> HostedError {
    HostedError::new(
        409,
        Some("idempotency_conflict"),
        "The idempotency key was already used for a different request",
    )
}

fn no_subscription(message: &str) -> HostedError {
    HostedError::new(409, Some("no_subscription"), message)
}

fn is_pending(state: &str) -> bool {
    matches!(state, "prepared" | "provider_pending")
}

fn result<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The operation's provider data with `entries` set on top.
fn merged<const N: usize>(
    operation: &OperationRow,
    entries: [(&str, Value); N],
) -> Map<String, Value> {
    let mut data = operation.data.clone();
    for (key, value) in entries {
        data.insert(key.to_owned(), value);
    }
    data
}

fn operation_result<T: DeserializeOwned>(operation: &OperationRow) -> Option<T> {
    operation
        .data
        .get("result")
        .filter(|value| value.is_object())
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

fn session_quantity(session: &CheckoutSession) -> Option<i64> {
    session
        .metadata
        .get("suplex_quantity")
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|number| number.is_finite() && number.fract() == 0.0 && *number > 0.0)
        .map(|number| number as i64)
        .or_else(|| session.line_items.first().map(|line| line.quantity))
}

/// The authorized mutation, persisted on the operation before dispatch. An
/// increase records the confirmed preview's financial consent; a decrease
/// records the no-refund acknowledgment. A retry never retargets it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SeatCommand {
    direction: String,
    subscription_id: Option<String>,
    item_id: Option<String>,
    price_id: String,
    old_quantity: Option<i64>,
    requested_quantity: i64,
    quote_id: Option<String>,
    amount_due: Option<i64>,
    currency: Option<String>,
    proration_date: Option<i64>,
    quote_expires_at: Option<String>,
    no_refund_acknowledged: bool,
    provider_key: String,
    stripe_customer_id: Option<String>,
}

impl SeatCommand {
    fn increase(&self) -> bool {
        self.direction != "decrease"
    }

    /// Whether the command carries everything a dispatch needs. Missing
    /// consent is never invented.
    fn complete(&self) -> bool {
        let base = self.subscription_id.is_some()
            && self.item_id.is_some()
            && self.old_quantity.is_some()
            && self.requested_quantity > 0;
        base && if self.increase() {
            self.proration_date.is_some()
                && self.amount_due.is_some()
                && self.currency.as_deref() == Some(SEAT_CURRENCY)
                && self.quote_expires_at.is_some()
        } else {
            self.no_refund_acknowledged
        }
    }
}

impl Hosted {
    // -----------------------------------------------------------------------
    // Durable operations
    // -----------------------------------------------------------------------

    fn insert_operation(
        &self,
        account_id: &str,
        kind: &str,
        idempotency_key: &str,
        input: &Value,
        expires_at: Option<&str>,
    ) -> rusqlite::Result<OperationRow> {
        let id = format!("op_{}", uuid::Uuid::new_v4());
        let now = self.now_iso();
        self.immediate(|db| {
            store::insert_operation(
                db,
                &NewOperation {
                    id: &id,
                    account_id,
                    idempotency_key,
                    kind,
                    input_json: &canonical_json(input),
                    input_hash: &input_hash(kind, input),
                    expires_at,
                    now: &now,
                },
            )
        })?;
        self.query(|db| store::find_operation_by_id(db, &id))?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    fn update_operation(
        &self,
        operation: &mut OperationRow,
        state: Option<&str>,
        data: Option<Map<String, Value>>,
    ) -> HostedResult<()> {
        let data_json = data
            .as_ref()
            .map(|data| Value::Object(data.clone()).to_string());
        let now = self.now_iso();
        self.query(|db| {
            store::update_operation(db, &operation.id, state, data_json.as_deref(), &now)
        })?;
        if let Some(state) = state {
            operation.state = state.to_owned();
        }
        if let Some(data) = data {
            operation.data = data;
        }
        Ok(())
    }

    /// Records a terminal failure on the operation and returns it.
    fn terminal(&self, operation: &mut OperationRow, error: HostedError) -> HostedError {
        let data = merged(
            operation,
            [(
                "terminalError",
                json!({"code": error.code.clone().unwrap_or_default(), "status": error.status, "message": error.message}),
            )],
        );
        match self.update_operation(operation, Some("failed"), Some(data)) {
            Ok(()) => error,
            Err(failure) => failure,
        }
    }

    // -----------------------------------------------------------------------
    // Checkout
    // -----------------------------------------------------------------------

    fn session_has_price(session: &CheckoutSession, price_id: &str) -> bool {
        session.line_items.is_empty()
            || session
                .line_items
                .iter()
                .any(|line| line.price_id == price_id)
    }

    /// Verified source state as a checkout result; `None` when no live
    /// subscription exists.
    fn reconcile_checkout_result(
        &self,
        operation: &mut OperationRow,
        inspection: &SourceInspection,
    ) -> HostedResult<Option<HostedCheckoutResult>> {
        let Some(subscription) = inspection
            .subscription
            .as_ref()
            .filter(|subscription| !terminal(&subscription.status))
        else {
            return Ok(None);
        };
        let state = inspection.state.clone();
        if state.active {
            let outcome = HostedCheckoutResult::Subscribed {
                operation_id: operation.id.clone(),
                state,
            };
            let data = merged(
                operation,
                [
                    ("subscriptionId", json!(subscription.id)),
                    ("result", result(&outcome)),
                ],
            );
            self.update_operation(operation, Some("completed"), Some(data))?;
            return Ok(Some(outcome));
        }
        let outcome = HostedCheckoutResult::PaymentRequired {
            operation_id: operation.id.clone(),
            url: state.payment_action_url.clone(),
            state,
        };
        let recoverable = unpaid(&subscription.status) || subscription.pending_update.is_some();
        let data = merged(
            operation,
            [
                ("subscriptionId", json!(subscription.id)),
                ("result", result(&outcome)),
            ],
        );
        self.update_operation(
            operation,
            Some(if recoverable {
                "provider_pending"
            } else {
                "completed"
            }),
            Some(data),
        )?;
        Ok(Some(outcome))
    }

    fn redirect(
        &self,
        operation: &OperationRow,
        session: &CheckoutSession,
    ) -> HostedResult<HostedCheckoutResult> {
        Ok(HostedCheckoutResult::Redirect {
            operation_id: operation.id.clone(),
            url: require_stripe_url(session.url.as_deref(), "checkout.stripe.com")?,
        })
    }

    /// Inspects Stripe for the real outcome of a prepared or
    /// provider_pending checkout. Returns a finished result, or `None` when
    /// the operation proved to have no provider-side effect. A foreign
    /// operation is failed, which frees the pending-mutation slot; the
    /// owning caller continues its attempt.
    async fn resolve_checkout_operation(
        &self,
        account: &mut AccountRow,
        operation: &mut OperationRow,
        requested: i64,
        price_id: &str,
        for_owner: bool,
    ) -> HostedResult<Option<HostedCheckoutResult>> {
        let fail = |error| self.provider_failure("stripe request", error);
        let recorded_session = operation
            .data
            .get("checkoutSessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut session = None;
        if let Some(session_id) = &recorded_session {
            session = self
                .stripe
                .get_checkout_session(session_id)
                .await
                .map_err(fail)?;
        }
        if session.is_none() {
            let customer_id = operation
                .data
                .get("stripeCustomerId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| account.stripe_customer_id.clone());
            if let Some(customer_id) = customer_id {
                let open = self
                    .stripe
                    .list_open_checkout_sessions(&customer_id)
                    .await
                    .map_err(fail)?;
                session = open
                    .iter()
                    .find(|candidate| {
                        candidate.metadata.get("suplex_operation_id") == Some(&operation.id)
                    })
                    .or(open.first())
                    .cloned();
                if let Some(found) = &session {
                    let data = merged(operation, [("checkoutSessionId", json!(found.id))]);
                    self.update_operation(operation, None, Some(data))?;
                }
            }
        }

        let status = session
            .as_ref()
            .and_then(|session| session.status.as_deref());
        if let (Some(session), Some("open")) = (&session, status) {
            let stored_quantity = session_quantity(session)
                .or_else(|| operation.input.get("quantity").and_then(Value::as_i64))
                .unwrap_or(requested);
            if stored_quantity == requested && Self::session_has_price(session, price_id) {
                if operation.state != "provider_pending" {
                    self.update_operation(operation, Some("provider_pending"), None)?;
                }
                return self.redirect(operation, session).map(Some);
            }
            // A different quantity or price on an unpaid session: expire before
            // creating again; a payment that raced expiration wins.
            self.stripe
                .expire_checkout_session(&session.id)
                .await
                .map_err(fail)?;
            let after = self
                .stripe
                .get_checkout_session(&session.id)
                .await
                .map_err(fail)?;
            if after.is_some_and(|after| after.status.as_deref() == Some("complete")) {
                let inspection = self.inspect_source(account).await?;
                if let Some(reconciled) = self.reconcile_checkout_result(operation, &inspection)? {
                    return Ok(Some(reconciled));
                }
            }
            if !for_owner {
                self.update_operation(operation, Some("failed"), None)?;
            }
            return Ok(None);
        }

        if status == Some("complete") {
            let inspection = self.inspect_source(account).await?;
            if let Some(reconciled) = self.reconcile_checkout_result(operation, &inspection)? {
                return Ok(Some(reconciled));
            }
        }

        // An expired or vanished attempt is terminally unusable: an expired
        // session under this operation's Stripe key is never re-presented or
        // silently recreated.
        let attempted = session.is_some()
            || recorded_session.is_some()
            || operation.state == "provider_pending";
        if attempted {
            let error = self.terminal(
                operation,
                HostedError::operation_not_applied(CHECKOUT_EXPIRED),
            );
            if for_owner || error.is_internal() {
                return Err(error);
            }
            return Ok(None);
        }
        if !for_owner {
            self.update_operation(operation, Some("failed"), None)?;
        }
        Ok(None)
    }

    async fn run_checkout_attempt(
        &self,
        account: &mut AccountRow,
        operation: &mut OperationRow,
        quantity: i64,
        price_id: &str,
    ) -> HostedResult<HostedCheckoutResult> {
        let fail = |error| self.provider_failure("stripe request", error);
        let inspection = self.inspect_source(account).await?;
        if let Some(reconciled) = self.reconcile_checkout_result(operation, &inspection)? {
            return Ok(reconciled);
        }
        let customer_id = match inspection.customer {
            Some(customer) => customer.id,
            None => {
                let customer = self
                    .stripe
                    .create_customer(&account.id, &format!("suplex_customer_{}", operation.id))
                    .await
                    .map_err(fail)?;
                let now = self.now_iso();
                self.query(|db| {
                    store::update_stripe_customer(db, &account.id, Some(&customer.id), &now)
                })?;
                account.stripe_customer_id = Some(customer.id.clone());
                customer.id
            }
        };
        let data = merged(operation, [("stripeCustomerId", json!(customer_id))]);
        self.update_operation(operation, None, Some(data))?;

        // Reuse an open session for the same quantity and price; expire unpaid
        // sessions for another one only after re-reading their status.
        let open = self
            .stripe
            .list_open_checkout_sessions(&customer_id)
            .await
            .map_err(fail)?;
        if let Some(session) = open.iter().find(|session| {
            session_quantity(session) == Some(quantity)
                && Self::session_has_price(session, price_id)
        }) {
            let data = merged(
                operation,
                [
                    ("checkoutSessionId", json!(session.id)),
                    ("stripeCustomerId", json!(customer_id)),
                ],
            );
            self.update_operation(operation, Some("provider_pending"), Some(data))?;
            return self.redirect(operation, session);
        }
        for session in &open {
            self.stripe
                .expire_checkout_session(&session.id)
                .await
                .map_err(fail)?;
            let after = self
                .stripe
                .get_checkout_session(&session.id)
                .await
                .map_err(fail)?;
            if after.is_some_and(|after| after.status.as_deref() == Some("complete")) {
                let inspection = self.inspect_source(account).await?;
                if let Some(reconciled) = self.reconcile_checkout_result(operation, &inspection)? {
                    return Ok(reconciled);
                }
            }
        }

        let app_user_id = account.revenuecat_app_user_id.clone();
        let session = self
            .stripe
            .create_checkout_session(
                &CheckoutParams {
                    customer_id: &customer_id,
                    price_id,
                    quantity,
                    automatic_tax: self.config.automatic_tax,
                    success_url: &format!("{}/checkout/return", self.config.origin),
                    cancel_url: &format!("{}/checkout/cancel", self.config.origin),
                    metadata: &[
                        ("app_user_id", app_user_id.clone()),
                        ("suplex_operation_id", operation.id.clone()),
                        ("suplex_quantity", quantity.to_string()),
                    ],
                    subscription_metadata: &[
                        ("app_user_id", app_user_id),
                        ("account_id", account.id.clone()),
                        ("suplex_operation_id", operation.id.clone()),
                    ],
                },
                &format!("suplex_checkout_{}", operation.id),
            )
            .await
            .map_err(fail)?;
        let data = merged(
            operation,
            [
                ("checkoutSessionId", json!(session.id)),
                ("stripeCustomerId", json!(customer_id)),
            ],
        );
        self.update_operation(operation, Some("provider_pending"), Some(data))?;
        self.redirect(operation, &session)
    }

    pub async fn checkout(
        &self,
        account: &mut AccountRow,
        quantity: i64,
        interval: BillingInterval,
        idempotency_key: &str,
    ) -> HostedResult<HostedCheckoutResult> {
        let _lock = self.account_lock(&account.id).await;
        self.ensure_price_verified(interval).await?;
        let price_id = self.config.price_id(interval).to_owned();
        // A monthly input keeps its original shape, so its hash still matches.
        let mut input = json!({"quantity": quantity});
        if interval == BillingInterval::Year {
            input["interval"] = json!(interval);
        }
        let hash = input_hash("checkout", &input);

        let existing =
            self.query(|db| store::find_operation_by_key(db, &account.id, idempotency_key))?;
        let mut operation = if let Some(mut operation) = existing {
            if operation.kind != "checkout" || operation.input_hash != hash {
                return Err(idempotency_conflict());
            }
            if operation.state == "completed"
                && let Some(stored) = operation_result::<HostedCheckoutResult>(&operation)
            {
                // A completed replay reconciles against current source
                // state; the stored receipt is the fallback.
                let Ok(inspection) = self.inspect_source(account).await else {
                    return Ok(stored);
                };
                return Ok(self
                    .reconcile_checkout_result(&mut operation, &inspection)
                    .ok()
                    .flatten()
                    .unwrap_or(stored));
            }
            if let Some(resolved) = self
                .resolve_checkout_operation(account, &mut operation, quantity, &price_id, true)
                .await?
            {
                return Ok(resolved);
            }
            operation
        } else {
            let pending = self.query(|db| store::find_pending_mutation(db, &account.id))?;
            if let Some(mut pending) = pending {
                if pending.kind == "checkout" {
                    if let Some(resolved) = self
                        .resolve_checkout_operation(
                            account,
                            &mut pending,
                            quantity,
                            &price_id,
                            false,
                        )
                        .await?
                    {
                        return Ok(resolved);
                    }
                } else if !self.resolve_seat_change_operation(account, pending).await? {
                    return Err(HostedError::payment_pending(
                        "A payment change is still pending for this account",
                    ));
                }
            }
            match self.insert_operation(&account.id, "checkout", idempotency_key, &input, None) {
                Ok(mut operation) => {
                    // Persist the immutable command before any dispatch.
                    let data = json!({"command": {
                        "quantity": quantity,
                        "priceId": price_id,
                        "providerKey": format!("suplex_checkout_{}", operation.id),
                    }});
                    self.update_operation(&mut operation, None, data.as_object().cloned())?;
                    operation
                }
                Err(error) if store::is_constraint_violation(&error) => {
                    // Another writer won the pending-mutation slot.
                    let raced = self.query(|db| {
                        store::find_operation_by_key(db, &account.id, idempotency_key)
                    })?;
                    let Some(mut raced) = raced else {
                        let other =
                            self.query(|db| store::find_pending_mutation(db, &account.id))?;
                        if let Some(mut other) = other.filter(|other| other.kind == "checkout")
                            && let Some(resolved) = self
                                .resolve_checkout_operation(
                                    account, &mut other, quantity, &price_id, false,
                                )
                                .await?
                        {
                            return Ok(resolved);
                        }
                        return Err(HostedError::payment_pending(
                            "A billing operation is already in progress for this account",
                        ));
                    };
                    if let Some(resolved) = self
                        .resolve_checkout_operation(account, &mut raced, quantity, &price_id, true)
                        .await?
                    {
                        return Ok(resolved);
                    }
                    raced
                }
                Err(error) => return Err(error.into()),
            }
        };
        self.run_checkout_attempt(account, &mut operation, quantity, &price_id)
            .await
    }

    // -----------------------------------------------------------------------
    // Seat preview
    // -----------------------------------------------------------------------

    fn require_paid_subscription(
        &self,
        inspection: &SourceInspection,
    ) -> HostedResult<(Subscription, Item)> {
        let (Some(subscription), Some(item)) = (&inspection.subscription, &inspection.item) else {
            return Err(no_subscription("This account has no subscription"));
        };
        // Seat quotes price the monthly seat; an annual Pro is one seat.
        if item.price_id != self.config.stripe_price_id {
            return Err(no_subscription(
                "Seat changes apply only to a monthly subscription",
            ));
        }
        if terminal(&subscription.status) {
            return Err(no_subscription("This account has no active subscription"));
        }
        if unpaid(&subscription.status) || subscription.status == "paused" {
            return Err(HostedError::payment_pending(
                "The subscription has an unresolved payment",
            ));
        }
        if subscription.pending_update.is_some() && inspection.open_invoice.is_some() {
            return Err(HostedError::payment_pending(
                "A seat change payment is still pending",
            ));
        }
        // No prorated credit against an unpaid period.
        if inspection.unsettled_current_invoice {
            return Err(HostedError::payment_pending(
                "The subscription has an unpaid invoice",
            ));
        }
        if subscription.status != "active" {
            return Err(no_subscription("This account has no active subscription"));
        }
        Ok((subscription.clone(), item.clone()))
    }

    async fn create_seat_preview(
        &self,
        account: &AccountRow,
        subscription: &Subscription,
        item: &Item,
        quantity: i64,
    ) -> HostedResult<HostedSeatPreview> {
        let proration_date = self.now_ms().div_euclid(1000);
        let preview = self
            .stripe
            .create_invoice_preview(&InvoicePreviewParams {
                subscription_id: &subscription.id,
                item_id: &item.id,
                price_id: &self.config.stripe_price_id,
                quantity,
                proration_date,
            })
            .await
            .map_err(|error| self.provider_failure("stripe request", error))?;
        let expires_at = iso(self.now_ms() + SEAT_PREVIEW_TTL_MS);
        let mut operation = self.insert_operation(
            &account.id,
            "seat_preview",
            &format!("preview_{}", uuid::Uuid::new_v4()),
            &json!({"quantity": quantity}),
            Some(&expires_at),
        )?;
        let data = json!({
            "subscriptionId": subscription.id,
            "itemId": item.id,
            "priceId": self.config.stripe_price_id,
            "currentQuantity": item.quantity,
            "requestedQuantity": quantity,
            "amountDue": preview.amount_due,
            "currency": SEAT_CURRENCY,
            "prorationDate": proration_date,
        });
        self.update_operation(&mut operation, None, data.as_object().cloned())?;
        Ok(HostedSeatPreview {
            preview_id: operation.id,
            expires_at,
            current_quantity: item.quantity,
            requested_quantity: quantity,
            amount_due_now: preview.amount_due,
            next_subtotal: quantity * SEAT_UNIT_AMOUNT,
            currency: SEAT_CURRENCY.into(),
            proration_timestamp: proration_date,
        })
    }

    pub async fn preview_seats(
        &self,
        account: &mut AccountRow,
        quantity: i64,
    ) -> HostedResult<HostedSeatPreview> {
        let _lock = self.account_lock(&account.id).await;
        self.ensure_price_verified(BillingInterval::Month).await?;
        let pending = self.query(|db| store::find_pending_mutation(db, &account.id))?;
        if let Some(pending) = pending
            && !self.resolve_pending_operation(account, pending).await?
        {
            return Err(HostedError::payment_pending(
                "A billing operation is still pending for this account",
            ));
        }
        let inspection = self.inspect_source(account).await?;
        let (subscription, item) = self.require_paid_subscription(&inspection)?;
        if quantity <= item.quantity {
            return Err(HostedError::invalid_seat_quantity(
                "A seat increase preview requires a quantity above the current seats",
            ));
        }
        self.create_seat_preview(account, &subscription, &item, quantity)
            .await
    }

    /// Unparseable expiry fails closed: the preview counts as expired.
    fn load_preview(&self, account: &AccountRow, preview_id: &str) -> HostedResult<OperationRow> {
        let preview = self
            .query(|db| store::find_operation_by_id(db, preview_id))?
            .filter(|preview| preview.account_id == account.id && preview.kind == "seat_preview")
            .ok_or_else(|| {
                HostedError::invalid_seat_quantity("The seat preview is not valid for this account")
            })?;
        if preview.state != "prepared" {
            return Err(HostedError::invalid_seat_quantity(
                "The seat preview was already used",
            ));
        }
        let now = self.now_ms();
        if preview
            .expires_at
            .as_deref()
            .and_then(parse_ms)
            .is_none_or(|expires| expires <= now)
        {
            return Err(HostedError::invalid_seat_quantity(
                "The seat preview has expired",
            ));
        }
        Ok(preview)
    }

    // -----------------------------------------------------------------------
    // Seat commands: one immutable snapshot, one source-based resolution
    // -----------------------------------------------------------------------

    /// The persisted command. A row without one (a crash between insert
    /// and snapshot) keeps only its own input and is never complete.
    fn seat_command_for(&self, operation: &OperationRow) -> SeatCommand {
        let mut command = operation
            .data
            .get("command")
            .filter(|value| value.is_object())
            .and_then(|value| serde_json::from_value::<SeatCommand>(value.clone()).ok())
            .unwrap_or_else(|| SeatCommand {
                direction: operation
                    .input
                    .get("direction")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                requested_quantity: operation
                    .input
                    .get("quantity")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                quote_id: operation
                    .input
                    .get("previewId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                no_refund_acknowledged: operation.input.get("confirmNoRefund")
                    == Some(&Value::Bool(true)),
                ..SeatCommand::default()
            });
        if command.price_id.is_empty() {
            command.price_id.clone_from(&self.config.stripe_price_id);
        }
        if command.provider_key.is_empty() {
            command.provider_key = format!("suplex_seat_change_{}", operation.id);
        }
        command
    }

    /// A fresh quote on the original subscription for the same quantity,
    /// carried in the consent error the caller must confirm.
    async fn fresh_quote(
        &self,
        account: &AccountRow,
        subscription: &Subscription,
        item: &Item,
        quantity: i64,
    ) -> HostedError {
        match self
            .create_seat_preview(account, subscription, item, quantity)
            .await
        {
            Ok(preview) => HostedError::quote_changed(QUOTE_REQUIRED, Some(preview)),
            Err(error) if !error.is_internal() => error,
            Err(_) => HostedError::quote_changed(QUOTE_REQUIRED, None),
        }
    }

    fn applied(
        &self,
        operation: &mut OperationRow,
        inspection: &SourceInspection,
    ) -> HostedResult<Option<HostedSeatChangeResult>> {
        let outcome = HostedSeatChangeResult::Applied {
            operation_id: operation.id.clone(),
            state: inspection.state.clone(),
        };
        let data = merged(operation, [("result", result(&outcome))]);
        self.update_operation(operation, Some("completed"), Some(data))?;
        Ok(Some(outcome))
    }

    fn requires_payment(
        &self,
        operation: &mut OperationRow,
        inspection: &SourceInspection,
        invoice: &Invoice,
    ) -> HostedResult<Option<HostedSeatChangeResult>> {
        let outcome = HostedSeatChangeResult::PaymentRequired {
            operation_id: operation.id.clone(),
            url: safe_stripe_url(invoice.hosted_invoice_url.as_deref()),
            state: inspection.state.clone(),
        };
        let data = merged(operation, [("result", result(&outcome))]);
        self.update_operation(operation, Some("provider_pending"), Some(data))?;
        Ok(Some(outcome))
    }

    /// The single source-based resolution path for a seat_change. It
    /// inspects the original subscription and item on the command: applied
    /// becomes a durable receipt; a correlated open invoice becomes
    /// payment_required with the old capacity still applied; a voided
    /// pending change, a replaced subscription, or drifted quantity is
    /// terminally not applied; expired consent asks for a new quote.
    /// Returns `None` only when the exact saved command may dispatch now.
    async fn settle_seat_command(
        &self,
        account: &mut AccountRow,
        operation: &mut OperationRow,
    ) -> HostedResult<Option<HostedSeatChangeResult>> {
        let command = self.seat_command_for(operation);
        let complete = command.complete();
        let requested = command.requested_quantity;
        let inspection = self.inspect_source(account).await?;
        let not_applied = || HostedError::operation_not_applied(NOT_APPLIED);

        let subscription = match &command.subscription_id {
            Some(id) => inspection
                .subscriptions
                .iter()
                .find(|candidate| &candidate.id == id),
            None => inspection.subscription.as_ref(),
        }
        .cloned();
        // A replaced subscription never receives this command.
        let Some(subscription) = subscription else {
            return Err(self.terminal(operation, not_applied()));
        };
        let item = subscription
            .items
            .iter()
            .find(|candidate| command.item_id.as_deref() == Some(&candidate.id))
            .or_else(|| {
                subscription
                    .items
                    .iter()
                    .find(|candidate| candidate.price_id == self.config.stripe_price_id)
            })
            .cloned();
        let Some(item) = item else {
            return Err(self.terminal(
                operation,
                HostedError::operation_not_applied(
                    "The seat change target no longer exists. Review a new quote and try again.",
                ),
            ));
        };
        let open_invoice = latest(
            inspection.invoices.iter().filter(|invoice| {
                invoice.subscription_id.as_deref() == Some(&subscription.id)
                    && invoice.status.as_deref() == Some("open")
            }),
            |invoice| invoice.created,
        );

        // An open invoice on this command's pending update is its unresolved
        // payment; the old capacity stays applied.
        if let Some(pending_items) = &subscription.pending_update {
            let pending_quantity = pending_items
                .iter()
                .find(|candidate| {
                    candidate.id == item.id || candidate.price_id == self.config.stripe_price_id
                })
                .map(|candidate| candidate.quantity);
            if let Some(open) = open_invoice {
                if pending_quantity == Some(requested) {
                    return self.requires_payment(operation, &inspection, open);
                }
                return Err(HostedError::payment_pending(
                    "A different subscription change is still pending",
                ));
            }
            if item.quantity == requested {
                return self.applied(operation, &inspection);
            }
            let pending_invoice = subscription
                .latest_invoice_id
                .as_ref()
                .and_then(|id| inspection.invoices.iter().find(|invoice| &invoice.id == id));
            if pending_invoice.is_some_and(|invoice| {
                matches!(invoice.status.as_deref(), Some("void" | "uncollectible"))
            }) {
                return Err(self.terminal(operation, not_applied()));
            }
            return Err(HostedError::payment_pending(
                "The subscription change is still processing",
            ));
        }

        if item.quantity == requested {
            return self.applied(operation, &inspection);
        }
        // Provider-side evidence vanished without applying (a voided or
        // expired invoice). Never charge again.
        if operation.state == "provider_pending" || terminal(&subscription.status) {
            return Err(self.terminal(operation, not_applied()));
        }
        if unpaid(&subscription.status) || subscription.status == "paused" {
            return Err(HostedError::payment_pending(
                "The subscription has an unresolved payment",
            ));
        }
        if subscription.status != "active" {
            return Err(HostedError::payment_pending(
                "The subscription is not active",
            ));
        }
        // An unpaid period never receives a new prorated invoice or credit.
        if open_invoice.is_some() || inspection.unsettled_current_invoice {
            return Err(HostedError::payment_pending(
                "The subscription has an unpaid invoice",
            ));
        }
        // An old increase never becomes a decrease; any drift is
        // incompatible.
        let drifted = command.old_quantity.is_some_and(|old| old != item.quantity)
            || (command.increase() && item.quantity >= requested)
            || (!command.increase() && item.quantity <= requested);
        if drifted {
            return Err(self.terminal(operation, not_applied()));
        }
        if !complete {
            let error = if command.increase() {
                self.fresh_quote(account, &subscription, &item, requested)
                    .await
            } else {
                not_applied()
            };
            return Err(self.terminal(operation, error));
        }
        if command.increase() {
            let now = self.now_ms();
            let expired = command
                .quote_expires_at
                .as_deref()
                .and_then(parse_ms)
                .is_none_or(|expires| expires <= now);
            if expired {
                let error = self
                    .fresh_quote(account, &subscription, &item, requested)
                    .await;
                return Err(self.terminal(operation, error));
            }
            let repriced = self
                .stripe
                .create_invoice_preview(&InvoicePreviewParams {
                    subscription_id: &subscription.id,
                    item_id: &item.id,
                    price_id: &self.config.stripe_price_id,
                    quantity: requested,
                    proration_date: command.proration_date.unwrap_or_default(),
                })
                .await
                .map_err(|error| self.provider_failure("stripe request", error))?;
            if Some(repriced.amount_due) != command.amount_due
                || command.currency.as_deref() != Some(SEAT_CURRENCY)
            {
                let error = self
                    .fresh_quote(account, &subscription, &item, requested)
                    .await;
                return Err(self.terminal(operation, error));
            }
        }
        // Beyond Stripe's idempotency retention a replay could charge twice;
        // keep the command for recovery. An unreadable age fails closed.
        let now = self.now_ms();
        if parse_ms(&operation.created_at)
            .is_none_or(|created| now - created > STRIPE_IDEMPOTENCY_RETENTION_MS)
        {
            return Err(HostedError::unavailable());
        }
        Ok(None)
    }

    /// Executes (or idempotently re-executes) the recorded command, then
    /// settles again from a fresh read. The provider response, including a
    /// cached idempotent replay, is never treated as current state.
    async fn apply_seat_change(
        &self,
        account: &mut AccountRow,
        operation: &mut OperationRow,
    ) -> HostedResult<HostedSeatChangeResult> {
        if let Some(settled) = self.settle_seat_command(account, operation).await? {
            return Ok(settled);
        }
        let command = self.seat_command_for(operation);
        let direction = if command.increase() {
            SeatDirection::Increase {
                proration_date: command.proration_date.unwrap_or_default(),
            }
        } else {
            SeatDirection::Decrease
        };
        self.stripe
            .update_subscription_quantity(
                &SeatUpdate {
                    subscription_id: command.subscription_id.as_deref().unwrap_or_default(),
                    item_id: command.item_id.as_deref().unwrap_or_default(),
                    quantity: command.requested_quantity,
                    direction,
                },
                &command.provider_key,
            )
            .await
            .map_err(|error| self.provider_failure("stripe request", error))?;
        self.update_operation(operation, Some("provider_pending"), None)?;
        self.settle_seat_command(account, operation)
            .await?
            .ok_or_else(HostedError::unavailable)
    }

    /// Resolves another request's pending seat_change. `true` when it
    /// reached a completed or terminal state and the slot is free.
    async fn resolve_seat_change_operation(
        &self,
        account: &mut AccountRow,
        mut operation: OperationRow,
    ) -> HostedResult<bool> {
        if !is_pending(&operation.state) {
            return Ok(true);
        }
        match self.apply_seat_change(account, &mut operation).await {
            Ok(outcome) => Ok(matches!(outcome, HostedSeatChangeResult::Applied { .. })),
            Err(error) => {
                let fresh = self.query(|db| store::find_operation_by_id(db, &operation.id))?;
                if fresh.is_some_and(|fresh| !is_pending(&fresh.state)) {
                    return Ok(true);
                }
                if error.has_code("billing_payment_pending") {
                    return Ok(false);
                }
                Err(error)
            }
        }
    }

    async fn resolve_pending_operation(
        &self,
        account: &mut AccountRow,
        mut pending: OperationRow,
    ) -> HostedResult<bool> {
        if pending.kind == "seat_change" {
            return self.resolve_seat_change_operation(account, pending).await;
        }
        let stored_quantity = pending
            .input
            .get("quantity")
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let stored_price = pending
            .data
            .get("command")
            .and_then(|command| command.get("priceId"))
            .and_then(Value::as_str)
            .unwrap_or(&self.config.stripe_price_id)
            .to_owned();
        self.resolve_checkout_operation(
            account,
            &mut pending,
            stored_quantity,
            &stored_price,
            false,
        )
        .await?;
        let fresh = self.query(|db| store::find_operation_by_id(db, &pending.id))?;
        Ok(fresh.is_none_or(|fresh| !is_pending(&fresh.state)))
    }

    fn stored_terminal_error(operation: &OperationRow) -> Option<HostedError> {
        let raw = operation.data.get("terminalError")?.as_object()?;
        Some(HostedError::new(
            raw.get("status")
                .and_then(Value::as_u64)
                .and_then(|status| u16::try_from(status).ok())
                .unwrap_or(409),
            raw.get("code")
                .and_then(Value::as_str)
                .filter(|code| !code.is_empty()),
            raw.get("message")
                .and_then(Value::as_str)
                .unwrap_or("The change was not applied"),
        ))
    }

    pub async fn change_seats(
        &self,
        account: &mut AccountRow,
        body: &HostedSeatChangeBody,
        idempotency_key: &str,
    ) -> HostedResult<HostedSeatChangeResult> {
        let _lock = self.account_lock(&account.id).await;
        self.ensure_price_verified(BillingInterval::Month).await?;
        // Idempotency compares the normalized mutation input: an increase is
        // keyed by preview binding, a decrease by the refund acknowledgment.
        let stored_input = match body {
            HostedSeatChangeBody::Increase(increase) => {
                json!({"direction": "increase", "quantity": increase.quantity, "previewId": increase.preview_id})
            }
            HostedSeatChangeBody::Decrease(decrease) => {
                json!({"direction": "decrease", "quantity": decrease.quantity, "confirmNoRefund": true})
            }
        };
        let hash = input_hash("seat_change", &stored_input);

        let existing =
            self.query(|db| store::find_operation_by_key(db, &account.id, idempotency_key))?;
        if let Some(mut operation) = existing {
            if operation.kind != "seat_change" || operation.input_hash != hash {
                return Err(idempotency_conflict());
            }
            if operation.state == "completed" {
                // A later quote expiry never invalidates a completed
                // purchase: return the receipt with current billing state.
                let stored = operation_result::<HostedSeatChangeResult>(&operation);
                let refreshed = async {
                    let inspection = self.inspect_source(account).await?;
                    let outcome = HostedSeatChangeResult::Applied {
                        operation_id: operation.id.clone(),
                        state: inspection.state,
                    };
                    let data = merged(&operation, [("result", result(&outcome))]);
                    self.update_operation(&mut operation, None, Some(data))?;
                    Ok(outcome)
                }
                .await;
                return refreshed.or_else(|error| stored.ok_or(error));
            }
            // A terminally failed command replays its recorded outcome.
            if operation.state == "failed"
                && let Some(error) = Self::stored_terminal_error(&operation)
            {
                return Err(error);
            }
            return self.apply_seat_change(account, &mut operation).await;
        }

        let pending = self.query(|db| store::find_pending_mutation(db, &account.id))?;
        if let Some(pending) = pending
            && !self.resolve_pending_operation(account, pending).await?
        {
            return Err(HostedError::payment_pending(PAYMENT_PENDING));
        }

        let inspection = self.inspect_source(account).await?;
        let (subscription, item) = self.require_paid_subscription(&inspection)?;
        let quantity = body.quantity();
        let insert = || match self.insert_operation(
            &account.id,
            "seat_change",
            idempotency_key,
            &stored_input,
            None,
        ) {
            Ok(operation) => Ok(operation),
            Err(error) if store::is_constraint_violation(&error) => {
                Err(HostedError::payment_pending(
                    "A billing operation is already in progress for this account",
                ))
            }
            Err(error) => Err(HostedError::from(error)),
        };
        let customer_id = inspection
            .customer
            .as_ref()
            .map(|customer| customer.id.clone());
        let command = |operation: &OperationRow, increase: bool| SeatCommand {
            direction: (if increase { "increase" } else { "decrease" }).into(),
            subscription_id: Some(subscription.id.clone()),
            item_id: Some(item.id.clone()),
            price_id: self.config.stripe_price_id.clone(),
            old_quantity: Some(item.quantity),
            requested_quantity: quantity,
            no_refund_acknowledged: !increase,
            provider_key: format!("suplex_seat_change_{}", operation.id),
            stripe_customer_id: customer_id.clone(),
            ..SeatCommand::default()
        };

        match body {
            HostedSeatChangeBody::Increase(increase) => {
                if quantity <= item.quantity {
                    return Err(HostedError::invalid_seat_quantity(
                        "A seat increase requires a quantity above the current seats",
                    ));
                }
                let mut preview = self.load_preview(account, &increase.preview_id)?;
                let field = |key: &str| preview.data.get(key).cloned().unwrap_or(Value::Null);
                if field("requestedQuantity").as_i64() != Some(quantity) {
                    return Err(HostedError::invalid_seat_quantity(
                        "The seat preview does not match the requested quantity",
                    ));
                }
                if field("subscriptionId").as_str() != Some(&subscription.id)
                    || field("itemId").as_str() != Some(&item.id)
                {
                    return Err(HostedError::invalid_seat_quantity(
                        "The seat preview does not match the current subscription",
                    ));
                }
                // Re-preview with the same proration timestamp; only
                // financial changes revoke consent.
                let amount_due = field("amountDue").as_i64();
                let currency = field("currency").as_str().map(str::to_owned);
                let proration_date = field("prorationDate").as_i64();
                let repriced = self
                    .stripe
                    .create_invoice_preview(&InvoicePreviewParams {
                        subscription_id: &subscription.id,
                        item_id: &item.id,
                        price_id: &self.config.stripe_price_id,
                        quantity,
                        proration_date: proration_date.unwrap_or_default(),
                    })
                    .await
                    .map_err(|error| self.provider_failure("stripe request", error))?;
                let mismatch = Some(repriced.amount_due) != amount_due
                    || currency.as_deref() != Some(SEAT_CURRENCY)
                    || field("currentQuantity").as_i64() != Some(item.quantity);
                if mismatch {
                    self.update_operation(&mut preview, Some("failed"), None)?;
                    let fresh = self
                        .create_seat_preview(account, &subscription, &item, quantity)
                        .await?;
                    return Err(HostedError::quote_changed(
                        "The seat change amount changed; confirm the new preview",
                        Some(fresh),
                    ));
                }
                let mut operation = insert()?;
                // The immutable command, including the confirmed preview's
                // proration timestamp, is saved before any dispatch.
                let snapshot = SeatCommand {
                    quote_id: Some(preview.id.clone()),
                    amount_due,
                    currency,
                    proration_date,
                    quote_expires_at: preview.expires_at.clone(),
                    ..command(&operation, true)
                };
                let data = merged(
                    &operation,
                    [
                        ("stripeCustomerId", json!(customer_id)),
                        ("command", result(&snapshot)),
                    ],
                );
                self.update_operation(&mut operation, None, Some(data))?;
                let applied = self.apply_seat_change(account, &mut operation).await?;
                self.update_operation(&mut preview, Some("completed"), None)?;
                Ok(applied)
            }
            HostedSeatChangeBody::Decrease(_) => {
                if quantity >= item.quantity {
                    return Err(HostedError::invalid_seat_quantity(
                        "A seat decrease requires a quantity below the current seats",
                    ));
                }
                let mut operation = insert()?;
                let snapshot = command(&operation, false);
                let data = merged(
                    &operation,
                    [
                        ("stripeCustomerId", json!(customer_id)),
                        ("command", result(&snapshot)),
                    ],
                );
                self.update_operation(&mut operation, None, Some(data))?;
                self.apply_seat_change(account, &mut operation).await
            }
        }
    }

    // -----------------------------------------------------------------------
    // Portal
    // -----------------------------------------------------------------------

    pub async fn portal(&self, account: &mut AccountRow) -> HostedResult<HostedPortalResult> {
        let customer = self
            .resolve_customer(account)
            .await?
            .ok_or_else(|| no_subscription("This account has no billing customer"))?;
        let url = self
            .stripe
            .create_portal_session(
                &customer.id,
                &self.config.stripe_portal_configuration_id,
                &format!("{}/portal/return", self.config.origin),
            )
            .await
            .map_err(|error| self.provider_failure("stripe request", error))?;
        Ok(HostedPortalResult {
            url: require_stripe_url(url.as_deref(), "billing.stripe.com")?,
        })
    }
}

#[cfg(test)]
include!("../../../tests/billing/commands.rs");
