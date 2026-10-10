#[cfg(test)]
mod tests {
    use std::sync::{Arc, atomic::AtomicI64};

    use super::*;
    use crate::{
        billing::hosted::{
            backoff_at, canonical_json,
            fakes::{Recorded, fake_stripe, field, stub},
            iso,
        },
        shared::hash::sha256_hex,
    };
    use serde_json::json;

    fn raw_invoice(over: Value) -> Value {
        let mut invoice = json!({
            "id": "in_1",
            "status": "paid",
            "created": 1_759_000_000,
            "amount_due": 4000,
            "amount_paid": 4000,
            "currency": "usd",
            "hosted_invoice_url": "https://invoice.stripe.com/i/in_1",
            "parent": {"subscription_details": {"subscription": "sub_1"}},
            "payments": {"data": [], "has_more": false},
            "lines": {"data": [], "has_more": false},
        });
        invoice
            .as_object_mut()
            .unwrap()
            .extend(over.as_object().unwrap().clone());
        invoice
    }

    fn form(call: &Recorded) -> Vec<(&str, &str)> {
        call.form
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }

    fn query(call: &Recorded) -> Vec<(&str, &str)> {
        call.query
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }

    /// Pinned to the TypeScript `canonicalJson` + sha256 output so stored
    /// input hashes and RevenueCat fallback event ids keep their meaning.
    #[test]
    fn canonical_hashes_match_the_typescript_service() {
        let cases = [
            (
                json!({"kind": "checkout", "input": {"quantity": 2}}),
                r#"{"input":{"quantity":2},"kind":"checkout"}"#,
                "8210a44633c20344d3d8a2261c29b7237eb709ad19f9c8aebce640ead223baff",
            ),
            (
                json!({"kind": "seat_change", "input": {"direction": "increase", "quantity": 4, "previewId": "op_0b9c"}}),
                r#"{"input":{"direction":"increase","previewId":"op_0b9c","quantity":4},"kind":"seat_change"}"#,
                "4f4bce59e096216260d5fe18e15a9faf26e19918044e72c6224ea6c3934c0818",
            ),
            (
                json!({"kind": "seat_change", "input": {"direction": "decrease", "quantity": 1, "confirmNoRefund": true}}),
                r#"{"input":{"confirmNoRefund":true,"direction":"decrease","quantity":1},"kind":"seat_change"}"#,
                "d1ba1341643bb870c242398fedf70f9726e1dc8b33f753f8616cd035b845415c",
            ),
            (
                json!({"type": "RENEWAL", "appId": "app_suplex", "appUserId": "suplex_company_account_1", "at": 1_790_000_000_000_i64}),
                r#"{"appId":"app_suplex","appUserId":"suplex_company_account_1","at":1790000000000,"type":"RENEWAL"}"#,
                "604a92efc699a60cf0fa9566454eb02aacd873ded97cdbefd5a6b2de2ab84aa0",
            ),
            (
                json!({"type": "RENEWAL", "appId": "app_suplex", "at": null}),
                r#"{"appId":"app_suplex","at":null,"type":"RENEWAL"}"#,
                "753f39f580102aa38802ddb99d8525c223b75cf2486498e382b503b5abffbaf1",
            ),
            (
                json!({"b": [1, "x\u{1}\"é", {"z": null, "a": false}], "a": 1.5}),
                "{\"a\":1.5,\"b\":[1,\"x\\u0001\\\"é\",{\"a\":false,\"z\":null}]}",
                "8934a5bc0ccd686e47b0aef2381a494fb295f6f920bc0e48b53dae13a25d0d90",
            ),
        ];
        for (value, canonical, hash) in cases {
            assert_eq!(canonical_json(&value), canonical);
            assert_eq!(sha256_hex(canonical_json(&value)), hash);
        }
        // The service hashes operation inputs the same way.
        assert_eq!(
            crate::billing::hosted::commands::input_hash("checkout", &json!({"quantity": 2})),
            "8210a44633c20344d3d8a2261c29b7237eb709ad19f9c8aebce640ead223baff"
        );
        let now = 1_790_000_000_000;
        assert_eq!(backoff_at(0, now), iso(now + 30_000));
        assert_eq!(backoff_at(3, now), iso(now + 3_600_000));
    }

