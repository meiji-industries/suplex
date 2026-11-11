//! `suplex.sh/start`: the website's Start free and Start 14-day trial
//! buttons. Free goes to the downloads. Pro logs in to a Suplex account in
//! this browser, starts that account's trial, then shows the downloads.
//!
//! A start attempt is an ordinary login attempt with the installation
//! `suplex.sh`. Its verifier is discarded, so no account token is ever
//! minted for it; the attempt only names the account that logged in.
//!
//! Every link and form on these pages keeps the query the visitor arrived
//! with (`_gl`, `gclid`, `utm_*`, `visitor`, `consent`, and so on), so
//! attribution and the consent choice survive each step. The login leaves
//! suplex.sh, so `/start?plan=pro` also keeps that query in a short-lived
//! cookie that `/start/done` reads.

use axum::{
    Form, Router,
    extract::{Query, RawQuery, State},
    http::{HeaderMap, StatusCode, Uri, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::Deserialize;

use super::{Accounts, store};
use crate::{
    accounts::wire::{AuthAttemptBody, AuthEmailBody, LoginClient, challenge, random_token},
    billing::wire::HostedPlan,
};

pub const SITE_INSTALLATION: &str = "suplex.sh";

const WORDMARK: &str = include_str!("../../../../web/assets/suplex-wordmark.svg");
const BACKGROUND: &[u8] = include_bytes!("../../../../web/assets/account-background.png");
const FONT: &[u8] = include_bytes!("../../../../web/fonts/InterTight-Variable.woff2");

/// Keeps the forwarded query of a trial login until `/start/done`.
const QUERY_COOKIE: &str = "suplex_start_query";
/// Keys that a link on these pages sets itself. The incoming query never
/// replaces them.
const OWNED_KEYS: [&str; 6] = ["plan", "with", "attempt", "provider", "platform", "format"];
const MAX_KEY: usize = 64;
const MAX_VALUE: usize = 512;
const MAX_PAIRS: usize = 32;
const MAX_QUERY: usize = 2048;

/// The incoming query that internal links keep, URL-encoded and without the
/// keys a link sets itself. The first value of a repeated key wins. Pairs
/// past the size bounds are dropped.
pub(crate) fn forwarded(raw: Option<&str>) -> String {
    let mut keys: Vec<String> = Vec::new();
    let mut query = String::new();
    for (key, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        if key.is_empty()
            || key.len() > MAX_KEY
            || value.len() > MAX_VALUE
            || keys.len() >= MAX_PAIRS
            || OWNED_KEYS.contains(&key.as_ref())
            || keys.iter().any(|seen| *seen == key)
        {
            continue;
        }
        let pair = url::form_urlencoded::Serializer::new(String::new())
            .append_pair(&key, &value)
            .finish();
        if query.len() + pair.len() + 1 > MAX_QUERY {
            continue;
        }
        if !query.is_empty() {
            query.push('&');
        }
        query.push_str(&pair);
        keys.push(key.into_owned());
    }
    query
}

/// An HTML attribute value: `base`, which can have its own query, then the
/// forwarded query.
fn link(base: &str, forwarded: &str) -> String {
    if forwarded.is_empty() {
        return escape(base);
    }
    let separator = if base.contains('?') { '&' } else { '?' };
    escape(&format!("{base}{separator}{forwarded}"))
}

fn downloads(query: &str) -> String {
    format!(
        "<div class=\"stack\"><a class=\"button primary\" href=\"{}\">Download for macOS</a><a class=\"button outline\" href=\"{}\">Download for macOS Intel</a><a class=\"button outline\" href=\"{}\">Download for Linux x64</a><a class=\"button outline\" href=\"{}\">Download for Linux Arm64</a></div>",
        link("/download?platform=macos-arm64", query),
        link("/download?platform=macos-x64", query),
        link("/download?platform=linux-x64", query),
        link("/download?platform=linux-arm64", query),
    )
}

fn terms(query: &str) -> String {
    format!(
        "<p class=\"terms\">When you continue, you agree to the <a href=\"{}\" target=\"_blank\" rel=\"noreferrer\">Terms of Service</a> and <a href=\"{}\" target=\"_blank\" rel=\"noreferrer\">Privacy Policy</a>.</p>",
        link("/terms", query),
        link("/privacy", query),
    )
}

fn retry(query: &str) -> String {
    format!(
        "<a class=\"button primary\" href=\"{}\">Retry</a>",
        link("/start?plan=pro", query)
    )
}

fn cancel(query: &str) -> String {
    format!(
        "<a class=\"button ghost\" href=\"{}\">Cancel</a>",
        link("/start?plan=pro", query)
    )
}

/// Keeps the forwarded query for an hour on `/start` paths, for the
/// `/start/done` page after the login. An empty query clears an older one.
/// `DNT: 1` keeps nothing.
fn remember_query(accounts: &Accounts, headers: &HeaderMap, query: &str, response: &mut Response) {
    if headers.get("dnt").is_some_and(|value| value == "1") {
        return;
    }
    let secure = if accounts.hosted.config.origin.starts_with("https:") {
        "; Secure"
    } else {
        ""
    };
    let age = if query.is_empty() { 0 } else { 3600 };
    let cookie = format!(
        "{QUERY_COOKIE}={query}; Max-Age={age}; Path=/start; HttpOnly; SameSite=Lax{secure}"
    );
    if let Ok(cookie) = cookie.parse() {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
}

fn remembered_query(headers: &HeaderMap) -> String {
    let raw = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == QUERY_COOKIE)
        .map(|(_, query)| query);
    forwarded(raw)
}

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
    (status, Html(crate::shared::page::layout(title, content))).into_response()
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
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let forward = forwarded(uri.query());
    let mut response = if query.plan.as_deref() == Some("pro") {
        let mut response = trial_login(&accounts, query.with.as_deref() == Some("email"), &forward);
        remember_query(&accounts, &headers, &forward, &mut response);
        response
    } else {
        html(
            StatusCode::OK,
            "Start Suplex for free",
            &format!(
                "<p class=\"center\">Free includes 1 company, 2 projects, 3 tasks at a time, and 50 tasks each month. No credit card is necessary.</p>{}<p class=\"center\">Download Suplex, then log in with your Suplex account. Want more? <a href=\"{}\">Start a 14-day Pro trial</a>.</p>",
                downloads(&forward),
                link("/start?plan=pro", &forward),
            ),
        )
    };
    crate::hosted::site::remember_visitor(
        &accounts,
        &headers,
        query.visitor.as_deref(),
        &mut response,
    );
    super::attribution::remember(
        &accounts.hosted.config.origin,
        &headers,
        uri.query(),
        &mut response,
    );
    response
}

fn trial_login(accounts: &Accounts, email_form: bool, forward: &str) -> Response {
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
                &downloads(forward),
            ),
        );
    };
    let content = if email_form {
        format!(
            "<form class=\"stack\" method=\"post\" action=\"{}\"><input type=\"hidden\" name=\"attempt\" value=\"{attempt}\"><input type=\"email\" name=\"email\" required autofocus autocomplete=\"email\" placeholder=\"Email address\" aria-label=\"Email address\"><button class=\"button primary\" type=\"submit\">Continue</button>{}</form>",
            link("/start/email", forward),
            cancel(forward),
        )
    } else {
        format!(
            "<div class=\"stack\"><p class=\"note center\">No credit card is necessary. Log in to start the trial.</p><a class=\"button primary\" href=\"{}\">Continue with Google</a><a class=\"button outline\" href=\"{}\">Continue with GitHub</a><a class=\"button outline\" href=\"{}\">Continue with email</a></div>{}",
            link(
                &format!("/auth/start?attempt={attempt}&provider=google"),
                forward
            ),
            link(
                &format!("/auth/start?attempt={attempt}&provider=github"),
                forward
            ),
            link("/start?plan=pro&with=email", forward),
            terms(forward),
        )
    };
    html(StatusCode::OK, "Start your Pro trial", &content)
}

