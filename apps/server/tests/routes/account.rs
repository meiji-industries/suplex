#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        Json,
        extract::Path,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
    };
    use chrono::Utc;
    use serde_json::{Value, json};

    use crate::{
        accounts::{AccountClient, linked, wire},
        http::AppState,
    };

    const ACCOUNT_ID: &str = "user_67e55044-10b1-426f-9247-bb680e5fe0c8";
    const ATTEMPT_ID: &str = "attempt_0123456789abcdef0123456789abcdef";

    /// What the fake hosted service answers to a poll.
    #[derive(Clone, Copy)]
    enum Poll {
        Pending,
        Complete,
        Invalid,
        Gone,
        Broken,
    }

    #[derive(Default)]
    struct Hosted {
        challenge: Option<String>,
        verifiers: Vec<String>,
        emails: Vec<Value>,
        logouts: Vec<String>,
        poll: Option<Poll>,
        logout_fails: bool,
    }

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<Hosted>>);

    impl Fake {
        fn with<T>(&self, operation: impl FnOnce(&mut Hosted) -> T) -> T {
            operation(&mut self.0.lock().unwrap())
        }
    }

    async fn fake_hosted() -> (Fake, String) {
        let fake = Fake::default();
        let attempts = fake.clone();
        let polls = fake.clone();
        let emails = fake.clone();
        let logouts = fake.clone();
        let app = axum::Router::new()
            .route(
                "/v1/auth/attempts",
                post(move |Json(body): Json<wire::AuthAttemptBody>| async move {
                    assert!(body.valid());
                    attempts.with(|hosted| hosted.challenge = Some(body.challenge));
                    Json(json!({"attemptId": ATTEMPT_ID}))
                }),
            )
            .route(
                "/v1/auth/attempts/{id}/poll",
                post(
                    move |Path(id): Path<String>, Json(body): Json<wire::AuthPollBody>| async move {
                        assert_eq!(id, ATTEMPT_ID);
                        let poll = polls.with(|hosted| {
                            hosted.verifiers.push(body.verifier.clone());
                            hosted.poll.unwrap_or(Poll::Pending)
                        });
                        let complete = |email: &str| {
                            Json(json!({
                                "status": "complete",
                                "token": "k".repeat(43),
                                "account": {"id": ACCOUNT_ID, "email": email, "name": "Ada"},
                            }))
                            .into_response()
                        };
                        match poll {
                            Poll::Pending => Json(json!({"status": "pending"})).into_response(),
                            Poll::Complete => complete("ada@example.com"),
                            Poll::Invalid => complete("not an email"),
                            Poll::Gone => StatusCode::NOT_FOUND.into_response(),
                            Poll::Broken => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                        }
                    },
                ),
            )
            .route(
                "/v1/auth/email",
                post(move |Json(body): Json<Value>| async move {
                    emails.with(|hosted| hosted.emails.push(body));
                    StatusCode::NO_CONTENT
                }),
            )
            .route(
                "/v1/auth/logout",
                post(move |headers: HeaderMap| async move {
                    let fails = logouts.with(|hosted| {
                        hosted.logouts.push(
                            headers["authorization"].to_str().unwrap().to_owned(),
                        );
                        hosted.logout_fails
                    });
                    if fails {
                        StatusCode::INTERNAL_SERVER_ERROR
                    } else {
                        StatusCode::NO_CONTENT
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(axum::serve(listener, app).into_future());
        (fake, format!("http://{address}"))
    }

    struct Fixture {
        state: AppState,
        fake: Fake,
        hosted: String,
        admin: String,
        member: String,
    }

    async fn fixture() -> Fixture {
        let (fake, hosted) = fake_hosted().await;
        let (state, _) = crate::http::routes::auth::tests::state();
        let state = state.with_accounts(AccountClient::new(
            hosted.parse().unwrap(),
            "install-1".to_owned(),
        ));
        let (admin, member) = state.with_database(|database| {
            let admin = crate::identity::auth::development_sign_in(database, Utc::now()).unwrap();
            database.connection().execute(
                "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member-1', 'M', 'm', 'member', 'active', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 1)",
                [],
            ).unwrap();
            let member =
                crate::identity::auth::create_session(database, "member-1", Utc::now()).unwrap();
            (admin.session_token, member)
        });
        Fixture {
            state,
            fake,
            hosted,
            admin: format!("sid_v1={admin}"),
            member: format!("sid_v1={member}"),
        }
    }

    async fn call(app: &axum::Router, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, app.clone().into_make_service_with_connect_info::<std::net::SocketAddr>()).into_future());
        let mut request = reqwest::Client::new().request(method.parse().unwrap(), format!("http://{address}{path}")).header("host", "localhost:4111").header("origin", "http://localhost:4111");
        if let Some(cookie) = cookie { request = request.header("cookie", cookie); }
        if let Some(body) = body { request = request.json(&body); }
        let response = request.send().await.unwrap();
        let status = response.status(); let headers = response.headers().clone(); let body = response.bytes().await.unwrap().to_vec();
        server.abort(); (status, headers, body)
    }

    fn login_cookie(headers: &HeaderMap) -> String {
        headers.get_all("set-cookie").iter().filter_map(|value| value.to_str().ok()).find(|value| value.starts_with("suplex_login=")).unwrap().split(';').next().unwrap().to_owned()
    }

    fn body(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    #[tokio::test]
    async fn login_sends_only_the_challenge_and_links_the_account_once_complete() {
        let f = fixture().await;
        let app = crate::http::router(f.state.clone());
        let (status, _, read) = call(&app, "GET", "/api/account", Some(&f.member), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body(&read), json!({"configured": true, "canManage": true}));

        let (status, headers, started) = call(
            &app,
            "POST",
            "/api/account/login",
            Some(&f.admin),
            Some(json!({"provider": "google"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["cache-control"], "no-store");
        let browser_cookie = login_cookie(&headers);
        let started = body(&started);
        assert_eq!(started["attemptId"], ATTEMPT_ID);
        assert_eq!(
            started["url"],
            format!(
                "{}/auth/start?attempt={ATTEMPT_ID}&provider=google",
                f.hosted
            )
        );
        let status_path = format!("/api/account/login/{ATTEMPT_ID}");
        let poll = || async {
            let (status, _, polled) = call(&app, "GET", &status_path, Some(&browser_cookie), None).await;
            (status, body(&polled))
        };
        assert_eq!(poll().await, (StatusCode::OK, json!({"status": "pending"})));
        f.fake.with(|hosted| hosted.poll = Some(Poll::Broken));
        let (status, failure) = poll().await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(failure["code"], "account_unavailable");
        assert!(f.state.with_database(|database| linked(database).unwrap()).is_none());

        f.fake.with(|hosted| hosted.poll = Some(Poll::Complete));
        assert_eq!(poll().await, (StatusCode::OK, json!({"status": "complete"})));
        let (challenge, verifiers) =
            f.fake.with(|hosted| (hosted.challenge.clone(), hosted.verifiers.clone()));
        assert_eq!(verifiers.len(), 3);
        assert!(verifiers.iter().all(|verifier| verifier == &verifiers[0]));
        assert_eq!(challenge.as_deref(), Some(wire::challenge(&verifiers[0]).as_str()));
        assert_ne!(challenge.as_deref(), Some(verifiers[0].as_str()));
        let account = f.state.with_database(|database| linked(database).unwrap()).unwrap();
        assert_eq!(
            (account.account_id.as_str(), account.email.as_str(), account.display_name.as_deref()),
            (ACCOUNT_ID, "ada@example.com", Some("Ada"))
        );
        // The attempt is used: this host forgets the verifier.
        assert_eq!(poll().await.0, StatusCode::FORBIDDEN);
        assert_eq!(f.fake.with(|hosted| hosted.verifiers.len()), 3);

        let (_, _, read) = call(&app, "GET", "/api/account", Some(&f.admin), None).await;
        assert_eq!(
            body(&read),
            json!({"configured": true, "canManage": true, "account": {"email": "ada@example.com", "displayName": "Ada"}})
        );
        let audit: Vec<String> = f.state.with_database(|database| {
            database
                .connection()
                .prepare("SELECT metadata_json FROM suplex_audit_events WHERE action = 'account_linked'")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        });
        assert_eq!(audit, ["{}"]);
    }

    #[tokio::test]
    async fn expired_invalid_and_unknown_attempts_never_link() {
        let f = fixture().await;
        let app = crate::http::router(f.state.clone());
        let status_path = format!("/api/account/login/{ATTEMPT_ID}");
        // Unknown here: the hosted service is not asked.
        let (_, _, polled) = call(&app, "GET", &status_path, Some(&f.admin), None).await;
        assert!(body(&polled)["error"].is_string());
        assert!(f.fake.with(|hosted| hosted.verifiers.is_empty()));

        for (poll, expected) in [
            (Poll::Gone, StatusCode::OK),
            (Poll::Invalid, StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let (status, headers, _) = call(
                &app,
                "POST",
                "/api/account/login",
                Some(&f.admin),
                Some(json!({"provider": "github"})),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            f.fake.with(|hosted| hosted.poll = Some(poll));
            let cookie = login_cookie(&headers);
            let (status, _, polled) = call(&app, "GET", &status_path, Some(&cookie), None).await;
            assert_eq!(status, expected);
            if expected == StatusCode::OK {
                assert_eq!(body(&polled), json!({"status": "expired"}));
            }
            assert!(f.state.with_database(|database| linked(database).unwrap()).is_none());
            f.state.with_database(|db| db.connection().execute("DELETE FROM suplex_account_login_attempts", []).unwrap());
        }
    }

    #[tokio::test]
    async fn email_login_asks_the_hosted_service_to_send_the_link() {
        let f = fixture().await;
        let app = crate::http::router(f.state.clone());
        let (status, _, started) = call(
            &app,
            "POST",
            "/api/account/login",
            Some(&f.admin),
            Some(json!({"provider": "email", "email": "ada@example.com"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body(&started), json!({"attemptId": ATTEMPT_ID}));
        assert_eq!(
            f.fake.with(|hosted| hosted.emails.clone()),
            [json!({"attemptId": ATTEMPT_ID, "email": "ada@example.com"})]
        );
        let (status, _, _) = call(
            &app,
            "POST",
            "/api/account/login",
            Some(&f.admin),
            Some(json!({"provider": "email"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = call(
            &app,
            "POST",
            "/api/account/login",
            Some(&f.admin),
            Some(json!({"provider": "saml"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn logout_removes_the_link_even_when_the_hosted_service_fails() {
        let f = fixture().await;
        let app = crate::http::router(f.state.clone());
        f.state.with_database(|database| {
            crate::accounts::link(
                database,
                &wire::HostedAccount {
                    id: ACCOUNT_ID.to_owned(),
                    email: "ada@example.com".to_owned(),
                    name: None,
                },
                &"k".repeat(43),
            )
            .unwrap();
        });
        f.fake.with(|hosted| hosted.logout_fails = true);
        let (status, _, _) = call(&app, "POST", "/api/account/logout", Some(&f.admin), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(f.state.with_database(|database| linked(database).unwrap()).is_none());
        assert_eq!(
            f.fake.with(|hosted| hosted.logouts.clone()),
            [format!("Bearer {}", "k".repeat(43))]
        );
        // Logging out again is harmless and does not call the hosted service.
        let (status, _, _) = call(&app, "POST", "/api/account/logout", Some(&f.admin), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(f.fake.with(|hosted| hosted.logouts.len()), 1);
    }

    #[tokio::test]
    async fn login_requires_the_host_origin_and_a_configured_service() {
        let f = fixture().await;
        let app = crate::http::router(f.state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(
            axum::serve(
                listener,
                app.clone()
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .into_future(),
        );
        let missing_origin = reqwest::Client::new()
            .post(format!("http://{address}/api/account/login"))
            .header("host", "suplex.example.test:4111")
            .header("x-forwarded-host", "suplex.example.test:4111")
            .header("x-forwarded-proto", "https")
            .header("cookie", &f.admin)
            .json(&json!({"provider": "google"}))
            .send()
            .await
            .unwrap();
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
        let missing_origin: Value = missing_origin.json().await.unwrap();
        assert_eq!(missing_origin["error"], "Open the HTTPS host address to log in");
        assert!(f.fake.with(|hosted| hosted.challenge.is_none()));

        let (state, _) = crate::http::routes::auth::tests::state();
        let admin = state.with_database(|database| {
            crate::identity::auth::development_sign_in(database, Utc::now()).unwrap()
        });
        let unconfigured = crate::http::router(state);
        let cookie = format!("sid_v1={}", admin.session_token);
        let (status, _, failure) = call(
            &unconfigured,
            "POST",
            "/api/account/login",
            Some(&cookie),
            Some(json!({"provider": "google"})),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body(&failure)["code"], "account_not_configured");
        let (_, _, read) = call(&unconfigured, "GET", "/api/account", Some(&cookie), None).await;
        assert_eq!(body(&read), json!({"configured": false, "canManage": true}));
    }
    #[tokio::test]
    async fn remote_login_is_bound_to_browser_and_invited_email() {
        use crate::http::routes::avatars::tests::call as remote;
        let f = fixture().await;
        let owner = wire::HostedAccount { id: "user_67e55044-10b1-426f-9247-bb680e5fe0c9".into(), email: "owner@example.com".into(), name: None };
        f.state.with_database(|db| {
            crate::accounts::link(db, &owner, &"o".repeat(43)).unwrap();
            db.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_test', 'Test', 'active', '2026-10-03T00:00:00.000Z')", []).unwrap();
            let invitation = crate::accounts::members::prepare(db, "user_development", "company_test", "Ada", "ada@example.com", "https://suplex.example.test:4111", Utc::now()).unwrap();
            db.connection().execute("UPDATE suplex_company_invitations SET sent_at = created_at WHERE id = ?1", [&invitation.id]).unwrap();
        });
        let app = crate::http::router(f.state.clone());
        let (status, headers, _) = remote(&app, "POST", "/api/account/login", None, Some(json!({"provider":"google"}))).await;
        assert_eq!(status, StatusCode::OK);
        let cookie = login_cookie(&headers);
        assert!(headers.get_all("set-cookie").iter().any(|header| header.to_str().unwrap().contains("Secure")));
        let path = format!("/api/account/login/{ATTEMPT_ID}");
        assert_eq!(remote(&app, "GET", &path, None, None).await.0, StatusCode::FORBIDDEN);
        assert!(f.fake.with(|hosted| hosted.verifiers.is_empty()));
        f.fake.with(|hosted| hosted.poll = Some(Poll::Complete));
        let (status, headers, _) = remote(&app, "GET", &path, Some(&cookie), None).await;
        assert_eq!(status, StatusCode::OK);
        let session = headers.get_all("set-cookie").iter().map(|h| h.to_str().unwrap()).find(|h| h.starts_with("sid_v1=")).unwrap().split(';').next().unwrap();
        let (status, _, profile) = remote(&app, "GET", "/api/auth/me", Some(session), None).await;
        assert_eq!(status, StatusCode::OK);
        let profile = body(&profile);
        assert_ne!(profile["user"]["id"], "user_development");
        assert_eq!(profile["user"]["companyIds"], json!(["company_test"]));
        assert_eq!(f.state.with_database(|db| linked(db).unwrap().unwrap().account_id), owner.id);
        assert_eq!(f.fake.with(|hosted| hosted.logouts.len()), 1);
        f.state.with_database(|db| crate::identity::companies::remove_membership(db, "user_development", profile["user"]["id"].as_str().unwrap(), "company_test", Utc::now()).unwrap());
        assert_eq!(remote(&app, "GET", "/api/auth/me", Some(session), None).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_recovery_link_links_the_owner_from_a_remote_login_once() {
        use crate::http::routes::avatars::tests::call as remote;
        let f = fixture().await;
        let previous = wire::HostedAccount { id: "user_67e55044-10b1-426f-9247-bb680e5fe0c9".into(), email: "previous@example.com".into(), name: None };
        let token = f.state.with_database(|db| {
            crate::accounts::link(db, &previous, &"o".repeat(43)).unwrap();
            crate::identity::auth::issue_recovery_invitation(db, "{}", Utc::now()).unwrap()
        });
        let app = crate::http::router(f.state.clone());

        let (status, _, refused) = remote(&app, "POST", "/api/account/login", None, Some(json!({"provider": "google", "recovery": "invite_v1_recovery_wrong"}))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body(&refused)["error"], "This recovery link expired or was used. Run suplex recover again.");
        assert!(f.fake.with(|hosted| hosted.challenge.is_none()), "a bad link never reaches the account service");

        let (status, headers, _) = remote(&app, "POST", "/api/account/login", None, Some(json!({"provider": "google", "recovery": token}))).await;
        assert_eq!(status, StatusCode::OK);
        let cookie = login_cookie(&headers);
        f.fake.with(|hosted| hosted.poll = Some(Poll::Complete));
        let (status, headers, _) = remote(&app, "GET", &format!("/api/account/login/{ATTEMPT_ID}"), Some(&cookie), None).await;
        assert_eq!(status, StatusCode::OK);
        let session = headers.get_all("set-cookie").iter().map(|h| h.to_str().unwrap()).find(|h| h.starts_with("sid_v1=")).unwrap().split(';').next().unwrap();
        let (_, _, profile) = remote(&app, "GET", "/api/auth/me", Some(session), None).await;
        assert_eq!(body(&profile)["user"]["id"], "user_development", "the recovered account signs in as the owner");
        assert_eq!(f.state.with_database(|db| linked(db).unwrap().unwrap().account_id), ACCOUNT_ID);
        assert!(f.fake.with(|hosted| hosted.logouts.is_empty()), "the owner link keeps its hosted token");

        let (status, _, _) = remote(&app, "POST", "/api/account/login", None, Some(json!({"provider": "google", "recovery": token}))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a recovery link works once");
    }

}
