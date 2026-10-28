use super::Accounts;
use crate::{
    accounts::wire::{CompanyInvitationBody, token_shape},
    billing::hosted::{HostedError, HostedResult, iso},
    shared::{hash::sha256_hex, page},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{OptionalExtension, params};

/// The invitation page from the "Suplex Team Invite" design. The wordmark and
/// Inter Tight come from the `/start` routes.
const INVITE_PAGE: &str = include_str!("invite.html");
const MONO_FONT: &[u8] = include_bytes!("../../../../web/fonts/GeistMono-Variable.woff2");

pub fn router() -> Router<Accounts> {
    Router::new()
        .route("/v1/company-invitations", post(send))
        .route("/invite/{id}", get(invitation_page))
}

/// Static assets for the invitation page. They are merged outside the
/// `private` layer so their cache header holds.
pub fn assets() -> Router<Accounts> {
    Router::new().route(
        "/invite/geist-mono.woff2",
        get(|| async {
            (
                [
                    (header::CONTENT_TYPE, "font/woff2"),
                    (header::CACHE_CONTROL, "public, max-age=86400"),
                ],
                MONO_FONT,
            )
        }),
    )
}

/// Up to two letters or digits from the company name, for the avatar.
fn initials(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let letters: String = match words.as_slice() {
        [first, second, ..] => first
            .chars()
            .filter(|c| c.is_alphanumeric())
            .take(1)
            .chain(second.chars().filter(|c| c.is_alphanumeric()).take(1))
            .collect(),
        _ => name
            .chars()
            .filter(|c| c.is_alphanumeric())
            .take(2)
            .collect(),
    };
    letters.to_uppercase()
}

async fn send(
    State(accounts): State<Accounts>,
    headers: HeaderMap,
    Json(body): Json<CompanyInvitationBody>,
) -> HostedResult<axum::http::StatusCode> {
    let config = accounts.config()?;
    if !body.valid() {
        return Err(HostedError::new(400, None, "Invalid invitation"));
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|t| token_shape(t))
        .ok_or_else(|| HostedError::new(401, None, "Authentication required"))?;
    let owner: Option<String> = accounts.hosted.query(|db| {
        db.query_row(
            "SELECT account_id FROM account_tokens WHERE token_hash = ?1",
            [sha256_hex(token)],
            |row| row.get(0),
        )
        .optional()
    })?;
    let owner = owner.ok_or_else(|| HostedError::new(401, None, "Authentication required"))?;
    let now = accounts.hosted.now_iso();
    let expires = iso(accounts.hosted.now_ms() + 7 * 24 * 60 * 60 * 1000);
    let digest = sha256_hex(&body.id);
    let stored = accounts.hosted.immediate(|db| {
        db.execute("INSERT OR IGNORE INTO company_invitations (id, owner_account_id, company_id, company_name, full_name, email, host_origin, created_at, expires_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE (SELECT COUNT(*) FROM company_invitations WHERE owner_account_id = ?2 AND created_at > ?10) < 50", params![digest, owner, body.company_id, body.company_name, body.full_name, body.email, body.host_origin, now, expires, iso(accounts.hosted.now_ms() - 60 * 60 * 1000)])?;
        db.query_row("SELECT owner_account_id, company_id, company_name, full_name, email, host_origin, sent_at FROM company_invitations WHERE id = ?1", [&digest], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?, row.get::<_,String>(4)?, row.get::<_,String>(5)?, row.get::<_,Option<String>>(6)?))).optional()
    })?.ok_or_else(|| HostedError::new(429, None, "Too many invitations. Try again in one hour"))?;
    if stored.0 != owner || stored.1 != body.company_id || stored.4 != body.email {
        return Err(HostedError::new(409, None, "Invitation does not match"));
    }
    if stored.6.is_some() {
        return Ok(axum::http::StatusCode::NO_CONTENT);
    }
    let subject = format!("Join {} on Suplex", stored.2);
    let email = super::providers::template_email(
        config,
        &stored.4,
        &subject,
        &[
            ("HEADING", &subject),
            (
                "BODY",
                &format!(
                    "Hi {}, you have been invited to {} on Suplex.",
                    stored.3, stored.2
                ),
            ),
            ("ACTION_LABEL", "Open invitation"),
            (
                "ACTION_URL",
                &format!("{}/invite/{}", accounts.hosted.config.origin, body.id),
            ),
            (
                "NOTE",
                &format!(
                    "Download Suplex, then open the company and log in with {}. Connect over Tailscale or the same local network as the company's host. The host must be online. This invitation expires in 7 days. If you did not expect it, you can ignore this email.",
                    stored.4
                ),
            ),
        ],
    );
    let response = accounts
        .http
        .post(format!("{}/emails", accounts.endpoints.resend))
        .bearer_auth(&config.resend_api_key)
        .header("Idempotency-Key", format!("company-invitation/{digest}"))
        .json(&email)
        .send()
        .await
        .map_err(|_| {
            HostedError::new(
                503,
                Some("email_unavailable"),
                "Suplex cannot send email now",
            )
        })?;
    if !response.status().is_success() {
        return Err(HostedError::new(
            503,
            Some("email_unavailable"),
            "Suplex cannot send email now",
        ));
    }
    accounts.hosted.query(|db| {
        db.execute(
            "UPDATE company_invitations SET sent_at = ?2 WHERE id = ?1",
            params![digest, now],
        )
    })?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn invitation_page(State(accounts): State<Accounts>, Path(id): Path<String>) -> Response {
    match invitation(&accounts, &id) {
        Ok(html) => Html(html).into_response(),
        Err(error) => {
            let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::NOT_FOUND);
            let message = if status.is_server_error() {
                "<p>Suplex cannot open the invitation now. Retry later.</p>"
            } else {
                "<p>The invitation expired or does not exist. Ask the company owner to send a new invitation.</p>"
            };
            (
                status,
                Html(page::render("Invitation is not available", message)),
            )
                .into_response()
        }
    }
}