#[derive(Deserialize)]
struct EmailForm {
    attempt: Option<String>,
    email: Option<String>,
}

async fn email(
    State(accounts): State<Accounts>,
    RawQuery(raw): RawQuery,
    Form(form): Form<EmailForm>,
) -> Response {
    let forward = forwarded(raw.as_deref());
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
                    "Suplex sent a login link to <strong>{}</strong>. Open it to start the trial.",
                    escape(body.email.trim())
                ),
                &format!(
                    "<a class=\"button outline\" href=\"{}\">Cancel</a>",
                    link("/start?plan=pro", &forward)
                ),
            ),
        ),
        Err(error) => html(
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
            "Suplex did not send the link",
            &message(
                "Suplex did not send the link",
                "The login attempt expired, or Suplex limits login emails. Retry later.",
                &retry(&forward),
            ),
        ),
    }
}

#[derive(Deserialize)]
struct DoneQuery {
    attempt: Option<String>,
}

/// The browser arrives here after the login. Repeating the request shows the
/// same trial. Its links keep the query of this request, or else the query
/// that `/start?plan=pro` kept.
async fn done(
    State(accounts): State<Accounts>,
    Query(query): Query<DoneQuery>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let forward = match forwarded(raw.as_deref()) {
        forward if forward.is_empty() => remembered_query(&headers),
        forward => forward,
    };
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
                &retry(&forward),
            ),
        );
    };
    let email = format!("<strong>{}</strong>", escape(&account.email));
    let hosted = &accounts.hosted;
    let plan = match hosted.billing_for_user(&account.id) {
        Ok(mut billing) => match hosted.start_trial(&mut billing).await {
            Err(error) if error.has_code("trial_used") => hosted.plan(&mut billing, false).await,
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
    html(
        StatusCode::OK,
        heading,
        &message(heading, &text, &downloads(&forward)),
    )
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
