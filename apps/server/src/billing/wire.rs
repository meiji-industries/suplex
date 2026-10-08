//! The hosted billing contract. The private Suplex client and the hosted
//! billing service share these types. A hosted payload that does not match
//! them is `billing_unavailable`: the client fails closed.

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

pub const SEAT_UNIT_AMOUNT: i64 = 2000;
/// Pro each year: 12 months less 20%.
pub const ANNUAL_UNIT_AMOUNT: i64 = 19200;
pub const SEAT_CURRENCY: &str = "usd";
pub const MAX_SEATS: i64 = 9999;
const MAX_URL: usize = 2048;
const MAX_ID: usize = 128;

crate::shared::wire_enum! {
    pub enum BillingEnvironment { Sandbox = "sandbox", Production = "production" }
}

crate::shared::wire_enum! {
    /// The Pro price a checkout buys. A request without one buys monthly.
    pub enum BillingInterval { Month = "month", Year = "year" }
}

/// The body of a Pro checkout request.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckoutBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<BillingInterval>,
}

/// `z.number().int().min(1).max(9999)`: any integral JSON number.
pub fn seat_quantity(value: &serde_json::Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && (1.0..=MAX_SEATS as f64).contains(&number)).then_some(number as i64)
}

pub fn valid_idempotency_key(key: &str) -> bool {
    (8..=128).contains(&key.len())
        && key.as_bytes()[0].is_ascii_alphanumeric()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn quantity<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    seat_quantity(&serde_json::Value::deserialize(deserializer)?)
        .ok_or_else(|| D::Error::custom("invalid seat quantity"))
}

/// `z.literal(true)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct True;

impl Serialize for True {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match bool::deserialize(deserializer)? {
            true => Ok(True),
            false => Err(D::Error::custom("expected true")),
        }
    }
}

fn bounded(text: &str, max: usize) -> bool {
    !text.is_empty() && text.encode_utf16().count() <= max
}

fn timestamp(text: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(text).is_ok_and(|_| text.ends_with('Z'))
}

/// POST /v1/accounts
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationBody {
    pub registration_id: String,
    pub credential: String,
    pub installation_id: String,
    pub company_id: String,
}

impl RegistrationBody {
    pub fn valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.registration_id).is_ok()
            && self.credential.len() == 43
            && self
                .credential
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            && (8..=64).contains(&self.installation_id.len())
            && self.installation_id.as_bytes()[0] != b'-'
            && self
                .installation_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && bounded(&self.company_id, 256)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationResponse {
    pub account_id: String,
}

/// GET /v1/billing. Active state has positive seats and a paid-access
/// deadline; inactive state keeps lifecycle and payment status so an
/// administrator can still resolve payment or cancel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBillingState {
    pub active: bool,
    pub purchased_seats: i64,
    pub subscription_status: String,
    pub renewal_at: Option<String>,
    pub access_until: Option<String>,
    pub cancel_at_period_end: bool,
    pub payment_action_required: bool,
    pub payment_action_url: Option<String>,
    pub environment: BillingEnvironment,
}

impl HostedBillingState {
    pub fn valid(&self) -> bool {
        let seats = if self.active {
            self.purchased_seats > 0 && self.access_until.is_some()
        } else {
            self.purchased_seats == 0
        };
        seats
            && bounded(&self.subscription_status, 64)
            && self.renewal_at.as_deref().is_none_or(timestamp)
            && self.access_until.as_deref().is_none_or(timestamp)
            && self
                .payment_action_url
                .as_deref()
                .is_none_or(|url| bounded(url, MAX_URL))
    }
}

/// GET /v1/plan and POST /v1/plan/trial: the plan of the Suplex account that
/// owns the bearer token. Each Suplex account gets one trial.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedPlan {
    pub state: HostedBillingState,
    pub trial_available: bool,
}

/// POST /v1/checkout and POST /v1/seats/preview.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuantityBody {
    #[serde(deserialize_with = "quantity")]
    pub quantity: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostedCheckoutResult {
    #[serde(rename_all = "camelCase")]
    Redirect { operation_id: String, url: String },
    #[serde(rename_all = "camelCase")]
    Subscribed {
        operation_id: String,
        state: HostedBillingState,
    },
    #[serde(rename_all = "camelCase")]
    PaymentRequired {
        operation_id: String,
        url: Option<String>,
        state: HostedBillingState,
    },
}

