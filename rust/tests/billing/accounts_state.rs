#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::billing::hosted::fakes::{FakePayment, Fixture, PRICE_ID, random_credential};

    // -----------------------------------------------------------------------
    // POST /v1/accounts
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn registration_rejects_malformed_and_non_strict_bodies() {
        let f = Fixture::new().await;
        for body in [
            json!({}),
            json!({"registrationId": "x"}),
            json!({"registrationId": uuid::Uuid::new_v4().to_string(), "credential": "A".repeat(43), "installationId": "install-test01", "companyId": "c", "extra": 1}),
        ] {
            let (status, reply) = f.post("/v1/accounts", None, None, &body).await;
            assert_eq!(status, 400);
            assert_eq!(reply, json!({"error": "Invalid registration request"}));
        }
    }

    #[tokio::test]
    async fn registration_happens_once_and_a_repeat_returns_the_same_account() {
        let f = Fixture::new().await;
        let first = f.register().await;
        assert!(first.id.starts_with("account_"));
        let (status, repeat) = f.post("/v1/accounts", None, None, &first.registration).await;
        assert_eq!(status, 200);
        assert_eq!(repeat, json!({"accountId": first.id}));
        let app_user_id: String = f.sql(|db| {
            db.query_row(
                "SELECT revenuecat_app_user_id FROM billing_accounts WHERE id = ?1",
                [&first.id],
                |row| row.get(0),
            )
        });
        assert_eq!(app_user_id, format!("suplex_company_{}", first.id));
    }

    #[tokio::test]
    async fn registration_rejects_another_credential_or_namespace_for_the_same_id() {
        let f = Fixture::new().await;
        let first = f.register().await;
        let mut wrong_credential = first.registration.clone();
        wrong_credential["credential"] = json!(random_credential());
        let (status, _) = f.post("/v1/accounts", None, None, &wrong_credential).await;
        assert_eq!(status, 401);
        let mut wrong_namespace = first.registration.clone();
        wrong_namespace["companyId"] = json!("company_other");
        let (status, reply) = f.post("/v1/accounts", None, None, &wrong_namespace).await;
        assert_eq!(status, 401);
        assert_eq!(reply, json!({"error": "Unauthorized"}));
    }

    #[tokio::test]
    async fn simultaneous_registration_of_one_identity_returns_one_account() {
        let f = Fixture::new().await;
        let body = Fixture::registration_body();
        let (a, b) = tokio::join!(
            f.post("/v1/accounts", None, None, &body),
            f.post("/v1/accounts", None, None, &body)
        );
        assert_eq!((a.0, b.0), (200, 200));
        assert_eq!(a.1, b.1);
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_accounts"), 1);
    }

    // -----------------------------------------------------------------------
    // GET /v1/billing
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn billing_requires_a_bearer_credential() {
        let f = Fixture::new().await;
        assert_eq!(f.get("/v1/billing", None).await.0, 401);
        let (status, reply) = f.get("/v1/billing", Some(&random_credential())).await;
        assert_eq!(status, 401);
        assert_eq!(reply, json!({"error": "Unauthorized"}));
    }

    #[tokio::test]
    async fn an_account_with_no_provider_purchase_is_inactive() {
        let f = Fixture::new().await;
        let account = f.register().await;
        assert_eq!(
            f.state(&account.credential).await,
            json!({
                "active": false,
                "purchasedSeats": 0,
                "subscriptionStatus": "none",
                "renewalAt": null,
                "accessUntil": null,
                "cancelAtPeriodEnd": false,
                "paymentActionRequired": false,
                "paymentActionUrl": null,
                "environment": "sandbox",
            })
        );
    }

    #[tokio::test]
    async fn a_missing_customer_hint_is_rediscovered_from_stripe_metadata() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        // Drop the local observation; the Stripe customer remains.
        f.sql(|db| {
            db.execute(
                "UPDATE billing_accounts SET stripe_customer_id = NULL, subscription_hint = NULL WHERE id = ?1",
                [&p.account.id],
            )
        });
        let state = f.state(&p.account.credential).await;
        assert_eq!(state["active"], true);
        assert_eq!(state["purchasedSeats"], 2);
        let hint: Option<String> = f.sql(|db| {
            db.query_row(
                "SELECT stripe_customer_id FROM billing_accounts WHERE id = ?1",
                [&p.account.id],
                |row| row.get(0),
            )
        });
        assert_eq!(hint, Some(p.customer));
    }

    #[tokio::test]
    async fn a_foreign_stripe_customer_hint_is_never_adopted() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let other = f.stripe.with(|stripe| {
            let other = stripe.create_customer("account_other");
            stripe.add_subscription(&other, 9);
            other
        });
        f.sql(|db| {
            db.execute(
                "UPDATE billing_accounts SET stripe_customer_id = ?1 WHERE id = ?2",
                [&other, &p.account.id],
            )
        });
        // The account's own customer is rediscovered; the foreign one is not.
        assert_eq!(f.state(&p.account.credential).await["purchasedSeats"], 2);
    }

    #[tokio::test]
    async fn a_stripe_read_failure_is_billing_unavailable_never_fake_inactive() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| stripe.fail_reads = true);
        let (status, reply) = f.get("/v1/billing", Some(&p.account.credential)).await;
        assert_eq!(status, 503);
        assert_eq!(
            reply,
            json!({"error": "The billing provider cannot be reached", "code": "billing_unavailable"})
        );
    }

    #[tokio::test]
    async fn a_fully_refunded_current_period_is_inactive() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        // Stripe records a refund on the settled invoice's charge.
        f.stripe.with(|stripe| {
            let invoice = stripe.first_invoice(&p.subscription);
            stripe.invoice(&invoice).payments[0] = FakePayment::charge(4000, 4000);
        });
        let state = f.state(&p.account.credential).await;
        assert_eq!(state["active"], false);
        assert_eq!(state["purchasedSeats"], 0);
    }

    #[tokio::test]
    async fn a_partial_refund_of_the_current_period_keeps_access() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| {
            let invoice = stripe.first_invoice(&p.subscription);
            stripe.invoice(&invoice).payments[0] = FakePayment::charge(4000, 1200);
        });
        assert_eq!(f.state(&p.account.credential).await["active"], true);
    }

    #[tokio::test]
    async fn a_refund_of_an_older_period_does_not_revoke_a_later_paid_renewal() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| {
            let (created, period_start) = {
                let subscription = stripe.subscription(&p.subscription);
                (subscription.created, subscription.items[0].period_start)
            };
            let mut line = stripe.cover_line(&p.subscription);
            line.period_start = period_start - 2_600_000;
            line.period_end = period_start - 100;
            let mut older = stripe.new_invoice(Some(&p.subscription));
            older.created = created - 1000;
            older.amount_paid = 4000;
            older.payments = vec![FakePayment::charge(4000, 4000)];
            older.lines = vec![line];
            stripe.insert_invoice(older);
        });
        assert_eq!(f.state(&p.account.credential).await["active"], true);
    }

    #[tokio::test]
    async fn a_zero_invoice_settled_by_verified_credit_counts_as_paid() {
        let f = Fixture::new().await;
        let account = f.register().await;
        f.stripe.with(|stripe| {
            let customer = stripe.create_customer(&account.id);
            let subscription = stripe.add_unsettled_subscription(&customer, 2);
            let mut line = stripe.cover_line(&subscription);
            line.amount = 0;
            let mut invoice = stripe.new_invoice(Some(&subscription));
            invoice.amount_due = 0;
            invoice.amount_paid = 0;
            invoice.payments = vec![FakePayment::credit()];
            invoice.lines = vec![line];
            stripe.insert_invoice(invoice);
        });
        assert_eq!(f.state(&account.credential).await["active"], true);
    }

    #[tokio::test]
    async fn an_active_subscription_with_only_an_unpaid_invoice_is_not_pro() {
        let f = Fixture::new().await;
        let account = f.register().await;
        f.stripe.with(|stripe| {
            let customer = stripe.create_customer(&account.id);
            // A status string alone never grants paid access.
            let subscription = stripe.add_unsettled_subscription(&customer, 2);
            let mut invoice = stripe.new_invoice(Some(&subscription));
            invoice.status = "open".into();
            invoice.amount_paid = 0;
            let invoice = stripe.insert_invoice(invoice);
            stripe.subscription(&subscription).latest_invoice_id = Some(invoice);
        });
        let state = f.state(&account.credential).await;
        assert_eq!(state["active"], false);
        assert_eq!(state["purchasedSeats"], 0);
        assert_eq!(state["paymentActionRequired"], true);
    }

    #[tokio::test]
    async fn stripe_proven_access_survives_a_revenuecat_outage() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.revenuecat.with(|revenuecat| revenuecat.fail_get = true);
        let state = f.state(&p.account.credential).await;
        assert_eq!(state["active"], true);
        let period_end = f.stripe.with(|stripe| stripe.subscription(&p.subscription).items[0].period_end);
        assert_eq!(state["renewalAt"], json!(crate::billing::hosted::iso(period_end * 1000)));
        assert_eq!(state["accessUntil"], state["renewalAt"]);
    }

    #[tokio::test]
    async fn a_scheduled_cancellation_keeps_access_until_the_paid_period_ends() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| stripe.subscription(&p.subscription).cancel_at_period_end = true);
        let state = f.state(&p.account.credential).await;
        assert_eq!(state["active"], true);
        assert_eq!(state["cancelAtPeriodEnd"], true);
    }

    #[tokio::test]
    async fn a_trialing_subscription_does_not_grant_this_paid_product() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| stripe.subscription(&p.subscription).status = "trialing".into());
        let state = f.state(&p.account.credential).await;
        assert_eq!(state["active"], false);
        assert_eq!(state["subscriptionStatus"], "trialing");
    }

    #[tokio::test]
    async fn an_incomplete_subscription_reports_a_payment_action_not_access() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let invoice = f.stripe.with(|stripe| {
            let mut invoice = stripe.new_invoice(Some(&p.subscription));
            invoice.status = "open".into();
            invoice.amount_paid = 0;
            let invoice = stripe.insert_invoice(invoice);
            let subscription = stripe.subscription(&p.subscription);
            subscription.status = "incomplete".into();
            subscription.latest_invoice_id = Some(invoice.clone());
            invoice
        });
        let state = f.state(&p.account.credential).await;
        assert_eq!(state["active"], false);
        assert_eq!(state["paymentActionRequired"], true);
        assert_eq!(state["paymentActionUrl"], format!("https://invoice.stripe.com/i/{invoice}"));
    }

    #[tokio::test]
    async fn an_unexpired_revenuecat_grace_period_covers_a_lapsed_renewal() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let now = f.now_ms();
        f.stripe.with(|stripe| {
            let subscription = stripe.subscription(&p.subscription);
            subscription.status = "past_due".into();
            subscription.items[0].period_start = now / 1000 - 100;
            subscription.items[0].period_end = now / 1000 + 2_000_000;
            // The last paid period has ended; only grace can cover now.
            let invoice = stripe.first_invoice(&p.subscription);
            let line = &mut stripe.invoice(&invoice).lines[0];
            line.period_start = now / 1000 - 2_600_000;
            line.period_end = now / 1000 - 100;
        });
        let iso = crate::billing::hosted::iso;
        let grace = iso(now + 3 * 24 * 60 * 60 * 1000);
        f.revenuecat.with(|revenuecat| {
            revenuecat.subscriber = Some(json!({
                "entitlements": {"pro": {
                    "product_identifier": PRICE_ID,
                    "expires_date": iso(now - 1000),
                    "grace_period_expires_date": grace,
                }},
                "subscriptions": {PRICE_ID: {"store": "stripe", "is_sandbox": true}},
            }));
        });
        let state = f.state(&p.account.credential).await;
        assert_eq!(state["active"], true);
        assert_eq!(state["paymentActionRequired"], true);
        assert_eq!(state["accessUntil"], Value::String(grace));
        assert_eq!(state["renewalAt"], Value::Null);
    }

    // -----------------------------------------------------------------------
    // POST /v1/portal
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn the_portal_returns_a_url_for_an_account_with_a_verified_customer() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let (status, reply) = f.post("/v1/portal", Some(&p.account.credential), None, &json!({})).await;
        assert_eq!(status, 200);
        assert_eq!(reply, json!({"url": "https://billing.stripe.com/p/session_1"}));
        assert_eq!(
            f.stripe.with(|stripe| stripe.portal_requests.clone()),
            [format!("{}:bpc_fake:http://localhost:4211/portal/return", p.customer)]
        );
    }

    #[tokio::test]
    async fn the_portal_is_no_subscription_without_a_customer() {
        let f = Fixture::new().await;
        let account = f.register().await;
        let (status, reply) = f.post("/v1/portal", Some(&account.credential), None, &json!({})).await;
        assert_eq!(status, 409);
        assert_eq!(
            reply,
            json!({"error": "This account has no billing customer", "code": "no_subscription"})
        );
    }
}
