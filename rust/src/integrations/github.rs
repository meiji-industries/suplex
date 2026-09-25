//! Read-only GitHub access using Suplex or the active gh keychain account.

#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use std::{env, error::Error, fs, io, path::PathBuf};

use octocrab::Octocrab;
use serde::Deserialize;

pub type AccessResult<T> = Result<T, Box<dyn Error>>;

const HOST: &str = "github.com";
const SUPLEX_SERVICE: &str = "suplex:github.com";
const SUPLEX_ACCOUNT: &str = "default";

pub struct Access {
    client: Octocrab,
    token: Option<String>,
}

#[derive(Deserialize)]
struct GhHosts {
    #[serde(rename = "github.com")]
    github: Option<GhHost>,
}

#[derive(Deserialize)]
struct GhHost {
    user: Option<String>,
    oauth_token: Option<String>,
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

fn gh_config_path() -> Option<PathBuf> {
    if let Some(directory) = env::var_os("GH_CONFIG_DIR") {
        return Some(PathBuf::from(directory).join("hosts.yml"));
    }
    if let Some(directory) = env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(directory).join("gh/hosts.yml"));
    }
    env::var_os("HOME").map(|home| PathBuf::from(home).join(".config/gh/hosts.yml"))
}

fn gh_host() -> AccessResult<Option<GhHost>> {
    let Some(path) = gh_config_path() else {
        return Ok(None);
    };
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let hosts: GhHosts = serde_saphyr::from_str(&content).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "GitHub account config is invalid",
        )
    })?;
    Ok(hosts.github)
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

pub fn installed_token() -> AccessResult<Option<String>> {
    if let Ok(Some(token)) = keychain_password(SUPLEX_SERVICE, SUPLEX_ACCOUNT) {
        return Ok(Some(token));
    }
    let host = gh_host()?;
    if let Some(token) = host.as_ref().and_then(|host| host.oauth_token.as_ref()) {
        return Ok(Some(token.clone()));
    }
    if let Some(user) = host.as_ref().and_then(|host| host.user.as_deref())
        && let Ok(Some(token)) = keychain_password("gh:github.com", user)
    {
        return Ok(Some(token));
    }
    Ok(keychain_password("gh:github.com", "").ok().flatten())
}

impl Access {
    pub fn load() -> AccessResult<Self> {
        // The explicit interop build can use an isolated loopback API without
        // consulting a user's keychain.
        #[cfg(feature = "github-test-endpoint")]
        if let Ok(base_uri) = env::var("SUPLEX_RUST_TEST_GITHUB_API") {
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
        Self::for_api("https://api.github.com", installed_token()?)
    }

    pub fn for_api(base_uri: &str, token: Option<String>) -> AccessResult<Self> {
        let mut builder = Octocrab::builder().base_uri(base_uri)?;
        if let Some(value) = &token {
            builder = builder.personal_token(value.clone());
        }
        Ok(Self {
            client: builder.build()?,
            token,
        })
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

    #[test]
    fn gh_hosts_reads_only_active_user() {
        let hosts: GhHosts = serde_saphyr::from_str(
            "github.com:\n  user: active-name\n  users:\n    other-name: {}\n",
        )
        .unwrap();
        assert_eq!(hosts.github.unwrap().user.as_deref(), Some("active-name"));
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
        let access = Access::load().unwrap();
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
