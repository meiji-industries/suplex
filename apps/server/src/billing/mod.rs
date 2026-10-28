//! Suplex Free, Pro, and Team. A paid plan belongs to the Suplex account
//! linked to this installation. The hosted service at suplex.sh owns subscription evidence;
//! this module reads it, keeps the last confirmed Pro access in `suplex_plan`,
//! forwards money commands, and enforces each plan's limits.
//!
//! Limits are decided from `suplex_plan` inside the writing transaction.
//! Before a Free limit refuses an action, `observe` reads suplex.sh again, so
//! a purchase made anywhere applies at once. A hosted outage keeps confirmed
//! Pro until its paid access ends; it never grants Pro.

use std::{
    error::Error,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use chrono::{DateTime, Datelike, Utc};
use reqwest::Method;
use rusqlite::{OptionalExtension, params};
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
use wire::{
    CheckoutBody, HostedCheckoutResult, HostedErrorBody, HostedPlan, HostedPortalResult, PaidPlan,
    TEAM_INCLUDED_SEATS,
};

pub mod hosted;
pub mod wire;

crate::shared::wire_enum! {
    pub enum Plan { Free = "free", Pro = "pro", Team = "team" }
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
    projects: Some(25),
    running_tasks: None,
    monthly_tasks: None,
};

pub const TEAM: PlanLimits = PlanLimits {
    companies: None,
    projects: None,
    running_tasks: None,
    monthly_tasks: None,
};

/// The number in `running_limited_sql!`.
const FREE_RUNNING_TASKS: i64 = 3;

pub fn limits(plan: Plan) -> PlanLimits {
    match plan {
        Plan::Free => FREE,
        Plan::Pro => PRO,
        Plan::Team => TEAM,
    }
}

/// SQL: confirmed paid access for the linked account has not ended.
#[macro_export]
macro_rules! paid_sql {
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
            $crate::paid_sql!(),
            " AND ",
            $crate::running_tasks_sql!(),
            " >= 3)"
        )
    };
}

pub fn plan(database: &SuplexDatabase) -> DatabaseResult<Plan> {
    let (paid, team): (bool, bool) = database.connection().query_row(
        concat!(
            "SELECT ",
            paid_sql!(),
            ", EXISTS(SELECT 1 FROM suplex_plan WHERE id = 'host' AND plan = 'team')"
        ),
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(match (paid, team) {
        (false, _) => Plan::Free,
        (true, false) => Plan::Pro,
        (true, true) => Plan::Team,
    })
}

/// The linked account's last confirmed plan was Team and its paid access has
/// ended. Work is read-only until someone pays again.
pub fn team_lapsed(database: &SuplexDatabase) -> DatabaseResult<bool> {
    Ok(database.connection().query_row(
        concat!(
            "SELECT NOT ",
            paid_sql!(),
            " AND EXISTS(SELECT 1 FROM suplex_plan p JOIN suplex_account a ON a.account_id = p.account_id WHERE p.id = 'host' AND p.plan = 'team')"
        ),
        [],
        |row| row.get(0),
    )?)
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
        Plan::Pro => format!("Pro includes {what}. Select Team in Settings > Billing."),
        Plan::Team => format!("Team includes {what}."),
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
        Ok::<_, Box<dyn Error + Send + Sync>>(
            plan(database)? == Plan::Free
                && reached(Plan::Free, &usage(database, Utc::now())?, limit).is_some(),
        )
    });
    if refused.unwrap_or(false) {
        // A purchase made a moment ago applies: do not use a recent read.
        if let Some(client) = &state.billing {
            client.forget_plan_reads();
        }
        let _ = refresh(state).await;
    }
}

/// Only Team, also a Team trial, lets other people use this host.
pub fn require_team(database: &SuplexDatabase, message: &str) -> DatabaseResult<()> {
    if plan(database)? == Plan::Team {
        return Ok(());
    }
    Err(PublicFailure::new(402, message)
        .with_code("team_required")
        .into())
}

