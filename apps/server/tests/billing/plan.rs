#[cfg(test)]
mod tests {
    use axum::http::Method;
    use serde_json::{Value, json};

    use crate::{
        billing::hosted::{fakes::Fixture, iso},
        shared::hash::sha256_hex,
    };

    const DAY_MS: i64 = 86_400_000;

    /// A Suplex account with a host token, as after a login.
    fn login(f: &Fixture, user_id: &str) -> String {
        let token = crate::accounts::wire::random_token().unwrap();
        f.sql(|db| {
            db.execute(
                "INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?1, ?1 || '@example.com', 'now', 'now')",
                [user_id],
            )?;
            db.execute(
                "INSERT INTO account_tokens (token_hash, account_id, installation_id, created_at) VALUES (?1, ?2, 'host', 'now')",
                [sha256_hex(&token), user_id.to_owned()],
            )
        });
        token
    }

    async fn trial(f: &Fixture, token: &str) -> (u16, Value) {
        let authorization = format!("Bearer {token}");
        let response = f
            .send(
                Method::POST,
                "/v1/plan/trial",
                &[("authorization", &authorization)],
                None,
            )
            .await;
        (
            response.status().as_u16(),
            response.json().await.unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn a_suplex_account_starts_one_trial_without_a_payment_method() {
        let f = Fixture::new().await;
        assert_eq!(f.get("/v1/plan", None).await.0, 401);
        assert_eq!(f.get("/v1/plan", Some("x".repeat(43).as_str())).await.0, 401);
        let token = login(&f, "user_1");

        let (status, plan) = f.get("/v1/plan", Some(&token)).await;
        assert_eq!(status, 200);
        assert_eq!(plan["trialAvailable"], json!(true));
        assert_eq!(plan["state"]["active"], json!(false));

        let (status, plan) = trial(&f, &token).await;
        assert_eq!(status, 200, "{plan}");
        assert_eq!(plan["trialAvailable"], json!(false));
        assert_eq!(plan["state"]["active"], json!(true));
        assert_eq!(plan["state"]["subscriptionStatus"], json!("trialing"));
        assert_eq!(plan["state"]["purchasedSeats"], json!(1));
        assert_eq!(
            plan["state"]["accessUntil"],
            json!(iso((f.now_ms() / 1000) * 1000 + 14 * DAY_MS))
        );
        let subscription = f.stripe.with(|stripe| {
            assert_eq!(stripe.customers.len(), 1);
            stripe.subscriptions.keys().next().unwrap().clone()
        });
        // RevenueCat receives the trial like any other subscription.
        assert_eq!(f.revenuecat.with(|rc| rc.imports.len()), 1);

        // A repeated start is the same trial.
        let (status, again) = trial(&f, &token).await;
        assert_eq!(status, 200);
        assert_eq!(again["state"], plan["state"]);
        assert_eq!(f.stripe.with(|stripe| stripe.subscriptions.len()), 1);

        // Without a payment method, Stripe cancels the trial at its end.
        f.advance(15 * DAY_MS);
        f.stripe
            .with(|stripe| stripe.subscription(&subscription).status = "canceled".into());
        let (_, ended) = f.get("/v1/plan", Some(&token)).await;
        assert_eq!(ended["state"]["active"], json!(false));
        assert_eq!(ended["trialAvailable"], json!(false));
        let (status, used) = trial(&f, &token).await;
        assert_eq!((status, used["code"].clone()), (409, json!("trial_used")));
    }

    #[tokio::test]
    async fn team_checkout_buys_seats_and_the_plan_reports_team_to_hosts_that_ask() {
        use crate::billing::hosted::fakes::{TEAM_PRICE_ID, team_price};
        let f = Fixture::new().await;
        let token = login(&f, "user_1");
        // Pro is one seat; Team buys at least its 3 included seats.
        for (key, body) in [
            ("key-seats-0", json!({"quantity": 4})),
            ("key-seats-1", json!({"plan": "team", "quantity": 2})),
        ] {
            let (status, _) = f.post("/v1/plan/checkout", Some(&token), Some(key), &body).await;
            assert_eq!(status, 400, "{body}");
        }
        let (status, body) = f
            .post(
                "/v1/plan/checkout",
                Some(&token),
                Some("key-seats-4"),
                &json!({"plan": "team", "quantity": 4}),
            )
            .await;
        assert_eq!((status, body["status"].clone()), (200, json!("redirect")), "{body}");
        let customer = f.stripe.with(|stripe| {
            assert_eq!(stripe.sessions[0].line_items, [(TEAM_PRICE_ID.to_owned(), 4)]);
            stripe.sessions[0].customer_id.clone()
        });

        // Only a host that asks with `tier=1` receives the plan field.
        f.stripe.with(|stripe| {
            let subscription = stripe.add_subscription(&customer, 4);
            stripe.subscription(&subscription).items[0].price_id = TEAM_PRICE_ID.into();
        });
        let (_, old) = f.get("/v1/plan", Some(&token)).await;
        assert_eq!((old["state"]["active"].clone(), old.get("plan")), (json!(true), None), "{old}");
        let (_, new) = f.get("/v1/plan?tier=1", Some(&token)).await;
        assert_eq!(new["plan"], json!("team"), "{new}");
        assert_eq!(new["state"]["purchasedSeats"], json!(4));

        // A Team price with other tiers never sells.
        let f = Fixture::new().await;
        let token = login(&f, "user_2");
        f.stripe
            .with(|stripe| stripe.team_price = team_price(TEAM_PRICE_ID, "month", 7500, 1000));
        let (status, body) = f
            .post("/v1/plan/checkout", Some(&token), Some("key-seats-5"), &json!({"plan": "team"}))
            .await;
        assert_eq!((status, body["code"].clone()), (503, json!("billing_setup_invalid")));
    }

    #[tokio::test]
    async fn checkout_buys_the_requested_pro_price() {
        use crate::billing::hosted::fakes::{ANNUAL_PRICE_ID, PRICE_ID};
        let f = Fixture::new().await;
        let token = login(&f, "user_1");
        let annual = json!({"interval": "year"});

        let (status, body) = f
            .post("/v1/plan/checkout", Some(&token), Some("key-annual-1"), &annual)
            .await;
        assert_eq!((status, body["status"].clone()), (200, json!("redirect")), "{body}");
        let (annual_session, customer) = f.stripe.with(|stripe| {
            let session = &stripe.sessions[0];
            assert_eq!(session.line_items, [(ANNUAL_PRICE_ID.to_owned(), 1)]);
            (session.id.clone(), session.customer_id.clone())
        });

        // One key buys one price.
        let (status, body) = f
            .post("/v1/plan/checkout", Some(&token), Some("key-annual-1"), &json!({}))
            .await;
        assert_eq!((status, body["code"].clone()), (409, json!("idempotency_conflict")));
        let (status, _) = f
            .post("/v1/plan/checkout", Some(&token), Some("key-annual-2"), &json!({"interval": "week"}))
            .await;
        assert_eq!(status, 400);

        // A host before annual Pro sends no body: monthly, and the open
        // annual session is not reused.
        let authorization = format!("Bearer {token}");
        let response = f
            .send(
                Method::POST,
                "/v1/plan/checkout",
                &[("authorization", &authorization), ("idempotency-key", "key-monthly-1")],
                None,
            )
            .await;
        assert_eq!(response.status().as_u16(), 200);
        f.stripe.with(|stripe| {
            assert_eq!(stripe.expire_calls, std::slice::from_ref(&annual_session));
            assert_eq!(stripe.sessions[1].line_items, [(PRICE_ID.to_owned(), 1)]);
        });

        // An annual subscription is Pro.
        f.stripe.with(|stripe| {
            let subscription = stripe.add_subscription(&customer, 1);
            stripe.subscription(&subscription).items[0].price_id = ANNUAL_PRICE_ID.into();
        });
        let (_, plan) = f.get("/v1/plan", Some(&token)).await;
        assert_eq!(plan["state"]["active"], json!(true), "{plan}");

        // A misconfigured annual price never sells.
        let f = Fixture::new().await;
        let token = login(&f, "user_2");
        f.stripe.with(|stripe| stripe.annual_price["unit_amount"] = json!(24000));
        let (status, body) = f
            .post("/v1/plan/checkout", Some(&token), Some("key-annual-3"), &annual)
            .await;
        assert_eq!((status, body["code"].clone()), (503, json!("billing_setup_invalid")));
        assert_eq!(f.stripe.with(|stripe| stripe.sessions.len()), 0);
    }

    #[tokio::test]
    async fn each_suplex_account_has_its_own_billing_account() {
        let f = Fixture::new().await;
        let first = login(&f, "user_1");
        let second = login(&f, "user_2");
        assert_eq!(trial(&f, &first).await.0, 200);
        let (_, plan) = f.get("/v1/plan", Some(&second)).await;
        assert_eq!(plan["trialAvailable"], json!(true));
        assert_eq!(plan["state"]["active"], json!(false));
        assert_eq!(f.count("SELECT COUNT(*) FROM billing_accounts"), 2);
        // A Suplex account ID is not a registration a host can claim.
        assert!(f.hosted.billing_for_user("user_1").unwrap().company_id.is_empty());
    }
}
