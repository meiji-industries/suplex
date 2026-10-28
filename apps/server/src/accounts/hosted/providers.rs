//! Google and GitHub OAuth, and Resend email. Failures never echo provider
//! bodies; only the provider name and HTTP status reach the log.

use serde::Deserialize;
use serde_json::json;
use url::Url;

use super::AccountConfig;
use crate::{accounts::wire::AuthProvider, billing::hosted::HostedError};

/// Provider base URLs. Tests point them at loopback stubs.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub google_accounts: String,
    pub google_oauth: String,
    pub google_openid: String,
    pub github: String,
    pub github_api: String,
    pub resend: String,
    pub downloads: String,
}

impl Endpoints {
    pub fn production() -> Self {
        Self {
            google_accounts: "https://accounts.google.com".into(),
            google_oauth: "https://oauth2.googleapis.com".into(),
            google_openid: "https://openidconnect.googleapis.com".into(),
            github: "https://github.com".into(),
            github_api: "https://api.github.com".into(),
            resend: "https://api.resend.com".into(),
            downloads: "https://downloads.meiji.industries".into(),
        }
    }
}

/// A verified email address and an optional display name.
pub struct Profile {
    pub email: String,
    pub name: Option<String>,
}

pub fn unverified() -> HostedError {
    HostedError::new(
        403,
        Some("email_unverified"),
        "The provider did not verify an email address",
    )
}

fn failed(provider: &str, status: Option<reqwest::StatusCode>) -> HostedError {
    match status {
        Some(status) => eprintln!("accounts: {provider} error {}", status.as_u16()),
        None => eprintln!("accounts: {provider} error"),
    }
    HostedError::new(
        502,
        Some("provider_unavailable"),
        "The sign-in provider cannot be reached",
    )
}

async fn read<T: for<'de> Deserialize<'de>>(
    provider: &str,
    request: reqwest::RequestBuilder,
) -> Result<T, HostedError> {
    let response = request.send().await.map_err(|_| failed(provider, None))?;
    let status = response.status();
    if !status.is_success() {
        return Err(failed(provider, Some(status)));
    }
    response
        .json()
        .await
        .map_err(|_| failed(provider, Some(status)))
}

pub fn authorize_url(
    endpoints: &Endpoints,
    config: &AccountConfig,
    provider: AuthProvider,
    redirect_uri: &str,
    state: &str,
) -> Result<String, HostedError> {
    let (base, pairs) = match provider {
        AuthProvider::Google => (
            format!("{}/o/oauth2/v2/auth", endpoints.google_accounts),
            vec![
                ("client_id", config.google_client_id.as_str()),
                ("response_type", "code"),
                ("scope", "openid email profile"),
                ("prompt", "select_account"),
            ],
        ),
        AuthProvider::Github => (
            format!("{}/login/oauth/authorize", endpoints.github),
            vec![
                ("client_id", config.github_client_id.as_str()),
                ("scope", "read:user user:email"),
                ("allow_signup", "true"),
            ],
        ),
        AuthProvider::Email => return Err(HostedError::new(400, None, "Invalid provider")),
    };
    let pairs = pairs
        .into_iter()
        .chain([("redirect_uri", redirect_uri), ("state", state)]);
    Url::parse_with_params(&base, pairs)
        .map(String::from)
        .map_err(|_| HostedError::internal())
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
}

/// Exchanges an authorization code for the account's verified email.
pub async fn profile(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    config: &AccountConfig,
    provider: AuthProvider,
    code: &str,
    redirect_uri: &str,
) -> Result<Profile, HostedError> {
    match provider {
        AuthProvider::Google => google(http, endpoints, config, code, redirect_uri).await,
        AuthProvider::Github => github(http, endpoints, config, code, redirect_uri).await,
        AuthProvider::Email => Err(HostedError::new(400, None, "Invalid provider")),
    }
}