fn invitation(accounts: &Accounts, id: &str) -> HostedResult<String> {
    if !token_shape(id) {
        return Err(HostedError::new(404, None, "Invitation not found"));
    }
    let row = accounts.hosted.query(|db| db.query_row("SELECT company_name, host_origin, company_id FROM company_invitations WHERE id = ?1 AND expires_at > ?2 AND sent_at IS NOT NULL", params![sha256_hex(id), accounts.hosted.now_iso()], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).optional())?.ok_or_else(|| HostedError::new(404, None, "The invitation expired"))?;
    let mut target = url::Url::parse(&row.1).map_err(|_| HostedError::internal())?;
    target.query_pairs_mut().append_pair("company", &row.2);
    let mut deep = url::Url::parse("suplex://join").map_err(|_| HostedError::internal())?;
    deep.query_pairs_mut().append_pair("url", target.as_str());
    Ok(INVITE_PAGE
        .replace("{company}", &escape(&row.0))
        .replace("{initials}", &escape(&initials(&row.0)))
        .replace("{open_url}", &escape(deep.as_str()))
        .replace("{browser_url}", &escape(target.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{hosted::fakes::Fixture, wire::random_token};

    #[test]
    fn initials_use_two_words_or_the_first_two_characters() {
        assert_eq!(initials("Pedro Inc"), "PI");
        assert_eq!(initials("Test <Company>"), "TC");
        assert_eq!(initials("suplex"), "SU");
        assert_eq!(initials("  "), "");
    }

    #[tokio::test]
    async fn invitation_email_retries_once_and_landing_does_not_accept() {
        let f = Fixture::new().await;
        let login = f.login("google").await;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", login["token"].as_str().unwrap())
                .parse()
                .unwrap(),
        );
        let body = CompanyInvitationBody {
            id: random_token().unwrap(),
            company_id: "company_one".into(),
            company_name: "Test <Company>".into(),
            full_name: "New Member".into(),
            email: "member@example.com".into(),
            host_origin: "https://host.example.test".into(),
        };
        assert_eq!(
            send(
                State(f.accounts.clone()),
                HeaderMap::new(),
                Json(body.clone())
            )
            .await
            .unwrap_err()
            .status,
            401
        );
        f.answer("POST /emails", 503, "{}");
        assert_eq!(
            send(
                State(f.accounts.clone()),
                headers.clone(),
                Json(body.clone())
            )
            .await
            .unwrap_err()
            .status,
            503
        );
        assert_eq!(
            f.get(&format!("/invite/{}", body.id), &[]).await.status(),
            404
        );
        f.answer("POST /emails", 200, "{\"id\":\"email-1\"}");
        assert_eq!(
            send(
                State(f.accounts.clone()),
                headers.clone(),
                Json(body.clone())
            )
            .await
            .unwrap(),
            204
        );
        assert_eq!(
            send(
                State(f.accounts.clone()),
                headers.clone(),
                Json(body.clone())
            )
            .await
            .unwrap(),
            204
        );
        assert_eq!(
            f.calls("/emails").len(),
            2,
            "successful delivery is not repeated"
        );
        let calls = f.calls("/emails");
        assert_eq!(
            calls[0].header("idempotency-key"),
            calls[1].header("idempotency-key")
        );
        let sent = calls[0].json();
        assert_eq!(sent["template"]["id"], "suplex-base");
        // Resend inserts variables into the HTML unescaped.
        assert_eq!(
            sent["template"]["variables"]["HEADING"],
            "Join Test &lt;Company&gt; on Suplex"
        );
        assert_eq!(sent["subject"], "Join Test <Company> on Suplex");
        assert_eq!(
            sent["template"]["variables"]["ACTION_URL"],
            format!("{}/invite/{}", f.accounts.hosted.config.origin, body.id)
        );
        let page = f.get(&format!("/invite/{}", body.id), &[]).await;
        assert_eq!(page.status(), 200);
        assert_eq!(page.headers()["cache-control"], "no-store");
        let html = page.text().await.unwrap();
        assert!(html.contains("Test &lt;Company&gt;"));
        assert!(html.contains("suplex://join?url="));
        assert!(html.contains("company=company_one"));
        assert!(html.contains("<span class=\"avatar\" aria-hidden=\"true\">TC</span>"));
        assert!(!html.contains("{company}") && !html.contains("{open_url}"));
        let font = f.get("/invite/geist-mono.woff2", &[]).await;
        assert_eq!(font.status(), 200);
        assert_eq!(font.headers()["cache-control"], "public, max-age=86400");
        assert_eq!(
            f.count(
                "SELECT COUNT(*) FROM company_invitations WHERE accepted_account_id IS NOT NULL"
            ),
            0
        );
        let mut changed = body.clone();
        changed.email = "other@example.com".into();
        assert_eq!(
            send(State(f.accounts.clone()), headers, Json(changed))
                .await
                .unwrap_err()
                .status,
            409
        );
        f.advance(8 * 24 * 60 * 60 * 1000);
        assert_eq!(
            f.get(&format!("/invite/{}", body.id), &[]).await.status(),
            404
        );
    }
}
