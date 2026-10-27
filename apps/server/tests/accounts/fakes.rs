// The hosted account fixture. One loopback stub answers Google, GitHub,
// Resend, and the release feed by "METHOD /path"; tests change an answer
// with `answer` and read requests with `calls`. The full hosted router
// (billing, accounts, site) runs on 127.0.0.1:0.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
};

use axum::{
    Router,
    body::Bytes,
    http::{HeaderMap, Method, StatusCode, Uri},
};
use serde_json::{Value, json};

use super::{AccountConfig, Accounts, providers::Endpoints, store as account_store};
use crate::{
    accounts::wire::{challenge, random_token},
    billing::{
        hosted::{
            Hosted,
            fakes::{Recorded, hosted_config, spawn, start_ms},
            revenuecat::RevenueCatClient,
            store, stripe::StripeClient, telemetry,
        },
        wire::BillingEnvironment,
    },
};

pub const ORIGIN: &str = "https://suplex.test";
pub const INSTALLATION: &str = "installation_1";
/// `whsec_` and the base64 of "suplex-resend-webhook-key".
pub const RESEND_WEBHOOK_SECRET: &str = "whsec_c3VwbGV4LXJlc2VuZC13ZWJob29rLWtleQ==";
pub const MANIFEST: &str = "version: 1.2.3\nfiles:\n  - url: Suplex-1.2.3-arm64.dmg\n  - url: Suplex-1.2.3-arm64-mac.zip\npath: Suplex-1.2.3-arm64.dmg\n";

type Answers = Arc<Mutex<HashMap<String, (u16, String)>>>;

pub fn account_config() -> AccountConfig {
    AccountConfig {
        google_client_id: "google-client".into(),
        google_client_secret: "google-secret".into(),
        github_client_id: "github-client".into(),
        github_client_secret: "github-secret".into(),
        resend_api_key: "re_test".into(),
        email_from: "Suplex <login@suplex.test>".into(),
        review_email: None,
        resend_webhook_secret: Some(RESEND_WEBHOOK_SECRET.into()),
    }
}

fn default_answers() -> HashMap<String, (u16, String)> {
    [
        ("POST /token", json!({"access_token": "google-access"})),
        (
            "GET /v1/userinfo",
            json!({"email": "Ada@Example.com", "email_verified": true, "name": "Ada"}),
        ),
        (
            "POST /login/oauth/access_token",
            json!({"access_token": "github-access"}),
        ),
        ("GET /user", json!({"login": "ada", "name": null})),
        (
            "GET /user/emails",
            json!([
                {"email": "old@example.com", "primary": false, "verified": true},
                {"email": "ada@example.com", "primary": true, "verified": true}
            ]),
        ),
        ("POST /emails", json!({"id": "email_1"})),
        ("POST /contacts", json!({"id": "contact_1"})),
        ("POST /events/send", json!({"object": "event"})),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), (200, value.to_string())))
    .chain([(
        "GET /stable/mac/arm64/latest-mac.yml".to_owned(),
        (200, MANIFEST.to_owned()),
    )])
    .collect()
}

pub struct Fixture {
    pub url: String,
    pub stub: String,
    pub accounts: Accounts,
    pub clock: Arc<AtomicI64>,
    answers: Answers,
    calls: Arc<Mutex<Vec<Recorded>>>,
    directory: PathBuf,
    http: reqwest::Client,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

impl Fixture {
    pub async fn new() -> Self {
        Self::with(Some(account_config())).await
    }

    pub async fn with(config: Option<AccountConfig>) -> Self {
        let answers: Answers = Arc::new(Mutex::new(default_answers()));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stub = {
            let (answers, calls) = (answers.clone(), calls.clone());
            spawn(Router::new().fallback(
                move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
                    let key = format!("{method} {}", uri.path());
                    let (status, text) = answers
                        .lock()
                        .unwrap()
                        .get(&key)
                        .cloned()
                        .unwrap_or((404, "{}".into()));
                    calls.lock().unwrap().push(Recorded {
                        method,
                        path: uri.path().to_owned(),
                        query: url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
                            .into_owned()
                            .collect(),
                        form: url::form_urlencoded::parse(&body).into_owned().collect(),
                        headers,
                        body,
                    });
                    async move { (StatusCode::from_u16(status).unwrap(), text) }
                },
            ))
            .await
        };
        let clock = Arc::new(AtomicI64::new(start_ms()));
        let directory =
            std::env::temp_dir().join(format!("suplex-accounts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let connection = store::open(&directory.join("billing.sqlite")).unwrap();
        account_store::apply_schema(&connection).unwrap();
        let mut billing = hosted_config(BillingEnvironment::Sandbox);
        billing.origin = ORIGIN.into();
        billing.telemetry = Some(telemetry::Config {
            key: "phc_test".into(),
            host: stub.clone(),
        });
        let hosted = {
            let clock = clock.clone();
            Hosted::new(
                billing,
                connection,
                StripeClient::new("http://127.0.0.1:9", "sk_test_fake"),
                RevenueCatClient::new("http://127.0.0.1:9", "rc_secret", "rc_public"),
                Arc::new(move || clock.load(Ordering::SeqCst)),
            )
        };
        let endpoints = Endpoints {
            google_accounts: stub.clone(),
            google_oauth: stub.clone(),
            google_openid: stub.clone(),
            github: stub.clone(),
            github_api: stub.clone(),
            resend: stub.clone(),
            downloads: stub.clone(),
        };
        let accounts = Accounts::new(hosted, config, endpoints);
        Self {
            url: spawn(crate::hosted::router(&accounts)).await,
            stub,
            accounts,
            clock,
            answers,
            calls,
            directory,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        }
    }

    pub fn answer(&self, key: &str, status: u16, body: impl ToString) {
        self.answers
            .lock()
            .unwrap()
            .insert(key.to_owned(), (status, body.to_string()));
    }

    pub fn calls(&self, path: &str) -> Vec<Recorded> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.path == path)
            .cloned()
            .collect()
    }

