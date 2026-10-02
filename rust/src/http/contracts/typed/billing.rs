//! Billing request contracts. Every object is strict: the boundary rejects
//! unknown fields instead of forwarding them to the hosted service.

use serde::Deserialize;
use serde_json::Value;

use super::{Contract, ContractResult, Fields, MAX, fail, int, text, union};
use crate::billing::wire::{HostedSeatChangeBody, MAX_SEATS, valid_idempotency_key};

const QUANTITY: f64 = MAX_SEATS as f64;

/// Checkout and seat preview.
#[derive(Clone, Debug, Deserialize)]
pub struct SeatQuantityBody {
    pub quantity: i64,
}

impl Contract for SeatQuantityBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("quantity", int(1.0, QUANTITY))
            .strict()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub struct SeatChangeBody(pub HostedSeatChangeBody);

impl Contract for SeatChangeBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        union(
            input,
            &[
                &|input| {
                    Fields::new(input)?
                        .req("quantity", int(1.0, QUANTITY))
                        .req("previewId", text(1, 128))
                        .strict()
                },
                &|input| {
                    Fields::new(input)?
                        .req("quantity", int(1.0, QUANTITY))
                        .req("confirmNoRefund", |input| match input {
                            Some(Value::Bool(true)) => Ok(Value::Bool(true)),
                            _ => fail("invalid_literal"),
                        })
                        .strict()
                },
            ],
        )
    }
}

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
