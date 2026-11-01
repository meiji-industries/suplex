use serde::{Deserialize, Serialize};

use super::git::{Github, github_status, repository_coordinate, valid_repository};
use crate::integrations::github::Access;

crate::shared::wire_enum! {
    pub enum CheckoutStatus {
        Missing = "missing",
        NotARepository = "not_a_repository",
        Ready = "ready",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub status: &'static str,
    pub message: &'static str,
    pub method: &'static str,
    pub checkout: CheckoutStatus,
    pub origin_repository: Option<String>,
    pub login: Option<String>,
}

#[derive(Deserialize)]
struct RemoteRepository {
    id: u64,
}

pub async fn same_repository(
    access: &Access,
    left: &str,
    right: &str,
) -> Result<bool, octocrab::Error> {
    let left: RemoteRepository = access
        .client()
        .get(format!("/repos/{left}"), None::<&()>)
        .await?;
    let right: RemoteRepository = access
        .client()
        .get(format!("/repos/{right}"), None::<&()>)
        .await?;
    Ok(left.id == right.id)
}

pub async fn check(
    github: &Github,
    path: &str,
    identity: Option<&str>,
    branch: &str,
) -> ConnectionStatus {
    let mut result = ConnectionStatus {
        status: "needs_repair",
        message: "Set a GitHub repository in owner/name format.",
        method: "device",
        checkout: CheckoutStatus::Ready,
        origin_repository: None,
        login: None,
    };
    // Observe the checkout before the identity check so the field stays truthful.
    let path = path.to_owned();
    let (checkout, origin) = tokio::task::spawn_blocking(move || {
        if !std::path::Path::new(&path).is_dir() {
            return (CheckoutStatus::Missing, None);
        }
        let Ok(repo) = git2::Repository::open(&path) else {
            return (CheckoutStatus::NotARepository, None);
        };
        let origin = repo
            .config()
            .ok()
            .and_then(|config| config.get_string("remote.origin.url").ok())
            .and_then(|url| repository_coordinate(&url))
            .filter(|value| value.host == "github")
            .map(|value| value.repository);
        (CheckoutStatus::Ready, origin)
    })
    .await
    .unwrap_or((CheckoutStatus::Ready, None));
    result.checkout = checkout;
    let Some(identity) = identity.filter(|value| valid_repository(value)) else {
        return result;
    };
    match checkout {
        CheckoutStatus::Missing => {
            result.message =
                "No checkout at this path. Clone the repository to this path, then check again.";
            return result;
        }
        CheckoutStatus::NotARepository => {
            result.message = "This path is not a Git repository. Clone the repository to this path or correct the path.";
            return result;
        }
        CheckoutStatus::Ready => {}
    }
    result.origin_repository.clone_from(&origin);
    let Some(origin) = origin else {
        result.message =
            "Open a local checkout with a GitHub origin. Correct the repository path below.";
        return result;
    };
    let access = match github.access().await {
        Ok(access) if access.token().is_some() => access,
        _ => {
            result.status = "sign_in_required";
            result.message = "Sign in to GitHub to restore repository access.";
            return result;
        }
    };
    match same_repository(&access, identity, &origin).await {
        Ok(false) => {
            result.message = "The local origin points to a different repository. Correct the repository or checkout path below.";
            return result;
        }
        Err(error) => {
            (result.status, result.message) = match github_status(&error) {
                Some(401) => ("sign_in_required", "GitHub sign-in expired. Sign in again."),
                Some(404) => (
                    "needs_repair",
                    "GitHub cannot find or access this repository. Review the repository name and your GitHub access.",
                ),
                _ => (
                    "unavailable",
                    "GitHub could not check repository access. Try again.",
                ),
            };
            return result;
        }
        Ok(true) => {}
    }
    let branch = crate::shared::encode_uri_component(branch);
    let response: Result<serde_json::Value, _> = access
        .client()
        .get(format!("/repos/{identity}/branches/{branch}"), None::<&()>)
        .await;
    (result.status, result.message) = match response {
        Ok(_) => (
            "connected",
            "GitHub access, local origin, and base branch are valid.",
        ),
        Err(error) if github_status(&error) == Some(404) => (
            "needs_repair",
            "The base branch does not exist on GitHub. Correct the base branch below.",
        ),
        Err(error) if github_status(&error) == Some(401) => {
            ("sign_in_required", "GitHub sign-in expired. Sign in again.")
        }
        Err(_) => (
            "unavailable",
            "GitHub could not check the base branch. Try again.",
        ),
    };
    if result.status == "connected" {
        match access.current_user_login().await {
            Ok(login) => result.login = Some(login),
            Err(_) => {
                result.status = "unavailable";
                result.message = "GitHub could not check the account. Try again.";
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::git::fixtures::{github_api, init, temporary};
    use axum::{Json, Router, extract::Path, http::StatusCode, routing::get};
    use serde_json::json;

    #[tokio::test]
    async fn connection_observes_origin_and_github_identity_without_mutation() {
        let root = temporary("connection");
        let repo = init(&root, false);
        repo.remote("origin", "git@github.com:acme/old.git")
            .unwrap();
        let base = github_api(
            Router::new()
                .route(
                    "/user",
                    get(|| async { Json(json!({"login": "fixture-account"})) }),
                )
                .route(
                    "/repos/acme/{name}",
                    get(|Path(name): Path<String>| async move {
                        match name.as_str() {
                            "old" | "renamed" => (StatusCode::OK, Json(json!({"id": 1}))),
                            "different" => (StatusCode::OK, Json(json!({"id": 2}))),
                            "revoked" => (
                                StatusCode::UNAUTHORIZED,
                                Json(json!({"message":"Bad credentials"})),
                            ),
                            _ => (StatusCode::NOT_FOUND, Json(json!({"message":"Not Found"}))),
                        }
                    }),
                )
                .route(
                    "/repos/acme/{name}/branches/{branch}",
                    get(|Path((_, branch)): Path<(String, String)>| async move {
                        if branch == "main" {
                            (StatusCode::OK, Json(json!({"name":"main"})))
                        } else {
                            (StatusCode::NOT_FOUND, Json(json!({"message":"Not Found"})))
                        }
                    }),
                ),
        )
        .await;
        let github = Github {
            api: Some((base, "fixture".into())),
            git: None,
        };
        let path = root.to_str().unwrap();
        let connected = check(&github, path, Some("acme/renamed"), "main").await;
        assert_eq!(connected.status, "connected");
        assert_eq!(connected.checkout, CheckoutStatus::Ready);
        assert_eq!(connected.login.as_deref(), Some("fixture-account"));
        assert_eq!(
            check(&github, path, Some("acme/different"), "main")
                .await
                .status,
            "needs_repair"
        );
        assert_eq!(
            check(&github, path, Some("acme/renamed"), "missing")
                .await
                .status,
            "needs_repair"
        );
        assert_eq!(
            check(&github, path, Some("acme/missing"), "main")
                .await
                .status,
            "needs_repair"
        );
        assert_eq!(
            check(&github, path, Some("acme/revoked"), "main")
                .await
                .status,
            "sign_in_required"
        );
        assert_eq!(
            repo.config()
                .unwrap()
                .get_string("remote.origin.url")
                .unwrap(),
            "git@github.com:acme/old.git"
        );
        repo.remote_delete("origin").unwrap();
        assert_eq!(
            check(&github, path, Some("acme/renamed"), "main")
                .await
                .status,
            "needs_repair"
        );
        repo.remote("origin", "git@github.com:acme/renamed.git")
            .unwrap();
        let connected = check(&github, path, Some("acme/renamed"), "main").await;
        assert_eq!(connected.status, "connected");
        assert_eq!(connected.login.as_deref(), Some("fixture-account"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn connection_reports_missing_checkout_and_non_repository_path() {
        let github = Github {
            api: None,
            git: None,
        };
        let root = temporary("connection-checkout");
        let missing = root.join("missing");
        let status = check(&github, missing.to_str().unwrap(), Some("acme/app"), "main").await;
        assert_eq!(status.checkout, CheckoutStatus::Missing);
        assert_eq!(status.status, "needs_repair");
        assert_eq!(
            status.message,
            "No checkout at this path. Clone the repository to this path, then check again."
        );
        assert_eq!(
            serde_json::to_value(&status).unwrap()["checkout"],
            json!("missing")
        );

        let status = check(&github, root.to_str().unwrap(), Some("acme/app"), "main").await;
        assert_eq!(status.checkout, CheckoutStatus::NotARepository);
        assert_eq!(status.status, "needs_repair");
        assert_eq!(
            status.message,
            "This path is not a Git repository. Clone the repository to this path or correct the path."
        );

        // An invalid identity keeps its message; the checkout field stays truthful.
        let status = check(&github, missing.to_str().unwrap(), None, "main").await;
        assert_eq!(status.checkout, CheckoutStatus::Missing);
        assert_eq!(
            status.message,
            "Set a GitHub repository in owner/name format."
        );

        init(&root, false);
        let status = check(&github, root.to_str().unwrap(), Some("acme/app"), "main").await;
        assert_eq!(status.checkout, CheckoutStatus::Ready);
        assert_eq!(
            status.message,
            "Open a local checkout with a GitHub origin. Correct the repository path below."
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
