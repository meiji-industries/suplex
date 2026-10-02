#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use chrono::Utc;
    use serde_json::{Value, json};

    use crate::billing::tests::{active_state, fixture};

    const ORIGIN: &str = "https://suplex.example.test:4111";

    async fn serve(state: crate::http::AppState) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(
            axum::serve(
                listener,
                crate::http::router(state)
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .into_future(),
        );
        format!("http://{address}")
    }

    fn post(
        base: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> reqwest::RequestBuilder {
        let mut request = reqwest::Client::new().post(format!("{base}{path}"));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        match body {
            Some(body) => request.json(&body),
            None => request,
        }
    }

    #[tokio::test]
    async fn members_read_the_summary_while_money_commands_stay_administrator_only() {
        let f = fixture().await;
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        let member_token = f.state.with_database(|database| {
            crate::identity::auth::create_session(database, "member-1", Utc::now()).unwrap()
        });
        let other = f.state.with_database(|database| {
            crate::identity::companies::create_company(database, &f.admin_id, "Other", Utc::now())
                .unwrap()
                .id
        });
        let base = serve(f.state.clone()).await;
        let client = reqwest::Client::new();
        let member = format!("sid_v1={member_token}");
        let admin = format!("sid_v1={}", f.admin_token);
        let read = |company: &str, cookie: &str| {
            client
                .get(format!("{base}/api/companies/{company}/billing"))
                .header("cookie", cookie)
                .send()
        };
        let summary = read(&f.company_id, &member).await.unwrap();
        assert_eq!(summary.status(), StatusCode::OK);
        assert_eq!(summary.headers()["cache-control"], "no-store");
        let summary: Value = summary.json().await.unwrap();
        assert_eq!(
            (&summary["plan"], &summary["canManageBilling"], &summary["canCreateProject"]),
            (&json!("free"), &json!(false), &json!(true))
        );
        let admin_summary: Value = read(&f.company_id, &admin)
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(admin_summary["canManageBilling"], true);
        assert_eq!(read(&other, &member).await.unwrap().status(), 404);
        for (path, body) in [
            ("checkout", Some(json!({"quantity": 2}))),
            ("seats/preview", Some(json!({"quantity": 2}))),
            ("seats", Some(json!({"quantity": 3, "confirmNoRefund": true}))),
            ("portal", None),
        ] {
            for company in [&f.company_id, &other] {
                let denied = post(
                    &base,
                    &format!("/api/companies/{company}/billing/{path}"),
                    &[
                        ("cookie", &member),
                        ("origin", ORIGIN),
                        ("idempotency-key", "key-member-001"),
                    ],
                    body.clone(),
                )
                .send()
                .await
                .unwrap();
                assert_eq!(denied.status(), 404, "{path}");
            }
        }
        let missing = post(
            &base,
            "/api/companies/company_missing/billing/portal",
            &[("cookie", &admin), ("origin", ORIGIN)],
            None,
        )
        .send()
        .await
        .unwrap();
        assert_eq!(missing.status(), 404);
        assert!(f.fake.with(|hosted| hosted.calls.is_empty()));
    }

    #[tokio::test]
    async fn a_foreign_origin_cannot_reach_billing_with_or_without_a_cookie() {
        let f = fixture().await;
        let base = serve(f.state.clone()).await;
        let admin = format!("sid_v1={}", f.admin_token);
        for (path, body) in [
            ("checkout", Some(json!({"quantity": 2}))),
            ("seats/preview", Some(json!({"quantity": 2}))),
            ("seats", Some(json!({"quantity": 3, "confirmNoRefund": true}))),
            ("portal", None),
        ] {
            for headers in [
                &[
                    ("origin", "https://attacker.invalid"),
                    ("idempotency-key", "key-attack-001"),
                ][..],
                &[
                    ("origin", "https://attacker.invalid"),
                    ("idempotency-key", "key-attack-001"),
                    ("cookie", &admin),
                ][..],
            ] {
                let denied = post(
                    &base,
                    &format!("/api/companies/{}/billing/{path}", f.company_id),
                    headers,
                    body.clone(),
                )
                .send()
                .await
                .unwrap();
                assert_eq!(denied.status(), 403, "{path}");
                assert_eq!(
                    denied.json::<Value>().await.unwrap(),
                    json!({"error": "request_origin_invalid"})
                );
            }
        }
        assert!(f.fake.with(|hosted| hosted.calls.is_empty()));
        assert_eq!(f.binding(), None);
    }

    #[tokio::test]
    async fn checkout_and_seat_changes_require_and_forward_the_idempotency_key() {
        let f = fixture().await;
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, active_state(4)));
        let base = serve(f.state.clone()).await;
        let admin = format!("sid_v1={}", f.admin_token);
        let send = |path: &str, key: Option<&str>, body: Value| {
            let mut headers = vec![("cookie", admin.as_str()), ("origin", ORIGIN)];
            headers.extend(key.map(|key| ("idempotency-key", key)));
            post(
                &base,
                &format!("/api/companies/{}/billing/{path}", f.company_id),
                &headers,
                Some(body),
            )
            .send()
        };
        for (path, key, body) in [
            ("checkout", None, json!({"quantity": 2})),
            ("checkout", Some("short"), json!({"quantity": 2})),
            ("seats", None, json!({"quantity": 3, "confirmNoRefund": true})),
            (
                "seats",
                Some("key-mixed-0001"),
                json!({"quantity": 3, "previewId": "p", "confirmNoRefund": true}),
            ),
            ("seats", Some("key-false-0001"), json!({"quantity": 3, "confirmNoRefund": false})),
            ("checkout", Some("key-extra-0001"), json!({"quantity": 2, "extra": 1})),
            ("checkout", Some("key-big-00001"), json!({"quantity": 10000})),
        ] {
            assert_eq!(send(path, key, body).await.unwrap().status(), 400, "{path} {key:?}");
        }
        assert!(f.fake.with(|hosted| hosted.calls.is_empty()));
        let checkout = send("checkout", Some("key-checkout-verbatim"), json!({"quantity": 2}))
            .await
            .unwrap();
        assert_eq!(checkout.status(), 200);
        assert_eq!(
            checkout.json::<Value>().await.unwrap(),
            json!({"status": "redirect", "url": "https://checkout.stripe.com/c/pay/session_1"})
        );
        let preview = send("seats/preview", None, json!({"quantity": 4})).await.unwrap();
        assert_eq!(preview.status(), 200);
        assert_eq!(preview.json::<Value>().await.unwrap()["previewId"], "op_preview");
        let seats = send(
            "seats",
            Some("key-seats-verbatim"),
            json!({"quantity": 4, "previewId": "op_preview"}),
        )
        .await
        .unwrap();
        assert_eq!(seats.status(), 200);
        let seats: Value = seats.json().await.unwrap();
        assert_eq!(
            (&seats["status"], &seats["summary"]["plan"], &seats["summary"]["purchasedSeats"]),
            (&json!("applied"), &json!("pro"), &json!(4))
        );
        let keys = f.fake.with(|hosted| {
            hosted
                .calls
                .iter()
                .filter_map(|call| call.idempotency_key.clone())
                .collect::<Vec<_>>()
        });
        assert_eq!(keys, ["key-checkout-verbatim", "key-seats-verbatim"]);
        let below = send("checkout", Some("key-too-few-0001"), json!({"quantity": 1}));
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        let below = below.await.unwrap();
        assert_eq!(below.status(), 422);
        assert_eq!(below.json::<Value>().await.unwrap()["code"], "invalid_seat_quantity");
    }

    #[tokio::test]
    async fn known_hosted_failures_keep_their_status_through_the_route() {
        let f = fixture().await;
        f.bind(Some("acct_1"));
        f.fake.with(|hosted| {
            hosted.respond(
                "/v1/portal",
                409,
                json!({"error": "pending", "code": "billing_payment_pending"}),
            );
        });
        let base = serve(f.state.clone()).await;
        let admin = format!("sid_v1={}", f.admin_token);
        let pending = post(
            &base,
            &format!("/api/companies/{}/billing/portal", f.company_id),
            &[("cookie", &admin), ("origin", ORIGIN)],
            None,
        )
        .send()
        .await
        .unwrap();
        assert_eq!(pending.status(), 409);
        assert_eq!(
            pending.json::<Value>().await.unwrap(),
            json!({"error": "A billing payment is still pending", "code": "billing_payment_pending"})
        );
    }

    #[tokio::test]
    async fn the_third_free_project_is_refused_before_any_repository_work() {
        let f = fixture().await;
        f.project("one");
        f.project("two");
        let root = std::env::temp_dir().join(format!("suplex-billing-roots-{}", uuid::Uuid::new_v4()));
        let base = serve(
            f.state
                .clone()
                .with_project_roots(root.join("repositories"), root.join("worktrees")),
        )
        .await;
        let admin = format!("sid_v1={}", f.admin_token);
        let refused = post(
            &base,
            &format!("/api/companies/{}/projects", f.company_id),
            &[("cookie", &admin), ("origin", ORIGIN)],
            Some(json!({"repositoryUrl": "https://github.com/acme/three.git"})),
        )
        .send()
        .await
        .unwrap();
        assert_eq!(refused.status(), 402);
        assert_eq!(
            refused.json::<Value>().await.unwrap(),
            json!({"error": "Project limit reached", "code": "project_limit_reached"})
        );
        assert!(!root.exists(), "no repository was provisioned");
    }

    #[tokio::test]
    async fn the_company_list_carries_each_plan_label_from_local_data() {
        let f = fixture().await;
        let other = f.state.with_database(|database| {
            crate::identity::companies::create_company(database, &f.admin_id, "Other", Utc::now())
                .unwrap()
                .id
        });
        f.bind(Some("acct_1"));
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, active_state(1)));
        let base = serve(f.state.clone()).await;
        let list = || async {
            reqwest::Client::new()
                .get(format!("{base}/api/companies"))
                .header("cookie", format!("sid_v1={}", f.admin_token))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()["companies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|company| (company["id"].as_str().unwrap().to_owned(), company["plan"].clone()))
                .collect::<std::collections::HashMap<_, _>>()
        };
        // The first list answers from local data; the bound company has no
        // snapshot yet, so it has no label and is read in the background.
        let first = list().await;
        assert_eq!(first[&other], json!("free"));
        assert_eq!(first[&f.company_id], Value::Null);
        while list().await[&f.company_id] != json!("pro") {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let reads = f.fake.with(|hosted| hosted.count("/v1/billing"));
        list().await;
        assert_eq!(f.fake.with(|hosted| hosted.count("/v1/billing")), reads);
    }
}
