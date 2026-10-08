//! Pro for a Suplex account. A private host reads and changes the plan of its
//! linked account with that account's token; the suplex.sh start page starts
//! a trial for the account that logs in there. Each Suplex account has one
//! billing account whose registration ID is the Suplex account ID, so no
//! registration credential can reach it.

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, header},
    routing::{get, post},
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use super::{
    Hosted, HostedError, HostedResult,
    server::idempotency_key,
    store::{self, AccountKey, AccountRow, NewAccount},
};
use crate::{
    accounts::wire::token_shape,
    billing::wire::{HostedCheckoutResult, HostedPlan, HostedPortalResult},
    shared::hash::sha256_hex,
};

pub const TRIAL_DAYS: i64 = 30;

impl Hosted {
    /// The billing account of a Suplex account, created on first use.
    pub fn billing_for_user(&self, user_id: &str) -> HostedResult<AccountRow> {
        let now = self.now_iso();
        Ok(self.immediate(|db| {
            if let Some(row) = store::find_account(db, AccountKey::RegistrationId, user_id)? {
                return Ok(row);
            }
            let id = format!("account_{}", uuid::Uuid::new_v4());
            // No credential has this hash: credentials are 43 characters.
            let unusable = sha256_hex(uuid::Uuid::new_v4().to_string());
            store::insert_account(
                db,
                &NewAccount {
                    id: &id,
                    registration_id: user_id,
                    credential_hash: &unusable,
                    installation_id: "",
                    company_id: "",
                    app_user_id: &format!("suplex_{user_id}"),
                    now: &now,
                },
            )?;
            store::find_account(db, AccountKey::Id, &id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)
        })?)
    }

    /// The billing account of the Suplex account that owns the bearer token.
    fn billing_for_token(&self, headers: &HeaderMap) -> HostedResult<AccountRow> {
        let unauthorized = || HostedError::new(401, None, "Unauthorized");
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| token_shape(token))
            .ok_or_else(unauthorized)?;
        let user_id: Option<String> = self.query(|db| {
            db.query_row(
                "SELECT account_id FROM account_tokens WHERE token_hash = ?1",
                [sha256_hex(token)],
                |row| row.get(0),
            )
            .optional()
        })?;
        self.billing_for_user(&user_id.ok_or_else(unauthorized)?)
    }

    pub async fn plan(&self, account: &mut AccountRow) -> HostedResult<HostedPlan> {
        let inspection = self.inspect_source(account).await?;
        Ok(HostedPlan {
            trial_available: inspection.subscriptions.is_empty(),
            state: inspection.state,
        })
    }

    /// Starts the account's one trial: Pro for 30 days with no payment method.
    /// A repeated request returns the current plan.
    pub async fn start_trial(&self, account: &mut AccountRow) -> HostedResult<HostedPlan> {
        let _lock = self.account_lock(&account.id).await;
        self.ensure_price_verified().await?;
        let inspection = self.inspect_source(account).await?;
        if !inspection.subscriptions.is_empty() {
            if inspection.state.active {
                return Ok(HostedPlan {
                    state: inspection.state,
                    trial_available: false,
                });
            }
            return Err(HostedError::new(
                409,
                Some("trial_used"),
                "This Suplex account used its trial",
            ));
        }
        let fail = |error| self.provider_failure("stripe request", error);
        let customer_id = match inspection.customer {
            Some(customer) => customer.id,
            None => {
                let customer = self
                    .stripe
                    .create_customer(&account.id, &format!("suplex_customer_{}", account.id))
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
        self.stripe
            .create_trial_subscription(
                &customer_id,
                &self.config.stripe_price_id,
                TRIAL_DAYS,
                &[
                    ("app_user_id", account.revenuecat_app_user_id.clone()),
                    ("account_id", account.id.clone()),
                ],
                &format!("suplex_trial_{}", account.id),
            )
            .await
            .map_err(fail)?;
        self.plan(account).await
    }
}

type Reply = HostedResult<Json<Value>>;

fn to_json<T: serde::Serialize>(value: &T) -> Json<Value> {
    Json(serde_json::to_value(value).unwrap_or(Value::Null))
}

async fn read(State(hosted): State<Hosted>, headers: HeaderMap) -> Reply {
    let mut account = hosted.billing_for_token(&headers)?;
    Ok(to_json(&hosted.plan(&mut account).await?))
}

async fn trial(State(hosted): State<Hosted>, headers: HeaderMap) -> Reply {
    let mut account = hosted.billing_for_token(&headers)?;
    Ok(to_json(&hosted.start_trial(&mut account).await?))
}

/// Pro is one seat.
async fn checkout(State(hosted): State<Hosted>, headers: HeaderMap) -> Reply {
    let mut account = hosted.billing_for_token(&headers)?;
    let key = idempotency_key(&headers)?;
    let result: HostedCheckoutResult = hosted.checkout(&mut account, 1, &key).await?;
    Ok(to_json(&result))
}

async fn portal(State(hosted): State<Hosted>, headers: HeaderMap) -> Reply {
    let mut account = hosted.billing_for_token(&headers)?;
    let result: HostedPortalResult = hosted.portal(&mut account).await?;
    Ok(Json(json!(result)))
}

pub fn router() -> Router<Hosted> {
    Router::new()
        .route("/v1/plan", get(read))
        .route("/v1/plan/trial", post(trial))
        .route("/v1/plan/checkout", post(checkout))
        .route("/v1/plan/portal", post(portal))
}

#[cfg(test)]
include!("../../../tests/billing/plan.rs");
