//! Billing request contracts. Every object is strict: the boundary rejects
//! unknown fields instead of forwarding them to the hosted service.

use serde::Deserialize;
use serde_json::Value;

use super::{Contract, ContractResult, Fields, MAX, fail, text};
use crate::billing::wire::valid_idempotency_key;

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
