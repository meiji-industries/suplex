#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::billing::hosted::{
        fakes::{Fixture, PRICE_ID},
        iso,
    };

    async fn checkout(f: &Fixture, credential: &str, quantity: i64, key: &str) -> (u16, Value) {
        f.post("/v1/checkout", Some(credential), Some(key), &json!({"quantity": quantity}))
            .await
    }

    async fn preview(f: &Fixture, credential: &str, quantity: i64) -> (u16, Value) {
        f.post("/v1/seats/preview", Some(credential), None, &json!({"quantity": quantity}))
            .await
    }

    async fn preview_id(f: &Fixture, credential: &str, quantity: i64) -> String {
        let (status, body) = preview(f, credential, quantity).await;
        assert_eq!(status, 200, "{body}");
        body["previewId"].as_str().unwrap().into()
    }

    async fn change(f: &Fixture, credential: &str, body: Value, key: &str) -> (u16, Value) {
        f.post("/v1/seats", Some(credential), Some(key), &body).await
    }

    async fn increase(f: &Fixture, credential: &str, preview: &str, key: &str) -> (u16, Value) {
        change(f, credential, json!({"quantity": 4, "previewId": preview}), key).await
    }

    fn session_count(f: &Fixture) -> usize {
        f.stripe.with(|stripe| stripe.sessions.len())
    }

    fn update_count(f: &Fixture) -> usize {
        f.stripe.with(|stripe| stripe.update_calls.len())
    }

    fn quantity(f: &Fixture, subscription: &str) -> i64 {
        f.stripe
            .with(|stripe| stripe.subscription(subscription).items[0].quantity)
    }

    /// The pending invoice is voided and the pending update drops unapplied.
    fn void_pending_change(f: &Fixture, subscription: &str) {
        f.stripe.with(|stripe| {
            let open = stripe.open_invoice();
            stripe.invoice(&open).status = "void".into();
            stripe.subscription(subscription).pending_update = None;
        });
    }

    // -----------------------------------------------------------------------
    // POST /v1/checkout
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn checkout_creates_one_session_and_returns_a_validated_stripe_url() {
        let f = Fixture::new().await;
        let account = f.register().await;
        let (status, body) = checkout(&f, &account.credential, 2, "key-checkout-1").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "redirect");
        let operation = body["operationId"].as_str().unwrap();
        assert!(body["url"].as_str().unwrap().starts_with("https://checkout.stripe.com/"));
        f.stripe.with(|stripe| {
            assert_eq!(stripe.sessions.len(), 1);
            let session = &stripe.sessions[0];
            assert_eq!(session.metadata["app_user_id"], format!("suplex_company_{}", account.id));
            assert_eq!(session.metadata["suplex_quantity"], "2");
            assert_eq!(session.metadata["suplex_operation_id"], operation);
            assert_eq!(stripe.create_session_keys, [format!("suplex_checkout_{operation}")]);
            assert_eq!(stripe.create_customer_keys, [format!("suplex_customer_{operation}")]);
        });
    }

    #[tokio::test]
    async fn checkout_rejects_a_missing_key_extra_fields_and_an_invalid_quantity() {
        let f = Fixture::new().await;
        let account = f.register().await;
        let credential = Some(account.credential.as_str());
        let (status, body) = f.post("/v1/checkout", credential, None, &json!({"quantity": 2})).await;
        assert_eq!(status, 400);
        assert_eq!(body, json!({"error": "A valid Idempotency-Key header is required"}));
        let (status, body) = f
            .post("/v1/checkout", credential, Some("key-123456"), &json!({"quantity": 2, "priceId": "price_evil"}))
            .await;
        assert_eq!(status, 400);
        assert_eq!(body, json!({"error": "Invalid request"}));
        let (status, body) = checkout(&f, &account.credential, 0, "key-1234567").await;
        assert_eq!(status, 422);
        assert_eq!(body, json!({"error": "Invalid seat quantity", "code": "invalid_seat_quantity"}));
        assert_eq!(session_count(&f), 0);
    }

    #[tokio::test]
    async fn a_double_submit_with_one_key_returns_the_same_operation_and_url() {
        let f = Fixture::new().await;
        let account = f.register().await;
        let first = checkout(&f, &account.credential, 2, "key-repeat-1").await;
        let second = checkout(&f, &account.credential, 2, "key-repeat-1").await;
        assert_eq!(first.0, 200);
        assert_eq!(second, first);
        assert_eq!(session_count(&f), 1);
    }

    #[tokio::test]
    async fn one_key_with_another_quantity_is_an_idempotency_conflict() {
        let f = Fixture::new().await;
        let account = f.register().await;
        checkout(&f, &account.credential, 2, "key-conflict-1").await;
        let (status, body) = checkout(&f, &account.credential, 5, "key-conflict-1").await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "idempotency_conflict");
    }

    #[tokio::test]
    async fn an_existing_active_subscription_is_subscribed_without_a_session() {
        let f = Fixture::new().await;
        let p = f.provisioned(3).await;
        let (status, body) = checkout(&f, &p.account.credential, 5, "key-active-1").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "subscribed");
        assert_eq!(body["state"]["purchasedSeats"], 3);
        assert_eq!(session_count(&f), 0);
    }

    #[tokio::test]
    async fn an_incomplete_subscription_is_payment_required_with_the_invoice_url() {
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
        let (status, body) = checkout(&f, &p.account.credential, 2, "key-incomplete-1").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "payment_required");
        assert_eq!(body["url"], format!("https://invoice.stripe.com/i/{invoice}"));
        assert_eq!(session_count(&f), 0);
    }

    #[tokio::test]
    async fn another_quantity_expires_the_unpaid_session_before_creating_one() {
        let f = Fixture::new().await;
        let account = f.register().await;
        let (_, first) = checkout(&f, &account.credential, 2, "key-quantity-2").await;
        assert_eq!(first["status"], "redirect");
        let (_, second) = checkout(&f, &account.credential, 5, "key-quantity-5").await;
        assert_eq!(second["status"], "redirect");
        f.stripe.with(|stripe| {
            assert_eq!(stripe.expire_calls.len(), 1);
            assert_eq!(stripe.sessions.len(), 2);
            let open = stripe
                .sessions
                .values()
                .filter(|session| session.status == "open")
                .collect::<Vec<_>>();
            assert_eq!(open.len(), 1);
            assert_eq!(open[0].metadata["suplex_quantity"], "5");
        });
    }

    #[tokio::test]
    async fn a_payment_that_raced_session_expiration_reconciles_to_subscribed() {
        let f = Fixture::new().await;
        let account = f.register().await;
        checkout(&f, &account.credential, 2, "key-race-a").await;
        f.stripe.with(|stripe| {
            stripe.sessions[0]
                .metadata
                .insert("suplex_complete_on_expire".into(), "true".into());
        });
        let (status, body) = checkout(&f, &account.credential, 5, "key-race-b").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "subscribed");
        assert_eq!(session_count(&f), 1);
    }

    #[tokio::test]
    async fn concurrent_checkouts_create_at_most_one_session() {
        let f = Fixture::new().await;
        let account = f.register().await;
        let (a, b) = tokio::join!(
            checkout(&f, &account.credential, 2, "key-cc-a"),
            checkout(&f, &account.credential, 2, "key-cc-b")
        );
        assert_eq!((a.0, b.0), (200, 200));
        assert_eq!(session_count(&f), 1);
        assert_eq!(a.1["url"], b.1["url"]);
    }

    #[tokio::test]
    async fn an_expired_checkout_session_is_billing_operation_not_applied() {
        let f = Fixture::new().await;
        let account = f.register().await;
        checkout(&f, &account.credential, 2, "key-expired-1").await;
        f.stripe.with(|stripe| {
            let session = stripe.sessions[0].id.clone();
            stripe.expire_checkout_session(&session);
        });
        // A replay never re-presents the dead session or charges again
        // under the consumed provider key.
        let (status, body) = checkout(&f, &account.credential, 2, "key-expired-1").await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "billing_operation_not_applied");
        assert_eq!(f.stripe.with(|stripe| stripe.create_session_keys.len()), 1);
        // The failure replays from the durable operation.
        let (status, _) = checkout(&f, &account.credential, 2, "key-expired-1").await;
        assert_eq!(status, 409);
        // A new command creates a new session normally.
        let (_, fresh) = checkout(&f, &account.credential, 2, "key-expired-2").await;
        assert_eq!(fresh["status"], "redirect");
        assert_eq!(session_count(&f), 2);
    }

    #[tokio::test]
    async fn a_completed_checkout_replay_reconciles_to_subscribed() {
        let f = Fixture::new().await;
        let account = f.register().await;
        let (_, first) = checkout(&f, &account.credential, 2, "key-reconcile-1").await;
        f.stripe.with(|stripe| {
            let session = stripe.sessions[0].id.clone();
            stripe.complete_checkout_session(&session);
        });
        let (status, body) = checkout(&f, &account.credential, 2, "key-reconcile-1").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "subscribed");
        assert_eq!(body["operationId"], first["operationId"]);
        assert_eq!(body["state"]["purchasedSeats"], 2);
        assert_eq!(session_count(&f), 1);
    }

    #[tokio::test]
    async fn a_price_configuration_mismatch_refuses_mutations() {
        let f = Fixture::new().await;
        let account = f.register().await;
        f.stripe.with(|stripe| stripe.price["unit_amount"] = json!(2500));
        let (status, body) = checkout(&f, &account.credential, 2, "key-price-1").await;
        assert_eq!(status, 503);
        assert_eq!(body["code"], "billing_setup_invalid");
        assert_eq!(session_count(&f), 0);
    }

    // -----------------------------------------------------------------------
    // Seat preview and change
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_preview_returns_bound_amounts_expiry_and_the_proration_timestamp() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let (status, body) = preview(&f, &p.account.credential, 4).await;
        assert_eq!(status, 200);
        let now = f.now_ms();
        assert_eq!(
            body,
            json!({
                "previewId": body["previewId"],
                "expiresAt": iso(now + 5 * 60 * 1000),
                "currentQuantity": 2,
                "requestedQuantity": 4,
                "amountDueNow": 1300,
                "nextSubtotal": 8000,
                "currency": "usd",
                "prorationTimestamp": now / 1000,
            })
        );
        let call = f.stripe.with(|stripe| stripe.preview_calls[0].clone());
        let field = |key| crate::billing::hosted::fakes::field(&call, key).map(str::to_owned);
        assert_eq!(field("subscription_details[items][0][quantity]").as_deref(), Some("4"));
        assert_eq!(field("subscription_details[items][0][price]").as_deref(), Some(PRICE_ID));
        assert_eq!(
            field("subscription_details[proration_date]"),
            Some((now / 1000).to_string())
        );
    }

    #[tokio::test]
    async fn a_preview_requires_an_active_subscription_and_a_quantity_above_current() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        assert_eq!(preview(&f, &p.account.credential, 2).await.0, 422);
        let bare = f.register().await;
        let (status, body) = preview(&f, &bare.credential, 3).await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "no_subscription");
    }

    #[tokio::test]
    async fn an_increase_applies_with_always_invoice_and_pending_if_incomplete() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let id = preview_id(&f, &p.account.credential, 4).await;
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-up-1").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "applied");
        assert_eq!(body["state"]["purchasedSeats"], 4);
        assert_eq!(quantity(&f, &p.subscription), 4);
        let call = f.stripe.with(|stripe| stripe.update_calls[0].clone());
        assert_eq!(call.proration_behavior, "always_invoice");
        assert_eq!(call.payment_behavior.as_deref(), Some("pending_if_incomplete"));
        assert!(call.key.starts_with("suplex_seat_change_op_"));
    }

    #[tokio::test]
    async fn a_payment_required_increase_keeps_the_old_quantity_until_paid() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| stripe.pending_increase = true);
        let id = preview_id(&f, &p.account.credential, 4).await;
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-pending-1").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "payment_required");
        assert!(body["url"].as_str().unwrap().starts_with("https://invoice.stripe.com/"));
        assert_eq!(body["state"]["purchasedSeats"], 2);
        assert_eq!(quantity(&f, &p.subscription), 2);
        // A follow-up change waits for the unresolved increase payment.
        let (status, again) = change(
            &f,
            &p.account.credential,
            json!({"quantity": 1, "confirmNoRefund": true}),
            "key-seat-blocked",
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(again["code"], "billing_payment_pending");
        // Replaying the original key returns the same pending result.
        let (_, replay) = increase(&f, &p.account.credential, &id, "key-seat-pending-1").await;
        assert_eq!(replay["status"], "payment_required");
        assert_eq!(update_count(&f), 1);
    }

    #[tokio::test]
    async fn a_changed_quote_is_billing_quote_changed_with_a_fresh_preview() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let id = preview_id(&f, &p.account.credential, 4).await;
        f.stripe.with(|stripe| stripe.preview_amount_due = 2600);
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-quote-1").await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "billing_quote_changed");
        assert_eq!(body["preview"]["amountDueNow"], 2600);
        assert_ne!(body["preview"]["previewId"], json!(id));
        assert_eq!(update_count(&f), 0);
    }

    #[tokio::test]
    async fn an_expired_or_foreign_preview_is_rejected() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        // Another account with its own subscription cannot use this preview.
        let foreign = f.provisioned(1).await;
        let id = preview_id(&f, &p.account.credential, 4).await;
        let (status, body) = increase(&f, &foreign.account.credential, &id, "key-seat-foreign").await;
        assert_eq!(status, 422);
        assert_eq!(body["code"], "invalid_seat_quantity");
        f.advance(6 * 60 * 1000);
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-expired").await;
        assert_eq!(status, 422);
        assert_eq!(body["error"], "The seat preview has expired");
    }

    #[tokio::test]
    async fn a_decrease_applies_immediately_without_proration_and_requires_confirmation() {
        let f = Fixture::new().await;
        let p = f.provisioned(3).await;
        let (status, body) = change(&f, &p.account.credential, json!({"quantity": 1}), "key-seat-no-confirm").await;
        assert_eq!(status, 422);
        assert_eq!(body, json!({"error": "Invalid seat change request", "code": "invalid_seat_quantity"}));
        let (status, body) = change(
            &f,
            &p.account.credential,
            json!({"quantity": 1, "confirmNoRefund": true}),
            "key-seat-down-1",
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "applied");
        assert_eq!(quantity(&f, &p.subscription), 1);
        let call = f.stripe.with(|stripe| stripe.update_calls[0].clone());
        assert_eq!(call.proration_behavior, "none");
        assert_eq!((call.proration_date, call.payment_behavior), (None, None));
    }

    #[tokio::test]
    async fn seat_changes_wait_while_a_renewal_is_unpaid() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| stripe.subscription(&p.subscription).status = "past_due".into());
        let (status, body) = change(
            &f,
            &p.account.credential,
            json!({"quantity": 1, "confirmNoRefund": true}),
            "key-seat-pastdue",
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "billing_payment_pending");
        assert_eq!(preview(&f, &p.account.credential, 4).await.0, 409);
    }

    // -----------------------------------------------------------------------
    // Seat command recovery
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_crash_replayed_increase_reuses_the_provider_key_and_quoted_timestamp() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let id = preview_id(&f, &p.account.credential, 4).await;
        let quoted = f.now_ms() / 1000;
        f.advance(60_000);
        // The first dispatch fails before anything reaches Stripe.
        f.stripe.with(|stripe| stripe.fail_next_update = true);
        let (status, _) = increase(&f, &p.account.credential, &id, "key-seat-crash").await;
        assert_eq!(status, 503);
        assert_eq!(quantity(&f, &p.subscription), 2);
        // The replay executes the same recorded command.
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-crash").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "applied");
        assert_eq!(quantity(&f, &p.subscription), 4);
        let calls = f.stripe.with(|stripe| stripe.update_calls.clone());
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].key, calls[1].key);
        assert_eq!(calls[1].proration_date, Some(quoted));
    }

    #[tokio::test]
    async fn a_mutation_whose_response_was_lost_recovers_applied_without_a_second_charge() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let id = preview_id(&f, &p.account.credential, 4).await;
        f.stripe.with(|stripe| stripe.drop_next_update_result = true);
        let (status, _) = increase(&f, &p.account.credential, &id, "key-seat-lost").await;
        assert_eq!(status, 503);
        // The mutation landed; only the response was lost.
        assert_eq!(quantity(&f, &p.subscription), 4);
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-lost").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "applied");
        assert_eq!(update_count(&f), 1);
    }

    #[tokio::test]
    async fn a_voided_pending_invoice_is_not_applied_and_never_charges_again() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| stripe.pending_increase = true);
        let id = preview_id(&f, &p.account.credential, 4).await;
        let (_, first) = increase(&f, &p.account.credential, &id, "key-seat-void").await;
        assert_eq!(first["status"], "payment_required");
        void_pending_change(&f, &p.subscription);
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-void").await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "billing_operation_not_applied");
        assert_eq!(update_count(&f), 1);
        assert_eq!(quantity(&f, &p.subscription), 2);
        // A fresh preview is a new command and applies normally.
        let next = preview_id(&f, &p.account.credential, 4).await;
        f.stripe.with(|stripe| stripe.pending_increase = false);
        let (_, applied) = increase(&f, &p.account.credential, &next, "key-seat-void-2").await;
        assert_eq!(applied["status"], "applied");
        assert_eq!(update_count(&f), 2);
    }

    #[tokio::test]
    async fn a_completed_change_replays_its_receipt_after_the_quote_expires() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let id = preview_id(&f, &p.account.credential, 4).await;
        increase(&f, &p.account.credential, &id, "key-seat-done").await;
        assert_eq!(quantity(&f, &p.subscription), 4);
        f.advance(10 * 60 * 1000);
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-done").await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "applied");
        assert_eq!(update_count(&f), 1);
    }

    #[tokio::test]
    async fn a_stale_increase_to_four_never_becomes_a_decrease_after_a_change_to_six() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| stripe.pending_increase = true);
        let id = preview_id(&f, &p.account.credential, 4).await;
        increase(&f, &p.account.credential, &id, "key-seat-stale").await;
        void_pending_change(&f, &p.subscription);
        f.stripe
            .with(|stripe| stripe.subscription(&p.subscription).items[0].quantity = 6);
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-stale").await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "billing_operation_not_applied");
        assert_eq!(update_count(&f), 1);
        assert_eq!(quantity(&f, &p.subscription), 6);
    }

    #[tokio::test]
    async fn an_unpaid_renewal_before_a_retry_blocks_the_old_command() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let id = preview_id(&f, &p.account.credential, 4).await;
        f.stripe.with(|stripe| stripe.fail_next_update = true);
        increase(&f, &p.account.credential, &id, "key-seat-renewal").await;
        let invoices = f.stripe.with(|stripe| {
            let count = stripe.invoices.len();
            let mut renewal = stripe.new_invoice(Some(&p.subscription));
            renewal.status = "open".into();
            renewal.amount_paid = 0;
            let renewal = stripe.insert_invoice(renewal);
            let subscription = stripe.subscription(&p.subscription);
            subscription.status = "past_due".into();
            subscription.latest_invoice_id = Some(renewal);
            count
        });
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-renewal").await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "billing_payment_pending");
        // No prorated invoice or credit against the unpaid period.
        assert_eq!(update_count(&f), 1);
        assert_eq!(f.stripe.with(|stripe| stripe.invoices.len()), invoices + 1);
        assert_eq!(quantity(&f, &p.subscription), 2);
    }

    #[tokio::test]
    async fn a_cached_mutation_response_cannot_override_the_fresh_source_outcome() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        let id = preview_id(&f, &p.account.credential, 4).await;
        f.stripe.with(|stripe| stripe.drop_next_update_result = true);
        increase(&f, &p.account.credential, &id, "key-seat-cached").await;
        // The recorded response says four; the source shows two.
        f.stripe
            .with(|stripe| stripe.subscription(&p.subscription).items[0].quantity = 2);
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-cached").await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "billing_operation_not_applied");
        assert_eq!(quantity(&f, &p.subscription), 2);
    }

    #[tokio::test]
    async fn a_command_whose_subscription_was_replaced_is_terminally_not_applied() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.stripe.with(|stripe| stripe.pending_increase = true);
        let id = preview_id(&f, &p.account.credential, 4).await;
        increase(&f, &p.account.credential, &id, "key-seat-replaced").await;
        let replacement = f.stripe.with(|stripe| {
            stripe.subscriptions.shift_remove(&p.subscription);
            stripe.add_subscription(&p.customer, 2)
        });
        let (status, body) = increase(&f, &p.account.credential, &id, "key-seat-replaced").await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "billing_operation_not_applied");
        assert_eq!(quantity(&f, &replacement), 2);
        assert_eq!(update_count(&f), 1);
    }

    // -----------------------------------------------------------------------
    // RevenueCat import
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_verified_subscription_is_imported_once_per_lifecycle_fingerprint() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.state(&p.account.credential).await;
        f.state(&p.account.credential).await;
        let imports = || f.revenuecat.with(|revenuecat| revenuecat.imports.clone());
        assert_eq!(
            imports(),
            [(format!("suplex_company_{}", p.account.id), p.subscription.clone())]
        );
        // A scheduled cancellation is a lifecycle fact and re-syncs.
        f.stripe.with(|stripe| stripe.subscription(&p.subscription).cancel_at_period_end = true);
        f.state(&p.account.credential).await;
        assert_eq!(imports().len(), 2);
        f.stripe.with(|stripe| stripe.subscription(&p.subscription).status = "past_due".into());
        f.state(&p.account.credential).await;
        assert_eq!(imports().len(), 3);
    }

    #[tokio::test]
    async fn an_import_failure_never_blocks_stripe_access_and_schedules_a_repair() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        f.revenuecat.with(|revenuecat| revenuecat.fail_import = true);
        assert_eq!(f.state(&p.account.credential).await["active"], true);
        let sync = || -> (Option<String>, i64, Option<String>) {
            f.sql(|db| {
                db.query_row(
                    "SELECT next_sync_at, sync_attempt_count, last_sync_error FROM billing_accounts WHERE id = ?1",
                    [&p.account.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
        };
        let (next, attempts, error) = sync();
        assert!(next.is_some());
        assert_eq!(attempts, 1);
        // Only the sanitized provider status is stored.
        assert_eq!(error.as_deref(), Some("revenuecat error 503"));

        // The processor retries the due repair; an accepted import with no
        // visible subscriber stays repair-eligible.
        f.revenuecat.with(|revenuecat| revenuecat.fail_import = false);
        f.advance(31_000);
        f.process_events().await;
        assert_eq!(f.revenuecat.with(|revenuecat| revenuecat.imports.len()), 1);
        assert!(sync().0.is_some());

        // Verified representation clears the repair without another import.
        // The backoff after two attempts is 120 seconds.
        f.revenuecat.with(|revenuecat| {
            revenuecat.subscriber = Some(json!({
                "entitlements": {},
                "subscriptions": {PRICE_ID: {"store": "stripe", "is_sandbox": true}},
            }));
        });
        f.advance(121_000);
        f.process_events().await;
        assert_eq!(f.revenuecat.with(|revenuecat| revenuecat.imports.len()), 1);
        assert_eq!(sync(), (None, 0, None));
    }
}
