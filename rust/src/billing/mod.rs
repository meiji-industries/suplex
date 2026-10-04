//! Suplex Free and Pro. Pro belongs to the Suplex account linked to this
//! installation. The hosted service at suplex.sh owns subscription evidence;
//! this module reads it, keeps the last confirmed Pro access in `suplex_plan`,
//! forwards money commands, and enforces each plan's limits.
//!
//! Limits are decided from `suplex_plan` inside the writing transaction.
//! Before a Free limit refuses an action, `observe` reads suplex.sh again, so
//! a purchase made anywhere applies at once. A hosted outage keeps confirmed
//! Pro until its paid access ends; it never grants Pro.

use std::{error::Error, time::Duration};

use chrono::{DateTime, Datelike, Utc};
use reqwest::Method;
use rusqlite::params;
use serde::{Serialize, de::DeserializeOwned};
use ts_rs::TS;
use url::Url;

use crate::{
    accounts,
    http::AppState,
    identity::companies,
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::{PublicFailure, time::rfc3339_millis},
};
use wire::{HostedCheckoutResult, HostedErrorBody, HostedPlan, HostedPortalResult};

pub mod hosted;
pub mod wire;

crate::shared::wire_enum! {
    pub enum Plan { Free = "free", Pro = "pro" }
}

/// A `None` limit is unlimited.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    pub companies: Option<i64>,
    pub projects: Option<i64>,
    pub running_tasks: Option<i64>,
    pub monthly_tasks: Option<i64>,
}

pub const FREE: PlanLimits = PlanLimits {
    companies: Some(1),
    projects: Some(2),
    running_tasks: Some(FREE_RUNNING_TASKS),
    monthly_tasks: Some(50),
};

pub const PRO: PlanLimits = PlanLimits {
    companies: Some(3),
    projects: Some(10),
    running_tasks: None,
    monthly_tasks: None,
};

/// The number in `running_limited_sql!`.
const FREE_RUNNING_TASKS: i64 = 3;

pub fn limits(plan: Plan) -> PlanLimits {
    match plan {
        Plan::Free => FREE,
        Plan::Pro => PRO,
    }
}

/// SQL: confirmed Pro access for the linked account has not ended.
#[macro_export]
macro_rules! pro_sql {
    () => {
        "EXISTS(SELECT 1 FROM suplex_plan p JOIN suplex_account a ON a.account_id = p.account_id WHERE p.id = 'host' AND p.access_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
    };
}

/// SQL: running tasks in every company. A task waiting on you holds its slot.
#[macro_export]
macro_rules! running_tasks_sql {
    () => {
        "(SELECT COUNT(*) FROM suplex_tasks s JOIN suplex_task_controls sc ON sc.task_id = s.id WHERE s.archived_at IS NULL AND sc.status IN ('active', 'waiting_human'))"
    };
}

/// SQL: Free's running-task limit holds a queued task back.
#[macro_export]
macro_rules! running_limited_sql {
    () => {
        concat!(
            "(NOT ",
            $crate::pro_sql!(),
            " AND ",
            $crate::running_tasks_sql!(),
            " >= 3)"
        )
    };
}

pub fn plan(database: &SuplexDatabase) -> DatabaseResult<Plan> {
    let pro: bool = database
        .connection()
        .query_row(concat!("SELECT ", pro_sql!()), [], |row| row.get(0))?;
    Ok(if pro { Plan::Pro } else { Plan::Free })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    Companies,
    Projects,
    RunningTasks,
    MonthlyTasks,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub companies: i64,
    pub projects: i64,
    pub running_tasks: i64,
    pub monthly_tasks: i64,
}

/// The first instant of the UTC calendar month.
fn month_start(now: DateTime<Utc>) -> String {
    format!("{:04}-{:02}-01T00:00:00.000Z", now.year(), now.month())
}

/// Archived companies do not count. Projects cannot be removed, so every
/// project counts. Every task created this month counts, also an archived one.
pub fn usage(database: &SuplexDatabase, now: DateTime<Utc>) -> DatabaseResult<PlanUsage> {
    Ok(database.connection().query_row(
        concat!(
            "SELECT (SELECT COUNT(*) FROM suplex_companies WHERE status != 'archived'), (SELECT COUNT(*) FROM suplex_projects), ",
            running_tasks_sql!(),
            ", (SELECT COUNT(*) FROM suplex_tasks WHERE created_at >= ?1)"
        ),
        [month_start(now)],
        |row| {
            Ok(PlanUsage {
                companies: row.get(0)?,
                projects: row.get(1)?,
                running_tasks: row.get(2)?,
                monthly_tasks: row.get(3)?,
            })
        },
    )?)
}

