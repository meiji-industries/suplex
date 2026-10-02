//! Suplex Free and Pro. The hosted billing service owns subscription
//! evidence; this module reads it, forwards money commands to it, and gates
//! project creation above the Free limit.

use std::{
    error::Error,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use reqwest::Method;
use rusqlite::{OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use ts_rs::TS;
use url::Url;

use crate::{
    http::AppState,
    identity::companies,
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::{PublicFailure, time::rfc3339_millis},
};
use wire::{
    HostedBillingState, HostedCheckoutResult, HostedErrorBody, HostedPortalResult,
    HostedSeatChangeBody, HostedSeatChangeResult, HostedSeatPreview, QuantityBody,
    RegistrationBody, RegistrationResponse,
};

pub mod hosted;
pub mod wire;

pub const FREE_PROJECT_LIMIT: i64 = 2;

/// The Suplex-operated billing service on Fly.
pub const PRODUCTION_SERVICE_URL: &str = "https://billing.suplex.sh";

pub fn unavailable() -> PublicFailure {
    PublicFailure::new(503, "Suplex cannot check the subscription").with_code("billing_unavailable")
}

fn not_configured() -> PublicFailure {
    PublicFailure::new(503, "Billing is not configured").with_code("billing_not_configured")
}

/// Members of the company that hold a seat: every member account that is not
/// revoked. Administrators hold a seat only in companies where they are members.
fn seat_holders(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<i64> {
    Ok(database.connection().query_row(
        "SELECT COUNT(*) FROM suplex_memberships m JOIN suplex_users u ON u.id = m.user_id WHERE m.company_id = ?1 AND u.status != 'revoked'",
        [company_id],
        |row| row.get(0),
    )?)
}

/// The seats a Pro company needs: one for each seat holder, minimum one.
pub fn required_seats(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<i64> {
    Ok(seat_holders(database, company_id)?.max(1))
}

pub fn project_count(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<i64> {
    Ok(database.connection().query_row(
        "SELECT COUNT(*) FROM suplex_projects WHERE company_id = ?1",
        [company_id],
        |row| row.get(0),
    )?)
}

/// Billing evidence carried from the early check into the commit
/// transaction. `NotChecked` only means a Free slot existed when validation
/// started; it cannot approve a creation above the limit.
#[derive(Clone, Debug, PartialEq)]
pub enum BillingEvidence {
    NotChecked,
    Free,
    Unknown,
    Paid {
        purchased_seats: i64,
        access_until: Option<String>,
    },
}

/// Why a creation above the Free limit is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Billing evidence requires a refresh outside the transaction")]
pub enum Denial {
    ProjectLimitReached,
    SeatLimitExceeded,
    BillingUnavailable,
    /// The evidence must be read again outside the transaction.
    RefreshRequired,
}

/// The entitlement decision for one project creation. Elapsed paid evidence
/// asks for a refresh instead of approving stale evidence.
pub fn decide_project_entitlement(
    project_count: i64,
    required_seats: i64,
    now: DateTime<Utc>,
    billing: &BillingEvidence,
) -> Result<(), Denial> {
    if project_count < FREE_PROJECT_LIMIT {
        return Ok(());
    }
    match billing {
        BillingEvidence::NotChecked => Err(Denial::RefreshRequired),
        BillingEvidence::Free => Err(Denial::ProjectLimitReached),
        BillingEvidence::Unknown => Err(Denial::BillingUnavailable),
        BillingEvidence::Paid { access_until, .. }
            if access_until.as_deref().is_some_and(|until| {
                DateTime::parse_from_rfc3339(until).is_ok_and(|until| until <= now)
            }) =>
        {
            Err(Denial::RefreshRequired)
        }
        BillingEvidence::Paid {
            purchased_seats, ..
        } if *purchased_seats >= required_seats => Ok(()),
        BillingEvidence::Paid { .. } => Err(Denial::SeatLimitExceeded),
    }
}

/// `RefreshRequired` here means refresh attempts ran out.
pub fn denial_failure(denial: Denial) -> PublicFailure {
    match denial {
        Denial::SeatLimitExceeded => {
            PublicFailure::new(402, "Purchased seats do not cover active accounts")
                .with_code("seat_limit_exceeded")
        }
        Denial::ProjectLimitReached => {
            PublicFailure::new(402, "Project limit reached").with_code("project_limit_reached")
        }
        Denial::BillingUnavailable | Denial::RefreshRequired => unavailable(),
    }
}

/// The hosted billing API. It never follows a redirect: that would resend the
/// account credential to another origin.
#[derive(Clone)]
pub struct BillingClient {
    base: Url,
    installation_id: String,
    http: reqwest::Client,
    // ponytail: global registration lock; per-company map if registration contention matters
    registration: Arc<tokio::sync::Mutex<()>>,
    /// One background plan refresh runs at a time.
    refreshing: Arc<AtomicBool>,
}

/// Hosted 4xx codes that keep their meaning for the caller. Any other
/// failure is a sanitized `billing_unavailable`.
const KNOWN_HOSTED_FAILURES: [(&str, u16, &str); 6] = [
    (
        "idempotency_conflict",
        409,
        "This idempotency key belongs to a different request",
    ),
    ("billing_quote_changed", 409, "The billing quote changed"),
    (
        "billing_operation_not_applied",
        409,
        "The change was not applied. Review a new quote and try again.",
    ),
    ("invalid_seat_quantity", 422, "Seat quantity is invalid"),
    ("no_subscription", 409, "No subscription exists"),
    (
        "billing_payment_pending",
        409,
        "A billing payment is still pending",
    ),
];

impl BillingClient {
    pub fn new(base: Url, installation_id: String) -> Self {
        Self {
            base,
            installation_id,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("billing HTTP client builds"),
            registration: Arc::default(),
            refreshing: Arc::default(),
        }
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        credential: Option<&str>,
        idempotency_key: Option<&str>,
        body: Option<&impl Serialize>,
    ) -> Result<T, PublicFailure> {
        let url = self.base.join(path).map_err(|_| unavailable())?;
        let mut request = self.http.request(method, url);
        if let Some(credential) = credential {
            request = request.bearer_auth(credential);
        }
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

    async fn read(&self, credential: &str) -> Result<HostedBillingState, PublicFailure> {
        let state: HostedBillingState = self
            .call(
                Method::GET,
                "/v1/billing",
                Some(credential),
                None,
                None::<&()>,
            )
            .await?;
        state.valid().then_some(state).ok_or_else(unavailable)
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

pub fn parse_service_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "SUPLEX_BILLING_SERVICE_URL is invalid")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("SUPLEX_BILLING_SERVICE_URL must use HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("SUPLEX_BILLING_SERVICE_URL must not contain credentials".into());
    }
    Ok(url)
}

struct Binding {
    registration_id: String,
    credential: String,
    account_id: Option<String>,
}

fn binding(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<Option<Binding>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT registration_id, credential, account_id FROM suplex_company_billing WHERE company_id = ?1",
            [company_id],
            |row| {
                Ok(Binding {
                    registration_id: row.get(0)?,
                    credential: row.get(1)?,
                    account_id: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// Insert-or-read in one transaction: one registration identity per company.
fn ensure_binding(database: &mut SuplexDatabase, company_id: &str) -> DatabaseResult<Binding> {
    database.transaction(true, |database| {
        if let Some(existing) = binding(database, company_id)? {
            return Ok(existing);
        }
        let mut secret = [0_u8; 32];
        getrandom::fill(&mut secret)?;
        let created = Binding {
            registration_id: uuid::Uuid::new_v4().to_string(),
            credential: URL_SAFE_NO_PAD.encode(secret),
            account_id: None,
        };
        let now = rfc3339_millis(Utc::now());
        database.connection().execute(
            "INSERT INTO suplex_company_billing (company_id, registration_id, credential, account_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
            params![company_id, created.registration_id, created.credential, now],
        )?;
        Ok(created)
    })
}

/// The account credential. A missing account ID means the registration
/// response was lost; registering again with the stored registration ID and
/// credential recovers the same hosted account.
async fn ensure_account(
    state: &AppState,
    client: &BillingClient,
    company_id: &str,
) -> Result<String, Box<dyn Error>> {
    let first = state.with_database(|database| ensure_binding(database, company_id))?;
    if first.account_id.is_some() {
        return Ok(first.credential);
    }
    let _registration = client.registration.lock().await;
    let current = state
        .with_database(|database| binding(database, company_id))?
        .unwrap_or(first);
    if current.account_id.is_some() {
        return Ok(current.credential);
    }
    let registered: RegistrationResponse = client
        .call(
            Method::POST,
            "/v1/accounts",
            None,
            None,
            Some(&RegistrationBody {
                registration_id: current.registration_id,
                credential: current.credential.clone(),
                installation_id: client.installation_id.clone(),
                company_id: company_id.to_owned(),
            }),
        )
        .await?;
    if registered.account_id.is_empty() || registered.account_id.len() > 128 {
        return Err(unavailable().into());
    }
    state.with_database(|database| {
        database.connection().execute(
            "UPDATE suplex_company_billing SET account_id = ?1, updated_at = ?2 WHERE company_id = ?3",
            params![registered.account_id, rfc3339_millis(Utc::now()), company_id],
        )
    })?;
    Ok(current.credential)
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BillingSummaryBase {
    pub company_id: String,
    pub project_count: i64,
    pub required_seats: i64,
    pub can_manage_billing: bool,
    pub purchase_configured: bool,
}

/// Verified absence of paid access. Lifecycle fields are present when a
/// subscription exists, so an expired or unpaid one stays manageable.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BillingFreeSummary {
    #[serde(flatten)]
    pub base: BillingSummaryBase,
    pub project_limit: i64,
    pub purchased_seats: i64,
    pub can_create_project: bool,
    pub checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subscription_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub renewal_at: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub access_until: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cancel_at_period_end: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub payment_action_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub payment_action_url: Option<Option<String>>,
}

/// Verified paid access. A seat shortage is still Pro, limited to the Free
/// project count.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BillingProSummary {
    #[serde(flatten)]
    pub base: BillingSummaryBase,
    /// Null means unlimited.
    pub project_limit: Option<i64>,
    pub purchased_seats: i64,
    pub can_create_project: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"seat_limit_exceeded\"")]
    pub restriction: Option<&'static str>,
    pub checked_at: String,
    pub subscription_status: String,
    pub renewal_at: Option<String>,
    pub access_until: Option<String>,
    pub cancel_at_period_end: bool,
    pub payment_action_required: bool,
    pub payment_action_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unit_amount: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub monthly_subtotal: Option<i64>,
}

/// Provider evidence could not be obtained; capacity is omitted.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BillingUnknownSummary {
    #[serde(flatten)]
    pub base: BillingSummaryBase,
    /// True below the Free limit, else unknown.
    #[ts(type = "true | null")]
    pub can_create_project: Option<bool>,
    #[ts(type = "null")]
    pub checked_at: Option<String>,
    #[ts(type = "\"billing_unavailable\"")]
    pub reason: &'static str,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "plan", rename_all = "lowercase")]
#[ts(export)]
pub enum BillingSummary {
    Free(BillingFreeSummary),
    Pro(BillingProSummary),
    Unknown(BillingUnknownSummary),
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
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export)]
pub enum BillingSeatChangeResponse {
    Applied {
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

pub async fn summary(
    state: &AppState,
    user_id: &str,
    company_id: &str,
) -> Result<BillingSummary, Box<dyn Error>> {
    let (base, binding) = state.with_database(|database| {
        companies::require_company_access(database, user_id, company_id)?;
        let base = BillingSummaryBase {
            company_id: company_id.to_owned(),
            project_count: project_count(database, company_id)?,
            required_seats: required_seats(database, company_id)?,
            can_manage_billing: companies::require_admin(database, user_id).is_ok(),
            purchase_configured: state.billing.is_some(),
        };
        Ok::<_, Box<dyn Error>>((base, binding(database, company_id)?))
    })?;
    let below_limit = base.project_count < FREE_PROJECT_LIMIT;
    let checked_at = rfc3339_millis(Utc::now());
    let free = |base| BillingFreeSummary {
        base,
        project_limit: FREE_PROJECT_LIMIT,
        purchased_seats: 0,
        can_create_project: below_limit,
        checked_at: checked_at.clone(),
        subscription_status: None,
        renewal_at: None,
        access_until: None,
        cancel_at_period_end: None,
        payment_action_required: None,
        payment_action_url: None,
    };
    // No binding is a locally known Free: reading status never registers.
    let Some(binding) = binding else {
        return Ok(BillingSummary::Free(free(base)));
    };
    let remote = match &state.billing {
        Some(client) => read_and_remember(state, client, company_id, &binding.credential)
            .await
            .and_then(|remote| {
                // Members see the status but never a billing URL they could open.
                let url = match &remote.payment_action_url {
                    Some(url) if base.can_manage_billing => Some(client.forwarded_url(url)?),
                    _ => None,
                };
                Ok((remote, url))
            }),
        None => Err(unavailable()),
    };
    let Ok((remote, payment_action_url)) = remote else {
        let covered = state
            .with_database(|database| remembered_pro(database, company_id, Utc::now()))?
            .is_some_and(|evidence| {
                matches!(evidence, BillingEvidence::Paid { purchased_seats, .. } if purchased_seats >= base.required_seats)
            });
        return Ok(BillingSummary::Unknown(BillingUnknownSummary {
            can_create_project: (below_limit || covered).then_some(true),
            base,
            checked_at: None,
            reason: "billing_unavailable",
        }));
    };
    if !remote.active {
        return Ok(BillingSummary::Free(BillingFreeSummary {
            subscription_status: Some(remote.subscription_status),
            renewal_at: Some(remote.renewal_at),
            access_until: Some(remote.access_until),
            cancel_at_period_end: Some(remote.cancel_at_period_end),
            payment_action_required: Some(remote.payment_action_required),
            payment_action_url: Some(payment_action_url),
            ..free(base)
        }));
    }
    let sufficient = remote.purchased_seats >= base.required_seats;
    let manage = base.can_manage_billing;
    Ok(BillingSummary::Pro(BillingProSummary {
        base,
        project_limit: (!sufficient).then_some(FREE_PROJECT_LIMIT),
        purchased_seats: remote.purchased_seats,
        can_create_project: sufficient || below_limit,
        restriction: (!sufficient).then_some("seat_limit_exceeded"),
        checked_at,
        subscription_status: remote.subscription_status,
        renewal_at: remote.renewal_at,
        access_until: remote.access_until,
        cancel_at_period_end: remote.cancel_at_period_end,
        payment_action_required: remote.payment_action_required,
        payment_action_url,
        unit_amount: manage.then_some(wire::SEAT_UNIT_AMOUNT),
        currency: manage.then(|| wire::SEAT_CURRENCY.to_owned()),
        monthly_subtotal: manage.then_some(remote.purchased_seats * wire::SEAT_UNIT_AMOUNT),
    }))
}

/// How long a remembered plan labels a company, and when it is read again.
const PLAN_LABEL_LIFETIME: chrono::TimeDelta = chrono::TimeDelta::hours(24);
const PLAN_REFRESH_AFTER: chrono::TimeDelta = chrono::TimeDelta::hours(1);

/// Reads the hosted state and keeps a snapshot of it. The snapshot labels the
/// company in the interface. Only `remembered_pro` reads it for a decision,
/// and only when the hosted service cannot answer.
async fn read_and_remember(
    state: &AppState,
    client: &BillingClient,
    company_id: &str,
    credential: &str,
) -> Result<HostedBillingState, PublicFailure> {
    let remote = client.read(credential).await?;
    let _ = state.with_database(|database| {
        database.connection().execute(
            "UPDATE suplex_company_billing SET plan = ?1, access_until = ?2, checked_at = ?3, purchased_seats = ?4 WHERE company_id = ?5",
            params![
                if remote.active { "pro" } else { "free" },
                remote.access_until,
                rfc3339_millis(Utc::now()),
                remote.purchased_seats,
                company_id
            ],
        )
    });
    Ok(remote)
}

/// The plan label for a company from local data, and whether its snapshot is
/// due for a refresh. No billing account is a known Free. A Pro snapshot past
/// its paid access, or any snapshot older than a day, has no label.
pub fn plan_label(
    database: &SuplexDatabase,
    company_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<(Option<&'static str>, bool)> {
    let snapshot: Option<(Option<String>, Option<String>, Option<String>)> = database
        .connection()
        .query_row(
            "SELECT plan, access_until, checked_at FROM suplex_company_billing WHERE company_id = ?1",
            [company_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((plan, access_until, checked_at)) = snapshot else {
        return Ok((Some("free"), false));
    };
    let time = |text: Option<String>| {
        text.and_then(|text| DateTime::parse_from_rfc3339(&text).ok())
            .map(|time| time.with_timezone(&Utc))
    };
    let checked_at = time(checked_at);
    let fresh = checked_at.is_some_and(|checked| now - checked < PLAN_LABEL_LIFETIME);
    let label = match plan.as_deref() {
        Some("pro") if fresh && time(access_until).is_some_and(|until| until > now) => Some("pro"),
        Some("free") if fresh => Some("free"),
        _ => None,
    };
    let stale = checked_at.is_none_or(|checked| now - checked >= PLAN_REFRESH_AFTER);
    Ok((label, stale))
}

/// Reads the hosted state again for companies with an old snapshot, one at a
/// time, after the response that found them. It never blocks a request.
pub fn refresh_plans(state: &AppState, company_ids: Vec<String>) {
    let Some(client) = state.billing.clone() else {
        return;
    };
    if company_ids.is_empty() || client.refreshing.swap(true, Ordering::AcqRel) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        for company_id in company_ids {
            let credential = state
                .with_database(|database| binding(database, &company_id))
                .ok()
                .flatten()
                .map(|binding| binding.credential);
            if let Some(credential) = credential {
                let _ = read_and_remember(&state, &client, &company_id, &credential).await;
            }
        }
        client.refreshing.store(false, Ordering::Release);
    });
}

/// A new member of a Pro company takes a free seat, as on GitHub: the
/// administrator adds a seat first. A Free company, or a company whose billing
/// cannot be read, admits the member. The project limit still applies to a
/// seat shortage.
// ponytail: two concurrent adds can share the last free seat; the project limit catches the overage
pub async fn admit_member(state: &AppState, company_id: &str) -> DatabaseResult<()> {
    let Some(binding) = state.with_database(|database| binding(database, company_id))? else {
        return Ok(());
    };
    let Some(client) = &state.billing else {
        return Ok(());
    };
    let Ok(remote) = read_and_remember(state, client, company_id, &binding.credential).await else {
        return Ok(());
    };
    let holders = state.with_database(|database| seat_holders(database, company_id))?;
    if !remote.active || remote.purchased_seats > holders {
        return Ok(());
    }
    Err(
        PublicFailure::new(402, "Add a seat before you add a member")
            .with_code("seat_required")
            .into(),
    )
}

/// The billing read project creation uses. It never registers an account.
pub async fn create_decision(
    state: &AppState,
    company_id: &str,
) -> DatabaseResult<BillingEvidence> {
    let Some(binding) = state.with_database(|database| binding(database, company_id))? else {
        return Ok(BillingEvidence::Free);
    };
    let remote = match &state.billing {
        Some(client) => read_and_remember(state, client, company_id, &binding.credential)
            .await
            .ok(),
        None => None,
    };
    Ok(match remote {
        Some(remote) if remote.active => BillingEvidence::Paid {
            purchased_seats: remote.purchased_seats,
            access_until: remote.access_until,
        },
        Some(_) => BillingEvidence::Free,
        None => state
            .with_database(|database| remembered_pro(database, company_id, Utc::now()))?
            .unwrap_or(BillingEvidence::Unknown),
    })
}

/// Pro the hosted service confirmed earlier, while its paid period lasts. A
/// hosted outage keeps Pro usable; it never extends or grants Pro. A
/// confirmed lapse replaces the snapshot with Free.
fn remembered_pro(
    database: &SuplexDatabase,
    company_id: &str,
    now: DateTime<Utc>,
) -> DatabaseResult<Option<BillingEvidence>> {
    let row: Option<(Option<String>, Option<i64>, Option<String>)> = database
        .connection()
        .query_row(
            "SELECT plan, purchased_seats, access_until FROM suplex_company_billing WHERE company_id = ?1",
            [company_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(match row {
        Some((Some(plan), Some(purchased_seats), Some(until)))
            if plan == "pro"
                && DateTime::parse_from_rfc3339(&until).is_ok_and(|until| until > now) =>
        {
            Some(BillingEvidence::Paid {
                purchased_seats,
                access_until: Some(until),
            })
        }
        _ => None,
    })
}

/// The early quota check before a clone or provisioning. Below the Free
/// limit no billing read happens; the commit transaction decides again.
pub async fn admit_creation(state: &AppState, company_id: &str) -> DatabaseResult<()> {
    let decide = |evidence: &BillingEvidence| {
        state.with_database(|database| {
            Ok::<_, Box<dyn Error>>(decide_project_entitlement(
                project_count(database, company_id)?,
                required_seats(database, company_id)?,
                Utc::now(),
                evidence,
            ))
        })
    };
    let mut decision = decide(&BillingEvidence::NotChecked)?;
    for _ in 0..2 {
        if decision != Err(Denial::RefreshRequired) {
            break;
        }
        decision = decide(&create_decision(state, company_id).await?)?;
    }
    Ok(decision.map_err(denial_failure)?)
}

/// Money commands need an active administrator with company access.
fn administered<'a>(
    state: &'a AppState,
    user_id: &str,
    company_id: &str,
    quantity: Option<i64>,
) -> Result<&'a BillingClient, Box<dyn Error>> {
    state.with_database(|database| {
        companies::require_company_access(database, user_id, company_id)?;
        companies::require_admin(database, user_id)?;
        let client = state.billing.as_ref().ok_or_else(not_configured)?;
        if let Some(quantity) = quantity
            && quantity < required_seats(database, company_id)?
        {
            return Err(
                PublicFailure::new(422, "Seat quantity is below active accounts")
                    .with_code("invalid_seat_quantity")
                    .into(),
            );
        }
        Ok(client)
    })
}

pub async fn checkout(
    state: &AppState,
    user_id: &str,
    company_id: &str,
    quantity: i64,
    idempotency_key: &str,
) -> Result<BillingCheckoutResponse, Box<dyn Error>> {
    let client = administered(state, user_id, company_id, Some(quantity))?;
    let credential = ensure_account(state, client, company_id).await?;
    let result: HostedCheckoutResult = client
        .call(
            Method::POST,
            "/v1/checkout",
            Some(&credential),
            Some(idempotency_key),
            Some(&QuantityBody { quantity }),
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
            summary: summary(state, user_id, company_id).await?,
        },
        HostedCheckoutResult::PaymentRequired { url, .. } => {
            BillingCheckoutResponse::PaymentRequired {
                url: url.map(|url| client.forwarded_url(&url)).transpose()?,
                summary: summary(state, user_id, company_id).await?,
            }
        }
    })
}

pub async fn preview_seats(
    state: &AppState,
    user_id: &str,
    company_id: &str,
    quantity: i64,
) -> Result<HostedSeatPreview, Box<dyn Error>> {
    let client = administered(state, user_id, company_id, Some(quantity))?;
    let credential = ensure_account(state, client, company_id).await?;
    let preview: HostedSeatPreview = client
        .call(
            Method::POST,
            "/v1/seats/preview",
            Some(&credential),
            None,
            Some(&QuantityBody { quantity }),
        )
        .await?;
    Ok(preview.valid().then_some(preview).ok_or_else(unavailable)?)
}

pub async fn change_seats(
    state: &AppState,
    user_id: &str,
    company_id: &str,
    body: &HostedSeatChangeBody,
    idempotency_key: &str,
) -> Result<BillingSeatChangeResponse, Box<dyn Error>> {
    let client = administered(state, user_id, company_id, Some(body.quantity()))?;
    let credential = ensure_account(state, client, company_id).await?;
    let result: HostedSeatChangeResult = client
        .call(
            Method::POST,
            "/v1/seats",
            Some(&credential),
            Some(idempotency_key),
            Some(body),
        )
        .await?;
    if !result.valid() {
        return Err(unavailable().into());
    }
    Ok(match result {
        HostedSeatChangeResult::Applied { .. } => BillingSeatChangeResponse::Applied {
            summary: summary(state, user_id, company_id).await?,
        },
        HostedSeatChangeResult::PaymentRequired { url, .. } => {
            BillingSeatChangeResponse::PaymentRequired {
                url: url.map(|url| client.forwarded_url(&url)).transpose()?,
                summary: summary(state, user_id, company_id).await?,
            }
        }
    })
}

pub async fn portal(
    state: &AppState,
    user_id: &str,
    company_id: &str,
) -> Result<BillingPortalResponse, Box<dyn Error>> {
    let client = administered(state, user_id, company_id, None)?;
    let credential = ensure_account(state, client, company_id).await?;
    let result: HostedPortalResult = client
        .call(
            Method::POST,
            "/v1/portal",
            Some(&credential),
            None,
            Some(&serde_json::json!({})),
        )
        .await?;
    Ok(BillingPortalResponse {
        url: client.forwarded_url(&result.url)?,
    })
}

#[cfg(test)]
include!("../../tests/billing/private.rs");
