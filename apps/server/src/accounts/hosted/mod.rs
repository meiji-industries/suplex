//! The hosted account service: OAuth, magic links, and attempt polling.
//! A private host starts an attempt with `sha256(verifier)`, the browser
//! completes it at a provider, and the host polls with the verifier to
//! receive an account token once. Product update email choices sync to
//! Resend contacts through `resend`. See docs/accounts.md.

use std::{ops::Deref, sync::Arc, time::Duration};

use axum::http::{HeaderMap, header};
use rusqlite::Connection;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::{
    accounts::wire::{
        AuthAttemptBody, AuthEmailBody, AuthPollBody, AuthPollResponse, AuthProvider, LoginClient,
        challenge, random_token, token_shape, valid_attempt_id, valid_email,
    },
    billing::hosted::{Hosted, HostedError, HostedResult, iso},
    shared::{hash::sha256_hex, ids::random_hex_id},
};
use providers::{Endpoints, Profile};

pub mod delete;
pub mod email_updates;
pub mod invitations;
pub mod providers;
pub mod resend;
pub mod server;
pub mod start;
pub mod store;

#[cfg(test)]
pub(crate) mod fakes {
    include!("../../../tests/accounts/fakes.rs");
}

const ATTEMPT_MS: i64 = 15 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;
const MAGIC_LINKS_PER_HOUR: i64 = 5;
const MAX_NAME: usize = 200;
const ACCOUNT_VARIABLES: [&str; 6] = [
    "ACCOUNT_GOOGLE_CLIENT_ID",
    "ACCOUNT_GOOGLE_CLIENT_SECRET",
    "ACCOUNT_GITHUB_CLIENT_ID",
    "ACCOUNT_GITHUB_CLIENT_SECRET",
    "RESEND_API_KEY",
    "ACCOUNT_EMAIL_FROM",
];
pub const VISITOR_COOKIE: &str = "suplex_visitor";

#[derive(Clone, Debug)]
pub struct AccountConfig {
    pub google_client_id: String,
    pub google_client_secret: String,
    pub github_client_id: String,
    pub github_client_secret: String,
    pub resend_api_key: String,
    pub email_from: String,
    /// `ACCOUNT_REVIEW_EMAIL`: an email login for this address completes at
    /// once, without an email. App Review has no inbox; keep the address secret.
    pub review_email: Option<String>,
    /// `RESEND_WEBHOOK_SECRET`: the `whsec_` signing secret of the Resend
    /// webhook. Without it `/webhooks/resend` answers 503.
    pub resend_webhook_secret: Option<String>,
}

/// Reads the account configuration. `None` until every account variable is
/// set; account routes then answer 503 `account_unavailable`. The public
/// origin is `BILLING_PUBLIC_ORIGIN`.
pub fn load_config(env: &dyn Fn(&str) -> Option<String>) -> Result<Option<AccountConfig>, String> {
    let set = |name: &str| env(name).filter(|value| !value.is_empty());
    let resend_webhook_secret = set("RESEND_WEBHOOK_SECRET");
    if resend_webhook_secret
        .as_deref()
        .is_some_and(|secret| resend::signing_key(secret).is_none())
    {
        return Err("RESEND_WEBHOOK_SECRET must be a whsec_ secret".to_owned());
    }
    Ok(match ACCOUNT_VARIABLES.map(set) {
        [None, None, None, None, None, None] => None,
        [
            Some(google_client_id),
            Some(google_client_secret),
            Some(github_client_id),
            Some(github_client_secret),
            Some(resend_api_key),
            Some(email_from),
        ] => Some(AccountConfig {
            google_client_id,
            google_client_secret,
            github_client_id,
            github_client_secret,
            resend_api_key,
            email_from,
            review_email: set("ACCOUNT_REVIEW_EMAIL").and_then(|email| normalize_email(&email)),
            resend_webhook_secret,
        }),
        _ => {
            return Err(format!(
                "Set all or none of {}",
                ACCOUNT_VARIABLES.join(", ")
            ));
        }
    })
}

/// A PostHog distinct id from the website, carried by `/download?visitor=`.
pub fn valid_visitor(visitor: &str) -> bool {
    (8..=64).contains(&visitor.len())
        && visitor
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub fn visitor_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, visitor)| *name == VISITOR_COOKIE && valid_visitor(visitor))
        .map(|(_, visitor)| visitor)
}

fn normalize_email(email: &str) -> Option<String> {
    let email = email.trim().to_ascii_lowercase();
    valid_email(&email).then_some(email)
}

fn expired() -> HostedError {
    HostedError::new(400, Some("attempt_expired"), "The login attempt expired")
}

fn invalid() -> HostedError {
    HostedError::new(400, None, "Invalid request")
}

fn internal<E>(_: E) -> HostedError {
    HostedError::internal()
}

#[derive(Clone)]
pub struct Accounts(Arc<Inner>);

pub struct Inner {
    pub hosted: Hosted,
    pub config: Option<AccountConfig>,
    pub endpoints: Endpoints,
    pub http: reqwest::Client,
    /// One Resend outbox pass at a time, so each change is sent once and in order.
    pub resend_sync: tokio::sync::Mutex<()>,
}

