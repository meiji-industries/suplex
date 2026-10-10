//! `suplex.sh/account/delete`: delete a Suplex account. The person logs in
//! in this browser, then confirms. The app links here (App Store guideline
//! 5.1.1(v)).
//!
//! As with `/start`, the attempt only names the account that logged in: its
//! verifier is discarded and no account token is minted for it.

use axum::{
    Form, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use rusqlite::params;
use serde::Deserialize;

use super::{
    Accounts,
    start::{escape, html, message},
    store,
};
use crate::{
    accounts::wire::{
        AuthAttemptBody, AuthEmailBody, HostedAccount, LoginClient, challenge, random_token,
    },
    billing::hosted::store::{self as billing_store, AccountKey},
};

pub const DELETE_INSTALLATION: &str = "suplex.sh-delete";

const RETRY: &str = "<a class=\"button primary\" href=\"/account/delete\">Retry</a>";
const EXPLAIN: &str = "Suplex deletes your account, your login methods, and the invitations you sent. Data on your Suplex hosts stays on those hosts; an administrator of each host controls it.";

#[derive(Deserialize)]
struct LoginQuery {
    with: Option<String>,
}

async fn login(State(accounts): State<Accounts>, Query(query): Query<LoginQuery>) -> Response {
    let attempt = random_token().ok().and_then(|verifier| {
        accounts
            .create_attempt(&AuthAttemptBody {
                challenge: challenge(&verifier),
                installation_id: DELETE_INSTALLATION.to_owned(),
                client: LoginClient::Web,
            })
            .ok()
    });
    let Some(attempt) = attempt else {
        return html(
            StatusCode::SERVICE_UNAVAILABLE,
            "Log in is not available",
            &message("Log in is not available", "Retry later.", RETRY),
        );
    };
    let content = if query.with.as_deref() == Some("email") {
        format!(
            "<form class=\"stack\" method=\"post\" action=\"/account/delete/email\"><input type=\"hidden\" name=\"attempt\" value=\"{attempt}\"><input type=\"email\" name=\"email\" required autofocus autocomplete=\"email\" placeholder=\"Email address\" aria-label=\"Email address\"><button class=\"button primary\" type=\"submit\">Continue</button><a class=\"button ghost\" href=\"/account/delete\">Cancel</a></form>"
        )
    } else {
        format!(
            "<div class=\"stack\"><p class=\"center\">Log in to the account that you want to delete. {EXPLAIN}</p><a class=\"button primary\" href=\"/auth/start?attempt={attempt}&amp;provider=google\">Continue with Google</a><a class=\"button outline\" href=\"/auth/start?attempt={attempt}&amp;provider=github\">Continue with GitHub</a><a class=\"button outline\" href=\"/account/delete?with=email\">Continue with email</a></div>"
        )
    };
    html(StatusCode::OK, "Delete your Suplex account", &content)
}

#[derive(Deserialize)]
struct EmailForm {
    attempt: Option<String>,
    email: Option<String>,
}

async fn email(State(accounts): State<Accounts>, Form(form): Form<EmailForm>) -> Response {
    let body = AuthEmailBody {
        attempt_id: form.attempt.unwrap_or_default(),
        email: form.email.unwrap_or_default(),
    };
    match accounts.send_magic_link(&body).await {
        Ok(Some(next)) => Redirect::to(&next).into_response(),
        Ok(None) => html(
            StatusCode::OK,
            "Check your email",
            &message(
                "Check your email",
                &format!(
                    "Suplex sent a login link to <strong>{}</strong>. Open it to continue.",
                    escape(body.email.trim())
                ),
                "<a class=\"button outline\" href=\"/account/delete\">Cancel</a>",
            ),
        ),
        Err(error) => html(
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
            "Suplex did not send the link",
            &message(
                "Suplex did not send the link",
                "The login attempt expired, or Suplex limits login emails. Retry later.",
                RETRY,
            ),
        ),
    }
}

#[derive(Deserialize)]
struct AttemptForm {
    attempt: Option<String>,
}

/// The account that completed this delete attempt, if it is still live.
fn logged_in(accounts: &Accounts, attempt: Option<&str>) -> Option<HostedAccount> {
    let now = accounts.hosted.now_iso();
    accounts
        .hosted
        .query(|db| {
            let Some(attempt) = store::find_attempt(db, attempt.unwrap_or(""), &now)? else {
                return Ok(None);
            };
            match attempt.account_id {
                Some(id) if attempt.installation_id == DELETE_INSTALLATION => {
                    store::find_account(db, &id).map(Some)
                }
                _ => Ok(None),
            }
        })
        .ok()
        .flatten()
}

fn expired() -> Response {
    html(
        StatusCode::NOT_FOUND,
        "The login expired",
        &message(
            "The login expired",
            "Log in again to delete the account.",
            RETRY,
        ),
    )
}

/// A subscription that renews would keep charging an account that no longer
/// exists, so the person cancels it first. The billing provider decides.
async fn renewing_subscription(accounts: &Accounts, account_id: &str) -> Result<bool, ()> {
    let hosted = &accounts.hosted;
    let billing = hosted
        .query(|db| billing_store::find_account(db, AccountKey::RegistrationId, account_id))
        .map_err(|_| ())?;
    let Some(mut billing) = billing else {
        return Ok(false);
    };
    let state = hosted
        .plan(&mut billing, false)
        .await
        .map_err(|_| ())?
        .state;
    Ok(state.active && !state.cancel_at_period_end && state.subscription_status != "trialing")
}

async fn confirm(State(accounts): State<Accounts>, Query(form): Query<AttemptForm>) -> Response {
    let Some(account) = logged_in(&accounts, form.attempt.as_deref()) else {
        return expired();
    };
    let email = format!("<strong>{}</strong>", escape(&account.email));
    match renewing_subscription(&accounts, &account.id).await {
        Ok(false) => html(
            StatusCode::OK,
            "Delete your Suplex account",
            &format!(
                "<div class=\"stack center\"><h1>Delete {email}?</h1><p>{EXPLAIN} You cannot undo this.</p></div><form class=\"stack\" method=\"post\" action=\"/account/delete/confirm\"><input type=\"hidden\" name=\"attempt\" value=\"{}\"><button class=\"button primary\" type=\"submit\">Delete account</button><a class=\"button ghost\" href=\"/\">Cancel</a></form>",
                escape(form.attempt.as_deref().unwrap_or(""))
            ),
        ),
        Ok(true) => html(
            StatusCode::CONFLICT,
            "Cancel the subscription first",
            &message(
                "Cancel the subscription first",
                &format!(
                    "{email} has a Pro subscription that renews. Cancel it in Suplex, in Settings &gt; Billing, then delete the account."
                ),
                "",
            ),
        ),
        Err(()) => html(
            StatusCode::SERVICE_UNAVAILABLE,
            "Suplex cannot check the subscription",
            &message(
                "Suplex cannot check the subscription",
                "Retry later.",
                RETRY,
            ),
        ),
    }
}

async fn delete(State(accounts): State<Accounts>, Form(form): Form<AttemptForm>) -> Response {
    let Some(account) = logged_in(&accounts, form.attempt.as_deref()) else {
        return expired();
    };
    if renewing_subscription(&accounts, &account.id).await != Ok(false) {
        return confirm(State(accounts), Query(form)).await;
    }
    // Attempts and tokens cascade. Billing records stay: the law requires them.
    // PostHog keeps its person record; delete it there on request.
    let deleted = accounts.hosted.immediate(|db| {
        db.execute(
            "DELETE FROM company_invitations WHERE owner_account_id = ?1",
            params![account.id],
        )?;
        db.execute(
            "UPDATE company_invitations SET accepted_account_id = NULL WHERE accepted_account_id = ?1",
            params![account.id],
        )?;
        db.execute("DELETE FROM accounts WHERE id = ?1", params![account.id])
    });
    match deleted {
        Ok(_) => html(
            StatusCode::OK,
            "Your Suplex account is deleted",
            &message(
                "Your Suplex account is deleted",
                &format!("Suplex deleted the account {}.", escape(&account.email)),
                "",
            ),
        ),
        Err(_) => html(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Suplex did not delete the account",
            &message("Suplex did not delete the account", "Retry later.", RETRY),
        ),
    }
}

pub fn router(accounts: Accounts) -> Router {
    Router::new()
        .route("/account/delete", get(login))
        .route("/account/delete/email", post(email))
        .route("/account/delete/confirm", get(confirm).post(delete))
        .layer(axum::middleware::map_response(super::server::private))
        .with_state(accounts)
}

#[cfg(test)]
include!("../../../tests/accounts/delete.rs");
