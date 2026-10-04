//! `suplex.sh/start`: the website's Start free and Start 30-day trial
//! buttons. Free goes to the downloads. Pro logs in to a Suplex account in
//! this browser, starts that account's trial, then shows the downloads.
//!
//! A start attempt is an ordinary login attempt with the installation
//! `suplex.sh`. Its verifier is discarded, so no account token is ever
//! minted for it; the attempt only names the account that logged in.

use axum::{
    Form, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;

use super::{Accounts, store};
use crate::{
    accounts::wire::{AuthAttemptBody, AuthEmailBody, LoginClient, challenge, random_token},
    billing::wire::HostedPlan,
    shared::page,
};

pub const SITE_INSTALLATION: &str = "suplex.sh";

const DOWNLOADS: &str = "<div class=\"actions\"><a class=\"primary\" href=\"/download?platform=macos-arm64\">Download for macOS</a><a href=\"/download?platform=macos-x64\">macOS Intel</a><a href=\"/download?platform=linux-x64\">Linux x64</a><a href=\"/download?platform=linux-arm64\">Linux Arm64</a></div>";

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn html(status: StatusCode, heading: &str, body: &str) -> Response {
    (status, Html(page::render(heading, body))).into_response()
}

#[derive(Deserialize)]
struct StartQuery {
    plan: Option<String>,
    visitor: Option<String>,
}

async fn start(
    State(accounts): State<Accounts>,
    Query(query): Query<StartQuery>,
    headers: HeaderMap,
) -> Response {
    let mut response = if query.plan.as_deref() == Some("pro") {
        trial_login(&accounts)
    } else {
        html(
            StatusCode::OK,
            "Start Suplex for free",
            &format!(
                "<p>Free includes 1 company, 2 projects, 3 tasks at a time, and 50 tasks each month. No credit card is necessary.</p><p>Download Suplex, then log in with your Suplex account.</p>{DOWNLOADS}<p><a href=\"/start?plan=pro\">Start a 30-day Pro trial</a></p>"
            ),
        )
    };
    crate::hosted::site::remember_visitor(
        &accounts,
        &headers,
        query.visitor.as_deref(),
        &mut response,
    );
    response
}

fn trial_login(accounts: &Accounts) -> Response {
    let attempt = random_token().ok().and_then(|verifier| {
        accounts
            .create_attempt(&AuthAttemptBody {
                challenge: challenge(&verifier),
                installation_id: SITE_INSTALLATION.to_owned(),
                client: LoginClient::Web,
            })
            .ok()
    });
    let Some(attempt) = attempt else {
        return html(
            StatusCode::SERVICE_UNAVAILABLE,
            "Log in is not available",
            &format!(
                "<p>Suplex cannot start the trial now. Download Suplex, then start the trial in Settings &gt; Billing.</p>{DOWNLOADS}"
            ),
        );
    };
    html(
        StatusCode::OK,
        "Start your Pro trial",
        &format!(
            "<p>Pro is free for 30 days. No credit card is necessary. Log in with your Suplex account to start the trial.</p><div class=\"actions\"><a class=\"primary\" href=\"/auth/start?attempt={attempt}&amp;provider=google\">Continue with Google</a><a href=\"/auth/start?attempt={attempt}&amp;provider=github\">Continue with GitHub</a></div><form class=\"actions\" method=\"post\" action=\"/start/email\"><input type=\"hidden\" name=\"attempt\" value=\"{attempt}\"><input type=\"email\" name=\"email\" required autocomplete=\"email\" placeholder=\"you@example.com\" aria-label=\"Email address\"><button type=\"submit\">Send a login link</button></form>"
        ),
    )
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
        Ok(()) => html(
            StatusCode::OK,
            "Check your email",
            &format!(
                "<p>Suplex sent a login link to {}. Open the link to start the trial.</p>",
                escape(body.email.trim())
            ),
        ),
        Err(error) => html(
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
            "Suplex did not send the link",
            "<p>The login attempt expired, or Suplex limits login emails. Retry later.</p><div class=\"actions\"><a class=\"primary\" href=\"/start?plan=pro\">Retry</a></div>",
        ),
    }
}

#[derive(Deserialize)]
struct DoneQuery {
    attempt: Option<String>,
}

/// The browser arrives here after the login. Repeating the request shows the
/// same trial.
async fn done(State(accounts): State<Accounts>, Query(query): Query<DoneQuery>) -> Response {
    let now = accounts.hosted.now_iso();
    let account = accounts.hosted.query(|db| {
        let Some(attempt) = store::find_attempt(db, query.attempt.as_deref().unwrap_or(""), &now)?
        else {
            return Ok(None);
        };
        match attempt.account_id {
            Some(id) if attempt.installation_id == SITE_INSTALLATION => {
                store::find_account(db, &id).map(Some)
            }
            _ => Ok(None),
        }
    });
    let Ok(Some(account)) = account else {
        return html(
            StatusCode::NOT_FOUND,
            "The login expired",
            "<p>Log in again to start the trial.</p><div class=\"actions\"><a class=\"primary\" href=\"/start?plan=pro\">Retry</a></div>",
        );
    };
    let email = escape(&account.email);
    let hosted = &accounts.hosted;
    let plan = match hosted.billing_for_user(&account.id) {
        Ok(mut billing) => match hosted.start_trial(&mut billing).await {
            Err(error) if error.has_code("trial_used") => hosted.plan(&mut billing).await,
            other => other,
        },
        Err(error) => Err(error),
    };
    let (heading, message) = match plan {
        Ok(HostedPlan { state, .. }) if state.active => {
            let until = state
                .access_until
                .as_deref()
                .and_then(|until| chrono::DateTime::parse_from_rfc3339(until).ok())
                .map(|until| until.format("%B %-d, %Y").to_string())
                .unwrap_or_default();
            let what = if state.subscription_status == "trialing" {
                "Your Pro trial is active"
            } else {
                "Your Suplex account has Pro"
            };
            (
                what,
                format!("Pro is active until {until}. Download Suplex, then log in with {email}."),
            )
        }
        Ok(_) => (
            "Your Suplex account used its trial",
            format!(
                "Download Suplex, then log in with {email}. You can select Pro in Settings &gt; Billing."
            ),
        ),
        Err(_) => (
            "Suplex cannot start the trial now",
            format!(
                "Download Suplex, then log in with {email}. Start the trial in Settings &gt; Billing."
            ),
        ),
    };
    html(
        StatusCode::OK,
        heading,
        &format!("<p>{message}</p>{DOWNLOADS}"),
    )
}

pub fn router(accounts: Accounts) -> Router {
    Router::new()
        .route("/start", get(start))
        .route("/start/email", post(email))
        .route("/start/done", get(done))
        .layer(axum::middleware::map_response(super::server::private))
        .with_state(accounts)
}

#[cfg(test)]
include!("../../../tests/accounts/start.rs");
