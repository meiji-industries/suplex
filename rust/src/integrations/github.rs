//! Read-only GitHub access using Suplex or the active gh keychain account.

#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
};

use chrono::Utc;
use octocrab::Octocrab;
use serde::{Deserialize, Serialize};

pub type AccessResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

const HOST: &str = "github.com";
const SUPLEX_SERVICE: &str = "suplex:github.com";
const SUPLEX_ACCOUNT: &str = "default";

/// Only this Suplex-owned Keychain value is written by device authorization.
/// The gh account entry remains read-only.
#[derive(Clone, Deserialize, Serialize)]
struct StoredCredential {
    access_token: String,
    refresh_token: Option<String>,
    access_expires_at: Option<i64>,
    refresh_expires_at: Option<i64>,
    login: String,
}

fn credential_lock_path() -> AccessResult<PathBuf> {
    // The lock must be shared by the HTTP server and detached Root MCP even
    // when task environment overrides HOME. The OS account owns the Keychain
    // item, so use that account's home for the lock as well.
    #[cfg(unix)]
    let home = {
        use std::{ffi::CStr, mem::MaybeUninit, os::unix::ffi::OsStrExt};
        let mut entry = MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0_i8; 16_384];
        let status = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut result,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status).into());
        }
        if result.is_null() {
            return Err(io::Error::other("OS account home is unavailable").into());
        }
        let bytes = unsafe { CStr::from_ptr((*result).pw_dir) }.to_bytes();
        PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
    };
    #[cfg(not(unix))]
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("Home directory is unavailable")?);
    Ok(home.join("Library/Caches/Suplex/github-credential.lock"))
}

async fn credential_lock(path: &Path) -> AccessResult<std::fs::File> {
    let path = path.to_owned();
    let file = tokio::task::spawn_blocking(move || -> io::Result<std::fs::File> {
        if let Some(directory) = path.parent() {
            fs::create_dir_all(directory)?;
        }
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)?;
        file.lock()?;
        Ok(file)
    })
    .await??;
    Ok(file)
}

pub async fn save_device_grant(grant: &super::github_device::Granted) -> AccessResult<()> {
    let _lock = credential_lock(&credential_lock_path()?).await?;
    disable_keychain_interaction()?;
    valid_expiry_pair(
        grant.expires_in,
        grant.refresh_token.as_deref(),
        grant.refresh_token_expires_in,
    )?;
    let now = Utc::now().timestamp();
    let stored = StoredCredential {
        access_token: grant.access_token.clone(),
        refresh_token: grant.refresh_token.clone(),
        access_expires_at: grant.expires_in.map(|seconds| now.saturating_add(seconds)),
        refresh_expires_at: grant
            .refresh_token_expires_in
            .map(|seconds| now.saturating_add(seconds)),
        login: grant.login.clone(),
    };
    // Keychain interaction policy is process-wide. Explicit sign-in may prompt,
    // while automatic reads and refreshes in the server must remain noninteractive.
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .arg("github-store-credential")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child
        .stdin
        .take()
        .ok_or("Credential input is unavailable")?;
    input.write_all(&serde_json::to_vec(&stored)?).await?;
    drop(input);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await??;
    if !output.status.success() {
        return Err(
            io::Error::other(String::from_utf8_lossy(&output.stderr).trim().to_owned()).into(),
        );
    }
    Ok(())
}

/// Internal stdin-only helper: never put credentials in arguments or output.
pub fn store_device_credential_from_stdin() -> AccessResult<()> {
    use std::io::Read;
    let stored: StoredCredential = serde_json::from_reader(std::io::stdin().take(65_536))
        .map_err(|_| io::Error::other("Invalid credential input"))?;
    write_own_credential(&stored)
}

fn valid_expiry_pair(
    access_seconds: Option<i64>,
    refresh_token: Option<&str>,
    refresh_seconds: Option<i64>,
) -> AccessResult<()> {
    match (access_seconds, refresh_token, refresh_seconds) {
        (None, None, None) => Ok(()),
        (Some(access), Some(token), Some(refresh))
            if access > 0 && refresh > 0 && !token.is_empty() =>
        {
            Ok(())
        }
        _ => {
            Err(io::Error::new(io::ErrorKind::InvalidData, "GitHub token expiry is invalid").into())
        }
    }
}