impl HostedCheckoutResult {
    pub fn valid(&self) -> bool {
        match self {
            Self::Redirect { operation_id, url } => {
                bounded(operation_id, MAX_ID) && bounded(url, MAX_URL)
            }
            Self::Subscribed {
                operation_id,
                state,
            } => bounded(operation_id, MAX_ID) && state.active && state.valid(),
            Self::PaymentRequired {
                operation_id,
                url,
                state,
            } => {
                bounded(operation_id, MAX_ID)
                    && url.as_deref().is_none_or(|url| bounded(url, MAX_URL))
                    && state.valid()
            }
        }
    }
}

/// The seat-change quote.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedSeatPreview {
    pub preview_id: String,
    pub expires_at: String,
    pub current_quantity: i64,
    pub requested_quantity: i64,
    pub amount_due_now: i64,
    pub next_subtotal: i64,
    /// Always `usd`.
    pub currency: String,
    pub proration_timestamp: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeatIncrease {
    #[serde(deserialize_with = "quantity")]
    pub quantity: i64,
    pub preview_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeatDecrease {
    #[serde(deserialize_with = "quantity")]
    pub quantity: i64,
    pub confirm_no_refund: True,
}

/// POST /v1/seats. A body that mixes `previewId` and `confirmNoRefund`
/// matches neither variant.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HostedSeatChangeBody {
    Increase(SeatIncrease),
    Decrease(SeatDecrease),
}

impl HostedSeatChangeBody {
    pub fn quantity(&self) -> i64 {
        match self {
            Self::Increase(body) => body.quantity,
            Self::Decrease(body) => body.quantity,
        }
    }

    pub fn valid(&self) -> bool {
        match self {
            Self::Increase(body) => bounded(&body.preview_id, MAX_ID),
            Self::Decrease(_) => true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostedSeatChangeResult {
    #[serde(rename_all = "camelCase")]
    Applied {
        operation_id: String,
        state: HostedBillingState,
    },
    #[serde(rename_all = "camelCase")]
    PaymentRequired {
        operation_id: String,
        url: Option<String>,
        state: HostedBillingState,
    },
}

/// POST /v1/portal
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostedPortalResult {
    pub url: String,
}

/// The hosted error envelope. Extra fields pass through.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostedErrorBody {
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn seat_change_bodies_match_exactly_one_variant() {
        let parse = |value| serde_json::from_value::<HostedSeatChangeBody>(value);
        assert!(matches!(
            parse(json!({"quantity": 3, "previewId": "preview_1"})),
            Ok(HostedSeatChangeBody::Increase(_))
        ));
        assert!(matches!(
            parse(json!({"quantity": 2.0, "confirmNoRefund": true})),
            Ok(HostedSeatChangeBody::Decrease(SeatDecrease {
                quantity: 2,
                ..
            }))
        ));
        assert!(parse(json!({"quantity": 2, "confirmNoRefund": false})).is_err());
        assert!(parse(json!({"quantity": 2, "previewId": "p", "confirmNoRefund": true})).is_err());
        assert!(parse(json!({"quantity": 2.5, "previewId": "p"})).is_err());
        assert!(parse(json!({"quantity": 10000, "previewId": "p"})).is_err());
    }

    #[test]
    fn billing_state_requires_seats_that_match_access() {
        let state = |value| serde_json::from_value::<HostedBillingState>(value).unwrap();
        let active = json!({"active": true, "purchasedSeats": 2, "subscriptionStatus": "active", "renewalAt": null, "accessUntil": "2026-11-01T00:00:00.000Z", "cancelAtPeriodEnd": false, "paymentActionRequired": false, "paymentActionUrl": null, "environment": "sandbox"});
        assert!(state(active.clone()).valid());
        let mut no_deadline = active.clone();
        no_deadline["accessUntil"] = json!(null);
        assert!(!state(no_deadline).valid());
        let mut inactive_with_seats = active.clone();
        inactive_with_seats["active"] = json!(false);
        assert!(!state(inactive_with_seats).valid());
        let mut extra = active;
        extra["extra"] = json!(1);
        assert!(serde_json::from_value::<HostedBillingState>(extra).is_err());
    }

    #[test]
    fn idempotency_keys_are_bounded_opaque_tokens() {
        assert!(valid_idempotency_key(
            "0f8e2a8c-1d7b-4b8e-9d55-5f0f0a1b2c3d"
        ));
        assert!(valid_idempotency_key("seat:abc.def_1"));
        assert!(!valid_idempotency_key("short"));
        assert!(!valid_idempotency_key("-leading-dash"));
        assert!(!valid_idempotency_key("has space here"));
        assert!(!valid_idempotency_key(&"a".repeat(129)));
    }
}