    #[test]
    fn webhook_signatures_verify_over_raw_bytes_within_the_tolerance() {
        let payload = br#"{"id":"evt_1","type":"invoice.paid","livemode":true,"data":{"object":{"id":"in_1"}}}"#;
        let now = 1_790_000_000;
        let header = |timestamp: i64, secret: &str| {
            format!("t={timestamp},v1={}", webhook_signature(payload, secret, timestamp))
        };
        let event = verify_webhook(payload, &header(now, "whsec"), "whsec", now).unwrap();
        assert_eq!(event.id, "evt_1");
        assert_eq!(event.event_type, "invoice.paid");
        // Environment proof survives verification.
        assert!(event.livemode);
        assert_eq!(event.object["id"], "in_1");
        // Another valid signature among several still verifies.
        let several = format!("t={now},v1=bogus,v1={},v0=old", webhook_signature(payload, "whsec", now));
        assert!(verify_webhook(payload, &several, "whsec", now).is_some());
        assert!(verify_webhook(payload, &header(now, "other"), "whsec", now).is_none());
        assert!(verify_webhook(payload, &header(now - 301, "whsec"), "whsec", now).is_none());
        assert!(verify_webhook(payload, &header(now - 300, "whsec"), "whsec", now).is_some());
        assert!(verify_webhook(b"{\"id\":\"evt_2\"}", &header(now, "whsec"), "whsec", now).is_none());
        assert!(verify_webhook(payload, &format!("t={now}"), "whsec", now).is_none());
        assert!(verify_webhook(payload, "bogus", "whsec", now).is_none());
    }

    #[tokio::test]
    async fn preview_and_seat_update_describe_the_same_operation() {
        let server = stub(|call| match call.path.as_str() {
            "/v1/invoices/create_preview" => (200, json!({"amount_due": 1300, "currency": "usd"})),
            _ => (200, json!({"id": "sub_1", "object": "subscription"})),
        })
        .await;
        let client = StripeClient::new(&server.url, "sk_test_fake");
        let proration_date = 1_790_000_000;
        let preview = client
            .create_invoice_preview(&InvoicePreviewParams {
                subscription_id: "sub_1",
                item_id: "si_1",
                price_id: "price_1",
                quantity: 4,
                proration_date,
            })
            .await
            .unwrap();
        assert_eq!(preview, InvoicePreview { amount_due: 1300 });
        client
            .update_subscription_quantity(
                &SeatUpdate {
                    subscription_id: "sub_1",
                    item_id: "si_1",
                    quantity: 4,
                    direction: SeatDirection::Increase { proration_date },
                },
                "suplex_seat_change_op_1",
            )
            .await
            .unwrap();

        let calls = server.calls();
        assert_eq!(calls[0].header("authorization"), Some("Bearer sk_test_fake"));
        assert_eq!(calls[0].header("stripe-version"), Some("2025-09-30.clover"));
        // The preview uses the mutation's immediate-invoice behavior; the
        // Stripe default would be create_prorations.
        assert_eq!(
            form(&calls[0]),
            [
                ("subscription", "sub_1"),
                ("subscription_details[items][0][id]", "si_1"),
                ("subscription_details[items][0][quantity]", "4"),
                ("subscription_details[items][0][price]", "price_1"),
                ("subscription_details[proration_date]", "1790000000"),
                ("subscription_details[proration_behavior]", "always_invoice"),
            ]
        );
        assert_eq!(calls[1].path, "/v1/subscriptions/sub_1");
        assert_eq!(
            form(&calls[1]),
            [
                ("items[0][id]", "si_1"),
                ("items[0][quantity]", "4"),
                ("proration_behavior", "always_invoice"),
                ("proration_date", "1790000000"),
                ("payment_behavior", "pending_if_incomplete"),
            ]
        );
        assert_eq!(calls[1].header("idempotency-key"), Some("suplex_seat_change_op_1"));
    }

    #[tokio::test]
    async fn a_decrease_sends_proration_none_and_never_a_proration_date() {
        let server = stub(|_| (200, json!({"id": "sub_1"}))).await;
        StripeClient::new(&server.url, "sk_test_fake")
            .update_subscription_quantity(
                &SeatUpdate {
                    subscription_id: "sub_1",
                    item_id: "si_1",
                    quantity: 1,
                    direction: SeatDirection::Decrease,
                },
                "suplex_seat_change_op_2",
            )
            .await
            .unwrap();
        let calls = server.calls();
        assert_eq!(
            form(&calls[0]),
            [("items[0][id]", "si_1"), ("items[0][quantity]", "1"), ("proration_behavior", "none")]
        );
        assert_eq!(calls[0].header("idempotency-key"), Some("suplex_seat_change_op_2"));
    }

