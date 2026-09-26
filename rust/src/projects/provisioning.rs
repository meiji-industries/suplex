use crate::projects::ProjectError;
use crate::shared::ids::random_hex_id;
use std::{
    fs,
    path::{Path, PathBuf},
};

use git2::{
    FetchOptions, PushOptions, Repository, RepositoryInitOptions, Signature, build::RepoBuilder,
};
use serde::Serialize;
use serde_json::{Value, json};

use super::git::{self, Finding, Github, remote_callbacks};

fn finding(code: &str, field: &str, message: impl Into<String>) -> Finding {
    Finding {
        code: code.to_owned(),
        field: field.to_owned(),
        message: message.into(),
    }
}

fn failure(message: &'static str, status: u16, finding: Finding) -> ProjectError {
    ProjectError::new(message, status, vec![finding])
}

/// The last line of the reason, so the person sees why the host refused.
fn command_failure(message: &str) -> String {
    message
        .trim()
        .lines()
        .last()
        .unwrap_or("The command failed")
        .to_owned()
}

/// GitHub's own explanation of a failed request when it gave one.
fn github_reason(error: &(dyn std::error::Error + 'static)) -> String {
    match error.downcast_ref::<octocrab::Error>() {
        Some(octocrab::Error::GitHub { source, .. }) => source
            .errors
            .iter()
            .flatten()
            .find_map(|error| error["message"].as_str())
            .unwrap_or(&source.message)
            .to_owned(),
        _ => error.to_string(),
    }
}

fn temporary_path(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    for _ in 0..8 {
        let name =
            random_hex_id(prefix).map_err(|error| std::io::Error::other(error.to_string()))?;
        let path = parent.join(name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other(
        "could not allocate repository directory",
    ))
}

pub async fn github_owners(github: &Github) -> Result<Vec<String>, ProjectError> {
    let unavailable = |reason: String| {
        failure(
            "Repository provisioning failed",
            422,
            finding(
                "github-auth-unavailable",
                "repositoryName",
                format!(
                    "GitHub CLI could not read the signed-in user: {}",
                    command_failure(&reason)
                ),
            ),
        )
    };
    let access = github
        .access()
        .await
        .map_err(|error| unavailable(github_reason(&*error)))?;
    let login = access
        .current_user_login()
        .await
        .map_err(|error| unavailable(github_reason(&*error)))?;
    let mut owners = vec![login];
    // Organizations need the read:org scope; without it the personal account still works.
    let mut organizations = Vec::new();
    for page in 1.. {
        let Ok(rows) = access
            .client()
            .get::<Vec<Value>, _, _>("/user/orgs", Some(&json!({"per_page": 100, "page": page})))
            .await
        else {
            organizations.clear();
            break;
        };
        organizations.extend(
            rows.iter()
                .filter_map(|row| row["login"].as_str().map(str::to_owned)),
        );
        if rows.len() < 100 {
            break;
        }
    }
    owners.extend(organizations);
    Ok(owners)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub name: String,
    pub default_branch: String,
}

/// The unarchived repositories `owner` owns, as `gh repo list` reads them.
const OWNER_REPOSITORIES: &str = "query($login: String!, $after: String) { repositoryOwner(login: $login) { repositories(first: 100, after: $after, isArchived: false, ownerAffiliations: [OWNER]) { nodes { name defaultBranchRef { name } } pageInfo { hasNextPage endCursor } } } }";
const REPOSITORY_LIMIT: usize = 1000;

pub async fn github_repositories(
    github: &Github,
    owner: &str,
) -> Result<Vec<GithubRepository>, ProjectError> {
    let list = async {
        let access = github
            .access()
            .await
            .map_err(|error| github_reason(&*error))?;
        let mut repositories = Vec::new();
        let mut after = Value::Null;
        while repositories.len() < REPOSITORY_LIMIT {
            let body =
                json!({"query": OWNER_REPOSITORIES, "variables": {"login": owner, "after": after}});
            let reply: Value = access
                .client()
                .post("/graphql", Some(&body))
                .await
                .map_err(|error| github_reason(&error))?;
            let page = &reply["data"]["repositoryOwner"]["repositories"];
            let nodes = page["nodes"].as_array().ok_or_else(|| {
                reply["errors"][0]["message"]
                    .as_str()
                    .unwrap_or("GitHub returned an invalid repository list")
                    .to_owned()
            })?;
            for node in nodes {
                let name = node["name"]
                    .as_str()
                    .ok_or("GitHub returned a repository without a name")?;
                let default_branch = node["defaultBranchRef"]["name"]
                    .as_str()
                    .filter(|branch| !branch.is_empty())
                    .unwrap_or("main");
                repositories.push(GithubRepository {
                    name: name.to_owned(),
                    default_branch: default_branch.to_owned(),
                });
            }
            if page["pageInfo"]["hasNextPage"] != true {
                break;
            }
            after = page["pageInfo"]["endCursor"].clone();
        }
        repositories.truncate(REPOSITORY_LIMIT);
        repositories.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        });
        Ok::<_, String>(repositories)
    };
    list.await.map_err(|error| {
        failure(
            "Repository listing failed",
            422,
            finding(
                "github-list-failed",
                "owner",
                format!(
                    "GitHub CLI could not list the repositories of {owner}: {}",
                    command_failure(&error)
                ),
            ),
        )
    })
}

