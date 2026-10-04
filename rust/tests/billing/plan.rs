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
            json!(iso((f.now_ms() / 1000) * 1000 + 30 * DAY_MS))
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
        f.advance(31 * DAY_MS);
        f.stripe
            .with(|stripe| stripe.subscription(&subscription).status = "canceled".into());
        let (_, ended) = f.get("/v1/plan", Some(&token)).await;
        assert_eq!(ended["state"]["active"], json!(false));
        assert_eq!(ended["trialAvailable"], json!(false));
        let (status, used) = trial(&f, &token).await;
        assert_eq!((status, used["code"].clone()), (409, json!("trial_used")));
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
