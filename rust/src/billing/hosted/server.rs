//! Hosted billing: environment config, the HTTP router, and operator
//! credential rotation. `crate::hosted` serves the router.

use std::path::Path;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, FromRequest, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use url::Url;

use super::{
    Hosted, HostedConfig, HostedError, HostedResult, credential_shape,
    store::{self, AccountRow},
    stripe::{STRIPE_API_BASE, StripeClient},
};
use crate::{
    billing::wire::{
        BillingEnvironment, HostedSeatChangeBody, QuantityBody, RegistrationResponse,
        seat_quantity, valid_idempotency_key,
    },
    shared::{hash::sha256_hex, time::now_millis_rfc3339},
};

const BODY_LIMIT: usize = 1 << 20;
const RETURN_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Suplex billing</title></head><body><p>You can return to Suplex and check the subscription.</p></body></html>";
const ROTATE_USAGE: &str =
    "Usage: suplex billing rotate-credential --db <path> --account <accountId>";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub origin: String,
    pub address: String,
    pub port: u16,
    pub database_path: String,
    pub environment: BillingEnvironment,
    pub stripe_secret_key: String,
    pub stripe_price_id: String,
    pub stripe_portal_configuration_id: String,
    pub stripe_webhook_secret: String,
    /// Stripe Tax on Checkout. It needs a head office address in Stripe.
    pub automatic_tax: bool,
    pub revenuecat_secret_api_key: String,
    pub revenuecat_stripe_public_api_key: String,
    pub revenuecat_webhook_authorization: String,
    pub revenuecat_app_id: String,
    pub telemetry: Option<super::telemetry::Config>,
}

impl ServiceConfig {
    pub fn hosted(&self) -> HostedConfig {
        HostedConfig {
            origin: self.origin.clone(),
            environment: self.environment,
            stripe_price_id: self.stripe_price_id.clone(),
            stripe_portal_configuration_id: self.stripe_portal_configuration_id.clone(),
            stripe_webhook_secret: self.stripe_webhook_secret.clone(),
            automatic_tax: self.automatic_tax,
            revenuecat_app_id: self.revenuecat_app_id.clone(),
            revenuecat_webhook_authorization: self.revenuecat_webhook_authorization.clone(),
            telemetry: self.telemetry.clone(),
        }
    }
}

pub(crate) fn parse_origin(name: &str, raw: &str) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| format!("{name} must be a valid URL"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{name} must not contain credentials"));
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() == "https" || (url.scheme() == "http" && loopback) {
        return Ok(url.origin().ascii_serialization());
    }
    Err(format!(
        "{name} must use HTTPS except on explicit loopback hosts"
    ))
}

fn parse_port(raw: Option<&str>) -> Result<u16, String> {
    raw.unwrap_or("4211")
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port >= 1)
        .ok_or_else(|| "BILLING_PORT must be an integer between 1 and 65535".into())
}

fn absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
}