async fn google(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    config: &AccountConfig,
    code: &str,
    redirect_uri: &str,
) -> Result<Profile, HostedError> {
    #[derive(Deserialize)]
    struct UserInfo {
        email: Option<String>,
        #[serde(default)]
        email_verified: bool,
        name: Option<String>,
    }
    let token: Token = read(
        "google",
        http.post(format!("{}/token", endpoints.google_oauth))
            .form(&[
                ("code", code),
                ("client_id", &config.google_client_id),
                ("client_secret", &config.google_client_secret),
                ("redirect_uri", redirect_uri),
                ("grant_type", "authorization_code"),
            ]),
    )
    .await?;
    let user: UserInfo = read(
        "google",
        http.get(format!("{}/v1/userinfo", endpoints.google_openid))
            .bearer_auth(&token.access_token),
    )
    .await?;
    match user.email {
        Some(email) if user.email_verified => Ok(Profile {
            email,
            name: user.name,
        }),
        _ => Err(unverified()),
    }
}

async fn github(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    config: &AccountConfig,
    code: &str,
    redirect_uri: &str,
) -> Result<Profile, HostedError> {
    #[derive(Deserialize)]
    struct User {
        name: Option<String>,
        login: Option<String>,
    }
    #[derive(Deserialize)]
    struct Email {
        email: String,
        #[serde(default)]
        primary: bool,
        #[serde(default)]
        verified: bool,
    }
    // GitHub answers a bad code with 200 and an `error` body; Token then
    // fails to parse and the attempt fails.
    let token: Token = read(
        "github",
        http.post(format!("{}/login/oauth/access_token", endpoints.github))
            .header("accept", "application/json")
            .form(&[
                ("client_id", config.github_client_id.as_str()),
                ("client_secret", &config.github_client_secret),
                ("code", code),
                ("redirect_uri", redirect_uri),
            ]),
    )
    .await?;
    let api = |path: &str| {
        http.get(format!("{}{path}", endpoints.github_api))
            .bearer_auth(&token.access_token)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "suplex-hosted")
            .header("x-github-api-version", "2022-11-28")
    };
    let user: User = read("github", api("/user")).await?;
    let emails: Vec<Email> = read("github", api("/user/emails")).await?;
    let email = emails
        .iter()
        .find(|email| email.primary && email.verified)
        .or_else(|| emails.iter().find(|email| email.verified))
        .ok_or_else(unverified)?;
    Ok(Profile {
        email: email.email.clone(),
        name: user.name.or(user.login),
    })
}

/// Sign-in and invitation emails render through this published Resend
/// template. It takes `HEADING`, `BODY`, `ACTION_LABEL`, `ACTION_URL`, and
/// `NOTE`; edit its design and plain text version in the Resend dashboard.
pub const EMAIL_TEMPLATE: &str = "suplex-base";

/// The Resend `/emails` body for one email through a published `template`.
///
/// Resend inserts each value into the template HTML unchanged, inside
/// attributes too, so this escapes every value. Resend also puts the same
/// value in the plain text version, where an escaped `&`, `<`, `>`, or `"`
/// shows as its entity. `'` stays unescaped: the template quotes attributes
/// with `"`, and names such as O'Brien are common.
pub fn template_email(
    config: &AccountConfig,
    template: &str,
    to: &str,
    subject: &str,
    variables: &[(&str, &str)],
) -> serde_json::Value {
    let variables: serde_json::Map<String, serde_json::Value> = variables
        .iter()
        .map(|(key, value)| {
            let value = value
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;");
            (key.to_string(), value.into())
        })
        .collect();
    json!({
        "from": config.email_from,
        "to": [to],
        "subject": subject,
        "template": { "id": template, "variables": variables },
    })
}

/// Sends the magic link. Any failure is `email_unavailable`.
pub async fn send_magic_link(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    config: &AccountConfig,
    email: &str,
    link: &str,
) -> Result<(), HostedError> {
    let response = http
        .post(format!("{}/emails", endpoints.resend))
        .bearer_auth(&config.resend_api_key)
        .json(&template_email(
            config,
            EMAIL_TEMPLATE,
            email,
            "Sign in to Suplex",
            &[
                ("HEADING", "Sign in to Suplex"),
                ("BODY", "Open this link to sign in to Suplex."),
                ("ACTION_LABEL", "Sign in"),
                ("ACTION_URL", link),
                ("NOTE", "The link expires in 15 minutes. If you did not request it, you can ignore this email."),
            ],
        ))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => Ok(()),
        response => {
            match response {
                Ok(response) => eprintln!("accounts: resend error {}", response.status().as_u16()),
                Err(_) => eprintln!("accounts: resend error"),
            }
            Err(HostedError::new(
                503,
                Some("email_unavailable"),
                "Suplex cannot send email now",
            ))
        }
    }
}
