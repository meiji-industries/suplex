use serde::{Deserialize, Serialize};

use super::git::{Github, github_status, repository_coordinate, valid_repository};
use crate::integrations::github::Access;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub status: &'static str,
    pub message: &'static str,
    pub method: &'static str,
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
        origin_repository: None,
        login: None,
    };
    let Some(identity) = identity.filter(|value| valid_repository(value)) else {
        return result;
    };
    let path = path.to_owned();
    let origin = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(path).ok()?;
        let url = repo.config().ok()?.get_string("remote.origin.url").ok()?;
        repository_coordinate(&url)
            .filter(|value| value.host == "github")
            .map(|value| value.repository)
    })
    .await
    .ok()
    .flatten();
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
}