fn reached(plan: Plan, usage: &PlanUsage, limit: Limit) -> Option<i64> {
    let limits = limits(plan);
    let (used, allowed) = match limit {
        Limit::Companies => (usage.companies, limits.companies),
        Limit::Projects => (usage.projects, limits.projects),
        Limit::RunningTasks => (usage.running_tasks, limits.running_tasks),
        Limit::MonthlyTasks => (usage.monthly_tasks, limits.monthly_tasks),
    };
    allowed.filter(|allowed| used >= *allowed)
}

pub fn limit_failure(plan: Plan, limit: Limit, allowed: i64) -> PublicFailure {
    let (code, what) = match (limit, allowed) {
        (Limit::Companies, 1) => ("company_limit_reached", "1 company".to_owned()),
        (Limit::Companies, n) => ("company_limit_reached", format!("{n} companies")),
        (Limit::Projects, 1) => ("project_limit_reached", "1 project".to_owned()),
        (Limit::Projects, n) => ("project_limit_reached", format!("{n} projects")),
        (Limit::RunningTasks, n) => ("running_task_limit_reached", format!("{n} tasks at a time")),
        (Limit::MonthlyTasks, n) => ("task_limit_reached", format!("{n} tasks each month")),
    };
    let message = match plan {
        Plan::Free => format!("Free includes {what}. Select Pro in Settings > Billing."),
        Plan::Pro => format!("Pro includes {what}."),
    };
    PublicFailure::new(402, message).with_code(code)
}

/// Refuses the action when the plan's limit is reached. Call it inside the
/// transaction that writes, so concurrent writers cannot pass it together.
pub fn require(database: &SuplexDatabase, limit: Limit, now: DateTime<Utc>) -> DatabaseResult<()> {
    let plan = plan(database)?;
    match reached(plan, &usage(database, now)?, limit) {
        Some(allowed) => Err(limit_failure(plan, limit, allowed).into()),
        None => Ok(()),
    }
}

/// Reads suplex.sh again when a Free limit would refuse `limit`. It never
/// fails: the decision that follows uses whatever plan is then confirmed.
pub async fn observe(state: &AppState, limit: Limit) {
    let refused = state.with_database(|database| {
        Ok::<_, Box<dyn Error>>(
            plan(database)? == Plan::Free
                && reached(Plan::Free, &usage(database, Utc::now())?, limit).is_some(),
        )
    });
    if refused.unwrap_or(false) {
        let _ = refresh(state).await;
    }
}

pub fn unavailable() -> PublicFailure {
    PublicFailure::new(503, "Suplex cannot check the subscription").with_code("billing_unavailable")
}

fn not_configured() -> PublicFailure {
    PublicFailure::new(503, "Billing is not configured").with_code("billing_not_configured")
}

fn account_required() -> PublicFailure {
    PublicFailure::new(409, "Log in to your Suplex account to change the plan")
        .with_code("account_required")
}

/// The hosted billing API. It never follows a redirect: that would resend the
/// account token to another origin.
#[derive(Clone)]
pub struct BillingClient {
    base: Url,
    http: reqwest::Client,
}

/// Hosted 4xx codes that keep their meaning for the caller. Any other
/// failure is a sanitized `billing_unavailable`.
const KNOWN_HOSTED_FAILURES: [(&str, u16, &str); 5] = [
    (
        "idempotency_conflict",
        409,
        "This idempotency key belongs to a different request",
    ),
    (
        "billing_operation_not_applied",
        409,
        "The change was not applied. Try again.",
    ),
    ("no_subscription", 409, "No subscription exists"),
    (
        "billing_payment_pending",
        409,
        "A billing payment is still pending",
    ),
    ("trial_used", 409, "This Suplex account used its trial"),
];

