#[cfg(test)]
mod tests {
    use axum::http::Method;
    use serde_json::{Value, json};

    use super::*;
    use crate::{
        accounts::hosted::{attribution::Attribution, store as account_store},
        billing::hosted::fakes::{Fixture, ORIGIN},
        shared::hash::sha256_hex,
    };

    const EMAIL: &str = "ada@example.com";
    const GCLID: &str = "Cj0K-example_click.1";

    /// The two arguments of the conversion script, or `None` without one.
    fn arguments(html: &str) -> Option<Value> {
        let script = &html[html.find("(function (event, emailHash)")?..];
        let rest = &script[script.find("})(")? + 3..];
        let end = rest.find(");\n</script>")?;
        Some(serde_json::from_str(&format!("[{}]", &rest[..end])).unwrap())
    }

    /// The event the conversion script pushes.
    fn pushed(html: &str) -> Option<Value> {
        arguments(html).map(|args| args[0].clone())
    }

    /// The email hash argument of the conversion script.
    fn hash_argument(html: &str) -> Value {
        arguments(html).unwrap()[1].clone()
    }

    async fn page(f: &Fixture, path: &str, headers: &[(&str, &str)]) -> String {
        let response = f.send(Method::GET, path, headers, None).await;
        assert_eq!(response.status(), 200);
        let html = response.text().await.unwrap();
        assert!(html.contains("<h1>Checkout is complete</h1>"));
        assert!(html.contains("Return to Suplex. The subscription can take a few seconds to show."));
        html
    }