impl Deref for Accounts {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl Accounts {
    /// Shares the billing database, clock, and telemetry configuration.
    pub fn new(hosted: Hosted, config: Option<AccountConfig>, endpoints: Endpoints) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("account HTTP client builds");
        Self(Arc::new(Inner {
            hosted,
            config,
            endpoints,
            http,
            resend_sync: tokio::sync::Mutex::new(()),
        }))
    }

    pub fn config(&self) -> HostedResult<&AccountConfig> {
        self.config.as_ref().ok_or_else(|| {
            HostedError::new(
                503,
                Some("account_unavailable"),
                "Suplex accounts are not available",
            )
        })
    }

    /// Queues a PostHog event when hosted telemetry is on.
    pub fn track(
        &self,
        db: &Connection,
        event: &str,
        distinct_id: &str,
        properties: Value,
    ) -> rusqlite::Result<()> {
        if self.hosted.config.telemetry.is_none() {
            return Ok(());
        }
        store::enqueue_posthog(db, event, distinct_id, &self.hosted.now_iso(), &properties)
    }

    fn redirect_uri(&self, provider: AuthProvider) -> String {
        format!("{}/auth/callback/{provider}", self.hosted.config.origin)
    }

    pub fn create_attempt(&self, body: &AuthAttemptBody) -> HostedResult<String> {
        self.config()?;
        if !body.valid() {
            return Err(invalid());
        }
        let id = random_hex_id("attempt").map_err(internal)?;
        let now = self.hosted.now_ms();
        self.hosted.query(|db| {
            store::insert_attempt(
                db,
                &id,
                &body.challenge,
                &body.installation_id,
                body.client,
                &iso(now),
                &iso(now + ATTEMPT_MS),
            )
        })?;
        Ok(id)
    }

    /// Returns the provider authorization URL for the browser.
    pub fn start_oauth(&self, attempt_id: &str, provider: AuthProvider) -> HostedResult<String> {
        let config = self.config()?;
        if provider == AuthProvider::Email || !valid_attempt_id(attempt_id) {
            return Err(invalid());
        }
        let state = random_token().map_err(internal)?;
        let now = self.hosted.now_iso();
        if !self
            .hosted
            .query(|db| store::set_attempt_provider(db, attempt_id, provider, &state, &now))?
        {
            return Err(expired());
        }
        providers::authorize_url(
            &self.endpoints,
            config,
            provider,
            &self.redirect_uri(provider),
            &state,
        )
    }

    pub async fn finish_oauth(
        &self,
        provider: AuthProvider,
        code: &str,
        state: &str,
        visitor: Option<&str>,
    ) -> HostedResult<String> {
        let config = self.config()?;
        if provider == AuthProvider::Email || !token_shape(state) || code.is_empty() {
            return Err(invalid());
        }
        let now = self.hosted.now_iso();
        let attempt_id = self
            .hosted
            .query(|db| store::find_attempt_by_state(db, provider, state, &now))?
            .ok_or_else(expired)?;
        let profile = providers::profile(
            &self.http,
            &self.endpoints,
            config,
            provider,
            code,
            &self.redirect_uri(provider),
        )
        .await?;
        self.complete(&attempt_id, provider, profile, visitor)
    }

    /// Sends a magic link for the attempt. Five sends per address per hour.
    /// The review address sends nothing: its attempt completes at once, and
    /// the result is the page the browser opens next.
    pub async fn send_magic_link(&self, body: &AuthEmailBody) -> HostedResult<Option<String>> {
        let config = self.config()?;
        let email = normalize_email(&body.email)
            .filter(|_| valid_attempt_id(&body.attempt_id))
            .ok_or_else(invalid)?;
        if config
            .review_email
            .as_deref()
            .is_some_and(|review| bool::from(review.as_bytes().ct_eq(email.as_bytes())))
        {
            let profile = Profile { email, name: None };
            return self
                .complete(&body.attempt_id, AuthProvider::Email, profile, None)
                .map(Some);
        }
        let token = random_token().map_err(internal)?;
        let token_hash = sha256_hex(&token);
        let now_ms = self.hosted.now_ms();
        let now = iso(now_ms);
        self.hosted.immediate(|db| {
            let live = store::find_attempt(db, &body.attempt_id, &now)?
                .is_some_and(|attempt| attempt.account_id.is_none());
            if !live {
                return Ok(Err(expired()));
            }
            if store::count_magic_links(db, &email, &iso(now_ms - HOUR_MS))? >= MAGIC_LINKS_PER_HOUR
            {
                return Ok(Err(HostedError::new(
                    429,
                    Some("rate_limited"),
                    "Too many sign-in emails for this address",
                )));
            }
            store::insert_magic_link(
                db,
                &token_hash,
                &body.attempt_id,
                &email,
                &now,
                &iso(now_ms + ATTEMPT_MS),
            )?;
            Ok(Ok(()))
        })??;
        let link = format!(
            "{}/auth/email/verify?token={token}",
            self.hosted.config.origin
        );
        if let Err(error) =
            providers::send_magic_link(&self.http, &self.endpoints, config, &email, &link).await
        {
            self.hosted
                .query(|db| store::delete_magic_link(db, &token_hash))?;
            return Err(error);
        }
        Ok(None)
    }