/// Reads the service configuration. `env` returns a variable's value.
pub fn load_config(env: &dyn Fn(&str) -> Option<String>) -> Result<ServiceConfig, String> {
    let require = |name: &str| {
        env(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{name} is required"))
    };
    let database_path = require("BILLING_DATABASE_PATH")?;
    if !absolute_path(&database_path) {
        return Err("BILLING_DATABASE_PATH must be an absolute path separate from any Suplex installation database".into());
    }
    let environment = BillingEnvironment::parse(&require("BILLING_ENVIRONMENT")?)
        .ok_or("BILLING_ENVIRONMENT must be exactly 'sandbox' or 'production'")?;
    let automatic_tax = match env("STRIPE_AUTOMATIC_TAX").as_deref() {
        None | Some("" | "true") => true,
        Some("false") => false,
        Some(_) => return Err("STRIPE_AUTOMATIC_TAX must be true or false".into()),
    };
    let telemetry = match env("BILLING_TELEMETRY").as_deref() {
        Some("1" | "true") => {
            let key = require("BILLING_POSTHOG_KEY")?;
            let host = env("BILLING_POSTHOG_HOST")
                .filter(|host| !host.is_empty())
                .unwrap_or_else(|| "https://us.i.posthog.com".into());
            let url = Url::parse(&host).map_err(|_| "BILLING_POSTHOG_HOST must be a valid URL")?;
            if url.scheme() != "https"
                && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            {
                return Err(
                    "BILLING_POSTHOG_HOST must use HTTPS except on explicit loopback hosts".into(),
                );
            }
            Some(super::telemetry::Config { key, host })
        }
        None | Some("" | "0" | "false" | "off") => None,
        Some(_) => return Err("BILLING_TELEMETRY must be 1, true, 0, false, or off".into()),
    };
    Ok(ServiceConfig {
        origin: parse_origin("BILLING_PUBLIC_ORIGIN", &require("BILLING_PUBLIC_ORIGIN")?)?,
        address: env("BILLING_BIND_ADDRESS")
            .filter(|address| !address.is_empty())
            .unwrap_or_else(|| "127.0.0.1".into()),
        port: parse_port(env("BILLING_PORT").as_deref())?,
        database_path,
        environment,
        stripe_secret_key: require("STRIPE_SECRET_KEY")?,
        stripe_price_id: require("STRIPE_PRO_MONTHLY_PRICE_ID")?,
        stripe_portal_configuration_id: require("STRIPE_PORTAL_CONFIGURATION_ID")?,
        stripe_webhook_secret: require("STRIPE_WEBHOOK_SECRET")?,
        automatic_tax,
        revenuecat_secret_api_key: require("REVENUECAT_SECRET_API_KEY")?,
        revenuecat_stripe_public_api_key: require("REVENUECAT_STRIPE_PUBLIC_API_KEY")?,
        revenuecat_webhook_authorization: require("REVENUECAT_WEBHOOK_AUTHORIZATION")?,
        revenuecat_app_id: require("REVENUECAT_APP_ID")?,
        telemetry,
    })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

impl IntoResponse for HostedError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut body = serde_json::Map::new();
        body.insert("error".into(), json!(self.message));
        if let Some(code) = self.code {
            body.insert("code".into(), json!(code));
        }
        if let Some(preview) = self.preview {
            body.insert("preview".into(), json!(preview));
        }
        (status, Json(body)).into_response()
    }
}

fn invalid_request(status: StatusCode) -> Response {
    (status, Json(json!({"error": "Invalid request"}))).into_response()
}

fn json_content(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("application/json")
        })
}

/// The request body, bounded to 1 MiB. Only JSON bodies are accepted.
struct RawBody(Bytes);

impl<S: Send + Sync> FromRequest<S> for RawBody {
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Response> {
        let json = json_content(request.headers());
        let bytes = Bytes::from_request(request, state)
            .await
            .map_err(|rejection| invalid_request(rejection.status()))?;
        if !bytes.is_empty() && !json {
            return Err(invalid_request(StatusCode::UNSUPPORTED_MEDIA_TYPE));
        }
        Ok(Self(bytes))
    }
}

/// A parsed JSON body; an absent body is `null`.
pub(crate) struct JsonBody(pub(crate) Value);

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Response> {
        let json = json_content(request.headers());
        let RawBody(bytes) = RawBody::from_request(request, state).await?;
        if bytes.is_empty() && !json {
            return Ok(Self(Value::Null));
        }
        serde_json::from_slice(&bytes)
            .map(Self)
            .map_err(|_| invalid_request(StatusCode::BAD_REQUEST))
    }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn require_account(hosted: &Hosted, headers: &HeaderMap) -> HostedResult<AccountRow> {
    hosted
        .account_for_credential(header_text(headers, "authorization"))?
        .ok_or_else(|| HostedError::new(401, None, "Unauthorized"))
}

fn idempotency_key(headers: &HeaderMap) -> HostedResult<String> {
    header_text(headers, "idempotency-key")
        .filter(|key| valid_idempotency_key(key))
        .map(str::to_owned)
        .ok_or_else(|| HostedError::new(400, None, "A valid Idempotency-Key header is required"))
}

