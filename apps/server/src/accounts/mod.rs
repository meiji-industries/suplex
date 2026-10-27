//! Suplex accounts. The hosted service at suplex.sh owns identities; this
//! host links one account per installation. The link row is Suplex's own
//! durable record: once it exists, hosted downtime never affects this host.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use reqwest::{Method, StatusCode};
use rusqlite::{OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use url::Url;

use crate::{
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::{PublicFailure, time::now_millis_rfc3339},
};
use wire::{
    AuthAttemptBody, AuthAttemptResponse, AuthEmailBody, AuthPollBody, AuthPollResponse,
    AuthProvider, HostedAccount, LoginClient,
};

pub mod hosted;
pub mod members;
pub mod wire;

const ATTEMPT_LIFETIME: Duration = Duration::from_secs(15 * 60);

crate::shared::wire_enum! {
    pub enum AccountLoginState { Pending = "pending", Complete = "complete", Expired = "expired" }
}

pub fn unavailable() -> PublicFailure {
    PublicFailure::new(503, "Suplex cannot reach the account service")
        .with_code("account_unavailable")
}

pub fn not_configured() -> PublicFailure {
    PublicFailure::new(503, "Suplex accounts are not configured")
        .with_code("account_not_configured")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedAccount {
    pub account_id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub token: String,
    pub identify_sent_at: Option<String>,
}

pub fn linked(database: &SuplexDatabase) -> DatabaseResult<Option<LinkedAccount>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT account_id, email, display_name, token, identify_sent_at FROM suplex_account WHERE id = 'host'",
            [],
            |row| {
                Ok(LinkedAccount {
                    account_id: row.get(0)?,
                    email: row.get(1)?,
                    display_name: row.get(2)?,
                    token: row.get(3)?,
                    identify_sent_at: row.get(4)?,
                })
            },
        )
        .optional()?)
}

/// Replaces any earlier link: one account per installation. The account
/// signs in as `user_development` (`members::accept`), so that user's
/// `suplex_account_users` row names it. When another user already has this
/// account or email, the owner gets no row: Suplex does not guess. The old
/// row goes first, so a failed step leaves no row rather than a wrong one.
pub fn link(database: &SuplexDatabase, account: &HostedAccount, token: &str) -> DatabaseResult<()> {
    forget_owner_account(database)?;
    database.connection().execute(
        "INSERT OR REPLACE INTO suplex_account (id, account_id, email, display_name, token, linked_at, identify_sent_at) VALUES ('host', ?1, ?2, ?3, ?4, ?5, NULL)",
        params![account.id, account.email, account.name, token, now_millis_rfc3339()],
    )?;
    database.connection().execute(
        "INSERT OR IGNORE INTO suplex_account_users (user_id, account_id, email) SELECT 'user_development', ?1, ?2 WHERE EXISTS (SELECT 1 FROM suplex_users WHERE id = 'user_development')",
        params![account.id, account.email],
    )?;
    Ok(())
}