    pub fn verify_magic_link(&self, token: &str, visitor: Option<&str>) -> HostedResult<String> {
        self.config()?;
        if !token_shape(token) {
            return Err(expired());
        }
        let now = self.hosted.now_iso();
        let (attempt_id, email) = self
            .hosted
            .query(|db| store::consume_magic_link(db, &sha256_hex(token), &now))?
            .ok_or_else(expired)?;
        let profile = Profile { email, name: None };
        self.complete(&attempt_id, AuthProvider::Email, profile, visitor)
    }

    /// Binds the account to the attempt. Signup and login differ only in
    /// whether the account row was inserted. Returns the page the browser
    /// opens next, which depends on where the login started.
    fn complete(
        &self,
        attempt_id: &str,
        provider: AuthProvider,
        profile: Profile,
        visitor: Option<&str>,
    ) -> HostedResult<String> {
        let email = normalize_email(&profile.email).ok_or_else(providers::unverified)?;
        let name = profile
            .name
            .map(|name| name.trim().chars().take(MAX_NAME).collect::<String>())
            .filter(|name| !name.is_empty());
        let candidate = format!("user_{}", uuid::Uuid::new_v4());
        let now = self.hosted.now_iso();
        let completed = self.hosted.immediate(|db| {
            let Some(attempt) = store::find_attempt(db, attempt_id, &now)?
                .filter(|attempt| attempt.account_id.is_none())
            else {
                return Ok(None);
            };
            let (account, created) =
                store::upsert_account(db, &candidate, &email, name.as_deref(), &now)?;
            store::complete_attempt(db, attempt_id, &account.id, provider, &now)?;
            let event = if created {
                "account_signed_up"
            } else {
                "account_logged_in"
            };
            self.track(
                db,
                event,
                &account.id,
                json!({
                    "$lib": "suplex-hosted",
                    "provider": provider,
                    "$groups": {"host": attempt.installation_id},
                    "$set": {"email": email},
                }),
            )?;
            if let Some(visitor) = visitor {
                self.track(
                    db,
                    "$identify",
                    &account.id,
                    json!({
                        "$lib": "suplex-hosted",
                        "$anon_distinct_id": visitor,
                        "$set": {"email": email},
                    }),
                )?;
            }
            Ok(Some(
                if attempt.installation_id == start::SITE_INSTALLATION {
                    format!("/start/done?attempt={attempt_id}")
                } else if attempt.installation_id == delete::DELETE_INSTALLATION {
                    format!("/account/delete/confirm?attempt={attempt_id}")
                } else if attempt.client == LoginClient::Web {
                    "/auth/done?client=web".to_owned()
                } else {
                    "/auth/done".to_owned()
                },
            ))
        })?;
        completed.ok_or_else(expired)
    }

    /// `Complete` once: the token is minted here and only its hash is kept.
    pub fn poll(&self, attempt_id: &str, body: &AuthPollBody) -> HostedResult<AuthPollResponse> {
        self.config()?;
        let missing = || {
            HostedError::new(
                404,
                Some("attempt_not_found"),
                "The login attempt is not available",
            )
        };
        if !valid_attempt_id(attempt_id) || !token_shape(&body.verifier) {
            return Err(missing());
        }
        let now = self.hosted.now_iso();
        let attempt = self
            .hosted
            .query(|db| store::find_attempt(db, attempt_id, &now))?
            .filter(|attempt| {
                bool::from(
                    challenge(&body.verifier)
                        .as_bytes()
                        .ct_eq(attempt.challenge.as_bytes()),
                )
            })
            .ok_or_else(missing)?;
        if attempt.account_id.is_none() {
            return Ok(AuthPollResponse::Pending);
        }
        let token = random_token().map_err(internal)?;
        let account = self.hosted.immediate(|db| {
            let Some((account_id, installation_id)) = store::delete_attempt(db, attempt_id)? else {
                return Ok(None);
            };
            store::insert_token(db, &sha256_hex(&token), &account_id, &installation_id, &now)?;
            store::find_account(db, &account_id).map(Some)
        })?;
        let account = account.ok_or_else(missing)?;
        Ok(AuthPollResponse::Complete { token, account })
    }

    /// Forgets the bearer token. Unknown tokens are already logged out.
    pub fn logout(&self, authorization: Option<&str>) -> HostedResult<()> {
        self.config()?;
        if let Some(token) = authorization
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|token| token_shape(token))
        {
            self.hosted
                .query(|db| store::delete_token(db, &sha256_hex(token)))?;
        }
        Ok(())
    }

    /// Keeps expired attempts and their magic links for an hour, so the
    /// per-address send limit still counts them.
    pub fn sweep(&self) -> HostedResult<()> {
        let cutoff = iso(self.hosted.now_ms() - HOUR_MS);
        self.hosted.query(|db| store::sweep(db, &cutoff))?;
        Ok(())
    }
}
