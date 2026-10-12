//! Billing request contracts. Every object is strict: the boundary rejects
//! unknown fields instead of forwarding them to the hosted service.

use serde::Deserialize;
use serde_json::Value;

use super::{Contract, ContractResult, Fields, MAX, choice, fail, int, text};
use crate::billing::wire::{
    BillingInterval, CheckoutBody, MAX_SEATS, PaidPlan, PlanChangeBody, valid_idempotency_key,
};

/// Money mutations require an `Idempotency-Key` header.
#[derive(Clone, Debug, Deserialize)]
pub struct IdempotencyHeader {
    #[serde(rename = "idempotency-key")]
    pub key: String,
}

impl Contract for IdempotencyHeader {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("idempotency-key", |input| {
                let key = text(1, MAX)(input)?;
                if key.as_str().is_some_and(valid_idempotency_key) {
                    Ok(key)
                } else {
                    fail("invalid_string")
                }
            })
            .finish()
    }
}

/// The plan an existing subscription becomes; Free cancels it.
impl Contract for PlanChangeBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("plan", choice::<crate::billing::Plan>)
            .opt("interval", choice::<BillingInterval>)
            .opt("quantity", int(1.0, MAX_SEATS as f64))
            .strict()
    }
}

/// The plan, price, and seats to buy; an absent body buys one monthly Pro seat.
impl Contract for CheckoutBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("plan", choice::<PaidPlan>)
            .opt("interval", choice::<BillingInterval>)
            .opt("quantity", int(1.0, MAX_SEATS as f64))
            .strict()
    }
}
