#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::{
        accounts::hosted::{
            fakes::{Fixture, RESEND_WEBHOOK_SECRET, account_config},
            resend::{SUBSCRIBED_EVENT, UNSUBSCRIBE_LINK_WORDING, signing_key, webhook_signature},
            store::apply_schema,
        },
        billing::hosted::iso,
    };

    const CONTACT: &str = "/contacts/ada%40example.com";
    const WORDING: &str = "Send me Suplex product updates and tips by email.";
    const SECOND: i64 = 1000;

    async fn token(f: &Fixture) -> String {
        f.login("google").await["token"].as_str().unwrap().to_owned()
    }

    async fn choose(f: &Fixture, token: &str, subscribed: bool, source: &str) -> (u16, Value) {
        let response = reqwest::Client::new()
            .put(format!("{}/v1/account/email-updates", f.url))
            .bearer_auth(token)
            .json(&json!({"subscribed": subscribed, "source": source, "wording": WORDING}))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn subscribed(f: &Fixture, token: &str) -> bool {
        let response = reqwest::Client::new()
            .get(format!("{}/v1/account/email-updates", f.url))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        response.json::<Value>().await.unwrap()["subscribed"].as_bool().unwrap()
    }

    fn pending(f: &Fixture) -> i64 {
        f.count("SELECT COUNT(*) FROM account_resend_outbox WHERE sent_at IS NULL")
    }

    async fn webhook_with(f: &Fixture, body: &Value, seconds: i64, secret: &str) -> u16 {
        let body = body.to_string();
        let timestamp = seconds.to_string();
        let signature = webhook_signature(&signing_key(secret).unwrap(), "msg_1", &timestamp, body.as_bytes());
        reqwest::Client::new()
            .post(format!("{}/webhooks/resend", f.url))
            .header("content-type", "application/json")
            .header("svix-id", "msg_1")
            .header("svix-timestamp", &timestamp)
            .header("svix-signature", format!("v1,b3RoZXI= v1,{signature}"))
            .body(body)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    async fn webhook(f: &Fixture, body: &Value) -> u16 {
        webhook_with(f, body, f.accounts.hosted.now_ms() / SECOND, RESEND_WEBHOOK_SECRET).await
    }

    fn contact_updated(email: &str, unsubscribed: bool, updated_ms: i64) -> Value {
        json!({
            "type": "contact.updated",
            "created_at": iso(updated_ms),
            "data": {
                "id": "contact_1",
                "email": email,
                "first_name": "Ada",
                "unsubscribed": unsubscribed,
                "created_at": iso(updated_ms),
                "updated_at": iso(updated_ms),
            },
        })
    }

    #[tokio::test]
    async fn opting_in_creates_the_contact_and_sends_one_event() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        assert_eq!(
            choose(&f, &token, true, "onboarding").await,
            (200, json!({"subscribed": true}))
        );
        f.accounts.sync_resend().await.unwrap();

        let patch = &f.calls(CONTACT)[0];
        assert_eq!(patch.method, "PATCH");
        assert_eq!(patch.header("authorization"), Some("Bearer re_test"));
        assert_eq!(patch.json(), json!({"unsubscribed": false, "first_name": "Ada"}));
        // The stub has no such contact, so the subscribe creates it.
        let created = f.calls("/contacts");
        assert_eq!(created.len(), 1);
        assert_eq!(
            created[0].json(),
            json!({"email": "ada@example.com", "unsubscribed": false, "first_name": "Ada"})
        );
        let events = f.calls("/events/send");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].json(),
            json!({
                "event": SUBSCRIBED_EVENT,
                "email": "ada@example.com",
                "payload": {"source": "onboarding"},
            })
        );
        assert_eq!(pending(&f), 0);

        // Subscribing again is no new opt-in: the contact updates, no event.
        f.answer(&format!("PATCH {CONTACT}"), 200, json!({"id": "contact_1"}));
        assert_eq!(choose(&f, &token, true, "settings").await.0, 200);
        f.accounts.sync_resend().await.unwrap();
        assert_eq!(f.calls(CONTACT).len(), 2);
        assert_eq!(f.calls("/contacts").len(), 1);
        assert_eq!(f.calls("/events/send").len(), 1);
        assert_eq!(pending(&f), 0);
    }

    #[tokio::test]
    async fn opting_out_unsubscribes_the_contact_without_an_event() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        // A person who never opted in is not sent to Resend.
        assert_eq!(choose(&f, &token, false, "onboarding").await.0, 200);
        f.accounts.sync_resend().await.unwrap();
        assert!(f.calls(CONTACT).is_empty());
        assert_eq!(f.count("SELECT COUNT(*) FROM account_resend_outbox"), 0);

        choose(&f, &token, true, "onboarding").await;
        f.accounts.sync_resend().await.unwrap();
        assert_eq!(f.calls("/events/send").len(), 1);

        // The contact is gone in Resend: a 404 means it is already unsubscribed.
        assert_eq!(
            choose(&f, &token, false, "settings").await,
            (200, json!({"subscribed": false}))
        );
        f.accounts.sync_resend().await.unwrap();
        let patches = f.calls(CONTACT);
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[1].json(), json!({"unsubscribed": true, "first_name": "Ada"}));
        assert_eq!(f.calls("/contacts").len(), 1);
        assert_eq!(f.calls("/events/send").len(), 1);
        assert_eq!(pending(&f), 0);

        // Opting in again is a new opt-in.
        choose(&f, &token, true, "settings").await;
        f.accounts.sync_resend().await.unwrap();
        let events = f.calls("/events/send");
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].json()["payload"], json!({"source": "settings"}));
    }

    #[tokio::test]
    async fn a_resend_failure_keeps_the_choice_and_a_later_pass_sends_it() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        f.answer(&format!("PATCH {CONTACT}"), 503, "{}");
        assert_eq!(
            choose(&f, &token, true, "onboarding").await,
            (200, json!({"subscribed": true}))
        );
        f.accounts.sync_resend().await.unwrap();
        assert!(subscribed(&f, &token).await);
        // The event waits for the contact change before it.
        assert_eq!(pending(&f), 2);
        assert!(f.calls("/events/send").is_empty());
        let attempts = f.calls(CONTACT).len();
        assert!(attempts >= 1);
        assert_eq!(
            f.count("SELECT attempt_count FROM account_resend_outbox WHERE kind = 'contact'"),
            1
        );

        // Not due yet: the next pass sends nothing.
        f.accounts.sync_resend().await.unwrap();
        assert_eq!(f.calls(CONTACT).len(), attempts);

        f.answer(&format!("PATCH {CONTACT}"), 200, json!({"id": "contact_1"}));
        f.advance(31 * SECOND);
        f.accounts.sync_resend().await.unwrap();
        assert_eq!(f.calls(CONTACT).len(), attempts + 1);
        assert_eq!(f.calls("/events/send").len(), 1);
        assert_eq!(pending(&f), 0);
    }

    #[tokio::test]
    async fn deleting_the_account_deletes_the_contact_after_the_row_is_gone() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        choose(&f, &token, true, "onboarding").await;
        f.accounts.sync_resend().await.unwrap();

        f.answer(&format!("DELETE {CONTACT}"), 503, "{}");
        let html = f.get("/account/delete", &[]).await.text().await.unwrap();
        let start = html.find("attempt=").unwrap() + "attempt=".len();
        let attempt: String = html[start..].chars().take_while(|c| *c != '&').collect();
        f.sign_in(&attempt, "google", None).await;
        let deleted = f.post_form("/account/delete/confirm", &[("attempt", &attempt)]).await;
        assert_eq!(deleted.status(), 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM accounts"), 0);
        f.accounts.sync_resend().await.unwrap();
        assert_eq!(
            f.count("SELECT COUNT(*) FROM account_resend_outbox WHERE kind = 'delete' AND sent_at IS NULL"),
            1
        );

        f.answer(&format!("DELETE {CONTACT}"), 200, json!({"deleted": true}));
        f.advance(31 * SECOND);
        f.accounts.sync_resend().await.unwrap();
        assert_eq!(
            f.calls(CONTACT).iter().filter(|call| call.method == "DELETE").count(),
            2
        );
        // Nothing about the address stays.
        assert_eq!(f.count("SELECT COUNT(*) FROM account_resend_outbox"), 0);
    }

    #[tokio::test]
    async fn the_webhook_checks_the_svix_signature() {
        let f = Fixture::new().await;
        let now = f.accounts.hosted.now_ms();
        let event = json!({"type": "email.sent", "data": {}});
        assert_eq!(webhook(&f, &event).await, 200);

        let other = "whsec_b3RoZXIta2V5";
        assert_eq!(webhook_with(&f, &event, now / SECOND, other).await, 401);
        assert_eq!(
            webhook_with(&f, &event, now / SECOND - 301, RESEND_WEBHOOK_SECRET).await,
            401
        );
        assert_eq!(
            webhook_with(&f, &event, now / SECOND + 301, RESEND_WEBHOOK_SECRET).await,
            401
        );
        assert_eq!(
            webhook_with(&f, &event, now / SECOND - 299, RESEND_WEBHOOK_SECRET).await,
            200
        );
        let unsigned = reqwest::Client::new()
            .post(format!("{}/webhooks/resend", f.url))
            .header("content-type", "application/json")
            .body(event.to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(unsigned.status(), 401);
        // The signature covers the raw body.
        let body = event.to_string();
        let timestamp = (now / SECOND).to_string();
        let signature = webhook_signature(&signing_key(RESEND_WEBHOOK_SECRET).unwrap(), "msg_1", &timestamp, body.as_bytes());
        let changed = reqwest::Client::new()
            .post(format!("{}/webhooks/resend", f.url))
            .header("svix-id", "msg_1")
            .header("svix-timestamp", &timestamp)
            .header("svix-signature", format!("v1,{signature}"))
            .body(format!("{body} "))
            .send()
            .await
            .unwrap();
        assert_eq!(changed.status(), 401);

        let mut config = account_config();
        config.resend_webhook_secret = None;
        let without = Fixture::with(Some(config)).await;
        assert_eq!(webhook(&without, &event).await, 503);
    }

    #[tokio::test]
    async fn an_unsubscribe_link_records_an_email_choice() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        choose(&f, &token, true, "onboarding").await;
        f.accounts.sync_resend().await.unwrap();
        f.advance(60 * SECOND);
        let now = f.accounts.hosted.now_ms();

        // Unknown addresses and other events change nothing.
        assert_eq!(webhook(&f, &contact_updated("bo@example.com", true, now)).await, 200);
        let mut created = contact_updated("ada@example.com", true, now);
        created["type"] = "contact.created".into();
        assert_eq!(webhook(&f, &created).await, 200);
        assert!(subscribed(&f, &token).await);

        assert_eq!(webhook(&f, &contact_updated("ADA@Example.com", true, now)).await, 200);
        assert!(!subscribed(&f, &token).await);
        let (source, wording): (String, String) = f
            .accounts
            .hosted
            .query(|db| {
                db.query_row(
                    "SELECT source, wording FROM account_email_updates ORDER BY id DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!((source.as_str(), wording.as_str()), ("email", UNSUBSCRIBE_LINK_WORDING));
        // A repeat adds nothing, and nothing goes back to Resend.
        assert_eq!(webhook(&f, &contact_updated("ada@example.com", true, now)).await, 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM account_email_updates"), 2);
        assert_eq!(pending(&f), 0);
        f.accounts.sync_resend().await.unwrap();
        assert_eq!(f.calls(CONTACT).len(), 1);
    }

    #[tokio::test]
    async fn a_webhook_never_subscribes() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        let now = f.accounts.hosted.now_ms();
        assert_eq!(webhook(&f, &contact_updated("ada@example.com", false, now)).await, 200);
        assert!(!subscribed(&f, &token).await);

        choose(&f, &token, true, "onboarding").await;
        choose(&f, &token, false, "settings").await;
        f.accounts.sync_resend().await.unwrap();
        f.advance(60 * SECOND);
        let now = f.accounts.hosted.now_ms();
        assert_eq!(webhook(&f, &contact_updated("ada@example.com", false, now)).await, 200);
        assert!(!subscribed(&f, &token).await);
        assert_eq!(f.count("SELECT COUNT(*) FROM account_email_updates"), 2);
    }

    #[tokio::test]
    async fn an_unsubscribe_older_than_the_latest_choice_is_ignored() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        let before = f.accounts.hosted.now_ms();
        f.advance(60 * SECOND);
        choose(&f, &token, true, "settings").await;
        f.accounts.sync_resend().await.unwrap();
        f.advance(60 * SECOND);
        assert_eq!(webhook(&f, &contact_updated("ada@example.com", true, before)).await, 200);
        assert!(subscribed(&f, &token).await);
        assert_eq!(f.count("SELECT COUNT(*) FROM account_email_updates"), 1);
    }

    #[tokio::test]
    async fn the_echo_of_an_unsubscribe_from_suplex_is_ignored() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        choose(&f, &token, true, "settings").await;
        choose(&f, &token, false, "settings").await;
        f.accounts.sync_resend().await.unwrap();
        // The person opts in again while Resend is down, then Resend reports
        // the unsubscribe Suplex sent before.
        f.advance(60 * SECOND);
        f.answer(&format!("PATCH {CONTACT}"), 503, "{}");
        choose(&f, &token, true, "settings").await;
        f.accounts.sync_resend().await.unwrap();
        f.advance(SECOND);
        let now = f.accounts.hosted.now_ms();
        assert_eq!(webhook(&f, &contact_updated("ada@example.com", true, now)).await, 200);
        assert!(subscribed(&f, &token).await);
        assert_eq!(pending(&f), 2);
    }

    #[tokio::test]
    async fn hosts_cannot_send_the_email_source() {
        let f = Fixture::new().await;
        let token = token(&f).await;
        assert_eq!(choose(&f, &token, false, "email").await.0, 400);
        assert_eq!(f.count("SELECT COUNT(*) FROM account_email_updates"), 0);
    }

    #[test]
    fn an_old_database_accepts_the_email_source_and_keeps_its_rows() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE account_email_updates (
               id INTEGER PRIMARY KEY,
               account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
               subscribed INTEGER NOT NULL CHECK (subscribed IN (0, 1)),
               source TEXT NOT NULL CHECK (source IN ('onboarding', 'settings')),
               wording TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE INDEX account_email_updates_account ON account_email_updates (account_id, id);
             INSERT INTO accounts VALUES ('user_1', 'ada@example.com', 'Ada', 't', 't');
             INSERT INTO account_email_updates VALUES (3, 'user_1', 1, 'onboarding', 'Yes', 't1');
             INSERT INTO account_email_updates VALUES (7, 'user_1', 0, 'settings', 'No', 't2');",
        )
        .unwrap();
        assert!(
            db.execute(
                "INSERT INTO account_email_updates (account_id, subscribed, source, wording, created_at) VALUES ('user_1', 0, 'email', 'x', 't3')",
                [],
            )
            .is_err()
        );

        apply_schema(&db).unwrap();
        apply_schema(&db).unwrap();
        let rows: Vec<(i64, bool, String, String)> = db
            .prepare("SELECT id, subscribed, source, wording FROM account_email_updates ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            [
                (3, true, "onboarding".to_owned(), "Yes".to_owned()),
                (7, false, "settings".to_owned(), "No".to_owned()),
            ]
        );
        db.execute(
            "INSERT INTO account_email_updates (account_id, subscribed, source, wording, created_at) VALUES ('user_1', 0, 'email', 'x', 't3')",
            [],
        )
        .unwrap();
        assert!(
            db.execute(
                "INSERT INTO account_email_updates (account_id, subscribed, source, wording, created_at) VALUES ('user_1', 0, 'other', 'x', 't4')",
                [],
            )
            .is_err()
        );
        let index: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'account_email_updates_account' AND tbl_name = 'account_email_updates'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index, 1);
        // The account reference still cascades.
        db.execute("DELETE FROM accounts", []).unwrap();
        let left: i64 = db
            .query_row("SELECT COUNT(*) FROM account_email_updates", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
        assert!(
            !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'account_email_updates_old'")
                .unwrap()
                .exists([])
                .unwrap()
        );
    }
}