fn clone(
    github: &Github,
    url: &str,
    target: &Path,
    token: Option<&str>,
) -> Result<(), git2::Error> {
    let transport_url = git::github_transport_url(url, token);
    let url = transport_url.as_deref().unwrap_or(url);
    let mut options = FetchOptions::new();
    options.remote_callbacks(remote_callbacks(token));
    RepoBuilder::new()
        .fetch_options(options)
        .remote_create(|repository, name, url| {
            github.route_git(repository)?;
            repository.remote(name, url)
        })
        .clone(url, target)?;
    Ok(())
}

pub async fn ensure(
    github: &Github,
    clone_url: &str,
    repository: &str,
    repository_path: &Path,
    worktree_root: &Path,
) -> Result<(), ProjectError> {
    let parent = repository_path
        .parent()
        .expect("repository path has parent");
    fs::create_dir_all(parent).map_err(|error| {
        failure(
            "Repository provisioning failed",
            422,
            finding("repository-unavailable", "repositoryUrl", error.to_string()),
        )
    })?;
    if repository_path.is_dir() {
        // The configured origin, not a URL rewritten by `insteadOf`.
        let remote = Repository::open(repository_path)
            .and_then(|checkout| checkout.config()?.get_string("remote.origin.url"));
        let expected = git::repository_coordinate(clone_url);
        if !remote
            .ok()
            .and_then(|value| git::repository_coordinate(&value))
            .zip(expected)
            .is_some_and(|(actual, expected)| {
                actual.repository == repository && actual.host == expected.host
            })
        {
            return Err(failure(
                "Repository provisioning failed",
                409,
                finding(
                    "repository-conflict",
                    "repositoryUrl",
                    "The default repository path already exists and does not match this GitHub repository",
                ),
            ));
        }
    } else {
        let temporary = temporary_path(parent, ".suplex-clone-").map_err(|error| {
            failure(
                "Repository provisioning failed",
                422,
                finding("repository-unavailable", "repositoryUrl", error.to_string()),
            )
        })?;
        let token = if git::repository_coordinate(clone_url)
            .is_some_and(|coordinate| coordinate.host == "github")
        {
            github.token().await
        } else {
            None
        };
        let (github, url, target) = (github.clone(), clone_url.to_owned(), temporary.clone());
        let cloned =
            tokio::task::spawn_blocking(move || clone(&github, &url, &target, token.as_deref()))
                .await;
        let renamed =
            matches!(cloned, Ok(Ok(()))) && fs::rename(&temporary, repository_path).is_ok();
        if !renamed {
            let _ = fs::remove_dir_all(&temporary);
            return Err(failure(
                "Repository provisioning failed",
                422,
                finding(
                    "repository-unavailable",
                    "repositoryUrl",
                    "Git could not clone the repository with the host's current credentials",
                ),
            ));
        }
    }
    fs::create_dir_all(worktree_root).map_err(|error| {
        failure(
            "Repository provisioning failed",
            422,
            finding("repository-unavailable", "repositoryUrl", error.to_string()),
        )
    })?;
    Ok(())
}

