#[cfg(test)]
pub(crate) mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use axum::{
        body::Bytes,
        http::{HeaderMap, StatusCode, Uri},
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
        pub authorization: Option<String>,
        pub idempotency_key: Option<String>,
        pub body: String,
    }

    /// A loopback fake of the hosted billing API. Each path answers with its
    /// configured status and body.
    #[derive(Default)]
    pub(crate) struct Hosted {
        pub calls: Vec<Call>,
        pub responses: HashMap<String, (u16, String)>,
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

    pub(crate) fn pro_state(status: &str, until: &str) -> Value {
        json!({"active": true, "purchasedSeats": 1, "subscriptionStatus": status, "renewalAt": null, "accessUntil": until, "cancelAtPeriodEnd": false, "paymentActionRequired": false, "paymentActionUrl": null, "environment": "sandbox"})
    }

    pub(crate) fn pro_plan() -> Value {
        json!({"state": pro_state("active", "2099-01-01T00:00:00.000Z"), "trialAvailable": false})
    }

    pub(crate) fn free_plan(trial_available: bool) -> Value {
        json!({"state": {"active": false, "purchasedSeats": 0, "subscriptionStatus": "none", "renewalAt": null, "accessUntil": null, "cancelAtPeriodEnd": false, "paymentActionRequired": false, "paymentActionUrl": null, "environment": "sandbox"}, "trialAvailable": trial_available})
    }

    /// Confirmed Pro for the linked account, linking one if none is, for
    /// tests that need room above Free's limits.
    pub(crate) fn grant_pro(database: &SuplexDatabase) {
        database.connection().execute(
            "INSERT OR IGNORE INTO suplex_account (id, account_id, email, token, linked_at) VALUES ('host', 'user_pro', 'pro@example.com', ?1, '2026-09-14T00:00:00.000Z')",
            ["p".repeat(43)],
        ).unwrap();
        database.connection().execute(
            "INSERT OR REPLACE INTO suplex_plan (id, account_id, access_until, checked_at) SELECT 'host', account_id, '2099-01-01T00:00:00.000Z', '2026-09-14T00:00:00.000Z' FROM suplex_account WHERE id = 'host'",
            [],
        ).unwrap();
    }

    /// Confirmed Team for the linked account: company scoping and read-only
    /// members, for tests that narrow access.
    pub(crate) fn grant_team(database: &SuplexDatabase) {
        grant_pro(database);
        database
            .connection()
            .execute("UPDATE suplex_plan SET plan = 'team'", [])
            .unwrap();
    }

    pub(crate) struct FakeHosted {
        pub url: Url,
        pub hosted: Arc<Mutex<Hosted>>,
    }

    impl FakeHosted {
        pub fn with<T>(&self, change: impl FnOnce(&mut Hosted) -> T) -> T {
            change(&mut self.hosted.lock().unwrap())
        }
    }

    pub(crate) async fn fake_hosted() -> FakeHosted {
        let hosted = Arc::new(Mutex::new(Hosted::default()));
        hosted.lock().unwrap().responses = [
            ("/v1/plan", free_plan(true)),
            ("/v1/plan/trial", json!({"state": pro_state("trialing", "2099-01-01T00:00:00.000Z"), "trialAvailable": false})),
            ("/v1/plan/checkout", json!({"status": "redirect", "operationId": "op_checkout", "url": "https://checkout.stripe.com/c/pay/session_1"})),
            ("/v1/plan/portal", json!({"url": "https://billing.stripe.com/session/portal_1"})),
        ]
        .into_iter()
        .map(|(path, body)| (path.to_owned(), (200, body.to_string())))
        .collect();
        let shared = hosted.clone();
        let app = axum::Router::new().fallback(move |uri: Uri, headers: HeaderMap, body: Bytes| {
            let hosted = shared.clone();
            async move {
                let header = |name: &str| {
                    headers
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned)
                };
                let mut hosted = hosted.lock().unwrap();
                let path = uri.path().to_owned();
                hosted.calls.push(Call {
                    path: path.clone(),
                    authorization: header("authorization"),
                    idempotency_key: header("idempotency-key"),
                    body: String::from_utf8_lossy(&body).into_owned(),
                });
                let (status, body) = hosted
                    .responses
                    .get(&path)
                    .cloned()
                    .unwrap_or((404, json!({"error": "Not found"}).to_string()));
                (
                    StatusCode::from_u16(status).unwrap(),
                    [("content-type", "application/json")],
                    body,
                )
                    .into_response()
            }
        });
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

    /// An administrator with a linked Suplex account and one company.
    pub(crate) async fn fixture() -> Fixture {
        let fake = fake_hosted().await;
        let (state, _filename) = crate::http::routes::auth::tests::state();
        let state = state.with_billing(BillingClient::new(fake.url.clone()));
        let now = Utc::now();
        let (admin, company_id) = state.with_database(|database| {
            let admin = crate::http::routes::auth::tests::verified_sign_in(database, now).unwrap();
            let company = companies::create_company(database, &admin.user.id, "Acme", now).unwrap();
            (admin, company.id)
        });
        Fixture {
            state,
            fake,
            admin_id: admin.user.id,
            admin_token: admin.session_token,
            company_id,
        }
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

        pub fn plan(&self) -> Plan {
            self.state.with_database(|database| plan(database).unwrap())
        }

        pub fn reads(&self) -> usize {
            self.fake.with(|hosted| hosted.count("/v1/plan"))
        }

        pub async fn summary(&self, user_id: &str) -> Value {
            serde_json::to_value(summary(&self.state, user_id).await.unwrap()).unwrap()
        }
    }

    fn code(error: Box<dyn Error + Send + Sync>) -> Option<&'static str> {
        crate::shared::public_failure(error).code
    }

    #[test]
    fn each_plan_has_the_limits_on_getsuplex_ai() {
        assert_eq!(
            (
                FREE.companies,
                FREE.projects,
                FREE.running_tasks,
                FREE.monthly_tasks
            ),
            (Some(1), Some(2), Some(3), Some(50))
        );
        assert_eq!(
            (PRO.companies, PRO.projects, PRO.running_tasks, PRO.monthly_tasks),
            (Some(3), Some(25), None, None)
        );
        // The SQL running limit is the same number.
        assert!(running_limited_sql!().contains(&format!(" >= {FREE_RUNNING_TASKS})")));
        let usage = |monthly_tasks| PlanUsage {
            companies: 1,
            projects: 0,
            running_tasks: 3,
            monthly_tasks,
        };
        assert_eq!(reached(Plan::Free, &usage(49), Limit::MonthlyTasks), None);
        assert_eq!(
            reached(Plan::Free, &usage(50), Limit::MonthlyTasks),
            Some(50)
        );
        assert_eq!(reached(Plan::Free, &usage(0), Limit::RunningTasks), Some(3));
        assert_eq!(reached(Plan::Free, &usage(0), Limit::Companies), Some(1));
        assert_eq!(reached(Plan::Free, &usage(0), Limit::Projects), None);
        assert_eq!(reached(Plan::Pro, &usage(5000), Limit::MonthlyTasks), None);
        assert_eq!(reached(Plan::Pro, &usage(0), Limit::Companies), None);
        let now = chrono::DateTime::parse_from_rfc3339("2026-12-31T23:59:59Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(month_start(now), "2026-12-01T00:00:00.000Z");
        assert_eq!(
            limit_failure(Plan::Free, Limit::Companies, 1).message,
            "Free includes 1 company. Select Pro in Settings > Billing."
        );
    }

    #[tokio::test]
    async fn pro_holds_only_while_confirmed_access_lasts_for_the_linked_account() {
        let f = fixture().await;
        assert_eq!(f.plan(), Plan::Free);
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 200, pro_plan()));
        refresh(&f.state).await.unwrap();
        assert_eq!(f.plan(), Plan::Pro);

        // A hosted outage keeps confirmed Pro.
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 503, json!({"error": "down"})));
        assert!(refresh(&f.state).await.is_err());
        assert_eq!(f.plan(), Plan::Pro);
        // It never extends Pro past its paid access.
        f.sql(
            "UPDATE suplex_plan SET access_until = '2000-01-01T00:00:00.000Z'",
            &[],
        );
        assert_eq!(f.plan(), Plan::Free);

        // A confirmed lapse replaces the snapshot with Free.
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 200, pro_plan()));
        refresh(&f.state).await.unwrap();
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 200, free_plan(false)));
        refresh(&f.state).await.unwrap();
        assert_eq!(f.plan(), Plan::Free);

        // Pro belongs to the account: another linked account starts Free.
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 200, pro_plan()));
        refresh(&f.state).await.unwrap();
        f.sql("UPDATE suplex_account SET account_id = 'user_other'", &[]);
        assert_eq!(f.plan(), Plan::Free);
        f.sql("DELETE FROM suplex_account", &[]);
        assert_eq!(f.plan(), Plan::Free);
        // With no linked account there is nothing to read.
        assert!(refresh(&f.state).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn team_lifts_every_limit_and_a_confirmed_team_lapse_is_remembered_until_paid() {
        let f = fixture().await;
        let team = || {
            let mut plan = pro_plan();
            plan["plan"] = json!("team");
            plan["state"]["purchasedSeats"] = json!(4);
            plan
        };
        f.fake.with(|hosted| hosted.respond("/v1/plan", 200, team()));
        refresh(&f.state).await.unwrap();
        assert_eq!(f.plan(), Plan::Team);
        assert_eq!(limits(Plan::Team), TEAM);
        assert_eq!((TEAM.companies, TEAM.projects), (None, None));
        let lapsed = |f: &Fixture| f.state.with_database(|database| team_lapsed(database).unwrap());
        assert!(!lapsed(&f));
        assert_eq!(f.summary(&f.admin_id).await["purchasedSeats"], json!(4));

        // A confirmed lapse keeps Team in the snapshot: work stays read-only.
        f.fake.with(|hosted| hosted.respond("/v1/plan", 200, free_plan(false)));
        refresh(&f.state).await.unwrap();
        assert_eq!(f.plan(), Plan::Free);
        assert!(lapsed(&f));
        assert_eq!(f.summary(&f.admin_id).await["teamLapsed"], json!(true));

        // Paying again restores it; a host that receives no tier records Pro.
        f.fake.with(|hosted| hosted.respond("/v1/plan", 200, pro_plan()));
        refresh(&f.state).await.unwrap();
        assert_eq!(f.plan(), Plan::Pro);
        assert!(!lapsed(&f));

        // A lapse belongs to its account: another linked account is not read-only.
        f.fake.with(|hosted| hosted.respond("/v1/plan", 200, team()));
        refresh(&f.state).await.unwrap();
        f.fake.with(|hosted| hosted.respond("/v1/plan", 200, free_plan(false)));
        refresh(&f.state).await.unwrap();
        f.sql("UPDATE suplex_account SET account_id = 'user_other'", &[]);
        assert!(!lapsed(&f));
    }

    #[tokio::test]
    async fn a_free_limit_reads_suplex_sh_before_it_refuses() {
        let f = fixture().await;
        let create = |name: &str| {
            f.state.with_database(|database| {
                companies::create_company(database, &f.admin_id, name, Utc::now())
            })
        };
        // Below the limit, no hosted read.
        observe(&f.state, Limit::Projects).await;
        assert_eq!(f.reads(), 0);
        // At the limit and still Free: one read, then the refusal.
        observe(&f.state, Limit::Companies).await;
        assert_eq!(f.reads(), 1);
        assert_eq!(
            code(create("Second").unwrap_err()),
            Some("company_limit_reached")
        );
        // A purchase made on another device applies at once.
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 200, pro_plan()));
        observe(&f.state, Limit::Companies).await;
        assert_eq!(f.reads(), 2);
        create("Second").unwrap();
        create("Third").unwrap();
        // Confirmed Pro needs no read at its own limit.
        observe(&f.state, Limit::Companies).await;
        assert_eq!(f.reads(), 2);
        assert_eq!(
            code(create("Fourth").unwrap_err()),
            Some("company_limit_reached")
        );
        // An archived company does not count; restoring it counts again.
        let third = f.state.with_database(|database| {
            companies::list_visible_companies(database, &f.admin_id)
                .unwrap()
                .into_iter()
                .find(|company| company.name == "Third")
                .unwrap()
                .id
        });
        let status = |status: companies::CompanyStatus| {
            f.state.with_database(|database| {
                companies::set_company_status(database, &f.admin_id, &third, status, Utc::now())
            })
        };
        status(companies::CompanyStatus::Archived).unwrap();
        create("Fourth").unwrap();
        assert_eq!(
            code(status(companies::CompanyStatus::Active).unwrap_err()),
            Some("company_limit_reached")
        );
    }

    #[tokio::test]
    async fn the_summary_reads_the_linked_account_and_shows_usage() {
        let f = fixture().await;
        let summary = f.summary(&f.admin_id).await;
        assert_eq!(summary["plan"], json!("free"));
        assert_eq!(summary["checked"], json!(true));
        assert_eq!(summary["trialAvailable"], json!(true));
        assert_eq!(
            summary["limits"],
            json!({"companies": 1, "projects": 2, "runningTasks": 3, "monthlyTasks": 50})
        );
        assert_eq!(
            summary["usage"],
            json!({"companies": 1, "projects": 0, "runningTasks": 0, "monthlyTasks": 0})
        );
        assert_eq!(
            f.fake.with(|hosted| hosted.calls[0].authorization.clone()),
            Some(format!("Bearer {}", "k".repeat(43)))
        );

        let mut paying = pro_plan();
        paying["state"]["paymentActionRequired"] = json!(true);
        paying["state"]["paymentActionUrl"] = json!("https://invoice.stripe.com/i/in_1");
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 200, paying));
        let summary = f.summary(&f.admin_id).await;
        assert_eq!(summary["plan"], json!("pro"));
        assert_eq!(summary["limits"]["runningTasks"], Value::Null);
        assert_eq!(
            summary["paymentActionUrl"],
            json!("https://invoice.stripe.com/i/in_1")
        );
        // A member sees the plan but never a billing URL.
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        let summary = f.summary("member-1").await;
        assert_eq!(summary["canManageBilling"], json!(false));
        assert_eq!(summary["paymentActionUrl"], Value::Null);

        // suplex.sh does not answer: the last confirmed plan applies.
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 503, json!({})));
        let summary = f.summary(&f.admin_id).await;
        assert_eq!(
            (summary["plan"].clone(), summary["checked"].clone()),
            (json!("pro"), json!(false))
        );
    }

    #[tokio::test]
    async fn the_trial_and_money_commands_need_an_administrator_and_a_linked_account() {
        let f = fixture().await;
        f.user("member-1", "member", "active");
        f.member("member-1", &f.company_id);
        assert!(start_trial(&f.state, "member-1").await.is_err());
        assert_eq!(f.fake.with(|hosted| hosted.count("/v1/plan/trial")), 0);

        // The trial's answer is remembered even when the next read fails.
        f.fake
            .with(|hosted| hosted.respond("/v1/plan", 503, json!({})));
        let summary =
            serde_json::to_value(start_trial(&f.state, &f.admin_id).await.unwrap()).unwrap();
        assert_eq!(f.plan(), Plan::Pro);
        assert_eq!(summary["plan"], json!("pro"));

        let BillingCheckoutResponse::Redirect { url } =
            checkout(&f.state, &f.admin_id, "checkout-key-1", CheckoutBody::default()).await.unwrap()
        else {
            panic!("checkout did not redirect");
        };
        assert_eq!(url, "https://checkout.stripe.com/c/pay/session_1");
        assert_eq!(
            f.fake
                .with(|hosted| hosted.calls.last().unwrap().idempotency_key.clone()),
            Some("checkout-key-1".into())
        );
        assert_eq!(f.fake.with(|hosted| hosted.calls.last().unwrap().body.clone()), "{}");
        let annual = CheckoutBody { plan: None, interval: Some(crate::billing::wire::BillingInterval::Year), quantity: None };
        checkout(&f.state, &f.admin_id, "checkout-key-2", annual).await.unwrap();
        assert_eq!(
            f.fake.with(|hosted| hosted.calls.last().unwrap().body.clone()),
            r#"{"interval":"year"}"#
        );
        f.fake.with(|hosted| {
            hosted.respond(
                "/v1/plan/portal",
                200,
                json!({"url": "https://attacker.example/portal"}),
            );
        });
        assert_eq!(
            code(portal(&f.state, &f.admin_id).await.unwrap_err()),
            Some("billing_unavailable")
        );
        f.fake.with(|hosted| {
            hosted.respond(
                "/v1/plan/trial",
                409,
                json!({"error": "used", "code": "trial_used"}),
            );
        });
        assert_eq!(
            code(start_trial(&f.state, &f.admin_id).await.unwrap_err()),
            Some("trial_used")
        );

        f.sql("DELETE FROM suplex_account", &[]);
        assert_eq!(
            code(start_trial(&f.state, &f.admin_id).await.unwrap_err()),
            Some("account_required")
        );
    }
}
