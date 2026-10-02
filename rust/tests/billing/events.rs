#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::billing::{
        hosted::{
            fakes::{FakePayment, Fixture, RC_APP_ID, RC_AUTHORIZATION},
            iso,
        },
        wire::BillingEnvironment,
    };

    fn stripe_event(id: &str, event_type: &str, object: Value) -> Value {
        json!({"id": id, "type": event_type, "livemode": false, "data": {"object": object}})
    }

    /// `(processed_at, attempt_count, next_attempt_at)` of one event.
    fn event_row(f: &Fixture, event_id: &str) -> (Option<String>, i64, Option<String>) {
        f.sql(|db| {
            db.query_row(
                "SELECT processed_at, attempt_count, next_attempt_at FROM billing_events WHERE event_id = ?1",
                [event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
    }

    #[tokio::test]
    async fn a_livemode_event_is_ignored_by_a_sandbox_deployment() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let mut event = stripe_event(
            "evt_live",
            "customer.subscription.updated",
            json!({"id": p.subscription, "customer": p.customer}),
        );
        event["livemode"] = json!(true);
        assert_eq!(f.stripe_event(&event, None).await, 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events"), 0);
    }

    #[tokio::test]
    async fn a_revenuecat_transfer_refreshes_each_known_account_once() {
        let f = Fixture::new().await;
        let first = f.provisioned(2).await;
        let second = f.provisioned(2).await;
        let from = format!("suplex_company_{}", first.account.id);
        let to = format!("suplex_company_{}", second.account.id);
        let event = json!({
            "id": "rc_transfer_1",
            "type": "TRANSFER",
            "app_id": RC_APP_ID,
            "environment": "SANDBOX",
            "transferred_from": [from],
            "transferred_to": [to],
        });
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event).await, 200);
        let payload: String = f.sql(|db| {
            db.query_row(
                "SELECT payload_json FROM billing_events WHERE event_id = 'rc_transfer_1'",
                [],
                |row| row.get(0),
            )
        });
        assert_eq!(
            serde_json::from_str::<Value>(&payload).unwrap(),
            json!({
                "type": "TRANSFER",
                "app_id": RC_APP_ID,
                "environment": "SANDBOX",
                "id": "rc_transfer_1",
                "transferred_from": [from],
                "transferred_to": [to],
            })
        );
        // A duplicate delivery is a no-op.
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event).await, 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events"), 1);

        // A transient source failure leaves the event retryable.
        f.stripe.with(|stripe| stripe.fail_reads = true);
        f.process_events().await;
        let (processed, attempts, _) = event_row(&f, "rc_transfer_1");
        assert_eq!((processed, attempts), (None, 1));

        f.stripe.with(|stripe| stripe.fail_reads = false);
        f.advance(31_000);
        f.process_events().await;
        assert!(event_row(&f, "rc_transfer_1").0.is_some());
        // Both sides were refreshed once; no identity moved from the payload.
        let mut imported = f.revenuecat.with(|revenuecat| {
            revenuecat
                .imports
                .iter()
                .map(|(app_user_id, _)| app_user_id.clone())
                .collect::<Vec<_>>()
        });
        imported.sort();
        let mut expected = vec![from, to];
        expected.sort();
        assert_eq!(imported, expected);
    }

    #[tokio::test]
    async fn a_production_deployment_ignores_sandbox_and_test_events() {
        let f = Fixture::with_environment(BillingEnvironment::Production).await;
        // A test-mode Stripe event is not production evidence.
        let event = stripe_event("evt_test", "invoice.paid", json!({"id": "in_x"}));
        assert_eq!(f.stripe_event(&event, None).await, 200);
        // A sandbox RevenueCat event is not production evidence either.
        let event = json!({"id": "rc_sandbox", "type": "RENEWAL", "app_id": RC_APP_ID, "app_user_id": "suplex_company_x", "environment": "SANDBOX"});
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event).await, 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events"), 0);
    }

    #[tokio::test]
    async fn stripe_rejects_a_bad_signature_and_accepts_a_verified_event() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let bad = stripe_event("evt_bad", "customer.subscription.updated", json!({"id": p.subscription}));
        assert_eq!(f.stripe_event(&bad, Some("bogus")).await, 401);
        // A signature older than five minutes on the service clock fails.
        let stale = format!(
            "t={0},v1={1}",
            f.now_ms() / 1000 - 301,
            crate::billing::hosted::stripe::webhook_signature(bad.to_string().as_bytes(), "whsec_fake", f.now_ms() / 1000 - 301)
        );
        assert_eq!(f.stripe_event(&bad, Some(&stale)).await, 401);

        let good = stripe_event(
            "evt_1",
            "customer.subscription.updated",
            json!({"id": p.subscription, "customer": p.customer}),
        );
        assert_eq!(f.stripe_event(&good, None).await, 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events WHERE provider = 'stripe'"), 1);
        assert_eq!(event_row(&f, "evt_1"), (None, 0, None));

        f.process_events().await;
        assert!(event_row(&f, "evt_1").0.is_some());
        assert_eq!(f.state(&p.account.credential).await["active"], true);
    }

    #[tokio::test]
    async fn duplicate_stripe_event_ids_are_no_ops() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let event = stripe_event(
            "evt_dup",
            "invoice.paid",
            json!({"id": "in_x", "subscription": p.subscription, "customer": p.customer}),
        );
        assert_eq!(f.stripe_event(&event, None).await, 200);
        assert_eq!(f.stripe_event(&event, None).await, 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events WHERE event_id = 'evt_dup'"), 1);
    }

    #[tokio::test]
    async fn an_authentic_refund_event_never_resurrects_refunded_access() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        // An earlier grant event, processed late, cannot override the refund.
        let invoice = f.stripe.with(|stripe| {
            let invoice = stripe.first_invoice(&p.subscription);
            stripe.invoice(&invoice).payments[0] = FakePayment::charge(4000, 4000);
            invoice
        });
        let paid = stripe_event(
            "evt_old_paid",
            "invoice.paid",
            json!({"id": invoice, "subscription": p.subscription, "customer": p.customer}),
        );
        let refund = stripe_event("evt_refund", "charge.refunded", json!({"id": "ch_1", "customer": p.customer}));
        assert_eq!(f.stripe_event(&paid, None).await, 200);
        assert_eq!(f.stripe_event(&refund, None).await, 200);
        f.process_events().await;
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events WHERE processed_at IS NULL"), 0);
        assert_eq!(f.state(&p.account.credential).await["active"], false);
    }

    #[tokio::test]
    async fn revenuecat_requires_the_configured_authorization_app_and_environment() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let app_user_id = format!("suplex_company_{}", p.account.id);
        let event = |app_id: &str, environment: &str, event_type: &str| {
            json!({"type": event_type, "app_id": app_id, "app_user_id": app_user_id, "environment": environment})
        };
        assert_eq!(f.revenuecat_event("wrong", &event(RC_APP_ID, "SANDBOX", "RENEWAL")).await, 401);
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event("other_app", "SANDBOX", "RENEWAL")).await, 200);
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "PRODUCTION", "RENEWAL")).await, 200);
        // TEST is not the sandbox transaction environment.
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "TEST", "RENEWAL")).await, 200);
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "SANDBOX", "MADE_UP")).await, 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events"), 0);

        // An event without an id gets a stable derived id.
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "SANDBOX", "RENEWAL")).await, 200);
        assert_eq!(f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "SANDBOX", "RENEWAL")).await, 200);
        let (event_id, account_id): (String, Option<String>) = f.sql(|db| {
            db.query_row("SELECT event_id, account_id FROM billing_events", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
        });
        let identity = json!({"type": "RENEWAL", "appId": RC_APP_ID, "appUserId": app_user_id, "at": null});
        assert_eq!(
            event_id,
            format!(
                "rc_{}",
                crate::shared::hash::sha256_hex(crate::billing::hosted::canonical_json(&identity))
            )
        );
        assert_eq!(account_id, Some(p.account.id.clone()));
        f.process_events().await;
        assert_eq!(f.state(&p.account.credential).await["active"], true);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events WHERE processed_at IS NULL"), 0);
    }

    #[tokio::test]
    async fn failed_processing_retries_with_backoff_and_survives_restart() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let event = stripe_event(
            "evt_retry",
            "customer.subscription.updated",
            json!({"id": p.subscription, "customer": p.customer}),
        );
        assert_eq!(f.stripe_event(&event, None).await, 200);

        f.stripe.with(|stripe| stripe.fail_reads = true);
        f.process_events().await;
        let (processed, attempts, next) = event_row(&f, "evt_retry");
        assert_eq!((processed, attempts), (None, 1));
        assert_eq!(next, Some(iso(f.now_ms() + 30_000)));
        let error: Option<String> = f.sql(|db| {
            db.query_row("SELECT last_error FROM billing_events", [], |row| row.get(0))
        });
        assert_eq!(error.as_deref(), Some("billing_unavailable"));

        // Before the backoff elapses the event is not retried.
        f.stripe.with(|stripe| stripe.fail_reads = false);
        f.process_events().await;
        assert_eq!(event_row(&f, "evt_retry").0, None);

        // A new service instance on the same database finishes the work.
        let restarted = Fixture::hosted(
            &f.path,
            BillingEnvironment::Sandbox,
            &f.stripe.url,
            &f.revenuecat.url,
            &f.clock,
        );
        f.advance(31_000);
        restarted.run_processor_pass().await.unwrap();
        assert!(event_row(&f, "evt_retry").0.is_some());
    }
}