/// `git init` on `branch` and an empty "Initial commit".
fn initial_commit(path: &Path, branch: &str) -> Result<(), git2::Error> {
    let mut options = RepositoryInitOptions::new();
    options.initial_head(branch);
    let repository = Repository::init_opts(path, &options)?;
    // Without a configured Git identity, commit as Suplex rather than fail.
    let signature = repository
        .signature()
        .or_else(|_| Signature::now("Suplex", "suplex@localhost"))?;
    let tree = repository.find_tree(repository.index()?.write_tree()?)?;
    repository.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "Initial commit",
        &tree,
        &[],
    )?;
    Ok(())
}

/// Add `url` as origin, push `branch`, and track it, as `gh repo create --push` does.
fn publish(
    github: &Github,
    path: &Path,
    url: &str,
    branch: &str,
    token: Option<&str>,
) -> Result<(), git2::Error> {
    let repository = Repository::open(path)?;
    github.route_git(&repository)?;
    repository.remote("origin", url)?;
    let mut origin = git::origin_remote(&repository, git2::Direction::Push, token)?;
    let mut callbacks = remote_callbacks(token);
    callbacks.push_update_reference(|_, status| match status {
        Some(status) => Err(git2::Error::from_str(status)),
        None => Ok(()),
    });
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks);
    origin.push(
        &[format!("refs/heads/{branch}:refs/heads/{branch}")],
        Some(&mut options),
    )?;
    let mut config = repository.config()?;
    config.set_str(&format!("branch.{branch}.remote"), "origin")?;
    config.set_str(
        &format!("branch.{branch}.merge"),
        &format!("refs/heads/{branch}"),
    )?;
    Ok(())
}

pub async fn create(
    github: &Github,
    coordinate: &git::Coordinate,
    clone_url: &str,
    repository_path: &Path,
    base_branch: &str,
    connection: Option<&crate::http::contracts::typed::projects::RepositoryConnection>,
) -> Result<(), ProjectError> {
    let parent = repository_path
        .parent()
        .expect("repository path has parent");
    fs::create_dir_all(parent).map_err(|error| {
        failure(
            "Repository provisioning failed",
            422,
            finding(
                "repository-create-failed",
                "repositoryName",
                error.to_string(),
            ),
        )
    })?;
    if repository_path.exists() {
        return Err(failure(
            "Repository provisioning failed",
            409,
            finding(
                "repository-conflict",
                "repositoryName",
                "A repository with this name already exists in the Suplex repository folder",
            ),
        ));
    }
    let temporary = temporary_path(parent, ".suplex-create-").map_err(|error| {
        failure(
            "Repository provisioning failed",
            422,
            finding(
                "repository-create-failed",
                "repositoryName",
                error.to_string(),
            ),
        )
    })?;
    let result = async {
        let (target, branch) = (temporary.clone(), base_branch.to_owned());
        tokio::task::spawn_blocking(move || initial_commit(&target, &branch))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.message().to_owned())?;
        let token = if let Some(
            connection @ crate::http::contracts::typed::projects::RepositoryConnection::Bitbucket {
                ..
            },
        ) = connection
        {
            let client = crate::integrations::bitbucket::BitbucketClient::new(
                &serde_json::to_value(connection).map_err(|error| error.to_string())?,
            );
            client
                .api(
                    &format!("/2.0/repositories/{}", coordinate.repository),
                    "POST",
                    Some((
                        serde_json::to_vec(&json!({"scm":"git", "is_private":true}))
                            .map_err(|error| error.to_string())?,
                        "application/json".into(),
                    )),
                )
                .await
                .map_err(|error| error.to_string())?;
            None
        } else {
            let access = github
                .access()
                .await
                .map_err(|error| github_reason(&*error))?;
            let login = access
                .current_user_login()
                .await
                .map_err(|error| github_reason(&*error))?;
            let (owner, name) = coordinate
                .repository
                .split_once('/')
                .expect("validated coordinate");
            let route = if owner.eq_ignore_ascii_case(&login) {
                "/user/repos".to_owned()
            } else {
                format!("/orgs/{owner}/repos")
            };
            access
                .client()
                .post::<_, Value>(route, Some(&json!({"name": name, "private": true})))
                .await
                .map_err(|error| github_reason(&error))?;
            access.token().map(str::to_owned)
        };
        let (github, target, url, branch) = (
            github.clone(),
            temporary.clone(),
            clone_url.to_owned(),
            base_branch.to_owned(),
        );
        tokio::task::spawn_blocking(move || {
            publish(&github, &target, &url, &branch, token.as_deref())
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message().to_owned())?;
        fs::rename(&temporary, repository_path).map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(failure(
            "Repository provisioning failed",
            422,
            finding(
                "repository-create-failed",
                "repositoryName",
                command_failure(&error),
            ),
        ));
    }
    Ok(())
}

