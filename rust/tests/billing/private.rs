#[cfg(test)]
pub(crate) mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use axum::{
        body::Bytes,
        http::{HeaderMap, Method as HttpMethod, StatusCode, Uri},
        response::IntoResponse,
    };
    use chrono::Utc;
    use serde_json::{Value, json};
    use url::Url;

    use super::*;
    use crate::http::AppState;

    /// One request the fake hosted billing API received.
    #[derive(Clone, Debug)]
    pub(crate) struct Call {
        pub path: String,
        pub body: Value,
        pub authorization: Option<String>,
        pub idempotency_key: Option<String>,
    }

    /// A loopback fake of the hosted billing API. Each path answers with its
    /// configured status and raw body; `once` answers win for one request.
    #[derive(Default)]
    pub(crate) struct Hosted {
        pub calls: Vec<Call>,
        pub responses: HashMap<String, (u16, String)>,
        pub once: HashMap<String, (u16, String)>,
        pub registration_delay: Duration,
    }

    impl Hosted {
        pub fn count(&self, path: &str) -> usize {
            self.calls.iter().filter(|call| call.path == path).count()
        }

        pub fn respond(&mut self, path: &str, status: u16, body: Value) {
            self.responses
                .insert(path.to_owned(), (status, body.to_string()));
        }
    }

    pub(crate) fn active_state(seats: i64) -> Value {
        json!({"active": true, "purchasedSeats": seats, "subscriptionStatus": "active", "renewalAt": "2099-01-01T00:00:00.000Z", "accessUntil": "2099-01-01T00:00:00.000Z", "cancelAtPeriodEnd": false, "paymentActionRequired": false, "paymentActionUrl": null, "environment": "sandbox"})
    }

    pub(crate) fn inactive_state() -> Value {
        json!({"active": false, "purchasedSeats": 0, "subscriptionStatus": "none", "renewalAt": null, "accessUntil": null, "cancelAtPeriodEnd": false, "paymentActionRequired": false, "paymentActionUrl": null, "environment": "sandbox"})
    }

    pub(crate) struct FakeHosted {
        pub url: Url,
        pub hosted: Arc<Mutex<Hosted>>,
    }

    impl FakeHosted {
        pub fn with<T>(&self, change: impl FnOnce(&mut Hosted) -> T) -> T {
            change(&mut self.hosted.lock().unwrap())
        }

        pub fn client(&self) -> BillingClient {
            BillingClient::new(self.url.clone(), "installation-test".to_owned())
        }
    }

    pub(crate) async fn fake_hosted() -> FakeHosted {
        let hosted = Arc::new(Mutex::new(Hosted::default()));
        hosted.lock().unwrap().responses = [
            ("/v1/accounts", json!({"accountId": "acct_1"})),
            ("/v1/billing", inactive_state()),
            ("/v1/checkout", json!({"status": "redirect", "operationId": "op_checkout", "url": "https://checkout.stripe.com/c/pay/session_1"})),
            ("/v1/seats/preview", json!({"previewId": "op_preview", "expiresAt": "2099-01-01T00:05:00.000Z", "currentQuantity": 1, "requestedQuantity": 7, "amountDueNow": 2100, "nextSubtotal": 14000, "currency": "usd", "prorationTimestamp": 1_759_700_000})),
            ("/v1/seats", json!({"status": "applied", "operationId": "op_seats", "state": active_state(4)})),
            ("/v1/portal", json!({"url": "https://billing.stripe.com/session/portal_1"})),
        ]
        .into_iter()
        .map(|(path, body)| (path.to_owned(), (200, body.to_string())))
        .collect();
        let shared = hosted.clone();
        let app = axum::Router::new().fallback(
            move |_method: HttpMethod, uri: Uri, headers: HeaderMap, body: Bytes| {
                let hosted = shared.clone();
                async move {
                    let header = |name: &str| {
                        headers
                            .get(name)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned)
                    };
                    let path = uri.path().to_owned();
                    let delay = {
                        let mut hosted = hosted.lock().unwrap();
                        hosted.calls.push(Call {
                            path: path.clone(),
                            body: serde_json::from_slice(&body).unwrap_or(Value::Null),
                            authorization: header("authorization"),
                            idempotency_key: header("idempotency-key"),
                        });
                        if path == "/v1/accounts" {
                            hosted.registration_delay
                        } else {
                            Duration::ZERO
                        }
                    };
                    tokio::time::sleep(delay).await;
                    let mut hosted = hosted.lock().unwrap();
                    let (status, body) = hosted
                        .once
                        .remove(&path)
                        .or_else(|| hosted.responses.get(&path).cloned())
                        .unwrap_or((404, json!({"error": "Not found"}).to_string()));
                    (
                        StatusCode::from_u16(status).unwrap(),
                        [("content-type", "application/json")],
                        body,
                    )
                        .into_response()
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FakeHosted { url, hosted }
    }

    pub(crate) struct Fixture {
        pub state: AppState,
        pub fake: FakeHosted,
        pub admin_id: String,
        pub admin_token: String,
        pub company_id: String,
    }

    pub(crate) async fn fixture() -> Fixture {
        let fake = fake_hosted().await;
        let (state, _filename) = crate::http::routes::auth::tests::state();
        let state = state.with_billing(fake.client());
        let now = Utc::now();
        let (admin, company_id) = state.with_database(|database| {
            let admin = crate::identity::auth::development_sign_in(database, now).unwrap();
            let company = companies::create_company(database, &admin.user.id, "Acme", now).unwrap();
            (admin, company.id)
        });
        let f = Fixture {
            state,
            fake,
            admin_id: admin.user.id,
            admin_token: admin.session_token,
            company_id,
        };
        // The administrator works in the company, so it holds one seat.
        f.member(&f.admin_id, &f.company_id);
        f
    }

    impl Fixture {
        pub fn sql(&self, statement: &str, values: &[&dyn rusqlite::ToSql]) {
            self.state.with_database(|database| {
                database.connection().execute(statement, values).unwrap();
            });
        }

        pub fn user(&self, id: &str, role: &str, status: &str) {
            self.sql(
                "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES (?1, ?1, ?1, ?2, ?3, '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z', 1)",
                &[&id, &role, &status],
            );
        }

        pub fn member(&self, id: &str, company_id: &str) {
            self.sql(
                "INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES (?1, ?2, '2026-09-14T00:00:00.000Z')",
                &[&id, &company_id],
            );
        }

        pub fn bind(&self, account_id: Option<&str>) {
            self.sql(
                "INSERT INTO suplex_company_billing (company_id, registration_id, credential, account_id, created_at, updated_at) VALUES (?1, '018f2a2c-7c8e-7f2e-9d01-2f3c4d5e6f7a', 'stored-credential', ?2, '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')",
                &[&self.company_id, &account_id],
            );
        }

        pub fn binding(&self) -> Option<(String, String, Option<String>)> {
            self.state.with_database(|database| {
                binding(database, &self.company_id)
                    .unwrap()
                    .map(|found| (found.registration_id, found.credential, found.account_id))
            })
        }

        pub fn project(&self, slug: &str) {
            self.sql(
                "INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, agent_task_policy_json, created_at, updated_at) VALUES (?1, ?2, ?1, '/tmp/' || ?1, '/tmp/' || ?1 || '-worktrees', 'acme/' || ?1, 'main', '', '', 'profile_native_root', 'profile_native_worker', '{}', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')",
                &[&slug, &self.company_id],
            );
        }

        pub async fn summary(&self, user_id: &str) -> Value {
            serde_json::to_value(summary(&self.state, user_id, &self.company_id).await.unwrap())
                .unwrap()
        }
    }

    fn failure(error: Box<dyn Error>) -> (u16, Option<&'static str>) {
        let failure = crate::shared::public_failure(error);
        (failure.status.as_u16(), failure.code)
    }

    #[tokio::test]
    async fn seats_count_company_members_that_are_not_revoked() {
        let f = fixture().await;
        let seats = || {
            f.state
                .with_database(|database| required_seats(database, &f.company_id).unwrap())
        };
        assert_eq!(seats(), 1);
        // An administrator holds a seat only where it is a member.
        f.user("admin-2", "admin", "active");
        assert_eq!(seats(), 1);
        f.member("admin-2", &f.company_id);
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        // A pending member holds its seat; a revoked one does not.
        f.user("pending-1", "member", "pending");
        f.user("revoked-1", "member", "revoked");
        f.member("pending-1", &f.company_id);
        f.member("revoked-1", &f.company_id);
        let other = f.state.with_database(|database| {
            companies::create_company(database, &f.admin_id, "Other", Utc::now())
                .unwrap()
                .id
        });
        f.user("other-member", "member", "active");
        f.member("other-member", &other);
        assert_eq!(seats(), 4);
    }

    #[test]
    fn entitlement_covers_free_slots_unchecked_evidence_expiry_shortage_and_unknown() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-14T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let paid = |seats, until: Option<&str>| BillingEvidence::Paid {
            purchased_seats: seats,
            access_until: until.map(str::to_owned),
        };
        let decide = |billing: BillingEvidence, count| {
            decide_project_entitlement(count, 2, now, &billing)
        };
        for billing in [
            BillingEvidence::NotChecked,
            BillingEvidence::Unknown,
            BillingEvidence::Free,
        ] {
            assert_eq!(decide(billing, FREE_PROJECT_LIMIT - 1), Ok(()));
        }
        let limit = FREE_PROJECT_LIMIT;
        assert_eq!(
            decide(BillingEvidence::NotChecked, limit),
            Err(Denial::RefreshRequired)
        );
        assert_eq!(
            decide(BillingEvidence::Free, limit),
            Err(Denial::ProjectLimitReached)
        );
        assert_eq!(
            decide(BillingEvidence::Unknown, limit),
            Err(Denial::BillingUnavailable)
        );
        assert_eq!(
            decide(paid(9, Some("2026-09-14T12:00:00.000Z")), limit),
            Err(Denial::RefreshRequired)
        );
        assert_eq!(
            decide(paid(9, Some("2026-09-14T11:59:59.000Z")), limit),
            Err(Denial::RefreshRequired)
        );
        assert_eq!(decide(paid(9, Some("2026-09-14T12:00:01.000Z")), limit), Ok(()));
        assert_eq!(decide(paid(9, None), limit), Ok(()));
        assert_eq!(
            decide(paid(1, Some("2026-10-01T00:00:00.000Z")), limit),
            Err(Denial::SeatLimitExceeded)
        );
        assert_eq!(decide(paid(2, Some("2026-10-01T00:00:00.000Z")), limit), Ok(()));
    }

    #[tokio::test]
    async fn summary_without_a_binding_is_free_and_calls_nothing() {
        let f = fixture().await;
        let summary = f.summary(&f.admin_id).await;
        assert_eq!(
            summary,
            json!({"plan": "free", "companyId": f.company_id, "projectCount": 0, "requiredSeats": 1, "canManageBilling": true, "purchaseConfigured": true, "projectLimit": 2, "purchasedSeats": 0, "canCreateProject": true, "checkedAt": summary["checkedAt"]})
        );
        assert!(f.with_calls(Vec::is_empty));
    }

    impl Fixture {
        fn with_calls<T>(&self, read: impl FnOnce(&Vec<Call>) -> T) -> T {
            self.fake.with(|hosted| read(&hosted.calls))
        }
    }

    #[tokio::test]
    async fn summary_maps_a_bound_unpaid_account_to_free_with_lifecycle_fields() {
        let f = fixture().await;
        f.bind(Some("acct_1"));
        f.fake.with(|hosted| {
            let mut state = inactive_state();
            state["subscriptionStatus"] = json!("incomplete");
            state["paymentActionRequired"] = json!(true);
            state["paymentActionUrl"] = json!("https://invoice.stripe.com/i/invoice_1");
            hosted.respond("/v1/billing", 200, state);
        });
        let summary = f.summary(&f.admin_id).await;
        assert_eq!(summary["plan"], "free");
        assert_eq!(summary["purchasedSeats"], 0);
        assert_eq!(summary["subscriptionStatus"], "incomplete");
        assert_eq!(summary["paymentActionRequired"], true);
        assert_eq!(
            summary["paymentActionUrl"],
            "https://invoice.stripe.com/i/invoice_1"
        );
        assert_eq!(summary["accessUntil"], Value::Null);
        assert!(summary["checkedAt"].is_string());
        let call = f.with_calls(|calls| calls[0].clone());
        assert_eq!(call.path, "/v1/billing");
        assert_eq!(call.authorization.as_deref(), Some("Bearer stored-credential"));
    }

    #[tokio::test]
    async fn summary_reports_pro_with_admin_pricing_and_the_seat_restriction() {
        let f = fixture().await;
        f.bind(Some("acct_1"));
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, active_state(5)));
        let sufficient = f.summary(&f.admin_id).await;
        assert_eq!(
            (
                &sufficient["plan"],
                &sufficient["projectLimit"],
                &sufficient["requiredSeats"],
                &sufficient["monthlySubtotal"],
                &sufficient["unitAmount"],
                &sufficient["currency"],
                &sufficient["restriction"]
            ),
            (
                &json!("pro"),
                &Value::Null,
                &json!(2),
                &json!(10000),
                &json!(2000),
                &json!("usd"),
                &Value::Null
            )
        );
        assert!(sufficient.get("restriction").is_none());
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, active_state(1)));
        let short = f.summary(&f.admin_id).await;
        assert_eq!(short["projectLimit"], 2);
        assert_eq!(short["restriction"], "seat_limit_exceeded");
        assert_eq!(short["canCreateProject"], true);
        let member = f.summary("member-1").await;
        assert_eq!(member["plan"], "pro");
        assert_eq!(member["canManageBilling"], false);
        assert!(member.get("unitAmount").is_none());
        assert!(member.get("monthlySubtotal").is_none());
    }

    #[tokio::test]
    async fn summary_is_unknown_when_the_hosted_read_fails_or_billing_is_unconfigured() {
        let f = fixture().await;
        f.bind(Some("acct_1"));
        f.fake.with(|hosted| {
            hosted.respond("/v1/billing", 503, json!({"error": "down"}));
        });
        let summary = f.summary(&f.admin_id).await;
        assert_eq!(
            summary,
            json!({"plan": "unknown", "companyId": f.company_id, "projectCount": 0, "requiredSeats": 1, "canManageBilling": true, "purchaseConfigured": true, "canCreateProject": true, "checkedAt": null, "reason": "billing_unavailable"})
        );
        f.project("one");
        f.project("two");
        assert_eq!(f.summary(&f.admin_id).await["canCreateProject"], Value::Null);
        let mut unconfigured = f.state.clone();
        unconfigured.billing = None;
        let missing =
            serde_json::to_value(super::summary(&unconfigured, &f.admin_id, &f.company_id).await.unwrap())
                .unwrap();
        assert_eq!(missing["plan"], "unknown");
        assert_eq!(missing["purchaseConfigured"], false);
        assert_eq!(f.binding().unwrap().2.as_deref(), Some("acct_1"));
    }

    #[tokio::test]
    async fn summary_fails_closed_on_contract_violations_and_unsafe_payment_urls() {
        let f = fixture().await;
        f.bind(Some("acct_1"));
        let mut active_without_seats = active_state(1);
        active_without_seats["purchasedSeats"] = json!(0);
        let mut inactive_with_seats = inactive_state();
        inactive_with_seats["purchasedSeats"] = json!(3);
        let mut unsafe_url = inactive_state();
        unsafe_url["paymentActionUrl"] = json!("https://evil.example.com/pay");
        for state in [
            active_without_seats,
            inactive_with_seats,
            json!({"unexpected": true}),
            unsafe_url,
        ] {
            f.fake
                .with(|hosted| hosted.respond("/v1/billing", 200, state.clone()));
            assert_eq!(f.summary(&f.admin_id).await["plan"], "unknown", "{state}");
        }
        // Members never receive the payment URL, so an unsafe one cannot hide their status.
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        let member = f.summary("member-1").await;
        assert_eq!(member["plan"], "free");
        assert_eq!(member["paymentActionUrl"], Value::Null);
    }

    #[tokio::test]
    async fn a_lost_registration_response_recovers_with_the_stored_identity() {
        let f = fixture().await;
        f.fake.with(|hosted| {
            hosted.once.insert(
                "/v1/accounts".to_owned(),
                (500, json!({"error": "lost"}).to_string()),
            );
            hosted.respond("/v1/accounts", 200, json!({"accountId": "acct_recovered"}));
        });
        let lost = checkout(&f.state, &f.admin_id, &f.company_id, 1, "key-00000001")
            .await
            .unwrap_err();
        assert_eq!(failure(lost), (503, Some("billing_unavailable")));
        let (registration_id, credential, account_id) = f.binding().unwrap();
        assert_eq!(account_id, None);
        let recovered = checkout(&f.state, &f.admin_id, &f.company_id, 1, "key-00000002")
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(recovered).unwrap(),
            json!({"status": "redirect", "url": "https://checkout.stripe.com/c/pay/session_1"})
        );
        let registrations = f.with_calls(|calls| {
            calls
                .iter()
                .filter(|call| call.path == "/v1/accounts")
                .map(|call| call.body.clone())
                .collect::<Vec<_>>()
        });
        assert_eq!(registrations.len(), 2);
        assert_eq!(registrations[0], registrations[1]);
        assert_eq!(
            registrations[1],
            json!({"registrationId": registration_id, "credential": credential, "installationId": "installation-test", "companyId": f.company_id})
        );
        assert_eq!(credential.len(), 43);
        assert_eq!(f.binding().unwrap().2.as_deref(), Some("acct_recovered"));
    }

    #[tokio::test]
    async fn concurrent_money_calls_register_one_account() {
        let f = fixture().await;
        f.fake
            .with(|hosted| hosted.registration_delay = Duration::from_millis(200));
        let (portal_result, checkout_result) = tokio::join!(
            portal(&f.state, &f.admin_id, &f.company_id),
            checkout(&f.state, &f.admin_id, &f.company_id, 1, "key-00000003"),
        );
        assert_eq!(
            portal_result.unwrap().url,
            "https://billing.stripe.com/session/portal_1"
        );
        assert!(matches!(
            checkout_result.unwrap(),
            BillingCheckoutResponse::Redirect { .. }
        ));
        assert_eq!(f.fake.with(|hosted| hosted.count("/v1/accounts")), 1);
        assert_eq!(f.binding().unwrap().2.as_deref(), Some("acct_1"));
    }

    #[tokio::test]
    async fn money_commands_check_occupancy_and_forward_bodies_and_keys_verbatim() {
        let f = fixture().await;
        f.bind(Some("acct_1"));
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        let decrease: wire::HostedSeatChangeBody =
            serde_json::from_value(json!({"quantity": 1, "confirmNoRefund": true})).unwrap();
        for error in [
            checkout(&f.state, &f.admin_id, &f.company_id, 1, "key-00000004")
                .await
                .unwrap_err(),
            preview_seats(&f.state, &f.admin_id, &f.company_id, 1)
                .await
                .unwrap_err(),
            change_seats(&f.state, &f.admin_id, &f.company_id, &decrease, "key-00000005")
                .await
                .unwrap_err(),
        ] {
            assert_eq!(failure(error), (422, Some("invalid_seat_quantity")));
        }
        assert!(f.with_calls(Vec::is_empty));
        checkout(&f.state, &f.admin_id, &f.company_id, 4, "key-00000006")
            .await
            .unwrap();
        let preview = preview_seats(&f.state, &f.admin_id, &f.company_id, 7)
            .await
            .unwrap();
        assert_eq!(preview.preview_id, "op_preview");
        let increase: wire::HostedSeatChangeBody =
            serde_json::from_value(json!({"quantity": 7, "previewId": "op_preview"})).unwrap();
        change_seats(&f.state, &f.admin_id, &f.company_id, &increase, "key-00000007")
            .await
            .unwrap();
        let calls = f.with_calls(Clone::clone);
        let sent = |path: &str| {
            calls
                .iter()
                .find(|call| call.path == path)
                .map(|call| (call.body.clone(), call.idempotency_key.clone()))
                .unwrap()
        };
        assert_eq!(
            sent("/v1/checkout"),
            (json!({"quantity": 4}), Some("key-00000006".to_owned()))
        );
        assert_eq!(sent("/v1/seats/preview"), (json!({"quantity": 7}), None));
        assert_eq!(
            sent("/v1/seats"),
            (
                json!({"quantity": 7, "previewId": "op_preview"}),
                Some("key-00000007".to_owned())
            )
        );
    }

    #[tokio::test]
    async fn checkout_and_seat_outcomes_map_onto_the_local_contract() {
        let f = fixture().await;
        f.bind(Some("acct_1"));
        f.fake.with(|hosted| {
            hosted.respond(
                "/v1/checkout",
                200,
                json!({"status": "subscribed", "operationId": "op_checkout", "state": active_state(3)}),
            );
            hosted.respond("/v1/billing", 200, active_state(3));
            hosted.respond(
                "/v1/seats",
                200,
                json!({"status": "payment_required", "operationId": "op_seats", "url": "https://invoice.stripe.com/i/pay_1", "state": active_state(3)}),
            );
        });
        let subscribed = serde_json::to_value(
            checkout(&f.state, &f.admin_id, &f.company_id, 3, "key-00000008")
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(subscribed["status"], "subscribed");
        assert_eq!(subscribed["summary"]["plan"], "pro");
        assert_eq!(subscribed["summary"]["purchasedSeats"], 3);
        let decrease: wire::HostedSeatChangeBody =
            serde_json::from_value(json!({"quantity": 2, "confirmNoRefund": true})).unwrap();
        let pending = serde_json::to_value(
            change_seats(&f.state, &f.admin_id, &f.company_id, &decrease, "key-00000009")
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(pending["status"], "payment_required");
        assert_eq!(pending["url"], "https://invoice.stripe.com/i/pay_1");
        assert_eq!(pending["summary"]["plan"], "pro");
    }

    #[tokio::test]
    async fn money_commands_reject_non_administrators_before_any_hosted_call() {
        let f = fixture().await;
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        f.user("pending-admin", "admin", "pending");
        let other = f.state.with_database(|database| {
            companies::create_company(database, &f.admin_id, "Other", Utc::now())
                .unwrap()
                .id
        });
        let decrease: wire::HostedSeatChangeBody =
            serde_json::from_value(json!({"quantity": 2, "confirmNoRefund": true})).unwrap();
        let company = f.company_id.as_str();
        let state = &f.state;
        let denied = [
            checkout(state, "member-1", company, 1, "key-00000010")
                .await
                .map(drop),
            preview_seats(state, "member-1", company, 1).await.map(drop),
            change_seats(state, "member-1", company, &decrease, "key-00000011")
                .await
                .map(drop),
            portal(state, "member-1", company).await.map(drop),
            portal(state, "member-1", &other).await.map(drop),
        ];
        for result in denied {
            assert_eq!(failure(result.unwrap_err()).0, 404);
        }
        for user in ["pending-admin", "user-missing"] {
            assert_eq!(
                failure(portal(state, user, company).await.unwrap_err()).0,
                401
            );
        }
        assert!(f.with_calls(Vec::is_empty));
        let mut unconfigured = f.state.clone();
        unconfigured.billing = None;
        let error = checkout(&unconfigured, &f.admin_id, company, 1, "key-00000012")
            .await
            .unwrap_err();
        assert_eq!(failure(error), (503, Some("billing_not_configured")));
        assert_eq!(f.binding(), None);
    }

    #[tokio::test]
    async fn create_decision_reports_paid_free_and_unknown_evidence() {
        let f = fixture().await;
        assert_eq!(
            create_decision(&f.state, &f.company_id).await.unwrap(),
            BillingEvidence::Free
        );
        f.bind(Some("acct_1"));
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, active_state(4)));
        assert_eq!(
            create_decision(&f.state, &f.company_id).await.unwrap(),
            BillingEvidence::Paid {
                purchased_seats: 4,
                access_until: Some("2099-01-01T00:00:00.000Z".to_owned())
            }
        );
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, inactive_state()));
        assert_eq!(
            create_decision(&f.state, &f.company_id).await.unwrap(),
            BillingEvidence::Free
        );
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, json!({"active": true})));
        assert_eq!(
            create_decision(&f.state, &f.company_id).await.unwrap(),
            BillingEvidence::Unknown
        );
        let mut unconfigured = f.state.clone();
        unconfigured.billing = None;
        assert_eq!(
            create_decision(&unconfigured, &f.company_id).await.unwrap(),
            BillingEvidence::Unknown
        );
    }

    #[tokio::test]
    async fn hosted_failures_sanitize_unless_a_known_code_matches_its_status() {
        let f = fixture().await;
        f.bind(Some("acct_1"));
        let attempt = |status: u16, body: &str| {
            f.fake.with(|hosted| {
                hosted
                    .once
                    .insert("/v1/checkout".to_owned(), (status, body.to_owned()));
            });
            async {
                failure(
                    checkout(&f.state, &f.admin_id, &f.company_id, 1, "key-00000014")
                        .await
                        .unwrap_err(),
                )
            }
        };
        assert_eq!(
            attempt(409, r#"{"error":"x","code":"idempotency_conflict"}"#).await,
            (409, Some("idempotency_conflict"))
        );
        assert_eq!(
            attempt(409, r#"{"error":"x","code":"billing_quote_changed"}"#).await,
            (409, Some("billing_quote_changed"))
        );
        for (status, body) in [
            (500, r#"{"error":"x","code":"idempotency_conflict"}"#),
            (409, r#"{"error":"x","code":"something_else"}"#),
            (500, "not json"),
            (302, "{}"),
            (
                200,
                r#"{"status":"redirect","operationId":"op_2","url":"https://checkout.stripe.com/c/pay/y","extra":true}"#,
            ),
        ] {
            assert_eq!(
                attempt(status, body).await,
                (503, Some("billing_unavailable")),
                "{status} {body}"
            );
        }
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = closed.local_addr().unwrap();
        drop(closed);
        let offline = f.state.clone().with_billing(BillingClient::new(
            Url::parse(&format!("http://{address}/")).unwrap(),
            "installation-test".to_owned(),
        ));
        let error = checkout(&offline, &f.admin_id, &f.company_id, 1, "key-00000019")
            .await
            .unwrap_err();
        assert_eq!(failure(error), (503, Some("billing_unavailable")));
    }

    #[test]
    fn forwarded_urls_stay_on_the_hosted_origin_or_exact_stripe_hosts() {
        let client = BillingClient::new(
            Url::parse("https://billing.example.test").unwrap(),
            "installation-test".to_owned(),
        );
        for url in [
            "https://checkout.stripe.com/c/pay/ok",
            "https://billing.stripe.com/p/session/ok",
            "https://invoice.stripe.com/i/ok",
            "https://pay.stripe.com/ok",
            "https://billing.example.test/checkout/return",
            "https://billing.example.test:443/checkout/return",
        ] {
            assert!(client.forwarded_url(url).is_ok(), "{url}");
        }
        for url in [
            "http://checkout.stripe.com/c/pay/x",
            "https://evil.example.com/c/pay/x",
            "https://checkout.stripe.com.evil.example.com/x",
            "https://user:secret@checkout.stripe.com/x",
            "https://checkout.stripe.com:4443/x",
            "https://billing.example.test:4443/x",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert!(client.forwarded_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn the_service_url_needs_https_unless_it_is_loopback_and_has_no_credentials() {
        for url in [
            "https://billing.example.test",
            "http://127.0.0.1:4211",
            "http://localhost:4211",
            "http://[::1]:4211",
        ] {
            assert!(parse_service_url(url, "SUPLEX_BILLING_SERVICE_URL").is_ok(), "{url}");
        }
        for url in [
            "http://billing.example.test",
            "https://user:secret@billing.example.test",
            "not a url",
        ] {
            assert!(parse_service_url(url, "SUPLEX_BILLING_SERVICE_URL").is_err(), "{url}");
        }
    }

    #[tokio::test]
    async fn the_early_quota_check_reads_billing_only_at_the_limit() {
        let f = fixture().await;
        f.project("one");
        assert!(admit_creation(&f.state, &f.company_id).await.is_ok());
        f.project("two");
        let error = admit_creation(&f.state, &f.company_id).await.unwrap_err();
        assert_eq!(failure(error), (402, Some("project_limit_reached")));
        assert!(f.with_calls(Vec::is_empty));
        f.bind(Some("acct_1"));
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, active_state(1)));
        let error = admit_creation(&f.state, &f.company_id).await.unwrap_err();
        assert_eq!(failure(error), (402, Some("seat_limit_exceeded")));
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 500, json!({"error": "down"})));
        let error = admit_creation(&f.state, &f.company_id).await.unwrap_err();
        assert_eq!(failure(error), (402, Some("seat_limit_exceeded")));
        let mut expired = active_state(5);
        expired["accessUntil"] = json!("2000-01-01T00:00:00.000Z");
        f.fake.with(|hosted| {
            hosted.calls.clear();
            hosted.once.insert(
                "/v1/billing".to_owned(),
                (200, expired.to_string()),
            );
            hosted.respond("/v1/billing", 200, active_state(5));
        });
        assert!(admit_creation(&f.state, &f.company_id).await.is_ok());
        assert_eq!(f.fake.with(|hosted| hosted.count("/v1/billing")), 2);
        f.fake.with(|hosted| {
            hosted.calls.clear();
            hosted.respond("/v1/billing", 200, expired);
        });
        let error = admit_creation(&f.state, &f.company_id).await.unwrap_err();
        assert_eq!(failure(error), (503, Some("billing_unavailable")));
        assert_eq!(f.fake.with(|hosted| hosted.count("/v1/billing")), 2);
    }

    #[tokio::test]
    async fn live_reads_keep_a_plan_label_that_expires_and_refreshes_in_the_background() {
        let f = fixture().await;
        let now = Utc::now();
        let label = |now| {
            f.state
                .with_database(|database| plan_label(database, &f.company_id, now).unwrap())
        };
        // No billing account is a known Free that never needs a hosted read.
        assert_eq!(label(now), (Some("free"), false));
        f.bind(Some("acct_1"));
        // A bound company without a snapshot has no label and is due a read.
        assert_eq!(label(now), (None, true));
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, active_state(2)));
        f.summary(&f.admin_id).await;
        assert_eq!(label(now), (Some("pro"), false));
        assert_eq!(label(now + chrono::TimeDelta::hours(2)), (Some("pro"), true));
        // A day-old snapshot, or Pro past its paid access, has no label.
        assert_eq!(label(now + chrono::TimeDelta::hours(25)), (None, true));
        let past_access = chrono::DateTime::parse_from_rfc3339("2099-01-01T00:00:01Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(label(past_access).0, None);
        // A failed read keeps the last snapshot.
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 503, json!({"error": "down"})));
        assert_eq!(f.summary(&f.admin_id).await["plan"], "unknown");
        assert_eq!(label(now).0, Some("pro"));
        // The background refresh records a lapsed subscription as Free.
        f.sql(
            "UPDATE suplex_company_billing SET checked_at = '2026-01-01T00:00:00.000Z'",
            &[],
        );
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, inactive_state()));
        let reads = f.fake.with(|hosted| hosted.count("/v1/billing"));
        refresh_plans(&f.state, vec![f.company_id.clone()]);
        while f.fake.with(|hosted| hosted.count("/v1/billing")) == reads
            || label(Utc::now()).0 != Some("free")
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(label(Utc::now()), (Some("free"), false));
    }

    #[tokio::test]
    async fn a_hosted_outage_keeps_confirmed_pro_until_its_paid_period_ends() {
        let f = fixture().await;
        f.project("one");
        f.project("two");
        f.bind(Some("acct_1"));
        let down = |f: &Fixture| {
            f.fake
                .with(|hosted| hosted.respond("/v1/billing", 500, json!({"error": "down"})));
        };
        // Never confirmed: an outage is unknown, not Pro.
        down(&f);
        let error = admit_creation(&f.state, &f.company_id).await.unwrap_err();
        assert_eq!(failure(error), (503, Some("billing_unavailable")));
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, active_state(3)));
        assert!(admit_creation(&f.state, &f.company_id).await.is_ok());
        down(&f);
        assert!(admit_creation(&f.state, &f.company_id).await.is_ok());
        assert_eq!(f.summary(&f.admin_id).await["canCreateProject"], json!(true));
        // A confirmed lapse replaces the snapshot with Free.
        f.fake
            .with(|hosted| hosted.respond("/v1/billing", 200, inactive_state()));
        let error = admit_creation(&f.state, &f.company_id).await.unwrap_err();
        assert_eq!(failure(error), (402, Some("project_limit_reached")));
        down(&f);
        let error = admit_creation(&f.state, &f.company_id).await.unwrap_err();
        assert_eq!(failure(error), (503, Some("billing_unavailable")));
        // An elapsed paid period is never used.
        f.sql(
            "UPDATE suplex_company_billing SET plan = 'pro', purchased_seats = 3, access_until = '2000-01-01T00:00:00.000Z'",
            &[],
        );
        let error = admit_creation(&f.state, &f.company_id).await.unwrap_err();
        assert_eq!(failure(error), (503, Some("billing_unavailable")));
    }
}
