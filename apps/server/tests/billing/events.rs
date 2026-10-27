#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::billing::{
        hosted::{
            fakes::{FakePayment, Fixture, RC_APP_ID, RC_AUTHORIZATION, spawn, stub},
            iso,
            server::router,
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
        let bad = stripe_event(
            "evt_bad",
            "customer.subscription.updated",
            json!({"id": p.subscription}),
        );
        assert_eq!(f.stripe_event(&bad, Some("bogus")).await, 401);
        // A signature older than five minutes on the service clock fails.
        let stale = format!(
            "t={0},v1={1}",
            f.now_ms() / 1000 - 301,
            crate::billing::hosted::stripe::webhook_signature(
                bad.to_string().as_bytes(),
                "whsec_fake",
                f.now_ms() / 1000 - 301
            )
        );
        assert_eq!(f.stripe_event(&bad, Some(&stale)).await, 401);

        let good = stripe_event(
            "evt_1",
            "customer.subscription.updated",
            json!({"id": p.subscription, "customer": p.customer}),
        );
        assert_eq!(f.stripe_event(&good, None).await, 200);
        assert_eq!(
            f.count("SELECT COUNT(*) FROM billing_events WHERE provider = 'stripe'"),
            1
        );
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
        assert_eq!(
            f.count("SELECT COUNT(*) FROM billing_events WHERE event_id = 'evt_dup'"),
            1
        );
    }

    #[tokio::test]
    async fn verified_stripe_money_events_enqueue_once_and_send_privacy_bounded_properties() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        // The authenticated host read binds the provider customer to this
        // registered installation before later Stripe events arrive.
        assert_eq!(f.state(&p.account.credential).await["active"], true);
        let posthog = stub(|_| (200, json!({}))).await;
        let hosted = Fixture::hosted_with_telemetry(
            &f.path,
            BillingEnvironment::Sandbox,
            &f.stripe.url,
            &f.revenuecat.url,
            &f.clock,
            &posthog.url,
        );
        let mut event = stripe_event(
            "evt_paid_telemetry",
            "invoice.paid",
            json!({
                "id": "in_private",
                "customer": p.customer,
                "subscription": p.subscription,
                "customer_email": "private@example.test",
                "amount_paid": 4200,
                "amount_due": 9000,
                "currency": "cad"
            }),
        );
        event["created"] = json!(1_796_083_200);
        let raw = event.to_string();
        let timestamp = f.now_ms() / 1000;
        let signature = format!(
            "t={timestamp},v1={}",
            crate::billing::hosted::stripe::webhook_signature(
                raw.as_bytes(),
                "whsec_fake",
                timestamp
            )
        );
        hosted
            .ingest_stripe_webhook(raw.as_bytes(), Some(&signature))
            .unwrap();
        hosted
            .ingest_stripe_webhook(raw.as_bytes(), Some(&signature))
            .unwrap();
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events"), 1);
        let properties: String = f.sql(|db| {
            db.query_row(
                "SELECT properties_json FROM billing_telemetry_events",
                [],
                |row| row.get(0),
            )
        });
        let properties: Value = serde_json::from_str(&properties).unwrap();
        assert_eq!(properties["amount_paid_minor"], 4200);
        assert_eq!(properties["currency"], "cad");
        assert_eq!(properties["$groups"]["host"], "install-test01");
        let serialized = properties.to_string();
        assert!(!serialized.contains("private") && !serialized.contains("in_private"));

        hosted.run_processor_pass().await.unwrap();
        let calls = posthog.calls();
        assert_eq!(calls.len(), 1);
        let batch = calls[0].json();
        assert_eq!(batch["batch"][0]["event"], "billing_invoice_paid");
        assert_eq!(batch["batch"][0]["distinct_id"], "install-test01");
        assert_eq!(batch["batch"][0]["timestamp"], "2026-12-01T00:00:00.000Z");
        let stored_insert_id: String = f.sql(|db| {
            db.query_row(
                "SELECT insert_id FROM billing_telemetry_events",
                [],
                |row| row.get(0),
            )
        });
        assert_eq!(batch["batch"][0]["uuid"], stored_insert_id);
        assert!(
            f.sql(
                |db| db.query_row("SELECT sent_at FROM billing_telemetry_events", [], |row| {
                    row.get::<_, Option<String>>(0)
                },)
            )
            .is_some()
        );
        f.advance(31 * 24 * 60 * 60 * 1000);
        hosted.run_telemetry_pass().await;
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events"), 0);
    }

    #[tokio::test]
    async fn telemetry_opt_out_and_delivery_failures_do_not_change_billing_processing() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        assert_eq!(f.state(&p.account.credential).await["active"], true);
        let event = stripe_event(
            "evt_opted_out",
            "invoice.payment_failed",
            json!({"id":"in_x","customer":p.customer,"subscription":p.subscription,"amount_due":4200,"currency":"usd"}),
        );
        assert_eq!(f.stripe_event(&event, None).await, 200);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events"), 0);

        let posthog = stub(|_| (500, json!({"error":"down"}))).await;
        let hosted = Fixture::hosted_with_telemetry(
            &f.path,
            BillingEnvironment::Sandbox,
            &f.stripe.url,
            &f.revenuecat.url,
            &f.clock,
            &posthog.url,
        );
        let mut second = event;
        second["id"] = json!("evt_delivery_failure");
        let raw = second.to_string();
        let timestamp = f.now_ms() / 1000;
        let signature = format!(
            "t={timestamp},v1={}",
            crate::billing::hosted::stripe::webhook_signature(
                raw.as_bytes(),
                "whsec_fake",
                timestamp
            )
        );
        hosted
            .ingest_stripe_webhook(raw.as_bytes(), Some(&signature))
            .unwrap();
        hosted.run_processor_pass().await.unwrap();
        assert!(
            event_row(&f, "evt_delivery_failure").0.is_some(),
            "billing event still completes"
        );
        assert_eq!(
            f.sql(|db| db.query_row(
                "SELECT attempt_count FROM billing_telemetry_events",
                [],
                |row| row.get::<_, i64>(0)
            )),
            1
        );
        let first = posthog.calls()[0].json();
        f.advance(31_000);
        hosted.run_telemetry_pass().await;
        let second = posthog.calls()[1].json();
        assert_eq!(first["batch"][0]["uuid"], second["batch"][0]["uuid"]);
        assert_eq!(
            first["batch"][0]["timestamp"],
            second["batch"][0]["timestamp"]
        );
    }

    #[tokio::test]
    async fn authenticated_revenuecat_lifecycle_events_enqueue_without_aliases_or_money() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let posthog = stub(|_| (200, json!({}))).await;
        let hosted = Fixture::hosted_with_telemetry(
            &f.path,
            BillingEnvironment::Sandbox,
            &f.stripe.url,
            &f.revenuecat.url,
            &f.clock,
            &posthog.url,
        );
        let url = spawn(router(hosted.clone())).await;
        let event = json!({"event": {
            "id": "rc_analytics_1",
            "type": "RENEWAL",
            "app_id": RC_APP_ID,
            "app_user_id": format!("suplex_company_{}", p.account.id),
            "environment": "SANDBOX",
            "event_timestamp_ms": 1_796_083_200_000_i64,
            "price": 9999,
            "currency": "USD",
            "subscriber_email": "private@example.test"
        }});
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .post(format!("{url}/webhooks/revenuecat"))
                .header("authorization", "wrong")
                .json(&event)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events"), 0);
        for _ in 0..2 {
            assert_eq!(
                client
                    .post(format!("{url}/webhooks/revenuecat"))
                    .header("authorization", RC_AUTHORIZATION)
                    .json(&event)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                200
            );
        }
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events"), 1);
        hosted.run_processor_pass().await.unwrap();
        let body = posthog.calls()[0].json();
        assert_eq!(body["batch"][0]["event"], "revenuecat_subscription_renewed");
        assert_eq!(body["batch"][0]["properties"]["source"], "revenuecat");
        assert_eq!(body["batch"][0]["timestamp"], "2026-12-01T00:00:00.000Z");
        let sent = body.to_string();
        assert!(!sent.contains("private") && !sent.contains("suplex_company"));
        assert!(body["batch"][0]["properties"]["amount_minor"].is_null());
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
        let refund = stripe_event(
            "evt_refund",
            "charge.refunded",
            json!({"id": "ch_1", "customer": p.customer}),
        );
        assert_eq!(f.stripe_event(&paid, None).await, 200);
        assert_eq!(f.stripe_event(&refund, None).await, 200);
        f.process_events().await;
        assert_eq!(
            f.count("SELECT COUNT(*) FROM billing_events WHERE processed_at IS NULL"),
            0
        );
        assert_eq!(f.state(&p.account.credential).await["active"], false);
    }

    #[tokio::test]
    async fn revenuecat_requires_the_configured_authorization_app_and_environment() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let app_user_id = format!("suplex_company_{}", p.account.id);
        let event = |app_id: &str, environment: &str, event_type: &str| json!({"type": event_type, "app_id": app_id, "app_user_id": app_user_id, "environment": environment});
        assert_eq!(
            f.revenuecat_event("wrong", &event(RC_APP_ID, "SANDBOX", "RENEWAL"))
                .await,
            401
        );
        assert_eq!(
            f.revenuecat_event(RC_AUTHORIZATION, &event("other_app", "SANDBOX", "RENEWAL"))
                .await,
            200
        );
        assert_eq!(
            f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "PRODUCTION", "RENEWAL"))
                .await,
            200
        );
        // TEST is not the sandbox transaction environment.
        assert_eq!(
            f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "TEST", "RENEWAL"))
                .await,
            200
        );
        assert_eq!(
            f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "SANDBOX", "MADE_UP"))
                .await,
            200
        );
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_events"), 0);

        // An event without an id gets a stable derived id.
        assert_eq!(
            f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "SANDBOX", "RENEWAL"))
                .await,
            200
        );
        assert_eq!(
            f.revenuecat_event(RC_AUTHORIZATION, &event(RC_APP_ID, "SANDBOX", "RENEWAL"))
                .await,
            200
        );
        let (event_id, account_id): (String, Option<String>) = f.sql(|db| {
            db.query_row(
                "SELECT event_id, account_id FROM billing_events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        });
        let identity =
            json!({"type": "RENEWAL", "appId": RC_APP_ID, "appUserId": app_user_id, "at": null});
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
        assert_eq!(
            f.count("SELECT COUNT(*) FROM billing_events WHERE processed_at IS NULL"),
            0
        );
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
            db.query_row("SELECT last_error FROM billing_events", [], |row| {
                row.get(0)
            })
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

    fn panic_report(secret: &str) -> suplex_exception::Report {
        suplex_exception::Report::panic(
            "hosted",
            false,
            Some(("/app/build/suplex/apps/server/src/hosted/mod.rs", 5, 1)),
            Some("main"),
            &format!("   0: suplex::hosted::serve\n             at /app/build/suplex/apps/server/src/hosted/mod.rs:5:1\n   1: {secret}\n"),
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn hosted_panics_and_internal_failures_queue_only_when_hosted_telemetry_is_on() {
        let (_guard, _) = crate::telemetry::exceptions::isolate_for_test();
        let f = Fixture::new().await;
        // Hosted telemetry is off: nothing is queued, and nothing changes.
        f.hosted.route_exceptions("hosted", "suplex-hosted");
        crate::telemetry::exceptions::report_handled(
            "BackgroundLoopFailure",
            "background_loop",
            &[("loop", "off-switch")],
        );
        let _ = std::panic::catch_unwind(|| panic!("/home/ada/secret token=sk-live"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events"), 0);

        let posthog = stub(|_| (200, json!({}))).await;
        let hosted = Fixture::hosted_with_telemetry(
            &f.path,
            BillingEnvironment::Sandbox,
            &f.stripe.url,
            &f.revenuecat.url,
            &f.clock,
            &posthog.url,
        );
        hosted.route_exceptions("hosted", "suplex-hosted");
        let _ = std::panic::catch_unwind(|| panic!("/home/ada/secret token=sk-live"));
        crate::telemetry::exceptions::report_handled(
            "BackgroundLoopFailure",
            "background_loop",
            &[("loop", "account_sweep")],
        );
        // The handled report is queued from its own thread.
        for _ in 0..40 {
            if f.count("SELECT COUNT(*) FROM billing_telemetry_events WHERE event_name = '$exception'") == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events WHERE event_name = '$exception'"), 2);
        hosted.run_processor_pass().await.unwrap();
        let calls = posthog.calls();
        assert_eq!(calls.len(), 1);
        let batch = calls[0].json();
        let events = batch["batch"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        let panic = events
            .iter()
            .find(|event| event["properties"]["exception_source"] == "hosted" && event["properties"]["$exception_list"][0]["mechanism"]["type"] == "panic")
            .expect("the panic is sent");
        assert_eq!(panic["event"], "$exception");
        assert_eq!(panic["properties"]["$lib"], "suplex-hosted");
        assert_eq!(panic["properties"]["$exception_list"][0]["mechanism"]["handled"], false);
        let sent = batch.to_string();
        for leak in ["ada", "secret", "sk-live", "/home", "/app/build"] {
            assert!(!sent.contains(leak), "{leak} in {sent}");
        }
        // The same failure repeats once an hour, and the queue is bounded.
        for _ in 0..5 {
            hosted.enqueue_exception(&panic_report("again"), "suplex-hosted").unwrap();
        }
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events WHERE event_name = '$exception' AND sent_at IS NULL"), 1);
        for index in 0..80 {
            let mut report = panic_report("many");
            report.frames[0].function = format!("suplex::failure_{index}");
            let report = suplex_exception::Report::new("hosted", "Panic", "panic", false, report.frames);
            hosted.enqueue_exception(&report, "suplex-hosted").unwrap();
        }
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_telemetry_events WHERE event_name = '$exception' AND sent_at IS NULL"), 50);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_billing_command_panic_is_sent_at_once_and_a_send_failure_is_dropped() {
        let posthog = stub(|_| (200, json!({}))).await;
        let config = crate::billing::hosted::telemetry::Config {
            key: "phc_billing_test".into(),
            host: posthog.url.clone(),
        };
        crate::billing::hosted::telemetry::send_exception_now(&config, &panic_report("cli"), "suplex-billing");
        for _ in 0..40 {
            if !posthog.calls().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let calls = posthog.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].json()["batch"][0]["properties"]["$lib"], "suplex-billing");
        let unreachable = crate::billing::hosted::telemetry::Config {
            key: "phc_billing_test".into(),
            host: "http://127.0.0.1:9".into(),
        };
        crate::billing::hosted::telemetry::send_exception_now(&unreachable, &panic_report("cli"), "suplex-billing");
    }
}
