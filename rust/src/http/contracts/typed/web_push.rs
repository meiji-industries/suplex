//! Web push key response and browser subscription requests.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::{Contract, ContractResult, Fields, text};

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WebPushKeyResponse {
    pub public_key: String,
}

#[derive(Debug, Deserialize)]
pub struct WebPushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// The shape of the browser's `PushSubscription.toJSON()`. Other fields, such as `expirationTime`, are dropped.
#[derive(Debug, Deserialize)]
pub struct WebPushSubscriptionRequest {
    pub endpoint: String,
    pub keys: WebPushSubscriptionKeys,
}

#[derive(Debug, Deserialize)]
pub struct WebPushUnsubscribeRequest {
    pub endpoint: String,
}

fn keys(input: Option<&Value>) -> ContractResult<Value> {
    Fields::new(input)?
        .req("p256dh", text(1, 256))
        .req("auth", text(1, 256))
        .finish()
}

impl Contract for WebPushSubscriptionRequest {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .req("endpoint", text(1, 2048))
            .req("keys", keys)
            .finish()
    }
}

impl Contract for WebPushUnsubscribeRequest {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.req("endpoint", text(1, 2048)).finish()
    }
}
