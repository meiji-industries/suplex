//! Source reads. Stripe is authoritative for paid access; RevenueCat
//! supplies only a validated grace window and is kept in sync.

use std::{cmp::Reverse, collections::BTreeMap, sync::atomic::Ordering};

use url::Url;

use super::{
    Hosted, HostedError, HostedResult, ProviderError, backoff_at, iso, parse_ms,
    revenuecat::{Subscriber, pro_entitlement_window},
    store::{self, AccountRow},
    stripe::{Customer, Invoice, InvoiceLine, Item, Subscription},
};
use crate::billing::wire::{
    ANNUAL_UNIT_AMOUNT, BillingEnvironment, BillingInterval, HostedBillingState, SEAT_CURRENCY,
    SEAT_UNIT_AMOUNT,
};

pub const TERMINAL_STATUSES: [&str; 2] = ["canceled", "incomplete_expired"];
pub const UNPAID_STATUSES: [&str; 3] = ["incomplete", "past_due", "unpaid"];
const GRACE_ELIGIBLE_STATUSES: [&str; 3] = ["past_due", "unpaid", "paused"];

pub fn terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

pub fn unpaid(status: &str) -> bool {
    UNPAID_STATUSES.contains(&status)
}

/// The latest-created element; ties keep the first in source order.
pub fn latest<'a, T>(
    items: impl IntoIterator<Item = &'a T>,
    created: impl Fn(&T) -> i64,
) -> Option<&'a T> {
    let mut items = items.into_iter().collect::<Vec<_>>();
    items.sort_by_key(|item| Reverse(created(item)));
    items.first().copied()
}

pub struct SourceInspection {
    pub customer: Option<Customer>,
    pub subscriptions: Vec<Subscription>,
    pub subscription: Option<Subscription>,
    pub item: Option<Item>,
    /// All of the customer's invoices: command recovery inspects the
    /// original subscription's invoices, not only the selected one's.
    pub invoices: Vec<Invoice>,
    pub open_invoice: Option<Invoice>,
    pub unsettled_current_invoice: bool,
    pub state: HostedBillingState,
}

/// Only verified https Stripe-hosted URLs leave the service.
pub fn safe_stripe_url(url: Option<&str>) -> Option<String> {
    let parsed = Url::parse(url?).ok()?;
    let host = parsed.host_str()?;
    (parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && (host == "stripe.com" || host.ends_with(".stripe.com")))
    .then(|| parsed.to_string())
}

pub fn require_stripe_url(url: Option<&str>, expected_host: &str) -> HostedResult<String> {
    safe_stripe_url(url)
        .filter(|url| Url::parse(url).is_ok_and(|url| url.host_str() == Some(expected_host)))
        .ok_or_else(|| {
            HostedError::new(
                503,
                Some("billing_unavailable"),
                "The billing provider returned an unexpected payment URL",
            )
        })
}

/// An invoice is settlement evidence only with a paid payment record (a
/// card charge or a verified non-charge settlement), or as a paid $0
/// invoice with nothing due.
fn invoice_settled(invoice: &Invoice) -> bool {
    if invoice.status.as_deref() != Some("paid") {
        return false;
    }
    let paid = invoice
        .payments
        .iter()
        .filter(|payment| payment.status == "paid");
    if paid
        .clone()
        .any(|payment| payment.charge_refunded.is_some() || payment.settled_without_charge)
    {
        return true;
    }
    invoice.amount_due <= 0 && invoice.amount_paid <= 0
}

fn invoice_fully_refunded(invoice: &Invoice) -> bool {
    if invoice.amount_paid <= 0 {
        return false;
    }
    let refunded = invoice
        .payments
        .iter()
        .filter(|payment| payment.status == "paid")
        .map(|payment| payment.charge_refunded.unwrap_or(0))
        .sum::<i64>();
    refunded >= invoice.amount_paid
}

impl Hosted {
    pub(super) fn provider_failure(&self, operation: &str, error: ProviderError) -> HostedError {
        eprintln!("billing: {operation} failed: {error}");
        HostedError::unavailable()
    }