/// Removes the link and returns its token for the hosted logout.
pub fn unlink(database: &SuplexDatabase) -> DatabaseResult<Option<String>> {
    forget_owner_account(database)?;
    Ok(database
        .connection()
        .query_row(
            "DELETE FROM suplex_account WHERE id = 'host' RETURNING token",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

fn forget_owner_account(database: &SuplexDatabase) -> DatabaseResult<()> {
    database.connection().execute(
        "DELETE FROM suplex_account_users WHERE user_id = 'user_development'",
        [],
    )?;
    Ok(())
}

/// The hosted account that `user_id` signs in with, if any.
pub fn user_account_id(database: &SuplexDatabase, user_id: &str) -> DatabaseResult<Option<String>> {
    Ok(database
        .connection()
        .query_row(
            "SELECT account_id FROM suplex_account_users WHERE user_id = ?1",
            [user_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten())
}

struct PendingAttempt {
    verifier: String,
    started: Instant,
}

/// The outcome of one poll. `Complete` carries the validated hosted account.
#[derive(Debug, PartialEq, Eq)]
pub enum LoginPoll {
    Pending,
    Complete {
        token: String,
        account: HostedAccount,
    },
    Expired,
}

/// The hosted account API. It never follows a redirect: that would resend
/// the verifier or token to another origin.
#[derive(Clone)]
pub struct AccountClient {
    base: Url,
    installation_id: String,
    http: reqwest::Client,
    // In memory, a restart means retry
    pending: Arc<Mutex<HashMap<String, PendingAttempt>>>,
}

impl AccountClient {
    pub fn new(base: Url, installation_id: String) -> Self {
        Self {
            base,
            installation_id,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("account HTTP client builds"),
            pending: Arc::default(),
        }
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingAttempt>> {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        pending.retain(|_, attempt| attempt.started.elapsed() < ATTEMPT_LIFETIME);
        pending
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<&impl Serialize>,
    ) -> Result<reqwest::Response, PublicFailure> {
        let url = self.base.join(path).map_err(|_| unavailable())?;
        let mut request = self.http.request(method, url);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        request.send().await.map_err(|_| unavailable())
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, PublicFailure> {
        let response = self.send(Method::POST, path, None, Some(body)).await?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            return Err(
                PublicFailure::new(429, "Suplex limits login requests. Retry later.")
                    .with_code("account_rate_limited"),
            );
        }
        if !response.status().is_success() {
            return Err(unavailable());
        }
        response.json().await.map_err(|_| unavailable())
    }

    pub async fn send_company_invitation(
        &self,
        token: &str,
        body: &wire::CompanyInvitationBody,
    ) -> Result<(), PublicFailure> {
        let response = self
            .send(
                Method::POST,
                "/v1/company-invitations",
                Some(token),
                Some(body),
            )
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(
                PublicFailure::new(503, "Suplex could not send the invitation. Retry.")
                    .with_code("email_unavailable"),
            )
        }
    }

    /// Starts a login attempt. Only the challenge leaves this host; the
    /// verifier stays here until the poll. Returns the attempt and, for
    /// Google and GitHub, the URL the browser opens. The hosted done
    /// page opens the desktop app only for a desktop `client`.
    pub async fn start_login(
        &self,
        provider: AuthProvider,
        email: Option<&str>,
        client: LoginClient,
    ) -> Result<(String, Option<String>), PublicFailure> {
        let verifier = wire::random_token().map_err(|_| PublicFailure::internal())?;
        let attempt: AuthAttemptResponse = self
            .post(
                "/v1/auth/attempts",
                &AuthAttemptBody {
                    challenge: wire::challenge(&verifier),
                    installation_id: self.installation_id.clone(),
                    client,
                },
            )
            .await?;
        if !wire::valid_attempt_id(&attempt.attempt_id) {
            return Err(unavailable());
        }
        let url = match provider {
            AuthProvider::Email => {
                let email = email.ok_or_else(|| {
                    PublicFailure::new(400, "An email address is required")
                        .with_code("email_required")
                })?;
                let response = self
                    .send(
                        Method::POST,
                        "/v1/auth/email",
                        None,
                        Some(&AuthEmailBody {
                            attempt_id: attempt.attempt_id.clone(),
                            email: email.to_owned(),
                        }),
                    )
                    .await?;
                match response.status() {
                    status if status.is_success() => None,
                    StatusCode::TOO_MANY_REQUESTS => {
                        return Err(PublicFailure::new(
                            429,
                            "Suplex limits login emails. Retry later.",
                        )
                        .with_code("account_rate_limited"));
                    }
                    _ => return Err(unavailable()),
                }
            }
            AuthProvider::Google | AuthProvider::Github => {
                let mut url = self.base.join("/auth/start").map_err(|_| unavailable())?;
                url.query_pairs_mut()
                    .append_pair("attempt", &attempt.attempt_id)
                    .append_pair("provider", provider.as_str());
                Some(url.to_string())
            }
        };
        self.pending().insert(
            attempt.attempt_id.clone(),
            PendingAttempt {
                verifier,
                started: Instant::now(),
            },
        );
        Ok((attempt.attempt_id, url))
    }

    /// Polls with the verifier. An unknown or expired attempt, here or on
    /// the hosted service, is `Expired`. A complete payload that does not
    /// match the contract fails closed.
    pub async fn poll_login(&self, attempt_id: &str) -> Result<LoginPoll, PublicFailure> {
        let Some(verifier) = self
            .pending()
            .get(attempt_id)
            .map(|attempt| attempt.verifier.clone())
        else {
            return Ok(LoginPoll::Expired);
        };
        let response = self
            .send(
                Method::POST,
                &format!("/v1/auth/attempts/{attempt_id}/poll"),
                None,
                Some(&AuthPollBody { verifier }),
            )
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            self.pending().remove(attempt_id);
            return Ok(LoginPoll::Expired);
        }
        if !response.status().is_success() {
            return Err(unavailable());
        }
        match response.json().await.map_err(|_| unavailable())? {
            AuthPollResponse::Pending => Ok(LoginPoll::Pending),
            AuthPollResponse::Complete { token, account } => {
                self.pending().remove(attempt_id);
                if wire::token_shape(&token) && account.valid() {
                    Ok(LoginPoll::Complete { token, account })
                } else {
                    Err(unavailable())
                }
            }
        }
    }

    /// The linked account's choice about product update emails.
    pub async fn email_updates(
        &self,
        token: &str,
    ) -> Result<wire::EmailUpdatesState, PublicFailure> {
        let response = self
            .send(
                Method::GET,
                "/v1/account/email-updates",
                Some(token),
                None::<&()>,
            )
            .await?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        response.json().await.map_err(|_| unavailable())
    }

    /// Records one choice about product update emails with the wording the person saw.
    pub async fn set_email_updates(
        &self,
        token: &str,
        body: &wire::EmailUpdatesBody,
    ) -> Result<wire::EmailUpdatesState, PublicFailure> {
        let response = self
            .send(
                Method::PUT,
                "/v1/account/email-updates",
                Some(token),
                Some(body),
            )
            .await?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        response.json().await.map_err(|_| unavailable())
    }

    /// Best effort: the local link is already gone.
    pub async fn logout(&self, token: &str) {
        let _ = self
            .send(Method::POST, "/v1/auth/logout", Some(token), None::<&()>)
            .await;
    }
}