    #[tokio::test]
    async fn invoice_preview_rejects_a_non_usd_currency_and_invalid_amounts() {
        for invoice in [
            json!({"amount_due": 1300, "currency": "eur"}),
            json!({"amount_due": -5, "currency": "usd"}),
            json!({"amount_due": 12.5, "currency": "usd"}),
        ] {
            let server = stub(move |_| (200, invoice.clone())).await;
            let preview = StripeClient::new(&server.url, "sk_test_fake")
                .create_invoice_preview(&InvoicePreviewParams {
                    subscription_id: "sub_1",
                    item_id: "si_1",
                    price_id: "price_1",
                    quantity: 4,
                    proration_date: 1_790_000_000,
                })
                .await;
            assert!(preview.is_err());
        }
    }

    #[tokio::test]
    async fn a_charge_read_failure_propagates_and_is_never_a_missing_charge() {
        let server = stub(|call| match call.path.as_str() {
            "/v1/invoices/in_1" => (200, raw_invoice(json!({"payments": {"data": [
                {"id": "ip_1", "status": "paid", "payment": {"type": "payment_intent", "payment_intent": "pi_1"}},
            ], "has_more": false}}))),
            _ => (500, json!({"error": {"type": "api_error"}})),
        })
        .await;
        let read = StripeClient::new(&server.url, "sk_test_fake")
            .retrieve_invoice("in_1")
            .await;
        assert_eq!(read.unwrap_err().to_string(), "stripe error 500");
        let calls = server.calls();
        assert_eq!(calls[1].path, "/v1/payment_intents/pi_1");
        assert_eq!(query(&calls[1]), [("expand[0]", "latest_charge")]);
    }

    #[tokio::test]
    async fn a_paid_invoice_settled_without_a_card_charge_is_a_verified_condition() {
        let server = stub(|call| match call.path.as_str() {
            "/v1/invoices/in_1" => (200, raw_invoice(json!({"amount_due": 0, "amount_paid": 0, "payments": {"data": [
                {"id": "ip_1", "status": "paid", "payment": {"type": "payment_intent", "payment_intent": "pi_1"}},
            ], "has_more": false}}))),
            _ => (200, json!({"id": "pi_1", "status": "succeeded", "latest_charge": null})),
        })
        .await;
        let invoice = StripeClient::new(&server.url, "sk_test_fake")
            .retrieve_invoice("in_1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            invoice.payments,
            [InvoicePayment {
                status: "paid".into(),
                charge_refunded: None,
                settled_without_charge: true,
            }]
        );
    }

    #[tokio::test]
    async fn invoice_payments_paginate_and_a_second_page_changes_the_refund_conclusion() {
        // The second payment's charge is an id and is read separately.
        let server = stub(|call| match call.path.as_str() {
            "/v1/invoices/in_1" => (200, raw_invoice(json!({"amount_due": 6000, "amount_paid": 6000, "payments": {"data": [
                {"id": "ip_1", "status": "paid", "payment": {"type": "charge", "charge": {"id": "ch_1", "amount": 4000, "amount_refunded": 4000, "refunded": true}}},
            ], "has_more": true}}))),
            "/v1/charges/ch_2" => (200, json!({"id": "ch_2", "amount": 2000, "amount_refunded": 0, "refunded": false})),
            _ => (200, json!({"data": [
                {"id": "ip_2", "status": "paid", "payment": {"type": "charge", "charge": "ch_2"}},
            ], "has_more": false})),
        })
        .await;
        let invoice = StripeClient::new(&server.url, "sk_test_fake")
            .retrieve_invoice("in_1")
            .await
            .unwrap()
            .unwrap();
        let calls = server.calls();
        assert_eq!(calls[1].path, "/v1/invoice_payments");
        assert_eq!(
            query(&calls[1]),
            [("invoice", "in_1"), ("limit", "100"), ("starting_after", "ip_1")]
        );
        assert_eq!(calls[2].path, "/v1/charges/ch_2");
        // Page one alone looks fully refunded; page two's payment changes it.
        let refunded = invoice
            .payments
            .iter()
            .filter_map(|payment| payment.charge_refunded)
            .sum::<i64>();
        assert_eq!(invoice.payments.len(), 2);
        assert_eq!(refunded, 4000);
        assert!(refunded < invoice.amount_paid);
        assert_eq!(invoice.payments[1].charge_refunded, Some(0));
    }

