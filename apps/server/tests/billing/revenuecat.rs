#[cfg(test)]
mod tests {
    use super::*;
    use crate::billing::hosted::fakes::stub;

    // The RevenueCat Stripe integration names products by the Stripe price id.
    const PRO_PRODUCT: &str = "price_pro_monthly";

    fn subscriber(entitlements: Option<Value>, subscriptions: Option<Value>) -> Subscriber {
        parse_subscriber(&json!({"subscriber": {
            "entitlements": entitlements.unwrap_or_else(|| json!({"pro": {
                "product_identifier": PRO_PRODUCT,
                "expires_date": "2026-11-01T00:00:00Z",
                "grace_period_expires_date": null,
            }})),
            "subscriptions": subscriptions.unwrap_or_else(|| json!({PRO_PRODUCT: {
                "store": "stripe",
                "is_sandbox": true,
                "expires_date": "2026-11-01T00:00:00Z",
                "grace_period_expires_date": null,
            }})),
        }}))
        .unwrap()
    }

    fn record(over: Value) -> Value {
        let mut record = json!({"store": "stripe", "is_sandbox": true, "expires_date": "2026-11-01T00:00:00Z"});
        record.as_object_mut().unwrap().extend(over.as_object().unwrap().clone());
        json!({PRO_PRODUCT: record})
    }