fn readable(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn file(path: &Path) -> bool {
    path.metadata().is_ok_and(|metadata| metadata.is_file())
}

fn has_mise_task(configuration: &str, task: &str) -> bool {
    configuration.lines().any(|line| {
        line.starts_with(&format!("[tasks.{task}]"))
            || line.starts_with(&format!("[tasks.\"{task}\"]"))
            || line.starts_with(&format!("[tasks.'{task}']"))
    })
}

fn make_target(configuration: &str, task: &str) -> bool {
    configuration.lines().any(|line| {
        line.strip_prefix(task)
            .is_some_and(|rest| rest.trim_start().starts_with(':'))
    })
}

pub fn infer_commands(repository_path: &Path) -> (String, String) {
    let mise = readable(&repository_path.join("mise.toml"))
        .or_else(|| readable(&repository_path.join(".mise.toml")))
        .filter(|value| !value.is_empty());
    let package = readable(&repository_path.join("package.json"))
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(|value| match value {
            serde_json::Value::Null | serde_json::Value::Bool(false) => false,
            serde_json::Value::Number(number) => {
                number.as_f64().is_some_and(|number| number != 0.0)
            }
            serde_json::Value::String(value) => !value.is_empty(),
            _ => true,
        });
    let (manager, setup) = if file(&repository_path.join("pnpm-lock.yaml")) {
        (Some("pnpm"), Some("pnpm install --frozen-lockfile"))
    } else if file(&repository_path.join("package-lock.json"))
        || file(&repository_path.join("npm-shrinkwrap.json"))
    {
        (Some("npm"), Some("npm ci"))
    } else if file(&repository_path.join("yarn.lock")) {
        (Some("yarn"), Some("yarn install --immutable"))
    } else if file(&repository_path.join("bun.lock")) || file(&repository_path.join("bun.lockb")) {
        (Some("bun"), Some("bun install"))
    } else if let Some(package) = &package {
        let declared = package
            .get("packageManager")
            .and_then(|value| value.as_str())
            .and_then(|value| value.split('@').next());
        let manager = match declared {
            Some("pnpm") => "pnpm",
            Some("yarn") => "yarn",
            Some("bun") => "bun",
            _ => "npm",
        };
        let setup = match manager {
            "pnpm" => "pnpm install",
            "yarn" => "yarn install",
            "bun" => "bun install",
            _ => "npm install",
        };
        (Some(manager), Some(setup))
    } else if mise
        .as_ref()
        .is_some_and(|value| has_mise_task(value, "setup"))
    {
        (None, Some("mise run setup"))
    } else if file(&repository_path.join("Cargo.lock")) {
        (None, Some("cargo fetch --locked"))
    } else {
        (None, None)
    };
    let script = ["check", "test", "typecheck", "lint"]
        .into_iter()
        .find(|name| {
            package
                .as_ref()
                .and_then(|package| package.get("scripts"))
                .and_then(|scripts| scripts.get(name))
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty())
        });
    let verification = if let (Some(script), Some(manager)) = (script, manager) {
        if manager == "npm" {
            if script == "test" {
                "npm test".to_owned()
            } else {
                format!("npm run {script}")
            }
        } else {
            format!("{manager} {script}")
        }
    } else if let Some(mise) = mise.as_ref() {
        ["check", "test", "typecheck", "lint"]
            .into_iter()
            .find(|task| has_mise_task(mise, task))
            .map_or_else(|| "pnpm test".to_owned(), |task| format!("mise run {task}"))
    } else if file(&repository_path.join("Cargo.toml")) {
        "cargo test".to_owned()
    } else {
        let makefile = readable(&repository_path.join("Makefile"));
        if makefile
            .as_ref()
            .is_some_and(|value| make_target(value, "check"))
        {
            "make check".to_owned()
        } else if makefile
            .as_ref()
            .is_some_and(|value| make_target(value, "test"))
        {
            "make test".to_owned()
        } else {
            "pnpm test".to_owned()
        }
    };
    (setup.unwrap_or("pnpm install").to_owned(), verification)
}