    #[tokio::test]
    async fn invoice_lines_carry_the_item_price_and_service_period_and_paginate() {
        let line = |id: &str| {
            json!({
                "id": id,
                "amount": 4000,
                "currency": "usd",
                "quantity": 2,
                "period": {"start": 1_759_000_000, "end": 1_762_000_000},
                "pricing": {"type": "price_details", "price_details": {"price": "price_pro", "product": "prod_pro"}},
                "parent": {
                    "type": "subscription_item_details",
                    "subscription_item_details": {"subscription_item": "si_1", "subscription": "sub_1", "proration": false},
                    "invoice_item_details": null,
                },
                "subscription": "sub_1",
            })
        };
        let first = line("il_1");
        let second = line("il_2");
        let server = stub(move |call| match call.path.as_str() {
            "/v1/invoices/in_1" => (200, raw_invoice(json!({"lines": {"data": [first.clone()], "has_more": true}}))),
            _ => (200, json!({"data": [second.clone()], "has_more": false})),
        })
        .await;
        let invoice = StripeClient::new(&server.url, "sk_test_fake")
            .retrieve_invoice("in_1")
            .await
            .unwrap()
            .unwrap();
        let calls = server.calls();
        assert_eq!(calls[1].path, "/v1/invoices/in_1/lines");
        assert_eq!(query(&calls[1]), [("limit", "100"), ("starting_after", "il_1")]);
        assert_eq!(invoice.lines.len(), 2);
        assert_eq!(
            invoice.lines[0],
            InvoiceLine {
                price_id: Some("price_pro".into()),
                subscription_item_id: Some("si_1".into()),
                period_start: 1_759_000_000,
                period_end: 1_762_000_000,
            }
        );
        assert_eq!(invoice.subscription_id.as_deref(), Some("sub_1"));
    }