    /// A completed checkout of `quantity` Pro seats. Returns the session id
    /// and the billing account's registration id.
    async fn paid_checkout(f: &Fixture, quantity: i64) -> (String, String) {
        let account = f.register().await;
        let (status, body) = f
            .post(
                "/v1/checkout",
                Some(&account.credential),
                Some("key-conversion-1"),
                &json!({"quantity": quantity}),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        let session = f.stripe.with(|stripe| {
            let session = stripe.sessions[0].clone();
            assert_eq!(
                session.success_url,
                format!("{ORIGIN}/checkout/return?session_id={{CHECKOUT_SESSION_ID}}")
            );
            stripe.complete_checkout_session(&session.id);
            session.id
        });
        let registration = f.sql(|db| {
            db.query_row(
                "SELECT registration_id FROM billing_accounts WHERE id = ?1",
                [&account.id],
                |row| row.get::<_, String>(0),
            )
        });
        (session, registration)
    }

    /// A Suplex account for the billing account, with optional attribution.
    fn link_account(f: &Fixture, registration: &str, attribution: Option<&str>) {
        f.sql(|db| {
            db.execute(
                "INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?1, ?2, 'now', 'now')",
                [registration, EMAIL],
            )?;
            if let Some(raw) = attribution {
                account_store::insert_account_attribution(
                    db,
                    registration,
                    &Attribution::decode(raw),
                    "now",
                )?;
            }
            Ok(())
        });
    }

    #[tokio::test]
    async fn a_confirmed_checkout_pushes_subscribe_once_with_the_stored_gclid() {
        let f = Fixture::new().await;
        let (session, registration) = paid_checkout(&f, 3).await;
        link_account(&f, &registration, Some(&format!("utm_source=ads&gclid={GCLID}")));
        let path = format!("/checkout/return?session_id={session}");

        let html = page(&f, &path, &[]).await;
        assert_eq!(
            pushed(&html).unwrap(),
            json!({
                "event": "subscribe",
                "value": 60,
                "currency": "USD",
                "transaction_id": session,
                "plan": "pro",
                "gclid": GCLID,
            })
        );
        // Only the hash reaches the page, as the script argument; never the email.
        assert_eq!(hash_argument(&html), json!(sha256_hex(EMAIL)));
        assert!(!html.contains(EMAIL));
        assert!(!html.contains("utm_source"));

        // A reload, or a second request with the same session, pushes nothing.
        let again = page(&f, &path, &[]).await;
        assert_eq!(pushed(&again), None);
        assert!(!again.contains("(function (event, emailHash)"));
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_checkout_conversions"), 1);
    }

    #[tokio::test]
    async fn without_a_stored_gclid_the_key_is_absent() {
        let f = Fixture::new().await;
        let (session, registration) = paid_checkout(&f, 1).await;
        link_account(&f, &registration, Some("utm_source=ads"));
        let html = page(&f, &format!("/checkout/return?session_id={session}"), &[]).await;
        let event = pushed(&html).unwrap();
        assert_eq!(event["value"], json!(20));
        assert!(event.get("gclid").is_none(), "{event}");
        assert!(event.get("user_data").is_none(), "{event}");
    }

    #[tokio::test]
    async fn without_a_suplex_account_the_cookie_gclid_is_used_and_there_is_no_hash() {
        let f = Fixture::new().await;
        let (session, _) = paid_checkout(&f, 1).await;
        let cookie = format!("suplex_attribution=gclid={GCLID}");
        let html = page(
            &f,
            &format!("/checkout/return?session_id={session}"),
            &[("cookie", &cookie)],
        )
        .await;
        assert_eq!(pushed(&html).unwrap()["gclid"], json!(GCLID));
        assert_eq!(hash_argument(&html), Value::Null);
    }

    /// The Google click IDs of the event pushed for a checkout of an account
    /// with `kept` attribution and a browser with the `cookie` attribution.
    async fn pushed_click_ids(kept: Option<&str>, cookie: Option<&str>) -> Value {
        let f = Fixture::new().await;
        let (session, registration) = paid_checkout(&f, 1).await;
        link_account(&f, &registration, kept);
        let header = cookie.map(|raw| format!("suplex_attribution={raw}"));
        let headers: Vec<(&str, &str)> = header.iter().map(|h| ("cookie", h.as_str())).collect();
        let html = page(&f, &format!("/checkout/return?session_id={session}"), &headers).await;
        let event = pushed(&html).unwrap();
        assert_eq!(event["event"], json!("subscribe"));
        let ids: serde_json::Map<String, Value> = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid"]
            .into_iter()
            .filter_map(|key| event.get(key).map(|value| (key.to_owned(), value.clone())))
            .collect();
        Value::Object(ids)
    }

    #[tokio::test]
    async fn the_event_carries_only_the_google_click_ids_that_were_captured() {
        assert_eq!(
            pushed_click_ids(Some("utm_source=ads&gbraid=gb-1"), None).await,
            json!({"gbraid": "gb-1"})
        );
        assert_eq!(
            pushed_click_ids(Some("wbraid=wb-1"), None).await,
            json!({"wbraid": "wb-1"})
        );
        assert_eq!(
            pushed_click_ids(
                Some(&format!("gclid={GCLID}&gbraid=gb-1&wbraid=wb-1&msclkid=ms.1&fbclid=fb_1")),
                None
            )
            .await,
            json!({"gclid": GCLID, "gbraid": "gb-1", "wbraid": "wb-1"})
        );
        assert_eq!(
            pushed_click_ids(Some("utm_source=ads&msclkid=ms.1&fbclid=fb_1"), None).await,
            json!({})
        );
        // Without kept attribution, the cookie supplies them.
        assert_eq!(
            pushed_click_ids(None, Some("gbraid=gb-2&wbraid=wb-2")).await,
            json!({"gbraid": "gb-2", "wbraid": "wb-2"})
        );
    }

    #[tokio::test]
    async fn click_ids_never_mix_the_account_and_the_cookie() {
        // The account has a Google click ID: the cookie adds nothing.
        assert_eq!(
            pushed_click_ids(Some("gbraid=gb-kept"), Some(&format!("gclid={GCLID}&wbraid=wb-2"))).await,
            json!({"gbraid": "gb-kept"})
        );
        // The account has none: every ID comes from the cookie.
        assert_eq!(
            pushed_click_ids(Some("utm_source=ads&fbclid=fb_1"), Some("wbraid=wb-2")).await,
            json!({"wbraid": "wb-2"})
        );
    }

    #[test]
    fn google_click_ids_take_one_source_and_skip_empty_values() {
        let kept = Attribution::decode("gclid=&gbraid=gb-1&msclkid=ms.1");
        let cookie = Attribution::decode("gclid=c-1&wbraid=wb-1");
        let owned = |pairs: &[(&'static str, &str)]| {
            pairs
                .iter()
                .map(|(key, value)| (*key, (*value).to_owned()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            google_click_ids(Some(&kept), Some(&cookie)),
            owned(&[("gbraid", "gb-1")])
        );
        let campaign_only = Attribution::decode("utm_source=ads&gclid=&fbclid=fb_1");
        assert_eq!(
            google_click_ids(Some(&campaign_only), Some(&cookie)),
            owned(&[("gclid", "c-1"), ("wbraid", "wb-1")])
        );
        assert_eq!(google_click_ids(None, Some(&cookie)), owned(&[("gclid", "c-1"), ("wbraid", "wb-1")]));
        assert_eq!(google_click_ids(Some(&campaign_only), None), owned(&[]));
        assert_eq!(google_click_ids(None, None), owned(&[]));
    }

    #[tokio::test]
    async fn missing_invalid_unpaid_or_unreadable_sessions_render_the_static_page() {
        let f = Fixture::new().await;
        let account = f.register().await;
        let (status, _) = f
            .post(
                "/v1/checkout",
                Some(&account.credential),
                Some("key-conversion-2"),
                &json!({"quantity": 1}),
            )
            .await;
        assert_eq!(status, 200);
        let open = f.stripe.with(|stripe| stripe.sessions[0].id.clone());
        for path in [
            "/checkout/return".to_owned(),
            "/checkout/return?session_id=".to_owned(),
            "/checkout/return?session_id=%3C%2Fscript%3E".to_owned(),
            "/checkout/return?session_id=cs_unknown_1".to_owned(),
            format!("/checkout/return?session_id={open}"),
        ] {
            let html = page(&f, &path, &[]).await;
            assert!(!html.contains("(function (event, emailHash)"), "{path}");
        }
        // Stripe unavailable: the same page and no record, so a later read still reports it.
        f.stripe.with(|stripe| stripe.complete_checkout_session(&open));
        f.stripe.with(|stripe| stripe.fail_reads = true);
        let path = format!("/checkout/return?session_id={open}");
        assert!(!page(&f, &path, &[]).await.contains("(function (event, emailHash)"));
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_checkout_conversions"), 0);
        f.stripe.with(|stripe| stripe.fail_reads = false);
        assert!(pushed(&page(&f, &path, &[]).await).is_some());
    }

    #[test]
    fn values_are_major_units_of_the_currency() {
        assert_eq!(major_units(2000, "usd"), json!(20));
        assert_eq!(major_units(1999, "usd"), json!(19.99));
        assert_eq!(major_units(2000, "jpy"), json!(2000));
        assert_eq!(major_units(5000, "kwd"), json!(5));
        assert_eq!(major_units(0, "eur"), json!(0));
    }

    #[test]
    fn only_stripe_checkout_session_ids_are_read() {
        assert!(valid_session_id("cs_test_a1B2c3"));
        for id in ["", "cs_", "sub_1", "cs_a-b", "cs_a/b", "cs_<x>", &format!("cs_{}", "a".repeat(253))] {
            assert!(!valid_session_id(id), "{id}");
        }
    }

    #[test]
    fn server_values_cannot_break_out_of_the_script() {
        let script = crate::shared::page::conversion_script(
            &json!({"event": "x", "gclid": "</script><script>alert(1)</script><!--\u{2028}&__SUPLEX_EMAIL_HASH__"}),
            Some("</script>"),
        );
        let body = script
            .strip_prefix("<script>\n")
            .and_then(|rest| rest.strip_suffix("</script>\n"))
            .unwrap();
        assert!(!body.to_ascii_lowercase().contains("</script"));
        assert!(!body.contains("<!--") && !body.contains('\u{2028}') && !body.contains('<'));
        // The escaped text still decodes to the original value.
        let pushed = pushed(&script).unwrap();
        assert_eq!(
            pushed["gclid"],
            json!("</script><script>alert(1)</script><!--\u{2028}&__SUPLEX_EMAIL_HASH__")
        );
    }
}