    /// Cached on success only.
    pub(super) async fn ensure_price_verified(
        &self,
        interval: BillingInterval,
    ) -> HostedResult<()> {
        let (verified, amount) = match interval {
            BillingInterval::Month => (&self.price_verified[0], SEAT_UNIT_AMOUNT),
            BillingInterval::Year => (&self.price_verified[1], ANNUAL_UNIT_AMOUNT),
        };
        if verified.load(Ordering::Acquire) {
            return Ok(());
        }
        let price = self
            .stripe
            .retrieve_price(self.config.price_id(interval))
            .await
            .map_err(|_| HostedError::unavailable())?;
        let valid = price.currency == SEAT_CURRENCY
            && price.unit_amount == Some(amount)
            && price.recurring.as_ref().is_some_and(|recurring| {
                recurring.interval == interval.as_str()
                    && recurring.interval_count == 1
                    && recurring.usage_type == "licensed"
            })
            && price.billing_scheme.as_deref() == Some("per_unit")
            && !price.transform_quantity
            && price.livemode == (self.config.environment == BillingEnvironment::Production);
        if !valid {
            return Err(HostedError::new(
                503,
                Some("billing_setup_invalid"),
                match interval {
                    BillingInterval::Month => {
                        "The configured Stripe price is not the Suplex Pro monthly seat price"
                    }
                    BillingInterval::Year => {
                        "The configured Stripe price is not the Suplex Pro annual seat price"
                    }
                },
            ));
        }
        verified.store(true, Ordering::Release);
        Ok(())
    }

    fn persist_customer_hint(
        &self,
        account: &mut AccountRow,
        customer_id: Option<&str>,
    ) -> HostedResult<()> {
        if account.stripe_customer_id.as_deref() != customer_id {
            let now = self.now_iso();
            self.query(|db| store::update_stripe_customer(db, &account.id, customer_id, &now))?;
            account.stripe_customer_id = customer_id.map(str::to_owned);
        }
        Ok(())
    }

    /// A stale or foreign hint is an observation, not authority: rediscover.
    pub(super) async fn resolve_customer(
        &self,
        account: &mut AccountRow,
    ) -> HostedResult<Option<Customer>> {
        let owned = |customer: &Customer| {
            !customer.deleted && customer.account_id.as_deref() == Some(&account.id)
        };
        if let Some(hint) = &account.stripe_customer_id {
            let hinted = self
                .stripe
                .get_customer(hint)
                .await
                .map_err(|error| self.provider_failure("stripe read", error))?;
            if let Some(hinted) = hinted.filter(owned) {
                return Ok(Some(hinted));
            }
        }
        let discovered = self
            .stripe
            .search_customers_by_account_id(&account.id)
            .await
            .map_err(|error| self.provider_failure("stripe read", error))?;
        if let Some(found) = discovered.into_iter().find(owned) {
            self.persist_customer_hint(account, Some(&found.id))?;
            return Ok(Some(found));
        }
        // Fall back to customer ids recorded on durable operations.
        let operations = self.query(|db| store::list_operations_for_account(db, &account.id))?;
        for operation in operations {
            let Some(candidate) = operation
                .data
                .get("stripeCustomerId")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            if account.stripe_customer_id.as_deref() == Some(candidate) {
                continue;
            }
            let found = self
                .stripe
                .get_customer(candidate)
                .await
                .map_err(|error| self.provider_failure("stripe read", error))?;
            if let Some(found) = found.filter(|customer| {
                !customer.deleted && customer.account_id.as_deref() == Some(&account.id)
            }) {
                self.persist_customer_hint(account, Some(&found.id))?;
                return Ok(Some(found));
            }
        }
        self.persist_customer_hint(account, None)?;
        Ok(None)
    }