fn read_own_credential() -> AccessResult<Option<StoredCredential>> {
    let raw = keychain_password(SUPLEX_SERVICE, SUPLEX_ACCOUNT)?;
    let Some(raw) = raw else { return Ok(None) };
    if raw.starts_with('{') {
        return serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| io::Error::other("Stored GitHub credential is invalid").into());
    }
    Ok(Some(StoredCredential {
        access_token: raw,
        refresh_token: None,
        access_expires_at: None,
        refresh_expires_at: None,
        login: String::new(),
    }))
}

fn write_own_credential(stored: &StoredCredential) -> AccessResult<()> {
    let entry = keyring::Entry::new(SUPLEX_SERVICE, SUPLEX_ACCOUNT)?;
    entry.set_password(&serde_json::to_string(stored)?)?;
    Ok(())
}

fn usable(stored: &StoredCredential, now: i64) -> bool {
    stored
        .access_expires_at
        .is_none_or(|expiry| expiry > now.saturating_add(60))
}

#[derive(Deserialize)]
struct RefreshedToken {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token_expires_in: Option<i64>,
    error: Option<String>,
}

async fn refresh_credential<R, W>(
    lock_path: &Path,
    oauth_base: &str,
    api_base: &str,
    read: R,
    write: W,
) -> AccessResult<Option<StoredCredential>>
where
    R: Fn() -> AccessResult<Option<StoredCredential>>,
    W: Fn(&StoredCredential) -> AccessResult<()>,
{
    // Re-read after the cross-process lock: a Root MCP and HTTP handler can
    // reach the same expired token at once, but only one may rotate it.
    let _lock = credential_lock(lock_path).await?;
    let Some(mut stored) = read()? else {
        return Ok(None);
    };
    let now = Utc::now().timestamp();
    if usable(&stored, now) {
        return Ok(Some(stored));
    }
    let Some(refresh_token) = stored.refresh_token.as_deref() else {
        return Ok(None);
    };
    if stored
        .refresh_expires_at
        .is_some_and(|expiry| expiry <= now)
    {
        return Ok(None);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let endpoint = url::Url::parse(oauth_base)?.join("login/oauth/access_token")?;
    let response = client
        .post(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("client_id", super::github_device::CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(io::Error::other("GitHub credential refresh failed").into());
    }
    let refreshed: RefreshedToken = response.json().await.map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "GitHub refresh response is invalid",
        )
    })?;
    if refreshed.error.as_deref() == Some("bad_refresh_token") {
        stored.refresh_token = None;
        stored.refresh_expires_at = None;
        write(&stored)?;
        return Ok(None);
    }
    if refreshed.error.is_some() {
        return Err(io::Error::other("GitHub credential refresh failed").into());
    }
    valid_expiry_pair(
        refreshed.expires_in,
        refreshed.refresh_token.as_deref(),
        refreshed.refresh_token_expires_in,
    )?;
    stored.access_token = refreshed
        .access_token
        .filter(|token| !token.is_empty())
        .ok_or("GitHub refresh response is invalid")?;
    stored.refresh_token = refreshed.refresh_token;
    stored.access_expires_at = refreshed
        .expires_in
        .map(|seconds| now.saturating_add(seconds));
    stored.refresh_expires_at = refreshed
        .refresh_token_expires_in
        .map(|seconds| now.saturating_add(seconds));
    // GitHub may have spent the old refresh token. Commit the complete new
    // pair before another network request so a failed /user read cannot lose it.
    write(&stored)?;
    let access = Access::for_api(api_base, Some(stored.access_token.clone()))?;
    let login = access.current_user_login().await?;
    if stored.login != login {
        stored.login = login;
        write(&stored)?;
    }
    Ok(Some(stored))
}

pub struct Access {
    client: Octocrab,
    token: Option<String>,
    source: CredentialSource,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CredentialSource {
    Suplex,
    Gh,
    None,
}

impl CredentialSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Suplex => "suplex",
            Self::Gh => "gh",
            Self::None => "none",
        }
    }
}

#[derive(Deserialize)]
struct Branch {
    commit: BranchCommit,
}

#[derive(Deserialize)]
struct BranchCommit {
    sha: String,
}

#[derive(Deserialize)]
struct CurrentUser {
    login: String,
}