    #[tokio::test]
    async fn receipt_import_posts_the_fetch_token_with_the_stripe_app_key_and_platform_header() {
        let server = stub(|_| (200, json!({"subscriber": {}}))).await;
        let client = RevenueCatClient::new(&server.url, "rc_secret", "rc_stripe_public");
        client
            .import_receipt("suplex_company_account_1", "sub_123")
            .await
            .unwrap();
        let calls = server.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].method, "POST");
        assert_eq!(calls[0].path, "/v1/receipts");
        assert_eq!(calls[0].header("authorization"), Some("Bearer rc_stripe_public"));
        assert_eq!(calls[0].header("x-platform"), Some("stripe"));
        assert_eq!(
            calls[0].json(),
            json!({"app_user_id": "suplex_company_account_1", "fetch_token": "sub_123"})
        );
    }

    #[tokio::test]
    async fn receipt_import_trims_the_base_url_and_rejects_non_2xx() {
        let ok = stub(|_| (200, json!({}))).await;
        let client = RevenueCatClient::new(&format!("{}/", ok.url), "s", "p");
        client.import_receipt("u", "sub_1").await.unwrap();
        assert_eq!(ok.calls()[0].path, "/v1/receipts");

        let failing = stub(|_| (503, json!({}))).await;
        let error = RevenueCatClient::new(&failing.url, "s", "p")
            .import_receipt("u", "sub_1")
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "revenuecat error 503");
        assert_eq!(REVENUECAT_API_BASE, "https://api.revenuecat.com");
    }

    #[tokio::test]
    async fn subscriber_read_uses_the_secret_key_encodes_the_app_user_id_and_maps_404_to_none() {
        let server = stub(|_| (200, json!({"subscriber": {"entitlements": {}, "subscriptions": {}}}))).await;
        let client = RevenueCatClient::new(&server.url, "rc_secret", "p");
        let read = client.get_subscriber("suplex_company_account:1").await.unwrap();
        assert_eq!(read, Some(Subscriber::default()));
        let calls = server.calls();
        assert_eq!(calls[0].path, "/v1/subscribers/suplex_company_account%3A1");
        assert_eq!(calls[0].header("authorization"), Some("Bearer rc_secret"));
        assert_eq!(encode_component("a b/c~*'()!"), "a%20b%2Fc~*'()!");

        let missing = stub(|_| (404, json!({}))).await;
        let client = RevenueCatClient::new(&missing.url, "s", "p");
        assert_eq!(client.get_subscriber("nobody").await.unwrap(), None);
    }

    #[test]
    fn pro_entitlement_requires_the_configured_product_in_the_matching_environment() {
        let parsed = subscriber(None, None);
        assert_eq!(
            pro_entitlement_window(&parsed, BillingEnvironment::Sandbox, PRO_PRODUCT),
            Some(ProWindow {
                expires_at: "2026-11-01T00:00:00Z".into(),
                grace_until: None,
            })
        );
        // A sandbox purchase never counts in production.
        assert_eq!(
            pro_entitlement_window(&parsed, BillingEnvironment::Production, PRO_PRODUCT),
            None
        );
        // A foreign product never counts, even for the same entitlement.
        assert_eq!(
            pro_entitlement_window(&parsed, BillingEnvironment::Sandbox, "price_other"),
            None
        );
    }

    #[test]
    fn pro_entitlement_rejects_foreign_or_missing_store_environment_and_product_evidence() {
        let sandbox = |parsed: &Subscriber| {
            pro_entitlement_window(parsed, BillingEnvironment::Sandbox, PRO_PRODUCT)
        };
        assert_eq!(sandbox(&subscriber(None, Some(record(json!({"store": "app_store"}))))), None);
        // A missing store is not proof of a Stripe purchase.
        assert_eq!(
            sandbox(&subscriber(None, Some(json!({PRO_PRODUCT: {"is_sandbox": true, "expires_date": "2026-11-01T00:00:00Z"}})))),
            None
        );
        // A missing transaction environment cannot be matched.
        assert_eq!(
            sandbox(&subscriber(None, Some(json!({PRO_PRODUCT: {"store": "stripe", "expires_date": "2026-11-01T00:00:00Z"}})))),
            None
        );
        // A live transaction does not count in the sandbox.
        assert_eq!(sandbox(&subscriber(None, Some(record(json!({"is_sandbox": false}))))), None);
        assert_eq!(sandbox(&subscriber(None, Some(json!({})))), None);
    }

    #[test]
    fn pro_entitlement_rejects_malformed_missing_and_refunded_proof() {
        let sandbox = |parsed: &Subscriber| {
            pro_entitlement_window(parsed, BillingEnvironment::Sandbox, PRO_PRODUCT)
        };
        // Lifetime or promotional grants (no expiry) do not qualify.
        let lifetime = subscriber(
            Some(json!({"pro": {"product_identifier": PRO_PRODUCT, "expires_date": null}})),
            Some(json!({PRO_PRODUCT: {"store": "stripe", "is_sandbox": true}})),
        );
        assert_eq!(sandbox(&lifetime), None);
        // An unparseable expiry is not proof of access.
        let malformed_expiry = subscriber(
            Some(json!({"pro": {"product_identifier": PRO_PRODUCT, "expires_date": "not-a-date"}})),
            None,
        );
        assert_eq!(sandbox(&malformed_expiry), None);
        // An unparseable grace never manufactures a window.
        let malformed_grace = subscriber(
            Some(json!({"pro": {"product_identifier": PRO_PRODUCT, "expires_date": "2026-11-01T00:00:00Z", "grace_period_expires_date": "garbage"}})),
            None,
        );
        assert_eq!(sandbox(&malformed_grace), None);
        // Refund evidence overrides any remaining window.
        let refunded = subscriber(None, Some(record(json!({"refunded_at": "2026-10-15T00:00:00Z"}))));
        assert_eq!(sandbox(&refunded), None);
        // A payload without a subscriber object is a provider failure.
        assert!(parse_subscriber(&json!("nope")).is_err());
    }

    #[test]
    fn pro_entitlement_surfaces_an_explicit_provider_grace_period() {
        let with_grace = subscriber(
            Some(json!({"pro": {
                "product_identifier": PRO_PRODUCT,
                "expires_date": "2026-10-01T00:00:00Z",
                "grace_period_expires_date": "2026-10-05T00:00:00Z",
            }})),
            None,
        );
        assert_eq!(
            pro_entitlement_window(&with_grace, BillingEnvironment::Sandbox, PRO_PRODUCT),
            Some(ProWindow {
                expires_at: "2026-10-01T00:00:00Z".into(),
                grace_until: Some("2026-10-05T00:00:00Z".into()),
            })
        );
    }
}
