#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use chrono::Utc;
    use serde_json::{Value, json};

    use crate::billing::tests::{fixture, pro_plan};

    const ORIGIN: &str = "https://suplex.example.test:4111";

    fn client() -> reqwest::Client {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("host", "suplex.example.test:4111".parse().unwrap());
        headers.insert("x-forwarded-host", "suplex.example.test:4111".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        reqwest::Client::builder().default_headers(headers).build().unwrap()
    }

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
        let mut request = client().post(format!("{base}{path}"));
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
            crate::http::routes::auth::tests::verified_session(database, "member-1", Utc::now()).unwrap()
        });
        let base = serve(f.state.clone()).await;
        let member = format!("sid_v1={member_token}");
        let admin = format!("sid_v1={}", f.admin_token);
        let read = |cookie: &str| client().get(format!("{base}/api/billing")).header("cookie", cookie).send();
        let summary = read(&member).await.unwrap();
        assert_eq!(summary.status(), StatusCode::OK);
        assert_eq!(summary.headers()["cache-control"], "no-store");
        let summary: Value = summary.json().await.unwrap();
        assert_eq!((&summary["plan"], &summary["canManageBilling"]), (&json!("free"), &json!(false)));
        let admin_summary: Value = read(&admin).await.unwrap().json().await.unwrap();
        assert_eq!(admin_summary["canManageBilling"], true);
        let reads = f.reads();
        for path in ["trial", "checkout", "portal"] {
            let denied = post(
                &base,
                &format!("/api/billing/{path}"),
                &[("cookie", &member), ("origin", ORIGIN), ("idempotency-key", "key-member-001")],
                None,
            )
            .send()
            .await
            .unwrap();
            assert_eq!(denied.status(), 404, "{path}");
        }
        assert_eq!(f.fake.with(|hosted| hosted.calls.len()), reads);
    }

    #[tokio::test]
    async fn a_foreign_origin_cannot_reach_billing_with_or_without_a_cookie() {
        let f = fixture().await;
        let base = serve(f.state.clone()).await;
        let admin = format!("sid_v1={}", f.admin_token);
        for path in ["trial", "checkout", "portal"] {
            for headers in [
                &[("origin", "https://attacker.invalid"), ("idempotency-key", "key-attack-001")][..],
                &[("origin", "https://attacker.invalid"), ("idempotency-key", "key-attack-001"), ("cookie", &admin)][..],
            ] {
                let denied = post(&base, &format!("/api/billing/{path}"), headers, None)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(denied.status(), 403, "{path}");
                assert_eq!(denied.json::<Value>().await.unwrap(), json!({"error": "request_origin_invalid"}));
            }
        }
        assert!(f.fake.with(|hosted| hosted.calls.is_empty()));
    }

    #[tokio::test]
    async fn checkout_requires_and_forwards_the_idempotency_key() {
        let f = fixture().await;
        let base = serve(f.state.clone()).await;
        let admin = format!("sid_v1={}", f.admin_token);
        let send = |key: Option<&str>| {
            let mut headers = vec![("cookie", admin.as_str()), ("origin", ORIGIN)];
            headers.extend(key.map(|key| ("idempotency-key", key)));
            post(&base, "/api/billing/checkout", &headers, None).send()
        };
        assert_eq!(send(None).await.unwrap().status(), 400);
        assert_eq!(send(Some("short")).await.unwrap().status(), 400);
        assert!(f.fake.with(|hosted| hosted.calls.is_empty()));
        let checkout = send(Some("key-checkout-verbatim")).await.unwrap();
        assert_eq!(checkout.status(), 200);
        assert_eq!(
            checkout.json::<Value>().await.unwrap(),
            json!({"status": "redirect", "url": "https://checkout.stripe.com/c/pay/session_1"})
        );
        assert_eq!(
            f.fake.with(|hosted| hosted.calls[0].idempotency_key.clone()),
            Some("key-checkout-verbatim".into())
        );
    }

    #[tokio::test]
    async fn known_hosted_failures_keep_their_status_through_the_route() {
        let f = fixture().await;
        f.fake.with(|hosted| {
            hosted.respond("/v1/plan/portal", 409, json!({"error": "pending", "code": "billing_payment_pending"}));
        });
        let base = serve(f.state.clone()).await;
        let admin = format!("sid_v1={}", f.admin_token);
        let pending = post(&base, "/api/billing/portal", &[("cookie", &admin), ("origin", ORIGIN)], None)
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
    async fn the_second_free_project_is_refused_before_any_repository_work() {
        let f = fixture().await;
        f.sql(
            "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES ('one', ?1, 'one', '/tmp/one', '/tmp/one-worktrees', 'acme/one', 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')",
            &[&f.company_id],
        );
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
            Some(json!({"repositoryUrl": "https://github.com/acme/two.git"})),
        )
        .send()
        .await
        .unwrap();
        assert_eq!(refused.status(), 402);
        assert_eq!(refused.json::<Value>().await.unwrap()["code"], "project_limit_reached");
        assert!(!root.exists(), "no repository was provisioned");
        // suplex.sh was read before the refusal.
        assert_eq!(f.reads(), 1);
    }

    #[tokio::test]
    async fn the_company_list_carries_the_installation_plan_from_local_data() {
        let f = fixture().await;
        let base = serve(f.state.clone()).await;
        let list = || async {
            client()
                .get(format!("{base}/api/companies"))
                .header("cookie", format!("sid_v1={}", f.admin_token))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()["companies"][0]["plan"]
                .clone()
        };
        assert_eq!(list().await, json!("free"));
        f.fake.with(|hosted| hosted.respond("/v1/plan", 200, pro_plan()));
        crate::billing::refresh(&f.state).await.unwrap();
        assert_eq!(list().await, json!("pro"));
        assert_eq!(f.reads(), 1);
    }
}