    pub fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.accounts
            .hosted
            .query(|db| db.query_row(sql, [], |row| row.get(0)))
            .unwrap()
    }

    /// Queued PostHog events as (event, distinct_id, properties).
    pub fn events(&self) -> Vec<(String, String, Value)> {
        self.accounts
            .hosted
            .query(|db| {
                db.prepare("SELECT event_name, distinct_id, properties_json FROM billing_telemetry_events ORDER BY rowid")?
                    .query_map([], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            serde_json::from_str(&row.get::<_, String>(2)?).unwrap(),
                        ))
                    })?
                    .collect()
            })
            .unwrap()
    }

    pub async fn get(&self, path: &str, headers: &[(&str, &str)]) -> reqwest::Response {
        let mut request = self.http.get(format!("{}{path}", self.url));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request.send().await.unwrap()
    }

    pub async fn post(&self, path: &str, body: &Value) -> (u16, Value) {
        let response = self
            .http
            .post(format!("{}{path}", self.url))
            .json(body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    pub async fn post_form(&self, path: &str, form: &[(&str, &str)]) -> reqwest::Response {
        self.http
            .post(format!("{}{path}", self.url))
            .form(form)
            .send()
            .await
            .unwrap()
    }

    pub async fn logout(&self, token: Option<&str>) -> u16 {
        let mut request = self.http.post(format!("{}/v1/auth/logout", self.url));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request.send().await.unwrap().status().as_u16()
    }

    /// A new attempt and its verifier.
    pub async fn attempt(&self) -> (String, String) {
        let verifier = random_token().unwrap();
        let (status, body) = self
            .post(
                "/v1/auth/attempts",
                &json!({"challenge": challenge(&verifier), "installationId": INSTALLATION}),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        (body["attemptId"].as_str().unwrap().to_owned(), verifier)
    }

    pub async fn poll(&self, attempt: &str, verifier: &str) -> (u16, Value) {
        self.post(
            &format!("/v1/auth/attempts/{attempt}/poll"),
            &json!({"verifier": verifier}),
        )
        .await
    }

    /// `/auth/start` and returns the provider authorization URL.
    pub async fn start(&self, attempt: &str, provider: &str) -> url::Url {
        let response = self
            .get(
                &format!("/auth/start?attempt={attempt}&provider={provider}"),
                &[],
            )
            .await;
        assert_eq!(response.status(), 303);
        url::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap()
    }

    /// The browser's provider round trip, ending at the callback.
    pub async fn sign_in(
        &self,
        attempt: &str,
        provider: &str,
        cookie: Option<&str>,
    ) -> reqwest::Response {
        let authorize = self.start(attempt, provider).await;
        let state = query(&authorize, "state").unwrap();
        self.callback(provider, &state, cookie).await
    }

    pub async fn callback(
        &self,
        provider: &str,
        state: &str,
        cookie: Option<&str>,
    ) -> reqwest::Response {
        let headers = cookie.map(|cookie| vec![("cookie", cookie)]).unwrap_or_default();
        self.get(
            &format!("/auth/callback/{provider}?code=code-1&state={state}"),
            &headers,
        )
        .await
    }

    /// A complete login through `provider`; returns the poll result.
    pub async fn login(&self, provider: &str) -> Value {
        let (attempt, verifier) = self.attempt().await;
        let response = self.sign_in(&attempt, provider, None).await;
        assert_eq!(response.status(), 303);
        let (status, body) = self.poll(&attempt, &verifier).await;
        assert_eq!(status, 200, "{body}");
        body
    }
}

pub fn query(url: &url::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}