/// Reads suplex.sh again when the confirmed plan is not Team, so a Team
/// purchase made a moment ago applies. It never fails.
pub async fn observe_team(state: &AppState) {
    let team = state.with_database(|database| plan(database).map(|plan| plan == Plan::Team));
    if !team.unwrap_or(true) {
        if let Some(client) = &state.billing {
            client.forget_plan_reads();
        }
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
    reads: Arc<PlanReads>,
    /// How long a plan read also answers later readers.
    plan_read_reuse: Duration,
}

/// One plan read at a time, and the last answer. Each open Settings > Billing
/// page and each tab reads the plan, so readers that wait on a running read,
/// or arrive soon after it, share its request to suplex.sh. A money command
/// starts a new generation, so a read that began before it is not used after
/// it.
#[derive(Default)]
struct PlanReads {
    generation: AtomicU64,
    last: tokio::sync::Mutex<Option<PlanRead>>,
}

struct PlanRead {
    at: Instant,
    generation: u64,
    token: String,
    result: Result<HostedPlan, PublicFailure>,
}

/// Hosted 4xx codes that keep their meaning for the caller. Any other
/// failure is a sanitized `billing_unavailable`.
const KNOWN_HOSTED_FAILURES: [(&str, u16, &str); 6] = [
    (
        "plan_unchanged",
        409,
        "The subscription already has this plan",
    ),
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
            reads: Arc::default(),
            plan_read_reuse: Duration::from_secs(5),
        }
    }

    /// GET /v1/plan for `token`. Readers that arrive while a read runs, or
    /// soon after it, get its answer.
    async fn read_plan(&self, token: &str) -> Result<HostedPlan, PublicFailure> {
        let arrived = Instant::now();
        let mut last = self.reads.last.lock().await;
        let generation = self.reads.generation.load(Ordering::SeqCst);
        if let Some(read) = last.as_ref().filter(|read| {
            read.generation == generation
                && read.token == token
                && (read.at >= arrived || read.at.elapsed() < self.plan_read_reuse)
        }) {
            return read.result.clone();
        }
        let result = self
            .call(Method::GET, "/v1/plan?tier=1", token, None, None)
            .await
            .and_then(valid);
        *last = Some(PlanRead {
            at: Instant::now(),
            generation,
            token: token.to_owned(),
            result: result.clone(),
        });
        result
    }

    /// The hosted plan changed or can have changed: the next read asks suplex.sh.
    fn forget_plan_reads(&self) {
        self.reads.generation.fetch_add(1, Ordering::SeqCst);
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: &str,
        idempotency_key: Option<&str>,
        body: Option<&serde_json::Value>,
    ) -> Result<T, PublicFailure> {
        let url = self.base.join(path).map_err(|_| unavailable())?;
        let mut request = self.http.request(method, url).bearer_auth(token);
        if let Some(key) = idempotency_key {
            request = request.header("idempotency-key", key);
        }
        if let Some(body) = body {
            request = request.json(body);
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

/// Keeps the last paid plan after access ends, so a lapsed Team plan stays
/// distinct from Free. A different account starts over.
fn remember(state: &AppState, account_id: &str, plan: &HostedPlan) -> DatabaseResult<()> {
    let access_until = plan
        .state
        .active
        .then(|| plan.state.access_until.clone())
        .flatten();
    let paid = plan
        .state
        .active
        .then(|| plan.plan.unwrap_or(PaidPlan::Pro).as_str());
    state.with_database(|database| {
        database.connection().execute(
            "INSERT INTO suplex_plan (id, account_id, access_until, checked_at, plan) VALUES ('host', ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET access_until = excluded.access_until, checked_at = excluded.checked_at,
               plan = CASE WHEN suplex_plan.account_id = excluded.account_id THEN COALESCE(excluded.plan, suplex_plan.plan) ELSE excluded.plan END,
               account_id = excluded.account_id",
            params![account_id, access_until, rfc3339_millis(Utc::now()), paid],
        )?;
        Ok(())
    })
}

fn valid(plan: HostedPlan) -> Result<HostedPlan, PublicFailure> {
    plan.state.valid().then_some(plan).ok_or_else(unavailable)
}

/// Reads the linked account's plan from suplex.sh and remembers it. `None`
/// means no Suplex account is linked, which is Free.
pub async fn refresh(state: &AppState) -> Result<Option<HostedPlan>, Box<dyn Error + Send + Sync>> {
    let client = state.billing.as_ref().ok_or_else(not_configured)?;
    let Some(account) = state.with_database(|database| accounts::linked(database))? else {
        return Ok(None);
    };
    let plan = client.read_plan(&account.token).await?;
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
    /// Seats on the subscription, as suplex.sh reports them. Zero without
    /// one. Team always covers its included seats.
    pub purchased_seats: i64,
    /// The last paid plan was Team and its access ended: work is read-only.
    pub team_lapsed: bool,
    /// The billing period of the active subscription.
    pub interval: Option<wire::BillingInterval>,
    /// Users who are not revoked, the owner included.
    pub seats_used: i64,
}

pub async fn summary(
    state: &AppState,
    user_id: &str,
) -> Result<BillingSummary, Box<dyn Error + Send + Sync>> {
    let (can_manage_billing, account_linked) = state.with_database(|database| {
        let admin = companies::require_admin(database, user_id).is_ok();
        Ok::<_, Box<dyn Error + Send + Sync>>((admin, accounts::linked(database)?.is_some()))
    })?;
    let remote = if account_linked && state.billing.is_some() {
        refresh(state).await.ok().flatten()
    } else {
        None
    };
    let (plan, usage, seats_used, team_lapsed) = state.with_database(|database| {
        let seats_used = database.connection().query_row(
            "SELECT count(*) FROM suplex_users WHERE status <> 'revoked'",
            [],
            |row| row.get(0),
        )?;
        Ok::<_, Box<dyn Error + Send + Sync>>((
            plan(database)?,
            usage(database, Utc::now())?,
            seats_used,
            team_lapsed(database)?,
        ))
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
        purchased_seats: remote.as_ref().map_or(0, |remote| match remote.plan {
            Some(PaidPlan::Team) => remote.state.purchased_seats.max(TEAM_INCLUDED_SEATS),
            _ => remote.state.purchased_seats,
        }),
        seats_used,
        team_lapsed,
        interval: remote.as_ref().and_then(|remote| remote.interval),
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
) -> Result<(&'a BillingClient, accounts::LinkedAccount), Box<dyn Error + Send + Sync>> {
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
) -> Result<BillingSummary, Box<dyn Error + Send + Sync>> {
    let (client, account) = administered(state, user_id)?;
    let plan = client
        .call(Method::POST, "/v1/plan/trial", &account.token, None, None)
        .await
        .and_then(valid);
    client.forget_plan_reads();
    let plan = plan?;
    remember(state, &account.account_id, &plan)?;
    summary(state, user_id).await
}

pub async fn checkout(
    state: &AppState,
    user_id: &str,
    idempotency_key: &str,
    body: CheckoutBody,
) -> Result<BillingCheckoutResponse, Box<dyn Error + Send + Sync>> {
    let (client, account) = administered(state, user_id)?;
    let body = serde_json::to_value(body)?;
    let result: Result<HostedCheckoutResult, _> = client
        .call(
            Method::POST,
            "/v1/plan/checkout",
            &account.token,
            Some(idempotency_key),
            Some(&body),
        )
        .await;
    client.forget_plan_reads();
    let result = result?;
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

/// A Stripe portal link that changes the live subscription to `change`;
/// Stripe asks the administrator to confirm it.
pub async fn change_plan(
    state: &AppState,
    user_id: &str,
    change: wire::PlanChangeBody,
) -> Result<BillingPortalResponse, Box<dyn Error + Send + Sync>> {
    let (client, account) = administered(state, user_id)?;
    let result: HostedPortalResult = client
        .call(
            Method::POST,
            "/v1/plan/change",
            &account.token,
            None,
            Some(&serde_json::to_value(change)?),
        )
        .await?;
    Ok(BillingPortalResponse {
        url: client.forwarded_url(&result.url)?,
    })
}

pub async fn portal(
    state: &AppState,
    user_id: &str,
) -> Result<BillingPortalResponse, Box<dyn Error + Send + Sync>> {
    let (client, account) = administered(state, user_id)?;
    let result: HostedPortalResult = client
        .call(Method::POST, "/v1/plan/portal", &account.token, None, None)
        .await?;
    Ok(BillingPortalResponse {
        url: client.forwarded_url(&result.url)?,
    })
}

/// When the background read asks suplex.sh again. Every 15 minutes at most,
/// so a renewal, cancellation, or trial end applies to queued tasks without a
/// visit to Settings > Billing. Confirmed access ends at the end of the paid
/// period, so the next read comes just after it: a renewal then keeps the
/// plan instead of showing Free until the next read. Stripe can settle the
/// renewal later, so for an hour after access ends it reads each minute. A
/// failed read retries sooner, backing off to 15 minutes.
fn next_refresh(
    now: DateTime<Utc>,
    access_until: Option<DateTime<Utc>>,
    failures: u32,
) -> Duration {
    let mut delay = Duration::from_secs(15 * 60);
    if failures > 0 {
        delay = delay.min(Duration::from_secs(30) * 2u32.pow(failures.min(6) - 1));
    }
    if let Some(until) = access_until {
        delay = match (until - now).to_std() {
            Ok(left) => delay.min(left + Duration::from_secs(5)),
            Err(_) if now - until < chrono::Duration::hours(1) => {
                delay.min(Duration::from_secs(60))
            }
            Err(_) => delay,
        };
    }
    delay
}

/// The end of the paid access that `suplex_plan` holds for the linked account.
fn confirmed_access_until(database: &SuplexDatabase) -> DatabaseResult<Option<DateTime<Utc>>> {
    let until: Option<String> = database
        .connection()
        .query_row(
            "SELECT p.access_until FROM suplex_plan p JOIN suplex_account a ON a.account_id = p.account_id WHERE p.id = 'host'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(until
        .and_then(|until| DateTime::parse_from_rfc3339(&until).ok())
        .map(|until| until.with_timezone(&Utc)))
}

/// Reads the plan from suplex.sh at start and then on the `next_refresh`
/// schedule.
pub fn spawn_refresh(state: AppState) {
    if state.billing.is_none() {
        return;
    }
    tokio::spawn(async move {
        let mut failures = 0u32;
        // The last end of paid access this loop saw. A lapse clears it in
        // `suplex_plan`, but the reads after it still follow the renewal.
        let mut access_until = None;
        loop {
            failures = match refresh(&state).await {
                Ok(_) => 0,
                Err(_) => failures.saturating_add(1),
            };
            if let Ok(Some(until)) =
                state.with_database(|database| confirmed_access_until(database))
            {
                access_until = Some(until);
            }
            tokio::time::sleep(next_refresh(Utc::now(), access_until, failures)).await;
        }
    });
}

#[cfg(test)]
include!("../../tests/billing/private.rs");
