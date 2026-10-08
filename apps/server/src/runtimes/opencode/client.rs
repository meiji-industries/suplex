//! Authenticated loopback client for the OpenCode v1 HTTP server.

use std::{fmt, time::Duration};

use base64::Engine;
use reqwest::{Method, StatusCode, header, redirect::Policy};
use serde_json::{Map, Value};
use url::Url;

use super::contracts::{
    Envelope, Health, McpStatus, NativeModel, PromptRequest, Providers, Session,
    SessionCreateModel, SessionCreateRequest, SessionStatusMap, TextInput,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureCode {
    InvalidAddress,
    InvalidRequest,
    Unauthorized,
    NotFound,
    UnexpectedStatus,
    InvalidResponse,
    ServerUnavailable,
    Timeout,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenCodeFailure {
    pub code: FailureCode,
    pub retryable: bool,
    pub message: String,
    pub status: Option<u16>,
}

impl fmt::Display for OpenCodeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for OpenCodeFailure {}

fn failure(code: FailureCode, retryable: bool, message: impl Into<String>) -> OpenCodeFailure {
    OpenCodeFailure {
        code,
        retryable,
        message: message.into(),
        status: None,
    }
}

fn loopback_address(raw: &str) -> Result<Url, OpenCodeFailure> {
    let invalid = |message: &str| failure(FailureCode::InvalidAddress, false, message);
    let mut parsed = Url::parse(raw).map_err(|_| invalid("OpenCode server address is invalid"))?;
    let host = parsed.host_str().unwrap_or_default();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if !["127.0.0.1", "localhost", "::1"].contains(&host) {
        return Err(invalid("OpenCode server address must be loopback"));
    }
    if !["http", "https"].contains(&parsed.scheme()) {
        return Err(invalid("OpenCode server address must use HTTP"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err(invalid(
            "OpenCode server address must not contain credentials",
        ));
    }
    let path = parsed.path().trim_end_matches('/').to_owned();
    parsed.set_path(&path);
    parsed.set_query(None);
    Ok(parsed)
}

fn failure_for_status(status: StatusCode, path: &str) -> OpenCodeFailure {
    let code = status.as_u16();
    let (kind, retryable, message) = match code {
        401 | 403 => (
            FailureCode::Unauthorized,
            false,
            format!("OpenCode rejected {path}"),
        ),
        404 => (
            FailureCode::NotFound,
            false,
            format!("OpenCode resource was not found at {path}"),
        ),
        408 | 429 | 500.. => (
            FailureCode::ServerUnavailable,
            true,
            format!("OpenCode server returned {code} for {path}"),
        ),
        _ => (
            FailureCode::UnexpectedStatus,
            false,
            format!("OpenCode server returned {code} for {path}"),
        ),
    };
    OpenCodeFailure {
        status: Some(code),
        ..failure(kind, retryable, message)
    }
}

pub struct CreateSessionInput<'a> {
    pub title: &'a str,
    pub directory: Option<&'a str>,
    pub model: SessionCreateModel,
    pub agent: &'a str,
    pub metadata: Option<Map<String, Value>>,
}

pub struct PromptInput<'a> {
    pub session_id: &'a str,
    pub message_id: &'a str,
    pub text: &'a str,
    pub model: &'a NativeModel,
    pub agent: &'a str,
    pub variant: &'a str,
    pub directory: Option<&'a str>,
    pub no_reply: Option<bool>,
    pub system: Option<&'a str>,
}

#[derive(Clone, Debug)]
pub struct OpenCodeClient {
    address: Url,
    password: String,
    timeout: Duration,
    http: reqwest::Client,
}

impl OpenCodeClient {
    pub fn new(base_url: &str, password: &str) -> Result<Self, OpenCodeFailure> {
        let address = loopback_address(base_url)?;
        if password.is_empty() {
            return Err(failure(
                FailureCode::InvalidRequest,
                false,
                "OpenCode server password is required",
            ));
        }
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::custom(|attempt| attempt.error("redirect")))
            .build()
            .map_err(|_| {
                failure(
                    FailureCode::ServerUnavailable,
                    true,
                    "OpenCode client could not start",
                )
            })?;
        Ok(Self {
            address,
            password: password.to_owned(),
            timeout: Duration::from_millis(10_000),
            http,
        })
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub async fn health(&self) -> Result<Health, OpenCodeFailure> {
        let (value, path) = self
            .request(Method::GET, &["global", "health"], &[], None, 200)
            .await?;
        Health::parse(value).map_err(|_| envelope(&path))
    }

    pub async fn providers(&self, directory: Option<&str>) -> Result<Providers, OpenCodeFailure> {
        self.typed(&["provider"], &[("directory", directory)]).await
    }

    pub async fn mcp_status(&self, directory: &str) -> Result<McpStatus, OpenCodeFailure> {
        self.typed(&["mcp"], &[("directory", Some(directory))])
            .await
    }

    pub async fn get_config(
        &self,
        directory: Option<&str>,
    ) -> Result<Map<String, Value>, OpenCodeFailure> {
        self.typed(&["config"], &[("directory", directory)]).await
    }

    pub async fn create_session(
        &self,
        input: CreateSessionInput<'_>,
    ) -> Result<Session, OpenCodeFailure> {
        let request = SessionCreateRequest {
            title: input.title.to_owned(),
            agent: input.agent.to_owned(),
            model: input.model,
            metadata: input.metadata,
        };
        if !request.valid() {
            return Err(failure(
                FailureCode::InvalidRequest,
                false,
                "OpenCode session request is invalid",
            ));
        }
        let body = serde_json::to_value(request).expect("session request serializes");
        let (value, path) = self
            .request(
                Method::POST,
                &["session"],
                &[("directory", input.directory)],
                Some(body),
                200,
            )
            .await?;
        Session::parse(value).map_err(|_| envelope(&path))
    }

    pub async fn get_session(
        &self,
        session_id: &str,
        directory: Option<&str>,
    ) -> Result<Session, OpenCodeFailure> {
        let (value, path) = self
            .request(
                Method::GET,
                &["session", session_id],
                &[("directory", directory)],
                None,
                200,
            )
            .await?;
        Session::parse(value).map_err(|_| envelope(&path))
    }

    pub async fn get_messages(
        &self,
        session_id: &str,
        directory: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<Envelope>, OpenCodeFailure> {
        let limit = limit.map(|limit| limit.to_string());
        let (value, path) = self
            .request(
                Method::GET,
                &["session", session_id, "message"],
                &[("directory", directory), ("limit", limit.as_deref())],
                None,
                200,
            )
            .await?;
        Envelope::parse_all(value).map_err(|_| envelope(&path))
    }

    pub async fn get_status(
        &self,
        directory: Option<&str>,
    ) -> Result<SessionStatusMap, OpenCodeFailure> {
        self.typed(&["session", "status"], &[("directory", directory)])
            .await
    }

    pub async fn abort_session(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<bool, OpenCodeFailure> {
        let (value, path) = self
            .request(
                Method::POST,
                &["session", session_id, "abort"],
                &[("directory", Some(directory))],
                None,
                200,
            )
            .await?;
        value.as_bool().ok_or_else(|| envelope(&path))
    }

    pub async fn prompt_async(&self, input: PromptInput<'_>) -> Result<(), OpenCodeFailure> {
        let request = PromptRequest {
            message_id: input.message_id.to_owned(),
            model: input.model.clone(),
            agent: input.agent.to_owned(),
            variant: input.variant.to_owned(),
            parts: vec![TextInput {
                kind: "text",
                text: input.text.to_owned(),
            }],
            no_reply: input.no_reply,
            system: input.system.map(str::to_owned),
            tools: None,
        };
        if !request.valid() {
            return Err(failure(
                FailureCode::InvalidRequest,
                false,
                "OpenCode prompt request is invalid",
            ));
        }
        let body = serde_json::to_value(request).expect("prompt request serializes");
        self.request(
            Method::POST,
            &["session", input.session_id, "prompt_async"],
            &[("directory", input.directory)],
            Some(body),
            204,
        )
        .await?;
        Ok(())
    }

    async fn typed<T: serde::de::DeserializeOwned>(
        &self,
        segments: &[&str],
        query: &[(&str, Option<&str>)],
    ) -> Result<T, OpenCodeFailure> {
        let (value, path) = self
            .request(Method::GET, segments, query, None, 200)
            .await?;
        serde_json::from_value(value).map_err(|_| envelope(&path))
    }

    async fn request(
        &self,
        method: Method,
        segments: &[&str],
        query: &[(&str, Option<&str>)],
        body: Option<Value>,
        expected: u16,
    ) -> Result<(Value, String), OpenCodeFailure> {
        let mut url = self.address.clone();
        url.path_segments_mut()
            .expect("loopback HTTP URL has a path")
            .clear()
            .extend(segments);
        let path = url.path().to_owned();
        for (key, value) in query {
            if let Some(value) = value {
                url.query_pairs_mut().append_pair(key, value);
            }
        }
        let credentials =
            base64::engine::general_purpose::STANDARD.encode(format!("opencode:{}", self.password));
        let mut request = self
            .http
            .request(method, url)
            .timeout(self.timeout)
            .header(header::ACCEPT, "application/json")
            .header(header::AUTHORIZATION, format!("Basic {credentials}"));
        if let Some(body) = body {
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(body.to_string());
        }
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                failure(
                    FailureCode::Timeout,
                    true,
                    format!("OpenCode request timed out for {path}"),
                )
            } else {
                failure(
                    FailureCode::ServerUnavailable,
                    true,
                    format!("OpenCode server could not be reached for {path}"),
                )
            }
        })?;
        if response.status().as_u16() != expected {
            return Err(failure_for_status(response.status(), &path));
        }
        if expected == 204 {
            return Ok((Value::Null, path));
        }
        let parsed = response
            .bytes()
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .ok_or_else(|| {
                failure(
                    FailureCode::InvalidResponse,
                    false,
                    format!("OpenCode returned invalid JSON for {path}"),
                )
            })?;
        Ok((parsed, path))
    }
}

fn envelope(path: &str) -> OpenCodeFailure {
    failure(
        FailureCode::InvalidResponse,
        false,
        format!("OpenCode returned an invalid v1 envelope for {path}"),
    )
}

#[cfg(test)]
pub(crate) mod fake {
    //! A loopback HTTP stand-in for the native server, like the TypeScript tests' fake fetch.

    use std::sync::{Arc, Mutex};

    use axum::{
        body::Bytes,
        http::{HeaderMap, Method, Uri},
        response::IntoResponse,
    };

    #[derive(Clone, Debug)]
    pub struct Request {
        pub method: String,
        pub path: String,
        pub query: String,
        pub authorization: String,
        pub body: Vec<u8>,
    }

    pub type Log = Arc<Mutex<Vec<Request>>>;

    pub async fn serve<F>(handler: F) -> (String, Log)
    where
        F: Fn(&Request) -> (u16, String) + Clone + Send + Sync + 'static,
    {
        let log: Log = Arc::default();
        let recorded = log.clone();
        let app = axum::Router::new().fallback(
            move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
                let handler = handler.clone();
                let recorded = recorded.clone();
                async move {
                    let request = Request {
                        method: method.to_string(),
                        path: uri.path().to_owned(),
                        query: uri.query().unwrap_or_default().to_owned(),
                        authorization: headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned(),
                        body: body.to_vec(),
                    };
                    let (status, text) = handler(&request);
                    recorded.lock().unwrap().push(request);
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        [("content-type", "application/json")],
                        text,
                    )
                        .into_response()
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://127.0.0.1:{}", address.port()), log)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> Value {
        json!({"id":"ses_test","projectID":"project","directory":"/tmp/suplex-opencode","title":"Native session","version":"1.18.29","time":{"created":1,"updated":2},"model":{"id":"gpt-5.6-luna","providerID":"openai","variant":"max"},"agent":"suplex-root"})
    }

    fn messages() -> Value {
        json!([
            {"info":{"id":"msg_user","sessionID":"ses_test","role":"user","time":{"created":3},"agent":"suplex-root","model":{"providerID":"openai","modelID":"gpt-5.6-luna"}},"parts":[{"type":"text","text":"Inspect the task."}]},
            {"info":{"id":"msg_assistant","sessionID":"ses_test","role":"assistant","time":{"created":4,"completed":5},"parentID":"msg_user","modelID":"gpt-5.6-luna","providerID":"openai","mode":"build","agent":"suplex-root","path":{"cwd":"/tmp/suplex-opencode","root":"/tmp/suplex-opencode"},"cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"max","finish":"stop"},"parts":[{"type":"text","text":"done"}]}
        ])
    }

    fn model() -> NativeModel {
        NativeModel {
            provider_id: "openai".into(),
            model_id: "gpt-5.6-luna".into(),
        }
    }

    #[tokio::test]
    async fn provider_observations_strip_credentials_and_configuration_secrets() {
        let (url, log) = fake::serve(|_| (200, json!({"all":[{"id":"openai","name":"OpenAI","key":"secret-key","options":{"apiKey":"secret-option"},"models":{"luna":{"id":"luna","name":"Luna","options":{"apiKey":"model-secret"}}}}],"connected":["openai"],"default":{"openai":"luna"}}).to_string())).await;
        let client = OpenCodeClient::new(&url, "test-password").unwrap();
        let providers = client.providers(Some("/tmp/providers")).await.unwrap();
        assert_eq!(
            serde_json::to_value(providers).unwrap(),
            json!({"all":[{"id":"openai","name":"OpenAI","models":{"luna":{"id":"luna","name":"Luna"}}}],"connected":["openai"],"default":{"openai":"luna"}})
        );
        let request = log.lock().unwrap()[0].clone();
        assert_eq!(
            (
                request.method.as_str(),
                request.path.as_str(),
                request.query.as_str()
            ),
            ("GET", "/provider", "directory=%2Ftmp%2Fproviders")
        );
    }

    #[tokio::test]
    async fn abort_targets_the_native_session_without_deleting_its_history() {
        let (url, log) = fake::serve(|_| (200, "true".into())).await;
        let client = OpenCodeClient::new(&url, "test-password").unwrap();
        assert!(client.abort_session("ses_test", "/tmp/task").await.unwrap());
        let request = log.lock().unwrap()[0].clone();
        assert_eq!(request.method, "POST");
        assert!(request.body.is_empty());
        assert_eq!(request.path, "/session/ses_test/abort");
        assert_eq!(request.query, "directory=%2Ftmp%2Ftask");
    }

    #[tokio::test]
    async fn mcp_discovery_uses_a_bodyless_get_scoped_to_the_session_directory() {
        let (url, log) = fake::serve(|_| {
            (
                200,
                json!({"suplex_root":{"status":"connected"}}).to_string(),
            )
        })
        .await;
        let client = OpenCodeClient::new(&url, "test-password").unwrap();
        let status = client.mcp_status("/tmp/suplex-opencode").await.unwrap();
        assert_eq!(status["suplex_root"].status, "connected");
        let request = log.lock().unwrap()[0].clone();
        assert_eq!(request.method, "GET");
        assert!(request.body.is_empty());
        assert_eq!(request.query, "directory=%2Ftmp%2Fsuplex-opencode");
    }

    #[tokio::test]
    async fn client_uses_the_installed_v1_routes_and_validates_native_envelopes() {
        let (url, log) = fake::serve(|request| {
            let scoped = request.query == "directory=%2Ftmp%2Fsuplex-opencode";
            match (request.path.as_str(), scoped) {
                ("/global/health", _) => {
                    (200, json!({"healthy":true,"version":"1.18.29"}).to_string())
                }
                ("/config", true) => (200, json!({"model":"openai/gpt-5.6-luna"}).to_string()),
                ("/session" | "/session/ses_test", true) => (200, session().to_string()),
                ("/session/ses_test/message", true) => (200, messages().to_string()),
                ("/session/status", true) => (200, json!({"ses_test":{"type":"idle"}}).to_string()),
                ("/session/ses_test/prompt_async", true) => (204, String::new()),
                _ => (500, String::new()),
            }
        })
        .await;
        let client = OpenCodeClient::new(&url, "test-password").unwrap();
        let directory = Some("/tmp/suplex-opencode");
        assert_eq!(
            client.health().await.unwrap(),
            Health {
                healthy: true,
                version: "1.18.29".into()
            }
        );
        assert_eq!(
            Value::Object(client.get_config(directory).await.unwrap()),
            json!({"model":"openai/gpt-5.6-luna"})
        );
        let created = client
            .create_session(CreateSessionInput {
                title: "Native session",
                directory,
                model: SessionCreateModel {
                    id: "gpt-5.6-luna".into(),
                    provider_id: "openai".into(),
                    variant: Some("max".into()),
                },
                agent: "suplex-root",
                metadata: None,
            })
            .await
            .unwrap();
        assert_eq!(created.id, "ses_test");
        assert_eq!(
            client.get_session("ses_test", directory).await.unwrap().id,
            "ses_test"
        );
        assert_eq!(
            client
                .get_messages("ses_test", directory, None)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            client.get_status(directory).await.unwrap()["ses_test"],
            super::super::contracts::SessionStatus::Idle
        );
        client
            .prompt_async(PromptInput {
                session_id: "ses_test",
                message_id: "msg_retry",
                text: "Inspect the task.",
                model: &model(),
                agent: "suplex-root",
                variant: "max",
                directory,
                no_reply: None,
                system: None,
            })
            .await
            .unwrap();
        let calls = log.lock().unwrap().clone();
        assert_eq!(
            calls
                .iter()
                .map(|call| format!("{} {}", call.method, call.path))
                .collect::<Vec<_>>(),
            [
                "GET /global/health",
                "GET /config",
                "POST /session",
                "GET /session/ses_test",
                "GET /session/ses_test/message",
                "GET /session/status",
                "POST /session/ses_test/prompt_async",
            ]
        );
        let body = |index: usize| serde_json::from_slice::<Value>(&calls[index].body).unwrap();
        assert_eq!(
            body(2),
            json!({"title":"Native session","agent":"suplex-root","model":{"id":"gpt-5.6-luna","providerID":"openai","variant":"max"}})
        );
        assert_eq!(
            body(6),
            json!({"messageID":"msg_retry","model":{"providerID":"openai","modelID":"gpt-5.6-luna"},"agent":"suplex-root","variant":"max","parts":[{"type":"text","text":"Inspect the task."}]})
        );
    }

    #[tokio::test]
    async fn client_authenticates_loopback_requests_without_exposing_response_bodies_on_failures() {
        let (url, log) = fake::serve(|_| {
            (
                503,
                json!({"secret":"must-not-become-error-text"}).to_string(),
            )
        })
        .await;
        let client =
            OpenCodeClient::new(&url.replace("127.0.0.1", "localhost"), "test-password").unwrap();
        let error = client.health().await.unwrap_err();
        assert_eq!(
            (error.code, error.retryable, error.status),
            (FailureCode::ServerUnavailable, true, Some(503))
        );
        assert!(!error.message.contains("must-not-become-error-text"));
        let authorization = log.lock().unwrap()[0].authorization.clone();
        let encoded = authorization.strip_prefix("Basic ").unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            b"opencode:test-password"
        );
    }

    #[tokio::test]
    async fn client_fails_closed_for_invalid_addresses_malformed_native_data_and_non_204_async_acknowledgements()
     {
        assert!(
            OpenCodeClient::new("https://example.com", "secret")
                .unwrap_err()
                .message
                .contains("loopback")
        );
        assert!(OpenCodeClient::new("http://user:pw@127.0.0.1:1", "secret").is_err());
        assert!(OpenCodeClient::new("http://127.0.0.1:1", "").is_err());
        let (malformed, _) = fake::serve(|_| {
            (
                200,
                json!({"healthy":false,"version":"1.18.29"}).to_string(),
            )
        })
        .await;
        let error = OpenCodeClient::new(&malformed, "secret")
            .unwrap()
            .health()
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.retryable),
            (FailureCode::InvalidResponse, false)
        );
        let (wrong_status, _) = fake::serve(|_| (200, "{}".into())).await;
        let error = OpenCodeClient::new(&wrong_status, "secret")
            .unwrap()
            .prompt_async(PromptInput {
                session_id: "ses_test",
                message_id: "msg_retry",
                text: "Inspect the task.",
                model: &model(),
                agent: "suplex-root",
                variant: "max",
                directory: None,
                no_reply: None,
                system: None,
            })
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.status),
            (FailureCode::UnexpectedStatus, Some(200))
        );
    }

    #[tokio::test]
    async fn unreachable_servers_are_retryable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = OpenCodeClient::new(&format!("http://127.0.0.1:{port}"), "secret")
            .unwrap()
            .health()
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.retryable),
            (FailureCode::ServerUnavailable, true)
        );
    }
}
