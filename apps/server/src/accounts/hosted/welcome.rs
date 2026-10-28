//! The welcome email. An account that signs up without a company invitation
//! is queued in `account_welcome_emails` in the signup transaction. The Resend
//! pass (`sync_resend`) sends it once and retries a failure with backoff.
//! An invited member gets the invitation email instead.

use rusqlite::{Connection, params};

use super::{AccountConfig, Accounts, providers::template_email};
use crate::billing::hosted::{HostedResult, backoff_at};

/// The published Resend template. It takes `NAME`, with the fallback "there".
const TEMPLATE: &str = "suplex-welcome";
const BATCH: i64 = 100;

/// Queues the welcome for an account that was just created.
pub fn enqueue(db: &Connection, account_id: &str, email: &str, now: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO account_welcome_emails (account_id, created_at) SELECT ?1, ?3 WHERE NOT EXISTS (SELECT 1 FROM company_invitations WHERE email = ?2 COLLATE NOCASE)",
        params![account_id, email, now],
    )?;
    Ok(())
}

struct Due {
    account_id: String,
    email: String,
    name: Option<String>,
    attempt_count: i64,
}

fn due(db: &Connection, now: &str) -> rusqlite::Result<Vec<Due>> {
    db.prepare(
        "SELECT w.account_id, a.email, a.name, w.attempt_count FROM account_welcome_emails w JOIN accounts a ON a.id = w.account_id
         WHERE w.sent_at IS NULL AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= ?1) ORDER BY w.created_at LIMIT ?2",
    )?
    .query_map(params![now, BATCH], |row| {
        Ok(Due {
            account_id: row.get(0)?,
            email: row.get(1)?,
            name: row.get(2)?,
            attempt_count: row.get(3)?,
        })
    })?
    .collect()
}

impl Accounts {
    /// Sends the due welcome emails. Only `sync_resend` calls it, under its lock.
    pub(super) async fn send_welcomes(&self, config: &AccountConfig) -> HostedResult<()> {
        let now = self.hosted.now_iso();
        for row in self.hosted.query(|db| due(db, &now))? {
            let first_name = row
                .name
                .as_deref()
                .and_then(|name| name.split_whitespace().next());
            let variables: Vec<(&str, &str)> =
                first_name.map(|name| ("NAME", name)).into_iter().collect();
            let status = self
                .http
                .post(format!("{}/emails", self.endpoints.resend))
                .bearer_auth(&config.resend_api_key)
                .header("Idempotency-Key", format!("welcome/{}", row.account_id))
                .json(&template_email(
                    config,
                    TEMPLATE,
                    &row.email,
                    "Welcome to Suplex",
                    &variables,
                ))
                .send()
                .await
                .map(|response| response.status());
            if status.as_ref().is_ok_and(reqwest::StatusCode::is_success) {
                let sent = self.hosted.now_iso();
                self.hosted.query(|db| {
                    db.execute(
                        "UPDATE account_welcome_emails SET sent_at = ?2 WHERE account_id = ?1",
                        params![row.account_id, sent],
                    )
                })?;
            } else {
                eprintln!(
                    "accounts: resend welcome error {}",
                    status.map_or("unreachable".to_owned(), |status| status
                        .as_u16()
                        .to_string())
                );
                let retry = backoff_at(row.attempt_count, self.hosted.now_ms());
                self.hosted.query(|db| {
                    db.execute(
                        "UPDATE account_welcome_emails SET attempt_count = attempt_count + 1, next_attempt_at = ?2 WHERE account_id = ?1",
                        params![row.account_id, retry],
                    )
                })?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::accounts::hosted::fakes::Fixture;

    #[tokio::test]
    async fn a_new_account_gets_one_welcome_and_an_invited_one_gets_none() {
        let f = Fixture::new().await;
        f.login("google").await;
        f.accounts
            .hosted
            .query(|db| {
                db.execute("UPDATE accounts SET name = 'Ada <Lovelace>'", [])?;
                db.execute("INSERT INTO company_invitations (id, owner_account_id, company_id, company_name, full_name, email, host_origin, created_at, expires_at) SELECT 'digest', id, 'company_one', 'One', 'Invited', 'Invited@Example.com', 'https://host.example.test', created_at, created_at FROM accounts", [])?;
                db.execute("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('user_invited', 'invited@example.com', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z')", [])?;
                super::enqueue(db, "user_invited", "invited@example.com", "2026-10-28T00:00:00.000Z")
            })
            .unwrap();
        let queued: i64 = f
            .accounts
            .hosted
            .query(|db| {
                db.query_row("SELECT COUNT(*) FROM account_welcome_emails", [], |row| {
                    row.get(0)
                })
            })
            .unwrap();
        assert_eq!(
            queued, 1,
            "the signup is queued and the invited member is not"
        );
        f.answer("POST /emails", 503, "{}");
        f.accounts.sync_resend().await.unwrap();
        f.accounts.sync_resend().await.unwrap();
        assert_eq!(
            f.calls("/emails").len(),
            1,
            "a failed welcome waits for its backoff"
        );
        f.accounts
            .hosted
            .query(|db| {
                db.execute(
                    "UPDATE account_welcome_emails SET next_attempt_at = NULL",
                    [],
                )
            })
            .unwrap();
        f.answer("POST /emails", 200, "{\"id\":\"email-1\"}");
        f.accounts.sync_resend().await.unwrap();
        f.accounts.sync_resend().await.unwrap();
        let calls = f.calls("/emails");
        assert_eq!(calls.len(), 2, "a sent welcome is not repeated");
        let sent = calls[1].json();
        assert_eq!(sent["template"]["id"], "suplex-welcome");
        assert_eq!(sent["template"]["variables"]["NAME"], "Ada");
        assert_eq!(sent["subject"], "Welcome to Suplex");
        assert_eq!(
            calls[0].header("idempotency-key"),
            calls[1].header("idempotency-key")
        );
    }
}
