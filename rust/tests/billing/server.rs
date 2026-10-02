#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::http::Method;
    use serde_json::json;

    use super::*;
    use crate::billing::hosted::fakes::{Fixture, random_credential};

    fn environment(overrides: &[(&str, &str)]) -> HashMap<String, String> {
        let mut variables = [
            ("BILLING_DATABASE_PATH", "/var/lib/suplex-billing/billing.sqlite"),
            ("BILLING_ENVIRONMENT", "sandbox"),
            ("BILLING_PUBLIC_ORIGIN", "https://billing.example.com/ignored/path"),
            ("STRIPE_SECRET_KEY", "sk_test_1"),
            ("STRIPE_PRO_MONTHLY_PRICE_ID", "price_1"),
            ("STRIPE_PORTAL_CONFIGURATION_ID", "bpc_1"),
            ("STRIPE_WEBHOOK_SECRET", "whsec_1"),
            ("REVENUECAT_SECRET_API_KEY", "rc_secret"),
            ("REVENUECAT_STRIPE_PUBLIC_API_KEY", "rc_public"),
            ("REVENUECAT_WEBHOOK_AUTHORIZATION", "rc-auth"),
            ("REVENUECAT_APP_ID", "app_1"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect::<HashMap<_, _>>();
        for (name, value) in overrides {
            variables.insert((*name).to_owned(), (*value).to_owned());
        }
        variables
    }

    fn load(overrides: &[(&str, &str)]) -> Result<ServiceConfig, String> {
        let variables = environment(overrides);
        load_config(&|name| variables.get(name).cloned())
    }

    #[tokio::test]
    async fn return_pages_render_plain_text_and_health_reports_ok() {
        let f = Fixture::new().await;
        for path in ["/checkout/return", "/checkout/cancel", "/portal/return"] {
            let response = f.send(Method::GET, path, &[], None).await;
            assert_eq!(response.status(), 200);
            assert!(response.text().await.unwrap().contains("return to Suplex"));
        }
        assert_eq!(
            f.get("/health", None).await,
            (200, json!({"ok": true, "events": {"pending": 0}}))
        );
    }

    #[tokio::test]
    async fn responses_carry_cache_control_no_store() {
        let f = Fixture::new().await;
        for path in ["/health", "/v1/billing", "/checkout/return"] {
            let response = f.send(Method::GET, path, &[], None).await;
            assert_eq!(response.headers()["cache-control"], "no-store", "{path}");
        }
    }

    #[tokio::test]
    async fn bodies_over_one_mebibyte_are_refused_with_413() {
        let f = Fixture::new().await;
        let oversized = json!({"padding": "x".repeat(1 << 20)});
        let response = f.send(Method::POST, "/v1/accounts", &[], Some(&oversized)).await;
        assert_eq!(response.status(), 413);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.json::<Value>().await.unwrap(), json!({"error": "Invalid request"}));
        // Malformed JSON is a plain 400.
        let response = f.post_raw("/v1/accounts", "application/json", "{").await;
        assert_eq!(response, (400, json!({"error": "Invalid request"})));
        let response = f.post_raw("/v1/accounts", "text/plain", "{}").await;
        assert_eq!(response, (415, json!({"error": "Invalid request"})));
        // The RevenueCat secret is checked before the body is read.
        let response = f
            .send(Method::POST, "/webhooks/revenuecat", &[("authorization", "wrong")], Some(&oversized))
            .await;
        assert_eq!(response.status(), 401);
    }

    #[test]
    fn configuration_is_read_and_validated_from_the_environment() {
        let config = load(&[]).unwrap();
        assert_eq!(config.origin, "https://billing.example.com");
        assert_eq!((config.address.as_str(), config.port), ("127.0.0.1", 4211));
        assert_eq!(config.environment, BillingEnvironment::Sandbox);
        assert_eq!(config.hosted().revenuecat_webhook_authorization, "rc-auth");
        let custom = load(&[
            ("BILLING_PUBLIC_ORIGIN", "http://localhost:4211"),
            ("BILLING_BIND_ADDRESS", "0.0.0.0"),
            ("BILLING_PORT", "8080"),
            ("BILLING_DATABASE_PATH", "C:\\billing\\billing.sqlite"),
            ("BILLING_ENVIRONMENT", "production"),
        ])
        .unwrap();
        assert_eq!(custom.origin, "http://localhost:4211");
        assert_eq!((custom.address.as_str(), custom.port), ("0.0.0.0", 8080));
        assert_eq!(custom.environment, BillingEnvironment::Production);

        for (overrides, message) in [
            (vec![("STRIPE_SECRET_KEY", "")], "STRIPE_SECRET_KEY is required"),
            (
                vec![("BILLING_DATABASE_PATH", "billing.sqlite")],
                "BILLING_DATABASE_PATH must be an absolute path separate from any Suplex installation database",
            ),
            (
                vec![("BILLING_ENVIRONMENT", "test")],
                "BILLING_ENVIRONMENT must be exactly 'sandbox' or 'production'",
            ),
            (
                vec![("BILLING_PUBLIC_ORIGIN", "http://billing.example.com")],
                "BILLING_PUBLIC_ORIGIN must use HTTPS except on explicit loopback hosts",
            ),
            (
                vec![("BILLING_PUBLIC_ORIGIN", "https://user:pass@billing.example.com")],
                "BILLING_PUBLIC_ORIGIN must not contain credentials",
            ),
            (vec![("BILLING_PUBLIC_ORIGIN", "not a url")], "BILLING_PUBLIC_ORIGIN must be a valid URL"),
            (vec![("BILLING_PORT", "0")], "BILLING_PORT must be an integer between 1 and 65535"),
            (vec![("BILLING_PORT", "65536")], "BILLING_PORT must be an integer between 1 and 65535"),
        ] {
            assert_eq!(load(&overrides).unwrap_err(), message);
        }
    }

    #[tokio::test]
    async fn rotate_credential_verifies_stripe_ownership_and_replaces_the_hash() {
        let f = Fixture::new().await;
        let p = f.provisioned(2).await;
        // A read records the account's verified Stripe customer.
        f.state(&p.account.credential).await;
        let database = f.path.to_string_lossy().into_owned();
        let args = |account: &str| {
            ["--db", database.as_str(), "--account", account]
                .map(str::to_owned)
                .to_vec()
        };
        let fresh = random_credential();
        let variables = HashMap::from([
            ("NEW_BILLING_CREDENTIAL".to_owned(), fresh.clone()),
            ("STRIPE_SECRET_KEY".to_owned(), "sk_test_fake".to_owned()),
        ]);
        let env = |name: &str| variables.get(name).cloned();

        assert_eq!(
            rotate_credential(&args(&p.account.id)[..2], &env, &f.stripe.url).await,
            Err(ROTATE_USAGE.into())
        );
        assert_eq!(
            rotate_credential(&["--db".to_owned()], &env, &f.stripe.url).await,
            Err("--db requires a value".into())
        );
        assert_eq!(
            rotate_credential(&args("account_missing"), &env, &f.stripe.url).await,
            Err("No billing account named account_missing".into())
        );
        assert_eq!(
            rotate_credential(&args(&p.account.id), &|_| None, &f.stripe.url).await,
            Err("NEW_BILLING_CREDENTIAL must be set to a 32-byte base64url credential (43 characters)".into())
        );
        let no_key = |name: &str| (name == "NEW_BILLING_CREDENTIAL").then(|| fresh.clone());
        assert_eq!(
            rotate_credential(&args(&p.account.id), &no_key, &f.stripe.url).await,
            Err("STRIPE_SECRET_KEY is required to verify the account's Stripe customer record".into())
        );

        // A customer that points at another account refuses rotation.
        let foreign = f.stripe.with(|stripe| stripe.create_customer("account_other"));
        f.sql(|db| {
            db.execute(
                "UPDATE billing_accounts SET stripe_customer_id = ?1 WHERE id = ?2",
                [&foreign, &p.account.id],
            )
        });
        assert_eq!(
            rotate_credential(&args(&p.account.id), &env, &f.stripe.url).await,
            Err("The stored Stripe customer does not belong to this account; refusing rotation".into())
        );
        assert_eq!(f.get("/v1/billing", Some(&p.account.credential)).await.0, 200);

        f.sql(|db| {
            db.execute(
                "UPDATE billing_accounts SET stripe_customer_id = ?1 WHERE id = ?2",
                [&p.customer, &p.account.id],
            )
        });
        let message = rotate_credential(&args(&p.account.id), &env, &f.stripe.url)
            .await
            .unwrap();
        assert_eq!(
            message,
            format!(
                "Rotated the billing credential for account {}. The previous credential no longer works.",
                p.account.id
            )
        );
        assert_eq!(f.get("/v1/billing", Some(&p.account.credential)).await.0, 401);
        assert_eq!(f.state(&fresh).await["purchasedSeats"], 2);

        // An account that never reached Stripe rotates without a Stripe key.
        let bare = f.register().await;
        let other = random_credential();
        let only_credential = |name: &str| (name == "NEW_BILLING_CREDENTIAL").then(|| other.clone());
        assert!(rotate_credential(&args(&bare.id), &only_credential, &f.stripe.url).await.is_ok());
        assert_eq!(f.get("/v1/billing", Some(&other)).await.0, 200);
    }
}