#[cfg(test)]
mod tests {
    use axum::{Json, Router, routing::post};

    use super::{super::git::fixtures::*, *};

    #[test]
    fn oauth_clones_and_publishes_ssh_github_urls_over_https() {
        let root = temporary("suplex-oauth-provision");
        let bare = root.join("acme/repo.git");
        fs::create_dir_all(bare.parent().unwrap()).unwrap();
        init(&bare, true);
        let source = init(&root.join("source"), false);
        let head = commit(&source, "initial");
        let github = Github {
            git: Some(format!("file://{}/", root.display())),
            ..Github::default()
        };
        let url = "git@github.com:acme/repo.git";
        publish(
            &github,
            source.workdir().unwrap(),
            url,
            "main",
            Some("fixture-token"),
        )
        .unwrap();
        let target = root.join("clone");
        clone(&github, url, &target, Some("fixture-token")).unwrap();
        assert_eq!(
            Repository::open(&target).unwrap().head().unwrap().target(),
            Some(head)
        );
        assert_eq!(
            source
                .config()
                .unwrap()
                .get_string("remote.origin.url")
                .unwrap(),
            url
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn package_checks_use_the_locked_package_manager() {
        for (lockfile, verification) in [
            ("pnpm-lock.yaml", "pnpm check"),
            ("package-lock.json", "npm run check"),
            ("yarn.lock", "yarn check"),
            ("bun.lock", "bun check"),
        ] {
            let root = temporary("suplex-infer");
            fs::write(
                root.join("package.json"),
                r#"{"scripts":{"check":"lint && test","test":"test"}}"#,
            )
            .unwrap();
            fs::write(root.join(lockfile), "").unwrap();
            assert_eq!(infer_commands(&root).1, verification, "{lockfile}");
            fs::remove_dir_all(root).unwrap();
        }
        let root = temporary("suplex-infer-checks");
        fs::write(
            root.join("mise.toml"),
            "[tasks.check]\nrun = \"test && lint\"\n[tasks.test]\nrun = \"test\"\n",
        )
        .unwrap();
        assert_eq!(infer_commands(&root).1, "mise run check");
        fs::remove_file(root.join("mise.toml")).unwrap();
        fs::write(root.join("Makefile"), "check:\n\ttrue\n\ntest:\n\ttrue\n").unwrap();
        assert_eq!(infer_commands(&root).1, "make check");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn ensure_clones_through_git_and_create_publishes_through_the_github_api() {
        let root = temporary("suplex-provision");
        init(&root.join("acme/repo.git"), true);
        let source = init(&root.join("source"), false);
        commit(&source, "initial");
        push_main(&source, &root.join("acme/repo.git"));
        init(&root.join("acme/fresh.git"), true);
        let created = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, Value)>::new()));
        let recorded = created.clone();
        let api = github_api(
            Router::new()
                .route(
                    "/user",
                    axum::routing::get(|| async { Json(json!({"login": "Acme"})) }),
                )
                .route(
                    "/user/repos",
                    post({
                        let recorded = recorded.clone();
                        move |Json(body): Json<Value>| async move {
                            recorded.lock().unwrap().push(("/user/repos".into(), body));
                            Json(json!({}))
                        }
                    }),
                )
                .route(
                    "/orgs/{owner}/repos",
                    post(|| async {
                        (
                            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                            Json(json!({"message": "Repository creation failed.", "errors": [{"message": "name already exists on this account"}]})),
                        )
                    }),
                ),
        )
        .await;
        let github = Github {
            api: Some((api, "fixture-token".to_owned())),
            git: Some(format!("file://{}/", root.display())),
        };
        let repositories = root.join("repositories");

        let clone_path = repositories.join("acme/repo");
        let worktrees = root.join("worktrees/acme/repo");
        ensure(
            &github,
            "https://github.com/acme/repo.git",
            "acme/repo",
            &clone_path,
            &worktrees,
        )
        .await
        .unwrap();
        let checkout = Repository::open(&clone_path).unwrap();
        assert_eq!(
            checkout
                .config()
                .unwrap()
                .get_string("remote.origin.url")
                .unwrap(),
            "https://github.com/acme/repo.git"
        );
        assert!(checkout.find_reference("refs/remotes/origin/main").is_ok());
        assert!(worktrees.is_dir());
        assert_eq!(
            git::inspect(&clone_path, "main", "github", None)
                .unwrap()
                .remote_repository,
            "acme/repo"
        );
        ensure(
            &github,
            "https://github.com/acme/repo.git",
            "acme/repo",
            &clone_path,
            &worktrees,
        )
        .await
        .unwrap();
        let conflict = ensure(
            &github,
            "https://github.com/acme/other.git",
            "acme/other",
            &clone_path,
            &worktrees,
        )
        .await
        .unwrap_err();
        assert_eq!(
            (conflict.status(), conflict.findings()[0].code.as_str()),
            (409, "repository-conflict")
        );
        let missing = ensure(
            &github,
            "https://github.com/acme/missing.git",
            "acme/missing",
            &repositories.join("acme/missing"),
            &worktrees,
        )
        .await
        .unwrap_err();
        assert_eq!(missing.findings()[0].code, "repository-unavailable");
        assert_eq!(
            fs::read_dir(repositories.join("acme")).unwrap().count(),
            1,
            "a failed clone leaves no directory"
        );

        let fresh = git::repository_coordinate("https://github.com/acme/fresh").unwrap();
        let fresh_path = repositories.join("acme/fresh");
        create(
            &github,
            &fresh,
            &fresh.clone_url,
            &fresh_path,
            "trunk",
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            created.lock().unwrap().as_slice(),
            &[(
                "/user/repos".to_owned(),
                json!({"name": "fresh", "private": true})
            )]
        );
        let published = Repository::open(root.join("acme/fresh.git")).unwrap();
        let head = published.find_reference("refs/heads/trunk").unwrap();
        assert_eq!(
            head.peel_to_commit().unwrap().message_bytes(),
            b"Initial commit"
        );
        let fresh_checkout = Repository::open(&fresh_path).unwrap();
        let config = fresh_checkout.config().unwrap();
        assert_eq!(config.get_string("branch.trunk.remote").unwrap(), "origin");
        assert_eq!(
            config.get_string("remote.origin.url").unwrap(),
            "https://github.com/acme/fresh.git"
        );
        let exists = create(
            &github,
            &fresh,
            &fresh.clone_url,
            &fresh_path,
            "trunk",
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            (exists.status(), exists.findings()[0].code.as_str()),
            (409, "repository-conflict")
        );
        let organization =
            git::repository_coordinate("https://github.com/meiji/fresh").unwrap();
        let refused = create(
            &github,
            &organization,
            &organization.clone_url,
            &repositories.join("meiji/fresh"),
            "main",
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            (
                refused.findings()[0].code.as_str(),
                refused.findings()[0].message.as_str()
            ),
            (
                "repository-create-failed",
                "name already exists on this account"
            )
        );
        assert_eq!(fs::read_dir(repositories.join("meiji")).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repository_commands_follow_mise_then_cargo_and_make_selection_order() {
        let root = std::env::temp_dir().join(random_hex_id("suplex_command_inference").unwrap());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Cargo.toml"), "[package]\nname = 'fixture'\n").unwrap();
        fs::write(
            root.join("mise.toml"),
            "[tasks.lint] # maintained by the repository\n",
        )
        .unwrap();
        assert_eq!(
            infer_commands(&root),
            ("pnpm install".to_owned(), "mise run lint".to_owned())
        );
        fs::write(root.join("mise.toml"), "[tasks.setup]\n").unwrap();
        assert_eq!(
            infer_commands(&root),
            ("mise run setup".to_owned(), "pnpm test".to_owned())
        );
        fs::remove_file(root.join("mise.toml")).unwrap();
        fs::remove_file(root.join("Cargo.toml")).unwrap();
        fs::write(root.join("Makefile"), "check :\n\t@true\n").unwrap();
        assert_eq!(
            infer_commands(&root),
            ("pnpm install".to_owned(), "make check".to_owned())
        );
        fs::remove_dir_all(root).unwrap();
    }
}