#[cfg(target_os = "macos")]
pub fn disable_keychain_interaction() -> AccessResult<()> {
    static STATUS: OnceLock<i32> = OnceLock::new();
    let status = *STATUS.get_or_init(|| unsafe {
        security_framework_sys::keychain::SecKeychainSetUserInteractionAllowed(0)
    });
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!("Keychain interaction policy failed: {status}")).into())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn disable_keychain_interaction() -> AccessResult<()> {
    Ok(())
}

fn keychain_password(service: &str, account: &str) -> AccessResult<Option<String>> {
    let entry = keyring::Entry::new(service, account)?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn installed_gh_token() -> AccessResult<Option<String>> {
    read_gh_token(tokio::process::Command::new("gh")).await
}

async fn read_gh_token(mut command: tokio::process::Command) -> AccessResult<Option<String>> {
    command
        .args(["auth", "token", "--hostname", HOST])
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output()).await?;
    let output = match output {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !output.status.success() {
        return Ok(None);
    }
    let token = String::from_utf8(output.stdout)
        .map_err(|_| io::Error::other("GitHub CLI returned an invalid credential"))?;
    Ok((!token.trim().is_empty()).then(|| token.trim().to_owned()))
}

impl Access {
    pub async fn load() -> AccessResult<Self> {
        // The explicit interop build can use an isolated loopback API without
        // consulting a user's keychain.
        #[cfg(feature = "github-test-endpoint")]
        if let Ok(base_uri) = std::env::var("SUPLEX_RUST_TEST_GITHUB_API") {
            let parsed = url::Url::parse(&base_uri)?;
            if parsed.scheme() != "http"
                || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Test GitHub API must be loopback HTTP",
                )
                .into());
            }
            return Self::for_api(&base_uri, None);
        }
        disable_keychain_interaction()?;
        let (stored, read_error) = match read_own_credential() {
            Ok(stored) => (stored, None),
            Err(error) => (None, Some(error)),
        };
        let (own, refresh_failed) = if let Some(stored) = stored {
            if usable(&stored, Utc::now().timestamp()) {
                (Some(stored), false)
            } else {
                // This task owns the complete refresh and Keychain write even
                // if the HTTP request waiting for Access is disconnected.
                let refreshed = tokio::spawn(async move {
                    refresh_credential(
                        &credential_lock_path().map_err(|_| ())?,
                        "https://github.com/",
                        "https://api.github.com",
                        read_own_credential,
                        write_own_credential,
                    )
                    .await
                    .map_err(|_| ())
                })
                .await;
                match refreshed {
                    Ok(Ok(credential)) => (credential, false),
                    _ => (None, true),
                }
            }
        } else {
            (None, false)
        };
        let (token, source) = if let Some(stored) = own {
            (Some(stored.access_token), CredentialSource::Suplex)
        } else {
            let token = installed_gh_token().await?;
            if token.is_none()
                && let Some(error) = read_error
            {
                return Err(error);
            }
            if refresh_failed && token.is_none() {
                return Err(io::Error::other("GitHub credential refresh failed").into());
            }
            let source = if token.is_some() {
                CredentialSource::Gh
            } else {
                CredentialSource::None
            };
            (token, source)
        };
        let mut access = Self::for_api("https://api.github.com", token)?;
        access.source = source;
        Ok(access)
    }

    pub fn for_api(base_uri: &str, token: Option<String>) -> AccessResult<Self> {
        let mut builder = Octocrab::builder().base_uri(base_uri)?;
        if let Some(value) = &token {
            builder = builder.personal_token(value.clone());
        }
        Ok(Self {
            client: builder.build()?,
            token,
            source: CredentialSource::None,
        })
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub(crate) fn client(&self) -> &Octocrab {
        &self.client
    }

    pub fn source(&self) -> CredentialSource {
        self.source
    }

    pub async fn current_user_login(&self) -> AccessResult<String> {
        let user: CurrentUser = self.client.get("/user", None::<&()>).await?;
        Ok(user.login)
    }

    pub async fn published_branch_sha(
        &self,
        configured_repository: &str,
        base_branch: &str,
    ) -> AccessResult<git2::Oid> {
        let canonical = format!("https://{HOST}/{configured_repository}.git");
        let coordinate = crate::projects::repository::repository_coordinate(&canonical)
            .filter(|coordinate| coordinate.host == "github")
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Configured GitHub repository is invalid",
                )
            })?;
        let mut route = url::Url::parse("https://api.github.com")?;
        {
            let mut segments = route
                .path_segments_mut()
                .map_err(|()| "Invalid GitHub API route")?;
            let (owner, _) = coordinate
                .repository
                .split_once('/')
                .ok_or("Invalid repository")?;
            segments.extend(["repos", owner, &coordinate.name, "branches", base_branch]);
        }
        let branch: Branch = self.client.get(route.path(), None::<&()>).await?;
        Ok(git2::Oid::from_str(&branch.commit.sha)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::post};
    use serde_json::json;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn simultaneous_process_style_refresh_rotates_once() {
        let requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/login/oauth/access_token",
                post({
                    let requests = requests.clone();
                    move |body: axum::body::Bytes| {
                        let requests = requests.clone();
                        async move {
                            let form = String::from_utf8_lossy(&body);
                            assert!(form.contains("refresh_token=old-refresh"));
                            assert!(form.contains("grant_type=refresh_token"));
                            requests.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "access_token":"new-access", "refresh_token":"new-refresh",
                                "expires_in":28800, "refresh_token_expires_in":15897600,
                            }))
                        }
                    }
                }),
            )
            .route(
                "/user",
                axum::routing::get(|headers: axum::http::HeaderMap| async move {
                    assert_eq!(
                        headers.get(axum::http::header::AUTHORIZATION).unwrap(),
                        "Bearer new-access"
                    );
                    Json(json!({"login":"fixture"}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let stored = Arc::new(Mutex::new(Some(StoredCredential {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            access_expires_at: Some(Utc::now().timestamp() - 1),
            refresh_expires_at: Some(Utc::now().timestamp() + 3600),
            login: "fixture".into(),
        })));
        let lock_path =
            std::env::temp_dir().join(format!("suplex-refresh-{}.lock", uuid::Uuid::new_v4()));
        let run = || {
            let read_state = stored.clone();
            let write_state = stored.clone();
            refresh_credential(
                &lock_path,
                &endpoint,
                &endpoint,
                move || Ok(read_state.lock().unwrap().clone()),
                move |new| {
                    *write_state.lock().unwrap() = Some(new.clone());
                    Ok(())
                },
            )
        };
        let (first, second) = tokio::join!(run(), run());
        assert_eq!(first.unwrap().unwrap().access_token, "new-access");
        assert_eq!(second.unwrap().unwrap().access_token, "new-access");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(
            stored
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .refresh_token
                .as_deref(),
            Some("new-refresh")
        );
        std::fs::remove_file(lock_path).unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn rotated_credential_survives_failed_user_read() {
        let requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/login/oauth/access_token",
                post({
                    let requests = requests.clone();
                    move || {
                        let requests = requests.clone();
                        async move {
                            requests.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "access_token":"new-access", "refresh_token":"new-refresh",
                                "expires_in":28800, "refresh_token_expires_in":15897600,
                            }))
                        }
                    }
                }),
            )
            .route(
                "/user",
                axum::routing::get(|| async { axum::http::StatusCode::BAD_GATEWAY }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let stored = Arc::new(Mutex::new(Some(StoredCredential {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            access_expires_at: Some(Utc::now().timestamp() - 1),
            refresh_expires_at: Some(Utc::now().timestamp() + 3600),
            login: "previous".into(),
        })));
        let lock_path =
            std::env::temp_dir().join(format!("suplex-refresh-{}.lock", uuid::Uuid::new_v4()));
        let run = || {
            let read_state = stored.clone();
            let write_state = stored.clone();
            refresh_credential(
                &lock_path,
                &endpoint,
                &endpoint,
                move || Ok(read_state.lock().unwrap().clone()),
                move |new| {
                    *write_state.lock().unwrap() = Some(new.clone());
                    Ok(())
                },
            )
        };
        assert!(run().await.is_err());
        let saved = stored.lock().unwrap().clone().unwrap();
        assert_eq!(saved.access_token, "new-access");
        assert_eq!(saved.refresh_token.as_deref(), Some("new-refresh"));
        assert_eq!(saved.login, "previous");
        assert_eq!(run().await.unwrap().unwrap().access_token, "new-access");
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        fs::remove_file(lock_path).unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn refresh_form_is_not_forwarded_on_redirect() {
        let app = Router::new().route(
            "/login/oauth/access_token",
            post(|| async {
                (
                    axum::http::StatusCode::TEMPORARY_REDIRECT,
                    [(
                        axum::http::header::LOCATION,
                        "https://example.invalid/steal",
                    )],
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let old = StoredCredential {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            access_expires_at: Some(Utc::now().timestamp() - 1),
            refresh_expires_at: Some(Utc::now().timestamp() + 3600),
            login: "fixture".into(),
        };
        let lock_path =
            std::env::temp_dir().join(format!("suplex-refresh-{}.lock", uuid::Uuid::new_v4()));
        let result = refresh_credential(
            &lock_path,
            &endpoint,
            &endpoint,
            || Ok(Some(old.clone())),
            |_| panic!("redirect response must not write a credential"),
        )
        .await;
        assert!(result.is_err());
        fs::remove_file(lock_path).unwrap();
        server.abort();
    }

    #[tokio::test]
    #[ignore = "invoked only by the separate-process refresh regression"]
    async fn refresh_child() {
        let Ok(directory) = std::env::var("SUPLEX_REFRESH_TEST_DIR") else {
            return;
        };
        let endpoint = std::env::var("SUPLEX_REFRESH_TEST_ENDPOINT").unwrap();
        let directory = PathBuf::from(directory);
        let store = directory.join("credential.json");
        let read = || -> AccessResult<Option<StoredCredential>> {
            Ok(Some(serde_json::from_slice(&fs::read(&store)?)?))
        };
        let write = |value: &StoredCredential| -> AccessResult<()> {
            fs::write(&store, serde_json::to_vec(value)?)?;
            Ok(())
        };
        let refreshed = refresh_credential(
            &directory.join("credential.lock"),
            &endpoint,
            &endpoint,
            read,
            write,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(refreshed.access_token, "new-access");
    }

    #[tokio::test]
    async fn separate_processes_share_the_rotation_lock() {
        let requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/login/oauth/access_token",
                post({
                    let requests = requests.clone();
                    move || {
                        let requests = requests.clone();
                        async move {
                            requests.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "access_token":"new-access", "refresh_token":"new-refresh",
                                "expires_in":28800, "refresh_token_expires_in":15897600,
                            }))
                        }
                    }
                }),
            )
            .route(
                "/user",
                axum::routing::get(|| async { Json(json!({"login":"fixture"})) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory =
            std::env::temp_dir().join(format!("suplex-refresh-process-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let expired = StoredCredential {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            access_expires_at: Some(Utc::now().timestamp() - 1),
            refresh_expires_at: Some(Utc::now().timestamp() + 3600),
            login: "fixture".into(),
        };
        fs::write(
            directory.join("credential.json"),
            serde_json::to_vec(&expired).unwrap(),
        )
        .unwrap();
        let binary = std::env::current_exe().unwrap();
        let child = || {
            tokio::process::Command::new(&binary)
                .args([
                    "integrations::github::tests::refresh_child",
                    "--ignored",
                    "--exact",
                ])
                .env("SUPLEX_REFRESH_TEST_DIR", &directory)
                .env("SUPLEX_REFRESH_TEST_ENDPOINT", &endpoint)
                .output()
        };
        let (first, second) = tokio::join!(child(), child());
        assert!(first.unwrap().status.success());
        assert!(second.unwrap().status.success());
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let saved: StoredCredential =
            serde_json::from_slice(&fs::read(directory.join("credential.json")).unwrap()).unwrap();
        assert_eq!(saved.refresh_token.as_deref(), Some("new-refresh"));
        fs::remove_dir_all(directory).unwrap();
        server.abort();
    }

    async fn serve_once(listener: tokio::net::TcpListener, response: String) -> bool {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0_u8; 8192];
        let bytes = socket.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..bytes]);
        let had_token = request.contains("Bearer fixture-only-token");
        socket.write_all(response.as_bytes()).await.unwrap();
        had_token
    }

    #[tokio::test]
    async fn branch_read_keeps_token_on_same_origin_and_strips_it_on_cross_origin() {
        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first_url = format!("http://{}", first.local_addr().unwrap());
        let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second_url = format!("http://{}", second.local_addr().unwrap());
        let sha = "a".repeat(40);
        let body = format!("{{\"commit\":{{\"sha\":\"{sha}\"}}}}");
        let second_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let first_response = format!(
            "HTTP/1.1 302 Found\r\nLocation: {second_url}/branch\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let first_task = tokio::spawn(serve_once(first, first_response));
        let second_task = tokio::spawn(serve_once(second, second_response));
        let access = Access::for_api(&first_url, Some("fixture-only-token".into())).unwrap();
        assert_eq!(
            access
                .published_branch_sha("example/project", "main")
                .await
                .unwrap()
                .to_string(),
            sha
        );
        assert!(first_task.await.unwrap());
        assert!(!second_task.await.unwrap());
    }

    #[tokio::test]
    async fn branch_read_preserves_token_on_same_origin_redirect() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_uri = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 8192];
            let bytes = first.read(&mut request).await.unwrap();
            let first_has_token =
                String::from_utf8_lossy(&request[..bytes]).contains("Bearer fixture-only-token");
            first.write_all(b"HTTP/1.1 302 Found\r\nLocation: /renamed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            let (mut second, _) = listener.accept().await.unwrap();
            let bytes = second.read(&mut request).await.unwrap();
            let second_has_token =
                String::from_utf8_lossy(&request[..bytes]).contains("Bearer fixture-only-token");
            let body = format!("{{\"commit\":{{\"sha\":\"{}\"}}}}", "b".repeat(40));
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            second.write_all(response.as_bytes()).await.unwrap();
            (first_has_token, second_has_token)
        });
        let access = Access::for_api(&base_uri, Some("fixture-only-token".into())).unwrap();
        access
            .published_branch_sha("example/project", "main")
            .await
            .unwrap();
        assert_eq!(task.await.unwrap(), (true, true));
    }

    #[tokio::test]
    async fn current_user_and_encoded_branch_use_token_backed_api() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_uri = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut paths = Vec::new();
            for body in [
                "{\"login\":\"fixture\"}".to_owned(),
                format!("{{\"commit\":{{\"sha\":\"{}\"}}}}", "c".repeat(40)),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 8192];
                let bytes = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..bytes]);
                assert!(request.contains("Bearer fixture-only-token"));
                paths.push(request.lines().next().unwrap().to_owned());
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            paths
        });
        let access = Access::for_api(&base_uri, Some("fixture-only-token".into())).unwrap();
        assert_eq!(access.current_user_login().await.unwrap(), "fixture");
        assert_eq!(
            access
                .published_branch_sha("example/project", "release/2026")
                .await
                .unwrap()
                .to_string(),
            "c".repeat(40)
        );
        assert_eq!(
            server.await.unwrap(),
            [
                "GET /user HTTP/1.1",
                "GET /repos/example/project/branches/release%2F2026 HTTP/1.1",
            ]
        );
    }

    #[tokio::test]
    async fn server_failure_does_not_retry_the_branch_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_uri = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 8192];
            let _ = socket.read(&mut request).await.unwrap();
            socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            tokio::time::timeout(std::time::Duration::from_millis(750), listener.accept())
                .await
                .is_ok()
        });
        let access = Access::for_api(&base_uri, Some("fixture-only-token".into())).unwrap();
        assert!(
            access
                .published_branch_sha("example/project", "main")
                .await
                .is_err()
        );
        assert!(!server.await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cli_credential_uses_saved_account_and_ignores_failed_output() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "test -z \"$GH_TOKEN$GITHUB_TOKEN\" && test \"$GH_PROMPT_DISABLED\" = 1 && printf 'fixture-token\\n'"])
            .env("GH_TOKEN", "wrong-account").env("GITHUB_TOKEN", "wrong-account");
        assert_eq!(
            read_gh_token(command).await.unwrap().as_deref(),
            Some("fixture-token")
        );
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "printf 'do-not-use'; exit 1"]);
        assert!(read_gh_token(command).await.unwrap().is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn automatic_keychain_access_disables_process_interaction() {
        disable_keychain_interaction().unwrap();
        let mut allowed = 1;
        let status = unsafe {
            security_framework_sys::keychain::SecKeychainGetUserInteractionAllowed(&mut allowed)
        };
        assert_eq!(status, 0);
        assert_eq!(allowed, 0);
    }

    #[tokio::test]
    #[ignore = "read-only live GitHub credential probe"]
    async fn installed_account_reads_current_user_and_configured_branch() {
        let access = Access::load().await.unwrap();
        assert!(!access.current_user_login().await.unwrap().is_empty());
        assert_ne!(
            access
                .published_branch_sha("meiji-industries/suplex", "main")
                .await
                .unwrap(),
            git2::Oid::ZERO_SHA1
        );
    }
}