    /// The live subscription with a Pro price, newest first.
    fn select_subscription(&self, subscriptions: &[Subscription]) -> Option<(Subscription, Item)> {
        let mut candidates = subscriptions
            .iter()
            .filter_map(|subscription| {
                let item = subscription
                    .items
                    .iter()
                    .find(|item| self.config.is_pro_price(&item.price_id))?;
                Some((subscription, item))
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|(subscription, _)| {
            (
                terminal(&subscription.status),
                Reverse(subscription.created),
            )
        });
        candidates
            .first()
            .map(|(subscription, item)| ((*subscription).clone(), (*item).clone()))
    }

    /// Invoice lines for the configured seat item or price with a real
    /// service period.
    fn relevant_lines<'a>(&self, invoice: &'a Invoice, item: &Item) -> Vec<&'a InvoiceLine> {
        invoice
            .lines
            .iter()
            .filter(|line| {
                line.period_end > line.period_start
                    && (line.price_id.as_deref() == Some(&item.price_id)
                        || line.subscription_item_id.as_deref() == Some(&item.id))
            })
            .collect()
    }

    /// Settled service-period coverage. The refund subject is the newest
    /// settled invoice covering a period, so a full refund of the current
    /// period removes exactly that coverage and an older-period refund never
    /// revokes a later renewal. A partial refund does not revoke a period.
    /// Returns `(paid_until_ms, current_period_fully_refunded)`.
    fn paid_coverage(
        &self,
        subscription: &Subscription,
        item: &Item,
        invoices: &[&Invoice],
    ) -> (Option<i64>, bool) {
        let mut periods = BTreeMap::<i64, Vec<&Invoice>>::new();
        for invoice in invoices {
            if invoice.subscription_id.as_deref() != Some(&subscription.id)
                || !invoice_settled(invoice)
            {
                continue;
            }
            let Some(end) = self
                .relevant_lines(invoice, item)
                .iter()
                .map(|line| line.period_end)
                .max()
            else {
                continue;
            };
            periods.entry(end).or_default().push(invoice);
        }
        let Some((&latest_end, current)) = periods.last_key_value() else {
            return (None, false);
        };
        let current_fully_refunded = latest(current.iter().copied(), |invoice| invoice.created)
            .is_some_and(invoice_fully_refunded);
        let paid_until = periods
            .iter()
            .filter(|(end, bucket)| {
                (**end != latest_end || !current_fully_refunded)
                    && !bucket.iter().all(|invoice| invoice_fully_refunded(invoice))
            })
            .map(|(end, _)| *end)
            .max()
            .filter(|end| *end > 0);
        (paid_until.map(|end| end * 1000), current_fully_refunded)
    }

    async fn read_revenuecat_subscriber(&self, account: &AccountRow) -> (Option<Subscriber>, bool) {
        match self
            .revenuecat
            .get_subscriber(&account.revenuecat_app_user_id)
            .await
        {
            Ok(subscriber) => (subscriber, false),
            Err(error) => {
                eprintln!(
                    "billing: revenuecat subscriber read failed for {}: {error}",
                    account.id
                );
                (None, true)
            }
        }
    }

    fn record_sync_success(&self, account: &mut AccountRow, fingerprint: &str) -> HostedResult<()> {
        let now = self.now_iso();
        self.query(|db| store::record_sync_success(db, &account.id, fingerprint, &now))?;
        account.revenuecat_fingerprint = Some(fingerprint.to_owned());
        account.next_sync_at = None;
        account.sync_attempt_count = 0;
        Ok(())
    }

    fn schedule_sync(
        &self,
        account: &mut AccountRow,
        fingerprint: &str,
        error: &str,
    ) -> HostedResult<()> {
        let now_ms = self.now_ms();
        let next = backoff_at(account.sync_attempt_count, now_ms);
        let now = iso(now_ms);
        self.query(|db| {
            store::record_sync_pending(db, &account.id, fingerprint, &next, error, &now)
        })?;
        account.revenuecat_fingerprint = Some(fingerprint.to_owned());
        account.next_sync_at = Some(next);
        account.sync_attempt_count += 1;
        Ok(())
    }

    /// Keeps RevenueCat's representation of the verified Stripe subscription
    /// repaired. The fingerprint records material lifecycle facts so a
    /// scheduled cancellation or a current-period refund re-syncs; it only
    /// suppresses redundant imports and never authorizes access. A matching
    /// fingerprint counts only after the subscriber read confirms the
    /// product is represented.
    async fn sync_revenuecat(
        &self,
        account: &mut AccountRow,
        subscription: &Subscription,
        item: &Item,
        current_period_fully_refunded: bool,
        subscriber: (Option<&Subscriber>, bool),
    ) -> HostedResult<()> {
        let (subscriber, subscriber_read_failed) = subscriber;
        let fingerprint = [
            subscription.id.clone(),
            item.quantity.to_string(),
            subscription.status.clone(),
            item.period_end.to_string(),
            (if subscription.cancel_at_period_end {
                "canceling"
            } else {
                "renewing"
            })
            .to_owned(),
            (if current_period_fully_refunded {
                "refunded"
            } else {
                "settled"
            })
            .to_owned(),
        ]
        .join(":");
        let should_represent = !terminal(&subscription.status) && !current_period_fully_refunded;
        let represented = should_represent
            && subscriber
                .and_then(|subscriber| subscriber.subscriptions.get(&item.price_id))
                .is_some_and(|record| !record.refunded());

        if !should_represent {
            // Nothing is owed to RevenueCat; an outstanding repair is done.
            if account.next_sync_at.is_some() {
                self.record_sync_success(account, &fingerprint)?;
            }
            return Ok(());
        }
        let same = account.revenuecat_fingerprint.as_deref() == Some(fingerprint.as_str());
        if same && represented {
            if account.next_sync_at.is_some() {
                self.record_sync_success(account, &fingerprint)?;
            }
            return Ok(());
        }
        let repair_due = account
            .next_sync_at
            .as_deref()
            .is_none_or(|at| parse_ms(at).is_some_and(|at| at <= self.now_ms()));
        if same && !repair_due {
            // A repair is already scheduled; do not import on every read.
            return Ok(());
        }
        if same && subscriber_read_failed {
            // An import cannot be verified while the subscriber read is down.
            if account.next_sync_at.is_none() {
                self.schedule_sync(
                    account,
                    &fingerprint,
                    "revenuecat subscriber read failed; verification pending",
                )?;
            }
            return Ok(());
        }
        match self
            .revenuecat
            .import_receipt(&account.revenuecat_app_user_id, &subscription.id)
            .await
        {
            Ok(()) if represented => self.record_sync_success(account, &fingerprint),
            // Accepted but not yet visible: stay eligible for a repair.
            Ok(()) => self.schedule_sync(
                account,
                &fingerprint,
                "receipt import accepted; subscriber confirmation pending",
            ),
            Err(error) => {
                eprintln!(
                    "billing: revenuecat receipt import failed for {}; retry scheduled: {error}",
                    account.id
                );
                self.schedule_sync(account, &fingerprint, &error.to_string())
            }
        }
    }

    pub(super) async fn inspect_source(
        &self,
        account: &mut AccountRow,
    ) -> HostedResult<SourceInspection> {
        let environment = self.config.environment;
        let mut inspection = SourceInspection {
            customer: None,
            subscriptions: Vec::new(),
            subscription: None,
            item: None,
            invoices: Vec::new(),
            open_invoice: None,
            unsettled_current_invoice: false,
            state: HostedBillingState {
                active: false,
                purchased_seats: 0,
                subscription_status: "none".into(),
                renewal_at: None,
                access_until: None,
                cancel_at_period_end: false,
                payment_action_required: false,
                payment_action_url: None,
                environment,
            },
        };
        let Some(customer) = self.resolve_customer(account).await? else {
            return Ok(inspection);
        };
        let read = |error| self.provider_failure("stripe read", error);
        let subscriptions = self
            .stripe
            .list_subscriptions(&customer.id)
            .await
            .map_err(read)?;
        let selected = self.select_subscription(&subscriptions);
        inspection.customer = Some(customer.clone());
        inspection.subscriptions = subscriptions;
        let Some((subscription, item)) = selected else {
            return Ok(inspection);
        };
        if account.subscription_hint.as_deref() != Some(&subscription.id) {
            let now = self.now_iso();
            self.query(|db| {
                store::update_subscription_hint(db, &account.id, &subscription.id, &now)
            })?;
            account.subscription_hint = Some(subscription.id.clone());
        }

        let invoices = self
            .stripe
            .list_invoices(&customer.id)
            .await
            .map_err(read)?;
        let subscription_invoices = invoices
            .iter()
            .filter(|invoice| invoice.subscription_id.as_deref() == Some(&subscription.id))
            .collect::<Vec<_>>();
        let latest_invoice = match &subscription.latest_invoice_id {
            Some(id) => match subscription_invoices
                .iter()
                .find(|invoice| &invoice.id == id)
            {
                Some(found) => Some((*found).clone()),
                None => self.stripe.retrieve_invoice(id).await.map_err(read)?,
            },
            None => None,
        };

        // Settled service-period coverage decides paid access; `active`, a
        // future item period end, and an unpaid amount due are not
        // settlement.
        let (paid_until, current_fully_refunded) =
            self.paid_coverage(&subscription, &item, &subscription_invoices);
        // A trial covers its period through its settled $0 invoice.
        let coverage_status = matches!(subscription.status.as_str(), "active" | "trialing")
            || GRACE_ELIGIBLE_STATUSES.contains(&subscription.status.as_str());
        let stripe_paid_until = paid_until.filter(|_| coverage_status);

        // The current invoice is the subscription's latest, or the settled
        // invoice covering the item's current cycle. An unsettled one
        // surfaces a payment action even while Stripe still says active.
        let covering_current = latest(
            subscription_invoices.iter().copied().filter(|invoice| {
                self.relevant_lines(invoice, &item).iter().any(|line| {
                    line.period_start <= item.period_start && line.period_end >= item.period_end
                })
            }),
            |invoice| invoice.created,
        );
        let current_invoice = latest_invoice.as_ref().or(covering_current);
        let unsettled_current_invoice = current_invoice
            .is_some_and(|invoice| !matches!(invoice.status.as_deref(), Some("paid" | "void")));
        let open_invoice = latest(
            subscription_invoices
                .iter()
                .copied()
                .filter(|invoice| invoice.status.as_deref() == Some("open")),
            |invoice| invoice.created,
        )
        .cloned();

        // RevenueCat supplies only a strictly validated grace window.
        let (subscriber, subscriber_read_failed) = self.read_revenuecat_subscriber(account).await;
        self.sync_revenuecat(
            account,
            &subscription,
            &item,
            current_fully_refunded,
            (subscriber.as_ref(), subscriber_read_failed),
        )
        .await?;
        // The RevenueCat Stripe integration names products by price id.
        let grace_until = subscriber
            .as_ref()
            .and_then(|subscriber| pro_entitlement_window(subscriber, environment, &item.price_id))
            .and_then(|window| window.grace_until)
            .and_then(|at| parse_ms(&at));
        // Grace extends only a renewal failure on the same product; it never
        // overrides a cancellation, expiry, or full refund.
        let grace = grace_until.filter(|_| {
            GRACE_ELIGIBLE_STATUSES.contains(&subscription.status.as_str())
                && !current_fully_refunded
        });

        let now_ms = self.now_ms();
        let access_until = Some(stripe_paid_until.unwrap_or(0).max(grace.unwrap_or(0)))
            .filter(|until| *until != 0);
        let quantity = item.quantity.max(0);
        let active = access_until.is_some_and(|until| until > now_ms) && quantity > 0;
        let payment_action_required = unpaid(&subscription.status)
            || unsettled_current_invoice
            || (subscription.pending_update.is_some() && open_invoice.is_some());
        let action_invoice = open_invoice
            .as_ref()
            .or(current_invoice.filter(|_| unsettled_current_invoice));
        let payment_action_url = safe_stripe_url(
            action_invoice.and_then(|invoice| invoice.hosted_invoice_url.as_deref()),
        );

        inspection.state = HostedBillingState {
            active,
            purchased_seats: if active { quantity } else { 0 },
            subscription_status: subscription.status.clone(),
            renewal_at: (active && subscription.status == "active")
                .then(|| iso(item.period_end * 1000)),
            access_until: access_until.map(iso),
            cancel_at_period_end: subscription.cancel_at_period_end,
            payment_action_required,
            payment_action_url,
            environment,
        };
        inspection.subscription = Some(subscription);
        inspection.item = Some(item);
        inspection.open_invoice = open_invoice;
        inspection.unsettled_current_invoice = unsettled_current_invoice;
        inspection.invoices = invoices;
        Ok(inspection)
    }

    pub async fn read_state(&self, account: &mut AccountRow) -> HostedResult<HostedBillingState> {
        Ok(self.inspect_source(account).await?.state)
    }
}

#[cfg(test)]
include!("../../../tests/billing/accounts_state.rs");
