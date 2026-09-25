use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use super::{
    repository::{self, Commands, Finding},
    service::ProjectFailure,
};

const GIT_BUFFER: usize = 64 * 1024;
const GH_BUFFER: usize = 1024 * 1024;

fn finding(code: &str, field: &str, message: impl Into<String>) -> Finding {
    Finding {
        code: code.to_owned(),
        field: field.to_owned(),
        message: message.into(),
    }
}

fn failure(message: &'static str, status_code: u16, finding: Finding) -> ProjectFailure {
    ProjectFailure {
        message,
        status_code,
        findings: vec![finding],
    }
}

fn command_failure(message: &str) -> String {
    message
        .trim()
        .lines()
        .last()
        .unwrap_or("The command failed")
        .to_owned()
}

fn temporary_path(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    for _ in 0..8 {
        let name = crate::identity::auth::random_hex_id(prefix)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
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

pub fn clone_url(raw: &str, coordinate: &repository::Coordinate) -> String {
    let host = if coordinate.host == "bitbucket" {
        "bitbucket.org"
    } else {
        "github.com"
    };
    if raw.trim().starts_with("git@") {
        format!("git@{host}:{}.git", coordinate.repository)
    } else {
        format!("https://{host}/{}.git", coordinate.repository)
    }
}

pub async fn github_owners(commands: &Commands, cwd: &Path) -> Result<Vec<String>, ProjectFailure> {
    let user = repository::run(
        &commands.gh,
        &["api", "user", "--jq", ".login"],
        cwd,
        30,
        GH_BUFFER,
    )
    .await
    .map_err(|error| {
        failure(
            "Repository provisioning failed",
            422,
            finding(
                "github-auth-unavailable",
                "repositoryName",
                format!(
                    "GitHub CLI could not read the signed-in user: {}",
                    command_failure(&error)
                ),
            ),
        )
    })?;
    let organizations = repository::run(
        &commands.gh,
        &["api", "user/orgs", "--paginate", "--jq", ".[].login"],
        cwd,
        30,
        GH_BUFFER,
    )
    .await
    .unwrap_or_default();
    Ok(format!("{user}\n{organizations}")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub name: String,
    pub default_branch: String,
}

pub async fn github_repositories(
    commands: &Commands,
    owner: &str,
    cwd: &Path,
) -> Result<Vec<GithubRepository>, ProjectFailure> {
    let output = repository::run(
        &commands.gh,
        &[
            "repo",
            "list",
            owner,
            "--no-archived",
            "--limit",
            "1000",
            "--json",
            "name,defaultBranchRef",
        ],
        cwd,
        30,
        16 * 1024 * 1024,
    )
    .await;
    let parse = || -> Result<Vec<GithubRepository>, String> {
        let output = output?;
        let value: serde_json::Value =
            serde_json::from_str(&output).map_err(|error| error.to_string())?;
        let rows = value
            .as_array()
            .ok_or("GitHub returned an invalid repository list")?;
        let mut repositories = rows
            .iter()
            .map(|row| {
                let name = row
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("GitHub returned a repository without a name")?;
                let default_branch = row
                    .get("defaultBranchRef")
                    .and_then(|branch| branch.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .filter(|branch| !branch.is_empty())
                    .unwrap_or("main");
                Ok(GithubRepository {
                    name: name.to_owned(),
                    default_branch: default_branch.to_owned(),
                })
            })
            .collect::<Result<Vec<_>, &str>>()
            .map_err(str::to_owned)?;
        repositories.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        });
        Ok(repositories)
    };
    parse().map_err(|error| {
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

pub async fn ensure(
    commands: &Commands,
    clone_url: &str,
    repository: &str,
    repository_path: &Path,
    worktree_root: &Path,
) -> Result<(), ProjectFailure> {
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
        let remote = repository::run(
            &commands.git,
            &["remote", "get-url", "origin"],
            repository_path,
            120,
            GIT_BUFFER,
        )
        .await;
        let expected = repository::repository_coordinate(clone_url);
        if !remote
            .ok()
            .and_then(|value| repository::repository_coordinate(&value))
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
        let target = temporary.to_string_lossy().into_owned();
        let clone = repository::run(
            &commands.git,
            &["clone", "--origin", "origin", "--", clone_url, &target],
            parent,
            120,
            GIT_BUFFER,
        )
        .await;
        let result = clone.and_then(|_| {
            fs::rename(&temporary, repository_path).map_err(|error| error.to_string())
        });
        if result.is_err() {
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

pub async fn create(
    commands: &Commands,
    coordinate: &repository::Coordinate,
    clone_url: &str,
    repository_path: &Path,
    base_branch: &str,
) -> Result<(), ProjectFailure> {
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
        repository::run(
            &commands.git,
            &["init", "--initial-branch", base_branch],
            &temporary,
            120,
            GIT_BUFFER,
        )
        .await?;
        repository::run(
            &commands.git,
            &["commit", "--allow-empty", "--message", "Initial commit"],
            &temporary,
            120,
            GIT_BUFFER,
        )
        .await?;
        if coordinate.host == "github" {
            repository::run(
                &commands.gh,
                &[
                    "repo",
                    "create",
                    &coordinate.repository,
                    "--private",
                    "--source",
                    temporary.to_str().unwrap(),
                    "--remote",
                    "origin",
                    "--push",
                ],
                &temporary,
                120,
                GH_BUFFER,
            )
            .await?;
        } else {
            return Err("Bitbucket repository creation is not yet connected".to_owned());
        }
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
    let _ = clone_url;
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
    use super::*;

    #[test]
    fn repository_commands_follow_mise_then_cargo_and_make_selection_order() {
        let root = std::env::temp_dir()
            .join(crate::identity::auth::random_hex_id("suplex_command_inference").unwrap());
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
