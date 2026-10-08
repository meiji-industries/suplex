//! Billing request contracts. Every object is strict: the boundary rejects
//! unknown fields instead of forwarding them to the hosted service.

use serde::Deserialize;
use serde_json::Value;

use super::{Contract, ContractResult, Fields, MAX, choice, fail, text};
use crate::billing::wire::{BillingInterval, CheckoutBody, valid_idempotency_key};

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

/// The Pro price to buy; an absent body or interval buys monthly.
impl Contract for CheckoutBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("interval", choice::<BillingInterval>)
            .strict()
    }
}
