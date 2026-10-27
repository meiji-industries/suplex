//! Product update emails. A linked host records each choice a person makes
//! with its wording, so suplex.sh can show who opted in and when.
//! `suplex hosted email-updates` prints the subscribed accounts as CSV.
//! Each choice also queues its Resend contact change (see `resend`).

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, header},
    routing::get,
};
use rusqlite::{Connection, OptionalExtension, params};

use super::{Accounts, resend};
use crate::{
    accounts::wire::{EmailUpdatesBody, EmailUpdatesState, token_shape},
    billing::hosted::{HostedError, HostedResult, server::JsonBody},
    shared::hash::sha256_hex,
};

pub fn router() -> Router<Accounts> {
    Router::new().route("/v1/account/email-updates", get(read).put(write))
}

/// The account that owns the bearer token.
fn account_id(accounts: &Accounts, headers: &HeaderMap) -> HostedResult<String> {
    let unauthorized = || HostedError::new(401, None, "Authentication required");
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| token_shape(token))
        .ok_or_else(unauthorized)?;
    let id: Option<String> = accounts.hosted.query(|db| {
        db.query_row(
            "SELECT account_id FROM account_tokens WHERE token_hash = ?1",
            [sha256_hex(token)],
            |row| row.get(0),
        )
        .optional()
    })?;
    id.ok_or_else(unauthorized)
}

fn subscribed(db: &Connection, account_id: &str) -> rusqlite::Result<bool> {
    Ok(db
        .query_row(
            "SELECT subscribed FROM account_email_updates WHERE account_id = ?1 ORDER BY id DESC LIMIT 1",
            [account_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false))
}

async fn read(
    State(accounts): State<Accounts>,
    headers: HeaderMap,
) -> HostedResult<Json<EmailUpdatesState>> {
    let id = account_id(&accounts, &headers)?;
    let subscribed = accounts.hosted.query(|db| subscribed(db, &id))?;
    Ok(Json(EmailUpdatesState { subscribed }))
}

async fn write(
    State(accounts): State<Accounts>,
    headers: HeaderMap,
    JsonBody(body): JsonBody,
) -> HostedResult<Json<EmailUpdatesState>> {
    let id = account_id(&accounts, &headers)?;
    let body: EmailUpdatesBody = serde_json::from_value(body)
        .ok()
        .filter(EmailUpdatesBody::valid)
        .ok_or_else(|| HostedError::new(400, None, "Invalid request"))?;
    let now = accounts.hosted.now_iso();
    accounts.hosted.immediate(|db| {
        resend::enqueue_choice(db, &id, body.subscribed, body.source, &now)?;
        db.execute(
            "INSERT INTO account_email_updates (account_id, subscribed, source, wording, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, body.subscribed, body.source.as_str(), body.wording.trim(), now],
        )
    })?;
    // The stored choice is the answer; Resend gets it now or on a later pass.
    let sync = accounts.clone();
    tokio::spawn(async move {
        if sync.sync_resend().await.is_err() {
            eprintln!("accounts: resend sync failed");
        }
    });
    Ok(Json(EmailUpdatesState {
        subscribed: body.subscribed,
    }))
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// Every account whose latest choice is subscribed: email, name, when they
/// subscribed, where, and the wording they saw.
pub fn export_csv(db: &Connection) -> rusqlite::Result<String> {
    let mut statement = db.prepare(
        "SELECT a.email, COALESCE(a.name, ''), u.created_at, u.source, u.wording
         FROM account_email_updates u JOIN accounts a ON a.id = u.account_id
         WHERE u.subscribed = 1
           AND u.id = (SELECT MAX(id) FROM account_email_updates WHERE account_id = u.account_id)
         ORDER BY u.created_at",
    )?;
    let mut csv = String::from("email,name,subscribed_at,source,wording\n");
    let rows = statement.query_map([], |row| {
        Ok([
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ])
    })?;
    for row in rows {
        let fields = row?;
        csv.push_str(
            &fields
                .iter()
                .map(|field| csv_field(field))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push('\n');
    }
    Ok(csv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{hosted::fakes::Fixture, wire::EmailUpdatesSource};

    const WORDING: &str = "Send me Suplex product updates and tips by email.";

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        headers
    }

    fn choice(subscribed: bool, source: EmailUpdatesSource) -> JsonBody {
        JsonBody(
            serde_json::to_value(EmailUpdatesBody {
                subscribed,
                source,
                wording: WORDING.to_owned(),
            })
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn the_latest_choice_counts_and_the_export_lists_only_subscribers() {
        let f = Fixture::new().await;
        let login = f.login("google").await;
        let headers = bearer(login["token"].as_str().unwrap());

        assert_eq!(
            read(State(f.accounts.clone()), HeaderMap::new())
                .await
                .unwrap_err()
                .status,
            401
        );
        assert!(
            !read(State(f.accounts.clone()), headers.clone())
                .await
                .unwrap()
                .0
                .subscribed
        );

        let saved = write(
            State(f.accounts.clone()),
            headers.clone(),
            choice(true, EmailUpdatesSource::Onboarding),
        )
        .await
        .unwrap();
        assert!(saved.0.subscribed);
        assert!(
            read(State(f.accounts.clone()), headers.clone())
                .await
                .unwrap()
                .0
                .subscribed
        );
        let csv = f.accounts.hosted.query(export_csv).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains(",onboarding,"));
        assert!(lines[1].ends_with(WORDING));

        let unsubscribed = write(
            State(f.accounts.clone()),
            headers.clone(),
            choice(false, EmailUpdatesSource::Settings),
        )
        .await
        .unwrap();
        assert!(!unsubscribed.0.subscribed);
        assert!(
            !read(State(f.accounts.clone()), headers.clone())
                .await
                .unwrap()
                .0
                .subscribed
        );
        let csv = f.accounts.hosted.query(export_csv).unwrap();
        assert_eq!(csv.lines().count(), 1);
        let history: i64 = f
            .accounts
            .hosted
            .query(|db| {
                db.query_row("SELECT COUNT(*) FROM account_email_updates", [], |row| {
                    row.get(0)
                })
            })
            .unwrap();
        assert_eq!(history, 2);
    }

    #[tokio::test]
    async fn empty_wording_is_refused() {
        let f = Fixture::new().await;
        let login = f.login("google").await;
        let body = JsonBody(
            serde_json::json!({ "subscribed": true, "source": "onboarding", "wording": " " }),
        );
        let error = write(
            State(f.accounts.clone()),
            bearer(login["token"].as_str().unwrap()),
            body,
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, 400);
    }

    #[test]
    fn csv_fields_with_commas_or_quotes_are_quoted() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a, b"), "\"a, b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    }
}