impl BillingClient {
    pub fn new(base: Url) -> Self {
        Self {
            base,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("billing HTTP client builds"),
        }
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: &str,
        idempotency_key: Option<&str>,
    ) -> Result<T, PublicFailure> {
        let url = self.base.join(path).map_err(|_| unavailable())?;
        let mut request = self.http.request(method, url).bearer_auth(token);
        if let Some(key) = idempotency_key {
            request = request.header("idempotency-key", key);
        }
        let response = request.send().await.map_err(|_| unavailable())?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            let code = response
                .json::<HostedErrorBody>()
                .await
                .ok()
                .and_then(|body| body.code);
            return Err(KNOWN_HOSTED_FAILURES
                .iter()
                .find(|(known, known_status, _)| {
                    code.as_deref() == Some(*known) && *known_status == status
                })
                .map_or_else(unavailable, |(code, status, message)| {
                    PublicFailure::new(*status, *message).with_code(code)
                }));
        }
        response.json().await.map_err(|_| unavailable())
    }

    /// Checkout, portal, and payment URLs forwarded to the browser must land
    /// on the hosted origin or an exact Stripe-hosted page.
    fn forwarded_url(&self, raw: &str) -> Result<String, PublicFailure> {
        const STRIPE_HOSTS: [&str; 4] = [
            "checkout.stripe.com",
            "billing.stripe.com",
            "invoice.stripe.com",
            "pay.stripe.com",
        ];
        let url = Url::parse(raw).map_err(|_| unavailable())?;
        let allowed = url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && if url.host_str() == self.base.host_str() {
                url.port_or_known_default() == self.base.port_or_known_default()
            } else {
                url.host_str()
                    .is_some_and(|host| STRIPE_HOSTS.contains(&host))
                    && url.port().is_none_or(|port| port == 443)
            };
        allowed.then(|| url.to_string()).ok_or_else(unavailable)
    }
}