    #[tokio::test]
    async fn customer_search_paginates_with_the_next_page_token() {
        let server = stub(|call| {
            if field(&call.query, "page").is_none() {
                (200, json!({"data": [{"id": "cus_1", "metadata": {"account_id": "acct_1"}}], "has_more": true, "next_page": "search_token_2"}))
            } else {
                (200, json!({"data": [{"id": "cus_2", "metadata": {"account_id": "acct_1"}}], "has_more": false, "next_page": null}))
            }
        })
        .await;
        let customers = StripeClient::new(&server.url, "sk_test_fake")
            .search_customers_by_account_id("acct_1")
            .await
            .unwrap();
        let calls = server.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            query(&calls[0]),
            [("query", "metadata[\"account_id\"]:\"acct_1\""), ("limit", "100")]
        );
        // The cursor is the search token, never the last customer's id.
        assert_eq!(field(&calls[1].query, "page"), Some("search_token_2"));
        assert_eq!(
            customers.iter().map(|customer| customer.id.as_str()).collect::<Vec<_>>(),
            ["cus_1", "cus_2"]
        );
        assert_eq!(customers[0].account_id.as_deref(), Some("acct_1"));
    }

    #[tokio::test]
    async fn the_fake_replays_a_key_with_the_original_response_and_never_mutates_twice() {
        let fake = fake_stripe(Arc::new(AtomicI64::new(1_790_000_000_000))).await;
        let (subscription, item) = fake.with(|stripe| {
            let customer = stripe.create_customer("acct_1");
            let subscription = stripe.add_subscription(&customer, 2);
            let item = stripe.subscription(&subscription).items[0].id.clone();
            (subscription, item)
        });
        let client = StripeClient::new(&fake.url, "sk_test_fake");
        let update = |quantity| SeatUpdate {
            subscription_id: &subscription,
            item_id: &item,
            quantity,
            direction: SeatDirection::Increase {
                proration_date: 1_790_000_000,
            },
        };
        client.update_subscription_quantity(&update(4), "key_1").await.unwrap();
        fake.with(|stripe| stripe.subscription(&subscription).items[0].quantity = 3);
        // Same parameters: the recorded response, no second mutation.
        client.update_subscription_quantity(&update(4), "key_1").await.unwrap();
        assert_eq!(fake.with(|stripe| stripe.subscription(&subscription).items[0].quantity), 3);
        // Same key with changed parameters is an error, not a mutation.
        let changed = client.update_subscription_quantity(&update(6), "key_1").await;
        assert_eq!(changed.unwrap_err().to_string(), "stripe error 400");
        assert_eq!(fake.with(|stripe| stripe.update_calls.len()), 3);
    }

    #[test]
    fn subscription_normalization_reads_billing_periods_from_items() {
        let subscription = normalize_subscription(&json!({
            "id": "sub_1",
            "customer": "cus_1",
            "status": "active",
            "created": 1_759_000_000,
            "cancel_at_period_end": true,
            "latest_invoice": "in_1",
            "pending_update": null,
            "metadata": {"app_user_id": "suplex_company_account_1"},
            "items": {"data": [{
                "id": "si_1",
                "price": {"id": "price_pro"},
                "quantity": 3,
                "current_period_start": 1_759_000_000,
                "current_period_end": 1_762_000_000,
            }]},
        }));
        assert_eq!(
            subscription,
            Subscription {
                id: "sub_1".into(),
                status: "active".into(),
                created: 1_759_000_000,
                cancel_at_period_end: true,
                latest_invoice_id: Some("in_1".into()),
                pending_update: None,
                items: vec![Item {
                    id: "si_1".into(),
                    price_id: "price_pro".into(),
                    quantity: 3,
                    period_start: 1_759_000_000,
                    period_end: 1_762_000_000,
                }],
            }
        );
        let pending = normalize_subscription(&json!({"pending_update": {"subscription_items": [{"id": "si_1", "price": "price_pro", "quantity": 5}]}}));
        assert_eq!(pending.pending_update.unwrap()[0].quantity, 5);
        let portal_cancel = normalize_subscription(
            &json!({"cancel_at_period_end": false, "cancel_at": 1_762_000_000}),
        );
        assert!(portal_cancel.cancel_at_period_end);
        assert!(!normalize_subscription(&json!({"cancel_at": null})).cancel_at_period_end);
    }

    #[tokio::test]
    async fn invoice_normalization_resolves_refund_evidence_through_invoice_payments() {
        let server = stub(|call| match call.path.as_str() {
            "/v1/invoices/in_1" => (200, raw_invoice(json!({"payments": {"data": [
                {"id": "ip_1", "status": "paid", "payment": {"type": "payment_intent", "payment_intent": "pi_1"}},
            ], "has_more": false}}))),
            "/v1/payment_intents/pi_1" => (200, json!({"id": "pi_1", "status": "succeeded", "latest_charge": "ch_1"})),
            _ => (200, json!({"id": "ch_1", "amount": 4000, "amount_refunded": 4000, "refunded": true})),
        })
        .await;
        let invoice = StripeClient::new(&server.url, "sk_test_fake")
            .retrieve_invoice("in_1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(invoice.subscription_id.as_deref(), Some("sub_1"));
        assert_eq!(
            invoice.payments,
            [InvoicePayment {
                status: "paid".into(),
                charge_refunded: Some(4000),
                settled_without_charge: false,
            }]
        );
        assert_eq!(server.calls()[2].path, "/v1/charges/ch_1");
    }

    #[test]
    fn price_and_checkout_session_normalization_expose_the_validated_fields() {
        let price = normalize_price(&json!({
            "id": "price_pro",
            "currency": "usd",
            "unit_amount": 2000,
            "billing_scheme": "per_unit",
            "livemode": false,
            "transform_quantity": null,
            "recurring": {"interval": "month", "interval_count": 1, "usage_type": "licensed"},
        }));
        assert_eq!(
            price,
            Price {
                currency: "usd".into(),
                unit_amount: Some(2000),
                billing_scheme: Some("per_unit".into()),
                livemode: false,
                transform_quantity: false,
                recurring: Some(Recurring {
                    interval: "month".into(),
                    interval_count: 1,
                    usage_type: "licensed".into(),
                }),
                tiers_mode: None,
                tiers: vec![],
            }
        );
        let session = normalize_checkout_session(&json!({
            "id": "cs_1",
            "status": "open",
            "payment_status": "unpaid",
            "url": "https://checkout.stripe.com/c/pay/cs_1",
            "subscription": null,
            "customer": "cus_1",
            "expires_at": 1_759_000_000,
            "metadata": {"suplex_quantity": "4"},
            "line_items": {"data": [{"price": {"id": "price_pro"}, "quantity": 4}]},
        }));
        assert_eq!(
            session.line_items,
            [CheckoutLine {
                price_id: "price_pro".into(),
                quantity: 4,
            }]
        );
        assert_eq!(session.metadata["suplex_quantity"], "4");
        let deleted = normalize_customer(&json!({"id": "cus_1", "deleted": true, "metadata": {"account_id": "acct_1"}}));
        assert!(deleted.deleted);
        assert_eq!(deleted.account_id, None);
    }
}