/// A strict `{quantity}` body. An invalid quantity is 422; any other shape
/// problem is 400.
fn quantity_body(body: &Value) -> HostedResult<i64> {
    serde_json::from_value::<QuantityBody>(body.clone())
        .map(|body| body.quantity)
        .map_err(|_| match body.get("quantity") {
            Some(quantity) if seat_quantity(quantity).is_none() => {
                HostedError::invalid_seat_quantity("Invalid seat quantity")
            }
            _ => HostedError::new(400, None, "Invalid request"),
        })
}

fn to_json<T: serde::Serialize>(value: &T) -> Json<Value> {
    Json(serde_json::to_value(value).unwrap_or(Value::Null))
}

type Reply = HostedResult<Json<Value>>;

async fn register(State(hosted): State<Hosted>, JsonBody(body): JsonBody) -> Reply {
    let account_id = hosted.register(&body)?;
    Ok(to_json(&RegistrationResponse { account_id }))
}

async fn billing(State(hosted): State<Hosted>, headers: HeaderMap) -> Reply {
    let mut account = require_account(&hosted, &headers)?;
    Ok(to_json(&hosted.read_state(&mut account).await?))
}

async fn checkout(
    State(hosted): State<Hosted>,
    headers: HeaderMap,
    JsonBody(body): JsonBody,
) -> Reply {
    let mut account = require_account(&hosted, &headers)?;
    let key = idempotency_key(&headers)?;
    let quantity = quantity_body(&body)?;
    Ok(to_json(
        &hosted.checkout(&mut account, quantity, &key).await?,
    ))
}

async fn preview_seats(
    State(hosted): State<Hosted>,
    headers: HeaderMap,
    JsonBody(body): JsonBody,
) -> Reply {
    let mut account = require_account(&hosted, &headers)?;
    let quantity = quantity_body(&body)?;
    Ok(to_json(
        &hosted.preview_seats(&mut account, quantity).await?,
    ))
}

async fn change_seats(
    State(hosted): State<Hosted>,
    headers: HeaderMap,
    JsonBody(body): JsonBody,
) -> Reply {
    let mut account = require_account(&hosted, &headers)?;
    let key = idempotency_key(&headers)?;
    let body = serde_json::from_value::<HostedSeatChangeBody>(body)
        .ok()
        .filter(HostedSeatChangeBody::valid)
        .ok_or_else(|| HostedError::invalid_seat_quantity("Invalid seat change request"))?;
    Ok(to_json(
        &hosted.change_seats(&mut account, &body, &key).await?,
    ))
}

async fn portal(State(hosted): State<Hosted>, headers: HeaderMap) -> Reply {
    let mut account = require_account(&hosted, &headers)?;
    Ok(to_json(&hosted.portal(&mut account).await?))
}

/// Signature verification needs the raw request bytes.
async fn stripe_webhook(
    State(hosted): State<Hosted>,
    headers: HeaderMap,
    RawBody(body): RawBody,
) -> Reply {
    hosted.ingest_stripe_webhook(&body, header_text(&headers, "stripe-signature"))?;
    Ok(Json(json!({"received": true})))
}

/// The RevenueCat shared secret is a static header, checked in constant
/// time before the body is read.
async fn revenuecat_webhook(
    State(hosted): State<Hosted>,
    request: Request,
) -> Result<Response, Response> {
    let expected = hosted.config.revenuecat_webhook_authorization.as_bytes();
    let provided = header_text(request.headers(), "authorization")
        .unwrap_or_default()
        .as_bytes();
    if !bool::from(provided.ct_eq(expected)) {
        return Err(HostedError::new(401, None, "Unauthorized").into_response());
    }
    let JsonBody(body) = JsonBody::from_request(request, &()).await?;
    hosted
        .ingest_revenuecat_event(&body)
        .map_err(IntoResponse::into_response)?;
    Ok(Json(json!({"received": true})).into_response())
}