/// A hosted service URL from the variable `name`: HTTPS, or HTTP on loopback.
pub fn parse_service_url(value: &str, name: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| format!("{name} is invalid"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(format!("{name} must use HTTPS"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{name} must not contain credentials"));
    }
    Ok(url)
}

fn remember(state: &AppState, account_id: &str, plan: &HostedPlan) -> DatabaseResult<()> {
    let access_until = plan
        .state
        .active
        .then(|| plan.state.access_until.clone())
        .flatten();
    state.with_database(|database| {
        database.connection().execute(
            "INSERT OR REPLACE INTO suplex_plan (id, account_id, access_until, checked_at) VALUES ('host', ?1, ?2, ?3)",
            params![account_id, access_until, rfc3339_millis(Utc::now())],
        )?;
        Ok(())
    })
}

fn valid(plan: HostedPlan) -> Result<HostedPlan, PublicFailure> {
    plan.state.valid().then_some(plan).ok_or_else(unavailable)
}

/// Reads the linked account's plan from suplex.sh and remembers it. `None`
/// means no Suplex account is linked, which is Free.
pub async fn refresh(state: &AppState) -> Result<Option<HostedPlan>, Box<dyn Error>> {
    let client = state.billing.as_ref().ok_or_else(not_configured)?;
    let Some(account) = state.with_database(|database| accounts::linked(database))? else {
        return Ok(None);
    };
    let plan = valid(
        client
            .call(Method::GET, "/v1/plan", &account.token, None)
            .await?,
    )?;
    remember(state, &account.account_id, &plan)?;
    Ok(Some(plan))
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BillingSummary {
    /// The plan that applies now.
    pub plan: Plan,
    pub limits: PlanLimits,
    pub usage: PlanUsage,
    /// False when suplex.sh did not answer: the plan is the last confirmed one.
    pub checked: bool,
    pub account_linked: bool,
    pub can_manage_billing: bool,
    pub purchase_configured: bool,
    pub trial_available: bool,
    /// The Stripe status, such as `trialing` or `active`. `none` without a
    /// subscription.
    pub subscription_status: Option<String>,
    pub renewal_at: Option<String>,
    pub access_until: Option<String>,
    pub cancel_at_period_end: bool,
    pub payment_action_required: bool,
    /// Only administrators receive a billing URL.
    pub payment_action_url: Option<String>,
}

pub async fn summary(state: &AppState, user_id: &str) -> Result<BillingSummary, Box<dyn Error>> {
    let (can_manage_billing, account_linked) = state.with_database(|database| {
        let admin = companies::require_admin(database, user_id).is_ok();
        Ok::<_, Box<dyn Error>>((admin, accounts::linked(database)?.is_some()))
    })?;
    let remote = if account_linked && state.billing.is_some() {
        refresh(state).await.ok().flatten()
    } else {
        None
    };
    let (plan, usage) = state.with_database(|database| {
        Ok::<_, Box<dyn Error>>((plan(database)?, usage(database, Utc::now())?))
    })?;
    let payment_action_url = match (&remote, &state.billing) {
        (Some(remote), Some(client)) if can_manage_billing => remote
            .state
            .payment_action_url
            .as_deref()
            .map(|url| client.forwarded_url(url))
            .transpose()?,
        _ => None,
    };
    Ok(BillingSummary {
        plan,
        limits: limits(plan),
        usage,
        checked: remote.is_some() || !account_linked,
        account_linked,
        can_manage_billing,
        purchase_configured: state.billing.is_some(),
        trial_available: remote.as_ref().is_some_and(|remote| remote.trial_available),
        subscription_status: remote
            .as_ref()
            .map(|remote| remote.state.subscription_status.clone()),
        renewal_at: remote
            .as_ref()
            .and_then(|remote| remote.state.renewal_at.clone()),
        access_until: remote
            .as_ref()
            .and_then(|remote| remote.state.access_until.clone()),
        cancel_at_period_end: remote
            .as_ref()
            .is_some_and(|remote| remote.state.cancel_at_period_end),
        payment_action_required: remote
            .as_ref()
            .is_some_and(|remote| remote.state.payment_action_required),
        payment_action_url,
    })
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export)]
pub enum BillingCheckoutResponse {
    Redirect {
        url: String,
    },
    Subscribed {
        summary: BillingSummary,
    },
    PaymentRequired {
        url: Option<String>,
        summary: BillingSummary,
    },
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct BillingPortalResponse {
    pub url: String,
}

/// Money commands need an active administrator and a linked Suplex account.
fn administered<'a>(
    state: &'a AppState,
    user_id: &str,
) -> Result<(&'a BillingClient, accounts::LinkedAccount), Box<dyn Error>> {
    state.with_database(|database| {
        companies::require_admin(database, user_id)?;
        let client = state.billing.as_ref().ok_or_else(not_configured)?;
        let account = accounts::linked(database)?.ok_or_else(account_required)?;
        Ok((client, account))
    })
}

pub async fn start_trial(
    state: &AppState,
    user_id: &str,
) -> Result<BillingSummary, Box<dyn Error>> {
    let (client, account) = administered(state, user_id)?;
    let plan = valid(
        client
            .call(Method::POST, "/v1/plan/trial", &account.token, None)
            .await?,
    )?;
    remember(state, &account.account_id, &plan)?;
    summary(state, user_id).await
}

pub async fn checkout(
    state: &AppState,
    user_id: &str,
    idempotency_key: &str,
) -> Result<BillingCheckoutResponse, Box<dyn Error>> {
    let (client, account) = administered(state, user_id)?;
    let result: HostedCheckoutResult = client
        .call(
            Method::POST,
            "/v1/plan/checkout",
            &account.token,
            Some(idempotency_key),
        )
        .await?;
    if !result.valid() {
        return Err(unavailable().into());
    }
    Ok(match result {
        HostedCheckoutResult::Redirect { url, .. } => BillingCheckoutResponse::Redirect {
            url: client.forwarded_url(&url)?,
        },
        HostedCheckoutResult::Subscribed { .. } => BillingCheckoutResponse::Subscribed {
            summary: summary(state, user_id).await?,
        },
        HostedCheckoutResult::PaymentRequired { url, .. } => {
            BillingCheckoutResponse::PaymentRequired {
                url: url.map(|url| client.forwarded_url(&url)).transpose()?,
                summary: summary(state, user_id).await?,
            }
        }
    })
}

pub async fn portal(
    state: &AppState,
    user_id: &str,
) -> Result<BillingPortalResponse, Box<dyn Error>> {
    let (client, account) = administered(state, user_id)?;
    let result: HostedPortalResult = client
        .call(Method::POST, "/v1/plan/portal", &account.token, None)
        .await?;
    Ok(BillingPortalResponse {
        url: client.forwarded_url(&result.url)?,
    })
}

/// Reads the plan every 15 minutes, so a renewal, cancellation, or trial end
/// applies to queued tasks without a visit to Settings > Billing.
pub fn spawn_refresh(state: AppState) {
    if state.billing.is_none() {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15 * 60));
        loop {
            interval.tick().await;
            let _ = refresh(&state).await;
        }
    });
}

#[cfg(test)]
include!("../../tests/billing/private.rs");
