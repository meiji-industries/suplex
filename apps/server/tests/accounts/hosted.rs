#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use crate::{
        accounts::{
            hosted::{
                fakes::{Fixture, INSTALLATION, ORIGIN, account_config, query},
                load_config,
            },
            wire::{random_token, token_shape, valid_account_id},
        },
        shared::hash::sha256_hex,
    };

    const MINUTE: i64 = 60 * 1000;

    #[tokio::test]
    async fn google_login_completes_the_attempt_once() {
        let f = Fixture::new().await;
        let (attempt, verifier) = f.attempt().await;
        assert_eq!(
            f.poll(&attempt, &verifier).await,
            (200, json!({"status": "pending"}))
        );

        let authorize = f.start(&attempt, "google").await;
        assert_eq!(authorize.path(), "/o/oauth2/v2/auth");
        assert_eq!(query(&authorize, "client_id").unwrap(), "google-client");
        assert_eq!(
            query(&authorize, "redirect_uri").unwrap(),
            format!("{ORIGIN}/auth/callback/google")
        );
        assert_eq!(query(&authorize, "scope").unwrap(), "openid email profile");
        assert_eq!(query(&authorize, "prompt").unwrap(), "select_account");
        let state = query(&authorize, "state").unwrap();
        assert!(token_shape(&state));

        let response = f
            .callback("google", &state, Some("theme=dark; suplex_visitor=visitor-12345"))
            .await;
        assert_eq!(response.status(), 303);
        assert_eq!(response.headers()["location"], "/auth/done");
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        let exchange = &f.calls("/token")[0];
        assert_eq!(
            exchange.form,
            [
                ("code", "code-1"),
                ("client_id", "google-client"),
                ("client_secret", "google-secret"),
                ("redirect_uri", &format!("{ORIGIN}/auth/callback/google")),
                ("grant_type", "authorization_code"),
            ]
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
        );
        assert_eq!(
            f.calls("/v1/userinfo")[0].header("authorization"),
            Some("Bearer google-access")
        );

        // A reused state fails; so does a wrong verifier, which consumes nothing.
        let reused = f.callback("google", &state, None).await;
        assert_eq!(reused.status(), 400);
        assert!(reused.text().await.unwrap().contains("could not complete the login"));
        assert_eq!(
            f.poll(&attempt, &random_token().unwrap()).await.0,
            404
        );

        let (status, body) = f.poll(&attempt, &verifier).await;
        assert_eq!(status, 200);
        assert_eq!(body["status"], "complete");
        let token = body["token"].as_str().unwrap();
        assert!(token_shape(token));
        let id = body["account"]["id"].as_str().unwrap();
        assert!(valid_account_id(id));
        assert_eq!(body["account"]["email"], "ada@example.com");
        assert_eq!(body["account"]["name"], "Ada");
        assert_eq!(
            f.count(&format!(
                "SELECT COUNT(*) FROM account_tokens WHERE token_hash = '{}' AND installation_id = '{INSTALLATION}'",
                sha256_hex(token)
            )),
            1
        );
        assert_eq!(f.poll(&attempt, &verifier).await.0, 404);

        let events = f.events();
        assert_eq!(events.len(), 2);
        assert_eq!(
            (events[0].0.as_str(), events[0].1.as_str()),
            ("account_signed_up", id)
        );
        assert_eq!(
            events[0].2,
            json!({
                "$lib": "suplex-hosted",
                "provider": "google",
                "$groups": {"host": INSTALLATION},
                "$set": {"email": "ada@example.com"},
            })
        );
        assert_eq!(
            (events[1].0.as_str(), events[1].1.as_str()),
            ("$identify", id)
        );
        assert_eq!(events[1].2["$anon_distinct_id"], "visitor-12345");
    }

    #[tokio::test]
    async fn github_login_reuses_the_account_with_the_primary_verified_email() {
        let f = Fixture::new().await;
        let first = f.login("google").await;
        let second = f.login("github").await;
        assert_eq!(second["account"]["id"], first["account"]["id"]);
        assert_eq!(second["account"]["email"], "ada@example.com");
        assert_eq!(f.count("SELECT COUNT(*) FROM accounts"), 1);
        let events = f.events();
        assert_eq!(events[1].0, "account_logged_in");
        assert_eq!(events[1].2["provider"], "github");

        let exchange = &f.calls("/login/oauth/access_token")[0];
        assert_eq!(exchange.header("accept"), Some("application/json"));
        let user = &f.calls("/user")[0];
        assert_eq!(user.header("user-agent"), Some("suplex-hosted"));
        assert_eq!(user.header("x-github-api-version"), Some("2022-11-28"));

        // Without a primary verified address, any verified address counts.
        f.answer(
            "GET /user/emails",
            200,
            json!([
                {"email": "primary@example.com", "primary": true, "verified": false},
                {"email": "verified@example.com", "primary": false, "verified": true}
            ]),
        );
        assert_eq!(
            f.login("github").await["account"]["email"],
            "verified@example.com"
        );

        f.answer(
            "GET /user/emails",
            200,
            json!([{"email": "primary@example.com", "primary": true, "verified": false}]),
        );
        let (attempt, verifier) = f.attempt().await;
        let refused = f.sign_in(&attempt, "github", None).await;
        assert_eq!(refused.status(), 403);
        assert!(refused.text().await.unwrap().contains("verified email address"));
        assert_eq!(
            f.poll(&attempt, &verifier).await,
            (200, json!({"status": "pending"}))
        );
    }

    #[tokio::test]
    async fn unverified_or_failing_providers_do_not_complete_the_attempt() {
        let f = Fixture::new().await;
        f.answer(
            "GET /v1/userinfo",
            200,
            json!({"email": "ada@example.com", "email_verified": false}),
        );
        let (attempt, _) = f.attempt().await;
        assert_eq!(f.sign_in(&attempt, "google", None).await.status(), 403);

        f.answer("POST /token", 500, "secret provider body");
        let failed = f.sign_in(&attempt, "google", None).await;
        assert_eq!(failed.status(), 502);
        assert!(!failed.text().await.unwrap().contains("secret"));

        assert_eq!(f.callback("google", &random_token().unwrap(), None).await.status(), 400);
        assert_eq!(f.callback("saml", "state", None).await.status(), 400);
        let email = f
            .get(&format!("/auth/start?attempt={attempt}&provider=email"), &[])
            .await;
        assert_eq!(email.status(), 400);
        assert_eq!(f.count("SELECT COUNT(*) FROM accounts"), 0);
    }

    #[tokio::test]
    async fn attempts_expire_after_fifteen_minutes_and_are_swept() {
        let f = Fixture::new().await;
        let (attempt, verifier) = f.attempt().await;
        f.advance(15 * MINUTE);
        assert_eq!(f.poll(&attempt, &verifier).await.0, 404);
        let start = f
            .get(&format!("/auth/start?attempt={attempt}&provider=google"), &[])
            .await;
        assert_eq!(start.status(), 400);
        f.accounts.sweep().unwrap();
        assert_eq!(f.count("SELECT COUNT(*) FROM account_attempts"), 1);
        f.advance(60 * MINUTE);
        f.accounts.sweep().unwrap();
        assert_eq!(f.count("SELECT COUNT(*) FROM account_attempts"), 0);
    }

    #[tokio::test]
    async fn magic_link_get_shows_a_form_and_post_consumes_it_once() {
        let f = Fixture::new().await;
        let (attempt, verifier) = f.attempt().await;
        let (status, _) = f
            .post(
                "/v1/auth/email",
                &json!({"attemptId": attempt, "email": " Ada@Example.com "}),
            )
            .await;
        assert_eq!(status, 204);
        let sent = f.calls("/emails")[0].json();
        assert_eq!(sent["to"], json!(["ada@example.com"]));
        assert_eq!(sent["subject"], "Sign in to Suplex");
        assert_eq!(sent["from"], "Suplex <login@suplex.test>");
        assert_eq!(
            f.calls("/emails")[0].header("authorization"),
            Some("Bearer re_test")
        );
        assert_eq!(sent["template"]["id"], "suplex-base");
        let link = sent["template"]["variables"]["ACTION_URL"].as_str().unwrap();
        let token = link
            .strip_prefix(&format!("{ORIGIN}/auth/email/verify?token="))
            .unwrap();
        assert!(token_shape(token));

        // A GET (a mail scanner) does not consume the link.
        let form = f.get(&format!("/auth/email/verify?token={token}"), &[]).await;
        assert_eq!(form.status(), 200);
        assert_eq!(form.headers()["cache-control"], "no-store");
        let html = form.text().await.unwrap();
        assert!(html.contains(&format!("value=\"{token}\"")));
        assert_eq!(
            f.poll(&attempt, &verifier).await,
            (200, json!({"status": "pending"}))
        );
        let bad = f.get("/auth/email/verify?token=<script>", &[]).await;
        assert_eq!(bad.status(), 400);
        assert!(!bad.text().await.unwrap().contains("<script>"));

        let verified = f.post_form("/auth/email/verify", &[("token", token)]).await;
        assert_eq!(verified.status(), 303);
        assert_eq!(verified.headers()["location"], "/auth/done");
        let again = f.post_form("/auth/email/verify", &[("token", token)]).await;
        assert_eq!(again.status(), 400);

        let (status, body) = f.poll(&attempt, &verifier).await;
        assert_eq!(status, 200);
        assert_eq!(body["account"]["email"], "ada@example.com");
        assert_eq!(f.events()[0].2["provider"], "email");
    }

    #[tokio::test]
    async fn magic_links_are_limited_per_address_and_need_resend() {
        let f = Fixture::new().await;
        let (attempt, _) = f.attempt().await;
        let body = json!({"attemptId": attempt, "email": "ada@example.com"});
        for _ in 0..5 {
            assert_eq!(f.post("/v1/auth/email", &body).await.0, 204);
        }
        assert_eq!(
            f.post("/v1/auth/email", &body).await,
            (
                429,
                json!({"error": "Too many sign-in emails for this address", "code": "rate_limited"})
            )
        );
        f.advance(61 * MINUTE);
        let (attempt, _) = f.attempt().await;
        let body = json!({"attemptId": attempt, "email": "ada@example.com"});
        f.answer("POST /emails", 500, "{}");
        let (status, error) = f.post("/v1/auth/email", &body).await;
        assert_eq!((status, &error["code"]), (503, &json!("email_unavailable")));
        assert_eq!(
            f.count(&format!(
                "SELECT COUNT(*) FROM account_magic_links WHERE attempt_id = '{attempt}'"
            )),
            0
        );
        assert_eq!(
            f.post(
                "/v1/auth/email",
                &json!({"attemptId": attempt, "email": "not-an-email"})
            )
            .await
            .0,
            400
        );
    }

    #[tokio::test]
    async fn logout_forgets_the_token_and_is_idempotent() {
        let f = Fixture::new().await;
        let token = f.login("google").await["token"].as_str().unwrap().to_owned();
        assert_eq!(f.count("SELECT COUNT(*) FROM account_tokens"), 1);
        assert_eq!(f.logout(Some(&token)).await, 204);
        assert_eq!(f.count("SELECT COUNT(*) FROM account_tokens"), 0);
        assert_eq!(f.logout(Some(&token)).await, 204);
        assert_eq!(f.logout(None).await, 204);
    }

    #[tokio::test]
    async fn without_account_config_auth_answers_503_and_the_rest_still_works() {
        let f = Fixture::with(None).await;
        let unavailable = json!({"error": "Suplex accounts are not available", "code": "account_unavailable"});
        assert_eq!(
            f.post(
                "/v1/auth/attempts",
                &json!({"challenge": "x", "installationId": INSTALLATION})
            )
            .await,
            (503, unavailable.clone())
        );
        assert_eq!(f.logout(None).await, 503);
        let start = f.get("/auth/start?attempt=a&provider=google", &[]).await;
        assert_eq!(start.status(), 503);
        assert_eq!(start.headers()["referrer-policy"], "no-referrer");
        let done = f.get("/auth/done", &[]).await;
        assert_eq!(done.status(), 200);
        assert_eq!(done.headers()["cache-control"], "no-store");
        assert_eq!(done.headers()["referrer-policy"], "no-referrer");
        assert!(done.text().await.unwrap().contains("suplex://auth/done"));
        assert_eq!(f.get("/health", &[]).await.status(), 200);
    }

    #[tokio::test]
    async fn auth_bodies_over_64_kib_are_refused() {
        let f = Fixture::new().await;
        let (status, _) = f
            .post(
                "/v1/auth/attempts",
                &json!({"padding": "x".repeat(64 * 1024)}),
            )
            .await;
        assert_eq!(status, 413);
    }

    #[tokio::test]
    async fn the_review_address_logs_in_without_an_email() {
        let mut config = account_config();
        config.review_email = Some("review-k3y@suplex.test".into());
        let f = Fixture::with(Some(config)).await;
        let (attempt, verifier) = f.attempt().await;
        let body = json!({"attemptId": attempt, "email": " Review-K3Y@suplex.test "});
        assert_eq!(f.post("/v1/auth/email", &body).await.0, 204);
        assert!(f.calls("/emails").is_empty());
        let (status, body) = f.poll(&attempt, &verifier).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["account"]["email"], "review-k3y@suplex.test");
        // Every other address still gets an email.
        let (other, _) = f.attempt().await;
        let body = json!({"attemptId": other, "email": "review-k3y@suplex.tes"});
        assert_eq!(f.post("/v1/auth/email", &body).await.0, 204);
        assert_eq!(f.calls("/emails").len(), 1);
    }

    #[test]
    fn configuration_requires_all_or_none_of_the_account_group() {
        let full = HashMap::from([
            ("ACCOUNT_GOOGLE_CLIENT_ID", "a"),
            ("ACCOUNT_GOOGLE_CLIENT_SECRET", "b"),
            ("ACCOUNT_GITHUB_CLIENT_ID", "c"),
            ("ACCOUNT_GITHUB_CLIENT_SECRET", "d"),
            ("RESEND_API_KEY", "e"),
            ("ACCOUNT_EMAIL_FROM", "f"),
            ("ACCOUNT_REVIEW_EMAIL", " Review-1@Suplex.test "),
        ]);
        let load = |skip: &[&str]| {
            load_config(&|name| {
                (!skip.contains(&name))
                    .then(|| full.get(name).map(|value| (*value).to_owned()))
                    .flatten()
            })
        };
        assert_eq!(load(&[]).unwrap().unwrap().email_from, "f");
        assert_eq!(load(&[]).unwrap().unwrap().review_email.as_deref(), Some("review-1@suplex.test"));
        assert_eq!(load(&["ACCOUNT_REVIEW_EMAIL"]).unwrap().unwrap().review_email, None);
        let without = load(&[
            "ACCOUNT_GOOGLE_CLIENT_ID",
            "ACCOUNT_GOOGLE_CLIENT_SECRET",
            "ACCOUNT_GITHUB_CLIENT_ID",
            "ACCOUNT_GITHUB_CLIENT_SECRET",
            "RESEND_API_KEY",
            "ACCOUNT_EMAIL_FROM",
        ])
        .unwrap();
        assert!(without.is_none());
        assert!(
            load(&["RESEND_API_KEY"])
                .unwrap_err()
                .starts_with("Set all or none of ACCOUNT_GOOGLE_CLIENT_ID")
        );
    }

    /// The private host's client against this service: the two halves agree.
    #[tokio::test]
    async fn the_host_client_links_through_the_real_service() {
        use crate::accounts::{AccountClient, LoginPoll, wire::{AuthProvider, LoginClient}};

        let f = Fixture::new().await;
        let client = AccountClient::new(f.url.parse().unwrap(), INSTALLATION.to_owned());
        let (attempt, url) = client.start_login(AuthProvider::Google, None, LoginClient::Web).await.unwrap();
        let url = url::Url::parse(&url.unwrap()).unwrap();
        assert_eq!(url.path(), "/auth/start");
        assert_eq!(client.poll_login(&attempt).await.unwrap(), LoginPoll::Pending);
        let state = query(&f.start(&attempt, "google").await, "state").unwrap();
        // A login that started in a web browser does not open the desktop app.
        let finished = f.callback("google", &state, None).await;
        assert_eq!(finished.status(), 303);
        assert_eq!(finished.headers()["location"], "/auth/done?client=web");
        let LoginPoll::Complete { token, account } = client.poll_login(&attempt).await.unwrap()
        else {
            panic!("the attempt did not complete");
        };
        assert!(token_shape(&token) && valid_account_id(&account.id));
        assert_eq!(client.poll_login(&attempt).await.unwrap(), LoginPoll::Expired);

        let (email_attempt, url) = client
            .start_login(AuthProvider::Email, Some("ada@example.com"), LoginClient::Desktop)
            .await
            .unwrap();
        assert!(url.is_none());
        assert_eq!(client.poll_login(&email_attempt).await.unwrap(), LoginPoll::Pending);

        client.logout(&token).await;
        assert_eq!(f.logout(Some(&token)).await, 204);
    }

    #[test]
    fn apply_schema_adds_the_client_column_to_an_older_database() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE accounts (id TEXT PRIMARY KEY); CREATE TABLE account_attempts (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, installation_id TEXT NOT NULL, provider TEXT, provider_state TEXT UNIQUE, account_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)").unwrap();
        crate::accounts::hosted::store::apply_schema(&db).unwrap();
        crate::accounts::hosted::store::apply_schema(&db).unwrap();
        crate::accounts::hosted::store::insert_attempt(&db, "a", "c", "i", crate::accounts::wire::LoginClient::Web, "1", "3").unwrap();
        assert_eq!(crate::accounts::hosted::store::find_attempt(&db, "a", "2").unwrap().unwrap().client, crate::accounts::wire::LoginClient::Web);
    }
}
