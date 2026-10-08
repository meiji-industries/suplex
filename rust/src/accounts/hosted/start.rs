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
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;

use super::{Accounts, store};
use crate::{
    accounts::wire::{AuthAttemptBody, AuthEmailBody, LoginClient, challenge, random_token},
    billing::wire::HostedPlan,
};

pub const SITE_INSTALLATION: &str = "suplex.sh";

/// The app's login layout, so the website and the app look the same.
const TEMPLATE: &str = include_str!("start.html");
const WORDMARK: &str = include_str!("../../../../src/frontend/assets/suplex-wordmark.svg");
const BACKGROUND: &[u8] = include_bytes!("../../../../src/frontend/assets/account-background.png");
const FONT: &[u8] = include_bytes!("../../../../src/frontend/fonts/InterTight-Variable.woff2");

const DOWNLOADS: &str = "<div class=\"stack\"><a class=\"button primary\" href=\"/download?platform=macos-arm64\">Download for macOS</a><a class=\"button outline\" href=\"/download?platform=macos-x64\">Download for macOS Intel</a><a class=\"button outline\" href=\"/download?platform=linux-x64\">Download for Linux x64</a><a class=\"button outline\" href=\"/download?platform=linux-arm64\">Download for Linux Arm64</a></div>";
const TERMS: &str = "<p class=\"terms\">When you continue, you agree to the <a href=\"/terms\" target=\"_blank\" rel=\"noreferrer\">Terms of Service</a> and <a href=\"/privacy\" target=\"_blank\" rel=\"noreferrer\">Privacy Policy</a>.</p>";
const RETRY: &str = "<a class=\"button primary\" href=\"/start?plan=pro\">Retry</a>";

pub(super) fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Both arguments are HTML: escape untrusted values first.
pub(super) fn html(status: StatusCode, title: &str, content: &str) -> Response {
    let (head, foot) = TEMPLATE
        .split_once("{content}")
        .expect("start template has a content slot");
    let page = format!("{}{content}{foot}", head.replace("{title}", title));
    (status, Html(page)).into_response()
}

/// A heading and a message, as the app shows a waiting state.
pub(super) fn message(heading: &str, text: &str, actions: &str) -> String {
    format!("<div class=\"stack center\"><h1>{heading}</h1><p>{text}</p></div>{actions}")
}

#[derive(Deserialize)]
struct StartQuery {
    plan: Option<String>,
    visitor: Option<String>,
    /// `email` shows the email form, as Continue with email does in the app.
    with: Option<String>,
}

async fn start(
    State(accounts): State<Accounts>,
    Query(query): Query<StartQuery>,
    headers: HeaderMap,
) -> Response {
    let mut response = if query.plan.as_deref() == Some("pro") {
        trial_login(&accounts, query.with.as_deref() == Some("email"))
    } else {
        html(
            StatusCode::OK,
            "Start Suplex for free",
            &format!(
                "<p class=\"center\">Free includes 1 company, 2 projects, 3 tasks at a time, and 50 tasks each month. No credit card is necessary.</p>{DOWNLOADS}<p class=\"center\">Download Suplex, then log in with your Suplex account. Want more? <a href=\"/start?plan=pro\">Start a 30-day Pro trial</a>.</p>"
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

fn trial_login(accounts: &Accounts, email_form: bool) -> Response {
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
            &message(
                "Log in is not available",
                "Suplex cannot start the trial now. Download Suplex, then start the trial in Settings &gt; Billing.",
                DOWNLOADS,
            ),
        );
    };
    let content = if email_form {
        format!(
            "<form class=\"stack\" method=\"post\" action=\"/start/email\"><input type=\"hidden\" name=\"attempt\" value=\"{attempt}\"><input type=\"email\" name=\"email\" required autofocus autocomplete=\"email\" placeholder=\"Email address\" aria-label=\"Email address\"><button class=\"button primary\" type=\"submit\">Continue</button><a class=\"button ghost\" href=\"/start?plan=pro\">Cancel</a></form>"
        )
    } else {
        format!(
            "<div class=\"stack\"><p class=\"note center\">No credit card is necessary. Log in to start the trial.</p><a class=\"button primary\" href=\"/auth/start?attempt={attempt}&amp;provider=google\">Continue with Google</a><a class=\"button outline\" href=\"/auth/start?attempt={attempt}&amp;provider=github\">Continue with GitHub</a><a class=\"button outline\" href=\"/start?plan=pro&amp;with=email\">Continue with email</a></div>{TERMS}"
        )
    };
    html(StatusCode::OK, "Start your Pro trial", &content)
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
            &message(
                "Check your email",
                &format!(
                    "Suplex sent a login link to <strong>{}</strong>. Open it to start the trial.",
                    escape(body.email.trim())
                ),
                "<a class=\"button outline\" href=\"/start?plan=pro\">Cancel</a>",
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
            &message(
                "The login expired",
                "Log in again to start the trial.",
                RETRY,
            ),
        );
    };
    let email = format!("<strong>{}</strong>", escape(&account.email));
    let hosted = &accounts.hosted;
    let plan = match hosted.billing_for_user(&account.id) {
        Ok(mut billing) => match hosted.start_trial(&mut billing).await {
            Err(error) if error.has_code("trial_used") => hosted.plan(&mut billing).await,
            other => other,
        },
        Err(error) => Err(error),
    };
    let (heading, text) = match plan {
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
    html(StatusCode::OK, heading, &message(heading, &text, DOWNLOADS))
}

fn asset(content_type: &'static str, bytes: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes,
    )
        .into_response()
}

pub fn router(accounts: Accounts) -> Router {
    Router::new()
        .route("/start", get(start))
        .route("/start/email", post(email))
        .route("/start/done", get(done))
        .layer(axum::middleware::map_response(super::server::private))
        .route(
            "/start/wordmark.svg",
            get(|| async { asset("image/svg+xml", WORDMARK.as_bytes()) }),
        )
        .route(
            "/start/background.png",
            get(|| async { asset("image/png", BACKGROUND) }),
        )
        .route(
            "/start/inter-tight.woff2",
            get(|| async { asset("font/woff2", FONT) }),
        )
        .with_state(accounts)
}

#[cfg(test)]
include!("../../../tests/accounts/start.rs");