async fn return_page() -> Html<&'static str> {
    Html(RETURN_PAGE)
}

async fn health(State(hosted): State<Hosted>) -> Reply {
    let pending = hosted.query(store::count_pending_events)?;
    Ok(Json(json!({"ok": true, "events": {"pending": pending}})))
}

async fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn router(hosted: Hosted) -> Router {
    Router::new()
        .route("/v1/accounts", post(register))
        .route("/v1/billing", get(billing))
        .route("/v1/checkout", post(checkout))
        .route("/v1/seats/preview", post(preview_seats))
        .route("/v1/seats", post(change_seats))
        .route("/v1/portal", post(portal))
        .route("/webhooks/stripe", post(stripe_webhook))
        .route("/webhooks/revenuecat", post(revenuecat_webhook))
        .route("/checkout/return", get(return_page))
        .route("/checkout/cancel", get(return_page))
        .route("/portal/return", get(return_page))
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::map_response(no_store))
        .with_state(hosted)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Operator credential recovery. Verifies ownership through the stored
/// Stripe customer (`metadata.account_id`), then replaces the credential
/// hash. The account, subscription, and history stay; the old credential
/// stops working. The new credential arrives only through
/// `NEW_BILLING_CREDENTIAL`; only its SHA-256 hash is stored.
pub async fn rotate_credential(
    args: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    stripe_base: &str,
) -> Result<String, String> {
    let (mut database, mut account_id) = (None, None);
    let mut args = args.iter();
    while let Some(key) = args.next() {
        let slot = match key.as_str() {
            "--db" => &mut database,
            "--account" => &mut account_id,
            _ => continue,
        };
        *slot = Some(
            args.next()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{key} requires a value"))?,
        );
    }
    let (Some(database), Some(account_id)) = (database, account_id) else {
        return Err(ROTATE_USAGE.into());
    };
    let credential = env("NEW_BILLING_CREDENTIAL")
        .filter(|credential| credential_shape(credential))
        .ok_or(
            "NEW_BILLING_CREDENTIAL must be set to a 32-byte base64url credential (43 characters)",
        )?;
    let connection =
        store::open_existing(Path::new(database)).map_err(|error| error.to_string())?;
    let account = store::find_account(&connection, store::AccountKey::Id, account_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("No billing account named {account_id}"))?;

    // Accounts that never reached Stripe have no paid state to protect.
    if let Some(customer_id) = &account.stripe_customer_id {
        let key = env("STRIPE_SECRET_KEY")
            .filter(|key| !key.is_empty())
            .ok_or(
                "STRIPE_SECRET_KEY is required to verify the account's Stripe customer record",
            )?;
        let customer = StripeClient::new(stripe_base, &key)
            .get_customer(customer_id)
            .await
            .map_err(|error| format!("The account's Stripe customer cannot be read: {error}"))?
            .ok_or("The account's Stripe customer was not found")?;
        if customer.deleted {
            return Err("The account's Stripe customer was deleted".into());
        }
        if customer.account_id.as_deref() != Some(&account.id) {
            return Err(
                "The stored Stripe customer does not belong to this account; refusing rotation"
                    .into(),
            );
        }
    }

    store::update_credential_hash(
        &connection,
        &account.id,
        &sha256_hex(&credential),
        &now_millis_rfc3339(),
    )
    .map_err(|error| error.to_string())?;
    Ok(format!(
        "Rotated the billing credential for account {}. The previous credential no longer works.",
        account.id
    ))
}

/// `suplex billing rotate-credential --db <path> --account <id>`. Returns
/// the process exit code.
pub async fn main(args: &[String]) -> i32 {
    let outcome = match args.first().map(String::as_str) {
        Some("rotate-credential") => rotate_credential(
            &args[1..],
            &|name| std::env::var(name).ok(),
            STRIPE_API_BASE,
        )
        .await
        .map(|message| println!("{message}")),
        _ => Err(ROTATE_USAGE.to_owned()),
    };
    match outcome {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

#[cfg(test)]
include!("../../../tests/billing/server.rs");
