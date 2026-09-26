//! GitHub OAuth App device authorization. Device codes stay in process memory;
//! only the user code and verification URL cross the HTTP boundary.

use crate::shared::time::rfc3339_millis;
use std::{collections::HashMap, error::Error, future::Future, io, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::github::Access;

pub type DeviceResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub const CLIENT_ID: &str = "Ov23liXzUOo24uKB09MA";
const SCOPE: &str = "repo read:user offline_access";

#[derive(Clone)]
pub struct DeviceAuth {
    client: Client,
    oauth_base: Url,
    api_base: String,
    pending: Arc<Mutex<HashMap<Uuid, Arc<Mutex<Pending>>>>>,
}

struct Pending {
    device_code: String,
    expires_at: DateTime<Utc>,
    interval: Duration,
    next_poll_at: DateTime<Utc>,
    state: Progress,
}

enum Progress {
    Awaiting,
    Granted(Granted),
    Saved(String),
    Complete(Poll),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub flow_id: Uuid,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at: String,
    pub interval_seconds: u64,
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Poll {
    Pending {
        #[serde(rename = "nextPollAt")]
        next_poll_at: String,
    },
    Connected {
        login: String,
    },
    Expired,
    Denied,
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: i64,
    interval: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token_expires_in: Option<i64>,
    error: Option<String>,
    interval: Option<u64>,
}

#[derive(Clone)]
pub struct Granted {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub refresh_token_expires_in: Option<i64>,
    pub login: String,
}

impl DeviceAuth {
    pub fn new() -> DeviceResult<Self> {
        Self::for_endpoints("https://github.com/", "https://api.github.com")
    }

    pub fn for_endpoints(oauth_base: &str, api_base: &str) -> DeviceResult<Self> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            client,
            oauth_base: Url::parse(oauth_base)?,
            api_base: api_base.to_owned(),
            pending: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn start(&self) -> DeviceResult<Started> {
        let response = self
            .client
            .post(self.oauth_base.join("login/device/code")?)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
            .send()
            .await?;
        if !response.status().is_success() {
            return Err("GitHub device authorization is unavailable".into());
        }
        let code: DeviceCodeResponse = response.json().await.map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "GitHub device response is invalid",
            )
        })?;
        if code.device_code.is_empty()
            || code.user_code.is_empty()
            || code.expires_in <= 0
            || code.interval == 0
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "GitHub device response is invalid",
            )
            .into());
        }
        let now = Utc::now();
        let flow_id = Uuid::new_v4();
        let expires_at = now + chrono::Duration::seconds(code.expires_in);
        let interval = Duration::from_secs(code.interval);
        let next_poll_at = now + chrono::Duration::seconds(code.interval as i64);
        let mut pending = self.pending.lock().await;
        pending.retain(|_, flow| flow.try_lock().map_or(true, |flow| flow.expires_at > now));
        pending.insert(
            flow_id,
            Arc::new(Mutex::new(Pending {
                device_code: code.device_code,
                expires_at,
                interval,
                next_poll_at,
                state: Progress::Awaiting,
            })),
        );
        Ok(Started {
            flow_id,
            user_code: code.user_code,
            verification_uri: code.verification_uri,
            expires_at: rfc3339_millis(expires_at),
            interval_seconds: code.interval,
        })
    }

    pub async fn poll<F, Fut>(&self, flow_id: Uuid, save: F) -> DeviceResult<Poll>
    where
        F: FnOnce(Granted) -> Fut,
        Fut: Future<Output = Result<(), ()>>,
    {
        let flow = self.pending.lock().await.get(&flow_id).cloned();
        let Some(flow) = flow else {
            return Ok(Poll::Expired);
        };
        // Serialize the exchange and storage for this flow, including retries.
        let mut flow = flow.lock().await;
        if let Progress::Complete(result) = &flow.state {
            return Ok(result.clone());
        }
        let now = Utc::now();
        if matches!(flow.state, Progress::Awaiting) {
            if now >= flow.expires_at {
                flow.state = Progress::Complete(Poll::Expired);
                return Ok(Poll::Expired);
            }
            if now < flow.next_poll_at {
                return Ok(Poll::Pending {
                    next_poll_at: rfc3339_millis(flow.next_poll_at),
                });
            }
            flow.next_poll_at = now + chrono::Duration::from_std(flow.interval)?;
            let device_code = flow.device_code.clone();
            let response = self
                .client
                .post(self.oauth_base.join("login/oauth/access_token")?)
                .header(reqwest::header::ACCEPT, "application/json")
                .form(&[
                    ("client_id", CLIENT_ID),
                    ("device_code", device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await?;
            if !response.status().is_success() {
                return Err("GitHub device token request failed".into());
            }
            let token: TokenResponse = response.json().await.map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "GitHub token response is invalid",
                )
            })?;
            match token.error.as_deref() {
                Some("authorization_pending") => {
                    return Ok(Poll::Pending {
                        next_poll_at: rfc3339_millis(flow.next_poll_at),
                    });
                }
                Some("slow_down") => {
                    flow.interval = Duration::from_secs(
                        token
                            .interval
                            .unwrap_or(0)
                            .max(flow.interval.as_secs().saturating_add(5)),
                    );
                    flow.next_poll_at = Utc::now() + chrono::Duration::from_std(flow.interval)?;
                    return Ok(Poll::Pending {
                        next_poll_at: rfc3339_millis(flow.next_poll_at),
                    });
                }
                Some("expired_token") => {
                    flow.state = Progress::Complete(Poll::Expired);
                    return Ok(Poll::Expired);
                }
                Some("access_denied") => {
                    flow.state = Progress::Complete(Poll::Denied);
                    return Ok(Poll::Denied);
                }
                Some(_) => {
                    return Err("GitHub device authorization failed".into());
                }
                None => {}
            }
            let access_token = token
                .access_token
                .filter(|token| !token.is_empty())
                .ok_or("GitHub token response is invalid")?;
            flow.state = Progress::Granted(Granted {
                access_token: access_token.clone(),
                refresh_token: token.refresh_token,
                expires_in: token.expires_in,
                refresh_token_expires_in: token.refresh_token_expires_in,
                login: String::new(),
            });
        }
        // Keep the grant if storage fails. Never exchange a spent code again.
        if let Progress::Granted(grant) = &flow.state {
            save(grant.clone())
                .await
                .map_err(|_| "GitHub credential store failed")?;
            flow.state = Progress::Saved(grant.access_token.clone());
        }
        let Progress::Saved(access_token) = &flow.state else {
            unreachable!()
        };
        let access = Access::for_api(&self.api_base, Some(access_token.clone()))
            .map_err(|_| "GitHub account validation failed")?;
        let login = access
            .current_user_login()
            .await
            .map_err(|_| "GitHub account validation failed")?;
        let result = Poll::Connected { login };
        flow.state = Progress::Complete(result.clone());
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        body::Bytes,
        http::{HeaderMap, StatusCode, header},
        routing::{get, post},
    };
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn device_code_stays_server_side_and_poll_respects_interval() {
        let polls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/login/device/code",
                post(|body: Bytes| async move {
                    let form = String::from_utf8_lossy(&body);
                    assert!(form.contains("client_id=Ov23liXzUOo24uKB09MA"));
                    assert!(form.contains("offline_access"));
                    Json(json!({
                        "device_code":"private-device-code", "user_code":"ABCD-EFGH",
                        "verification_uri":"https://github.com/login/device",
                        "expires_in":900, "interval":1,
                    }))
                }),
            )
            .route(
                "/login/oauth/access_token",
                post({
                    let polls = polls.clone();
                    move |body: Bytes| {
                        let polls = polls.clone();
                        async move {
                            let form = String::from_utf8_lossy(&body);
                            assert!(form.contains("device_code=private-device-code"));
                            assert!(form.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"));
                            if polls.fetch_add(1, Ordering::SeqCst) == 0 {
                                Json(json!({"error":"authorization_pending"}))
                            } else {
                                Json(json!({
                                    "access_token":"fixture-access", "refresh_token":"fixture-refresh",
                                    "expires_in":28800, "refresh_token_expires_in":15897600,
                                }))
                            }
                        }
                    }
                }),
            )
            .route(
                "/user",
                get(|headers: HeaderMap| async move {
                    assert_eq!(headers.get(header::AUTHORIZATION).unwrap(), "Bearer fixture-access");
                    Json(json!({"login":"fixture-account"}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let device = DeviceAuth::for_endpoints(&base, &base).unwrap();
        let started = device.start().await.unwrap();
        let public = serde_json::to_string(&started).unwrap();
        assert!(public.contains("ABCD-EFGH"));
        assert!(!public.contains("private-device-code"));
        assert!(matches!(
            device
                .poll(started.flow_id, |_| async { Ok(()) })
                .await
                .unwrap(),
            Poll::Pending { .. }
        ));
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(matches!(
            device
                .poll(started.flow_id, |_| async { Ok(()) })
                .await
                .unwrap(),
            Poll::Pending { .. }
        ));
        assert_eq!(polls.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            device
                .poll(started.flow_id, |_| async { Err(()) })
                .await
                .is_err()
        );
        assert_eq!(polls.load(Ordering::SeqCst), 2);
        let saved = Arc::new(std::sync::Mutex::new(None));
        let (public, repeated) = tokio::join!(
            device.poll(started.flow_id, {
                let saved = saved.clone();
                move |grant| async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    *saved.lock().unwrap() = Some(grant);
                    Ok(())
                }
            }),
            device.poll(started.flow_id, |_| async {
                panic!("grant must only be saved once")
            })
        );
        let public = public.unwrap();
        assert!(matches!(repeated.unwrap(), Poll::Connected { .. }));
        assert_eq!(polls.load(Ordering::SeqCst), 2);
        assert!(matches!(&public, Poll::Connected { login } if login == "fixture-account"));
        let grant = saved.lock().unwrap();
        let grant = grant.as_ref().unwrap();
        assert_eq!(grant.refresh_token.as_deref(), Some("fixture-refresh"));
        assert!(
            !serde_json::to_string(&public)
                .unwrap_or_default()
                .contains("fixture-access")
        );
        server.abort();
    }

    #[tokio::test]
    async fn accepted_device_token_is_saved_before_failed_user_read() {
        let reads = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/login/device/code",
                post(|| async {
                    Json(json!({
                        "device_code":"private-device-code", "user_code":"ABCD-EFGH",
                        "verification_uri":"https://github.com/login/device",
                        "expires_in":900, "interval":1,
                    }))
                }),
            )
            .route(
                "/login/oauth/access_token",
                post(|| async {
                    Json(json!({
                        "access_token":"fixture-access", "refresh_token":"fixture-refresh",
                        "expires_in":28800, "refresh_token_expires_in":15897600,
                    }))
                }),
            )
            .route(
                "/user",
                axum::routing::get({
                    let reads = reads.clone();
                    move || {
                        let reads = reads.clone();
                        async move {
                            if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                                (StatusCode::BAD_GATEWAY, Json(json!({})))
                            } else {
                                (StatusCode::OK, Json(json!({"login":"fixture"})))
                            }
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let device = DeviceAuth::for_endpoints(&endpoint, &endpoint).unwrap();
        let flow = device.start().await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        let saved = Arc::new(std::sync::Mutex::new(None::<Granted>));
        let result = device
            .poll(flow.flow_id, {
                let saved = saved.clone();
                move |grant| async move {
                    *saved.lock().unwrap() = Some(grant);
                    Ok(())
                }
            })
            .await;
        assert!(result.is_err());
        let retried = device
            .poll(flow.flow_id, |_| async {
                panic!("saved grant must not be written again")
            })
            .await
            .unwrap();
        assert!(matches!(retried, Poll::Connected { login } if login == "fixture"));
        let saved = saved.lock().unwrap();
        let saved = saved.as_ref().unwrap();
        assert_eq!(saved.access_token, "fixture-access");
        assert_eq!(saved.refresh_token.as_deref(), Some("fixture-refresh"));
        server.abort();
    }

    #[tokio::test]
    async fn oauth_form_body_is_not_forwarded_on_redirect() {
        let app = Router::new().route(
            "/login/device/code",
            post(|| async {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [(header::LOCATION, "https://example.invalid/steal")],
                    Json(Value::Null),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let device = DeviceAuth::for_endpoints(&base, &base).unwrap();
        assert!(device.start().await.is_err());
        server.abort();
    }
}
