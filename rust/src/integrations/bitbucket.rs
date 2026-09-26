//! Bitbucket Cloud repository, pull request, and Downloads access
//! (`src/integrations/bitbucket.ts`). Results use the GitHub delivery shapes.

use std::{collections::HashSet, path::Path, sync::LazyLock};

use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    github_delivery::{Checks, Github, GithubFailure, Observation, PullRequest, failure},
    issue_tracker::{BeforeWrite, environment_credential},
    provider_http::{self, MAXIMUM_BYTES, ProviderHttpFailure, ProviderResult},
};
use crate::shared::encode_uri_component;

const ORIGIN: &str = "https://api.bitbucket.org";
static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40,64}$").unwrap());
static REPOSITORY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").unwrap());
static EVIDENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^suplex-[A-Za-z0-9._-]+$").unwrap());

fn coordinate(repository: &str) -> ProviderResult<String> {
    if !REPOSITORY.is_match(repository) {
        return Err("The repository identity is invalid".into());
    }
    Ok(format!("/2.0/repositories/{repository}"))
}

fn malformed() -> Box<dyn std::error::Error + Send + Sync> {
    "Bitbucket returned a malformed response".into()
}

/// One Bitbucket pull request in the GitHub pull request shape.
pub fn pull(value: &Value) -> ProviderResult<PullRequest> {
    let text = |pointer: &str| value.pointer(pointer).and_then(Value::as_str);
    let end_valid = |side: &str| {
        text(&format!("/{side}/branch/name")).is_some()
            && text(&format!("/{side}/commit/hash")).is_some_and(|hash| SHA.is_match(hash))
            && text(&format!("/{side}/repository/full_name")).is_some()
    };
    let href = text("/links/html/href").filter(|href| {
        url::Url::parse(href)
            .is_ok_and(|url| url.origin().ascii_serialization() == "https://bitbucket.org")
    });
    let state = text("/state")
        .filter(|state| matches!(*state, "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED"));
    let description = match value.get("description") {
        None => Some(""),
        Some(Value::String(text)) => Some(text.as_str()),
        Some(_) => None,
    };
    let (Some(number), Some(title), Some(description), Some(state), Some(href), Some(draft)) = (
        value.get("id").and_then(Value::as_u64).filter(|id| *id > 0),
        text("/title"),
        description,
        state,
        href,
        value.get("draft").and_then(Value::as_bool),
    ) else {
        return Err(malformed());
    };
    if !end_valid("source")
        || !end_valid("destination")
        || value
            .get("updated_on")
            .is_some_and(|value| !value.is_string())
    {
        return Err(malformed());
    }
    let destination = text("/destination/repository/full_name")
        .unwrap_or_default()
        .to_lowercase();
    let merged = state == "MERGED";
    Ok(PullRequest {
        number,
        url: href.to_owned(),
        is_cross_repository: Some(
            text("/source/repository/full_name")
                .unwrap_or_default()
                .to_lowercase()
                != destination,
        ),
        repository: destination,
        head_branch: text("/source/branch/name").unwrap_or_default().to_owned(),
        base_branch: text("/destination/branch/name")
            .unwrap_or_default()
            .to_owned(),
        head_sha: text("/source/commit/hash").unwrap_or_default().to_owned(),
        base_sha: text("/destination/commit/hash")
            .unwrap_or_default()
            .to_owned(),
        is_draft: draft,
        state: match state {
            "OPEN" => "open",
            "MERGED" => "merged",
            _ => "closed",
        }
        .to_owned(),
        merged_at: if merged {
            text("/updated_on").map(str::to_owned)
        } else {
            None
        },
        auto_merge_enabled: None,
        title: Some(title.to_owned()),
        body: Some(description.to_owned()),
        author: None,
        updated_at: None,
        node_id: None,
    })
}

pub struct BitbucketClient {
    connection: Value,
    http: reqwest::Client,
    origin: String,
}

impl BitbucketClient {
    /// `connection` is the project's `{kind: "bitbucket", tokenEnvironment, usernameEnvironment?}`.
    pub fn new(connection: &Value) -> Self {
        Self::with_origin(connection, ORIGIN)
    }

    pub(crate) fn with_origin(connection: &Value, origin: &str) -> Self {
        Self {
            connection: connection.clone(),
            http: provider_http::client(),
            origin: origin.to_owned(),
        }
    }

    fn authorization(&self) -> ProviderResult<String> {
        let token = environment_credential(
            self.connection["tokenEnvironment"]
                .as_str()
                .unwrap_or_default(),
        )?;
        Ok(match self.connection["usernameEnvironment"].as_str() {
            Some(username) => format!(
                "Basic {}",
                STANDARD.encode(format!("{}:{token}", environment_credential(username)?))
            ),
            None => format!("Bearer {token}"),
        })
    }

    /// `api`: one JSON request with the release failure classes.
    pub async fn api(
        &self,
        path: &str,
        method: &str,
        body: Option<(Vec<u8>, String)>,
    ) -> ProviderResult<Value> {
        let url = url::Url::parse(&self.origin)?.join(path)?;
        let result = provider_http::provider_json(
            &self.http,
            method.parse()?,
            &url,
            &self.origin,
            &self.authorization()?,
            body,
        )
        .await;
        result.map_err(|error| {
            let status = error.downcast_ref::<ProviderHttpFailure>().map(|failure| failure.status);
            match status {
                Some(401 | 403) => Box::new(failure("authentication-required", "Bitbucket access is unavailable. Check the project's credential references and repository permissions.")) as _,
                Some(429) => Box::new(failure("provider-rate-limited", "Bitbucket rate limit reached")) as _,
                Some(500..) => Box::new(failure("provider-unavailable", "Bitbucket is unavailable")) as _,
                _ => error,
            }
        })
    }

    async fn get(&self, path: &str) -> ProviderResult<Value> {
        self.api(path, "GET", None).await
    }

    fn json_body(value: &Value) -> Option<(Vec<u8>, String)> {
        Some((value.to_string().into_bytes(), "application/json".into()))
    }

    /// Follow at most five Downloads redirects to known Bitbucket storage hosts.
    async fn download(&self, repository: &str, filename: &str) -> ProviderResult<Vec<u8>> {
        let authorization = self.authorization()?;
        let mut url = url::Url::parse(&self.origin)?.join(&format!(
            "{}/downloads/{}",
            coordinate(repository)?,
            encode_uri_component(filename)
        ))?;
        for _ in 0..5 {
            let mut request = self.http.get(url.clone()).header("Accept", "*/*");
            if url.origin().ascii_serialization() == self.origin {
                request = request.header("Authorization", &authorization);
            }
            let response = request.send().await?;
            if ![301, 302, 303, 307, 308].contains(&response.status().as_u16()) {
                return provider_http::bounded_response(response, MAXIMUM_BYTES).await;
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .ok_or("Bitbucket returned a redirect without a download location")?;
            url = url.join(location)?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.port().is_some()
                || !matches!(
                    url.host_str(),
                    Some(
                        "api.bitbucket.org"
                            | "bitbucket.org"
                            | "bbuseruploads.s3.amazonaws.com"
                            | "api.media.atlassian.com"
                    )
                )
            {
                return Err("Bitbucket returned an unsafe download URL".into());
            }
        }
        Err("Bitbucket download redirects did not complete".into())
    }

    /// `repository`: the canonical name and web URL.
    pub async fn repository(&self, repository: &str) -> ProviderResult<(String, String)> {
        let row = self.get(&coordinate(repository)?).await?;
        let (Some(name), Some(href)) = (
            row["full_name"].as_str(),
            row.pointer("/links/html/href").and_then(Value::as_str),
        ) else {
            return Err(malformed());
        };
        let href_url = url::Url::parse(href).map_err(|_| malformed())?;
        if name.to_lowercase() != repository.to_lowercase()
            || href_url.origin().ascii_serialization() != "https://bitbucket.org"
        {
            return Err("Bitbucket returned another repository".into());
        }
        Ok((name.to_owned(), href.to_owned()))
    }

    async fn pages(&self, first: String, message: &'static str) -> ProviderResult<Vec<Value>> {
        let mut next = Some(first);
        let mut seen = HashSet::new();
        let mut values = Vec::new();
        while let Some(path) = next {
            if seen.contains(&path) || seen.len() >= 100 {
                return Err(message.into());
            }
            seen.insert(path.clone());
            let page = self.get(&path).await?;
            values.extend(
                page["values"]
                    .as_array()
                    .ok_or_else(malformed)?
                    .iter()
                    .cloned(),
            );
            next = match page.get("next") {
                None => None,
                Some(Value::String(next)) => Some(next.clone()),
                Some(_) => return Err(malformed()),
            };
        }
        Ok(values)
    }

    /// `list`: every pull request, or those in one state.
    pub async fn list(
        &self,
        repository: &str,
        state: Option<&str>,
    ) -> ProviderResult<Vec<PullRequest>> {
        let states = state.map_or(
            "state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED".into(),
            |state| format!("state={state}"),
        );
        self.pages(
            format!(
                "{}/pullrequests?pagelen=50&{states}",
                coordinate(repository)?
            ),
            "Bitbucket pagination did not complete",
        )
        .await?
        .iter()
        .map(pull)
        .collect()
    }

    /// `upload`: publish evidence once to Downloads and confirm its exact bytes.
    pub async fn upload(
        &self,
        repository: &str,
        filename: &str,
        bytes: &[u8],
        mime_type: &str,
        before_write: BeforeWrite<'_>,
    ) -> ProviderResult<String> {
        if !EVIDENCE.is_match(filename) {
            return Err("The evidence filename is invalid".into());
        }
        let present = || async {
            let mut next = Some(format!("{}/downloads?pagelen=100", coordinate(repository)?));
            let mut seen = HashSet::new();
            while let Some(path) = next {
                if seen.contains(&path) || seen.len() >= 100 {
                    return Err("Bitbucket Downloads pagination did not complete".into());
                }
                seen.insert(path.clone());
                let page = self.get(&path).await?;
                let values = page["values"].as_array().ok_or_else(malformed)?;
                if values
                    .iter()
                    .any(|item| !item["name"].is_string() || !item["size"].is_number())
                {
                    return Err(malformed());
                }
                if let Some(existing) = values.iter().find(|item| item["name"] == filename) {
                    if existing["size"].as_u64() != Some(bytes.len() as u64) {
                        return Err("The existing evidence download has a different size".into());
                    }
                    let downloaded = self.download(repository, filename).await?;
                    if Sha256::digest(&downloaded) != Sha256::digest(bytes) {
                        return Err(
                            "The Bitbucket download does not match the task evidence".into()
                        );
                    }
                    return Ok(true);
                }
                next = page["next"].as_str().map(str::to_owned);
            }
            Ok::<bool, Box<dyn std::error::Error + Send + Sync>>(false)
        };
        let url = format!(
            "https://bitbucket.org/{repository}/downloads/{}",
            encode_uri_component(filename)
        );
        if present().await? {
            return Ok(url);
        }
        let boundary = format!("suplex-{}", uuid::Uuid::new_v4().simple());
        let mut form = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{filename}\"\r\nContent-Type: {mime_type}\r\n\r\n").into_bytes();
        form.extend_from_slice(bytes);
        form.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        before_write().await?;
        self.api(
            &format!("{}/downloads", coordinate(repository)?),
            "POST",
            Some((form, format!("multipart/form-data; boundary={boundary}"))),
        )
        .await?;
        if !present().await? {
            return Err("Bitbucket has not confirmed the evidence upload".into());
        }
        Ok(url)
    }

    // The release port (`createBitbucketReleasePort`).

    pub async fn check_authentication(&self) -> ProviderResult<()> {
        self.get("/2.0/user").await.map(|_| ())
    }

    pub async fn get_pull_request(
        &self,
        repository: &str,
        number: u64,
    ) -> ProviderResult<PullRequest> {
        pull(
            &self
                .get(&format!(
                    "{}/pullrequests/{number}",
                    coordinate(repository)?
                ))
                .await?,
        )
    }

    pub async fn get_branch_head(
        &self,
        repository: &str,
        branch: &str,
    ) -> ProviderResult<Option<String>> {
        match self
            .get(&format!(
                "{}/refs/branches/{}",
                coordinate(repository)?,
                encode_uri_component(branch)
            ))
            .await
        {
            Ok(value) => value
                .pointer("/target/hash")
                .and_then(Value::as_str)
                .filter(|hash| SHA.is_match(hash))
                .map(|hash| Some(hash.to_owned()))
                .ok_or_else(malformed),
            Err(error)
                if error
                    .downcast_ref::<ProviderHttpFailure>()
                    .is_some_and(|failure| failure.status == 404) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub async fn list_pull_requests(
        &self,
        repository: &str,
        head_branch: &str,
        base_branch: &str,
    ) -> ProviderResult<Vec<PullRequest>> {
        Ok(self
            .list(repository, None)
            .await?
            .into_iter()
            .filter(|row| {
                row.head_branch == head_branch
                    && row.base_branch == base_branch
                    && row.is_cross_repository != Some(true)
            })
            .collect())
    }

    pub async fn list_open_pull_requests(
        &self,
        repository: &str,
        limit: usize,
    ) -> ProviderResult<Vec<PullRequest>> {
        Ok(self
            .list(repository, Some("OPEN"))
            .await?
            .into_iter()
            .take(limit)
            .collect())
    }

    pub async fn create_draft_pull_request(
        &self,
        repository: &str,
        title: &str,
        body: &str,
        head_branch: &str,
        base_branch: &str,
    ) -> ProviderResult<PullRequest> {
        let request = json!({"title": title, "description": body, "draft": true, "close_source_branch": false, "source": {"branch": {"name": head_branch}}, "destination": {"branch": {"name": base_branch}}});
        pull(
            &self
                .api(
                    &format!("{}/pullrequests", coordinate(repository)?),
                    "POST",
                    Self::json_body(&request),
                )
                .await?,
        )
    }

    pub async fn update_draft_pull_request(
        &self,
        repository: &str,
        number: u64,
        title: &str,
        body: &str,
    ) -> ProviderResult<PullRequest> {
        pull(
            &self
                .api(
                    &format!("{}/pullrequests/{number}", coordinate(repository)?),
                    "PUT",
                    Self::json_body(&json!({"title": title, "description": body})),
                )
                .await?,
        )
    }

    pub async fn get_pull_request_states(
        &self,
        inputs: &[(String, u64)],
    ) -> ProviderResult<Vec<Value>> {
        let mut states = Vec::new();
        for (repository, number) in inputs {
            states.push(
                self.get_pull_request(repository, *number)
                    .await?
                    .reference(),
            );
        }
        Ok(states)
    }

    pub async fn observe_pull_request(
        &self,
        repository: &str,
        branch: &str,
        number: Option<u64>,
    ) -> ProviderResult<Observation> {
        let row = match number {
            Some(number) => Some(self.get_pull_request(repository, number).await?),
            None => self
                .list(repository, None)
                .await?
                .into_iter()
                .find(|row| row.head_branch == branch && row.is_cross_repository != Some(true)),
        };
        let Some(row) = row else {
            return Ok(Observation::absent());
        };
        let statuses = self
            .pages(
                format!(
                    "{}/commit/{}/statuses?pagelen=100",
                    coordinate(repository)?,
                    row.head_sha
                ),
                "Bitbucket checks pagination did not complete",
            )
            .await?;
        let mut runs = Vec::new();
        for status in statuses {
            let (Some(name), Some(state)) = (status["name"].as_str(), status["state"].as_str())
            else {
                return Err(malformed());
            };
            let status_name = match state {
                "SUCCESSFUL" => "successful",
                "FAILED" | "STOPPED" => "failing",
                _ => "pending",
            };
            runs.push(json!({"name": name, "status": status_name, "url": status.get("url").and_then(Value::as_str)}));
        }
        let count = |status: &str| runs.iter().filter(|run| run["status"] == status).count() as u64;
        Ok(Observation {
            exists: true,
            number: Some(row.number),
            url: Some(row.url),
            state: Some(row.state),
            is_draft: Some(row.is_draft),
            head_sha: Some(row.head_sha),
            base_sha: Some(row.base_sha),
            checks: Checks {
                total: runs.len() as u64,
                pending: count("pending"),
                failing: count("failing"),
                successful: count("successful"),
                runs,
            },
            auto_merge_enabled: Some(false),
            ..Observation::default()
        })
    }

    /// Bitbucket delivery stops at draft pull requests.
    pub fn draft_only() -> GithubFailure {
        failure(
            "provider-unavailable",
            "Bitbucket delivery supports draft pull requests only",
        )
    }
}

/// TypeScript `forTask`: the release port of a task or project. Bitbucket
/// repositories use `createBitbucketReleasePort`; every other repository uses GitHub.
pub enum ReleasePort<'a> {
    Github(&'a Github),
    Bitbucket(BitbucketClient),
}

type PortResult<T> = Result<T, Box<dyn std::error::Error>>;

fn port<T>(result: ProviderResult<T>) -> PortResult<T> {
    result.map_err(|error| error as _)
}

impl ReleasePort<'_> {
    /// The Bitbucket connection of a repository connection value, if it is one.
    pub fn bitbucket(connection: &Value) -> Option<BitbucketClient> {
        (connection["kind"] == "bitbucket").then(|| BitbucketClient::new(connection))
    }

    pub fn github(&self) -> Option<&Github> {
        match self {
            ReleasePort::Github(github) => Some(github),
            ReleasePort::Bitbucket(_) => None,
        }
    }

    /// The GitHub token for Git transport; Bitbucket pushes use the local Git credentials.
    pub fn token(&self) -> Option<&str> {
        self.github().and_then(Github::token)
    }

    pub fn remote_repository(&self, cwd: &Path) -> Result<String, GithubFailure> {
        match self {
            ReleasePort::Github(_) => super::github_delivery::remote_repository(cwd),
            ReleasePort::Bitbucket(_) => remote_repository(cwd),
        }
    }

    pub async fn get_pull_request(&self, repository: &str, number: u64) -> PortResult<PullRequest> {
        Ok(match self {
            ReleasePort::Github(github) => github.get_pull_request(repository, number).await?,
            ReleasePort::Bitbucket(client) => {
                port(client.get_pull_request(repository, number).await)?
            }
        })
    }

    pub async fn get_branch_head(
        &self,
        repository: &str,
        branch: &str,
    ) -> PortResult<Option<String>> {
        Ok(match self {
            ReleasePort::Github(github) => github.get_branch_head(repository, branch).await?,
            ReleasePort::Bitbucket(client) => {
                port(client.get_branch_head(repository, branch).await)?
            }
        })
    }

    pub async fn list_pull_requests(
        &self,
        repository: &str,
        head_branch: &str,
        base_branch: &str,
    ) -> PortResult<Vec<PullRequest>> {
        Ok(match self {
            ReleasePort::Github(github) => {
                github.list_pull_requests(repository, head_branch).await?
            }
            ReleasePort::Bitbucket(client) => port(
                client
                    .list_pull_requests(repository, head_branch, base_branch)
                    .await,
            )?,
        })
    }

    pub async fn list_open_pull_requests(
        &self,
        repository: &str,
        limit: u64,
    ) -> PortResult<Vec<PullRequest>> {
        Ok(match self {
            ReleasePort::Github(github) => {
                github.list_open_pull_requests(repository, limit).await?
            }
            ReleasePort::Bitbucket(client) => port(
                client
                    .list_open_pull_requests(repository, limit as usize)
                    .await,
            )?,
        })
    }

    pub async fn observe_pull_request(
        &self,
        repository: &str,
        branch: &str,
        number: Option<u64>,
    ) -> PortResult<Observation> {
        Ok(match self {
            ReleasePort::Github(github) => {
                github
                    .observe_pull_request(repository, branch, number)
                    .await?
            }
            ReleasePort::Bitbucket(client) => port(
                client
                    .observe_pull_request(repository, branch, number)
                    .await,
            )?,
        })
    }

    pub async fn create_draft_pull_request(
        &self,
        repository: &str,
        head_branch: &str,
        base_branch: &str,
        title: &str,
        body: &str,
    ) -> PortResult<PullRequest> {
        Ok(match self {
            ReleasePort::Github(github) => {
                github
                    .create_draft_pull_request(repository, head_branch, base_branch, title, body)
                    .await?
            }
            ReleasePort::Bitbucket(client) => port(
                client
                    .create_draft_pull_request(repository, title, body, head_branch, base_branch)
                    .await,
            )?,
        })
    }

    pub async fn update_draft_pull_request(
        &self,
        repository: &str,
        number: u64,
        title: &str,
        body: &str,
    ) -> PortResult<PullRequest> {
        Ok(match self {
            ReleasePort::Github(github) => {
                github
                    .update_draft_pull_request(repository, number, title, body)
                    .await?
            }
            ReleasePort::Bitbucket(client) => port(
                client
                    .update_draft_pull_request(repository, number, title, body)
                    .await,
            )?,
        })
    }

    /// Bitbucket delivery stops at draft pull requests, so it has no merge.
    pub async fn merge_conditionally(
        &self,
        repository: &str,
        number: u64,
        head_sha: &str,
        allow_queue: bool,
    ) -> PortResult<super::github_delivery::MergeResult> {
        match self {
            ReleasePort::Github(github) => Ok(github
                .merge_conditionally(repository, number, head_sha, allow_queue)
                .await?),
            ReleasePort::Bitbucket(_) => Err(Box::new(BitbucketClient::draft_only())),
        }
    }

    pub async fn mark_ready_for_review(&self, repository: &str, number: u64) -> PortResult<()> {
        match self {
            ReleasePort::Github(github) => {
                Ok(github.mark_ready_for_review(repository, number).await?)
            }
            ReleasePort::Bitbucket(_) => Err(Box::new(BitbucketClient::draft_only())),
        }
    }

    pub async fn pull_request_states(&self, inputs: &[(String, u64)]) -> PortResult<Vec<Value>> {
        Ok(match self {
            ReleasePort::Github(github) => github.pull_request_states(inputs).await?,
            ReleasePort::Bitbucket(client) => port(client.get_pull_request_states(inputs).await)?,
        })
    }
}

/// `getRemoteRepository`: the Bitbucket `workspace/name` of the origin remote.
pub fn remote_repository(cwd: &Path) -> Result<String, GithubFailure> {
    let wrong = || failure("wrong-remote", "Git origin is not a Bitbucket repository");
    let repository = git2::Repository::open(cwd).map_err(|_| wrong())?;
    let remote = repository.find_remote("origin").map_err(|_| wrong())?;
    crate::projects::git::repository_coordinate(remote.url().unwrap_or_default())
        .filter(|coordinate| coordinate.host == "bitbucket")
        .map(|coordinate| coordinate.repository)
        .ok_or_else(wrong)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{Json, Router, extract::OriginalUri, http::StatusCode, response::IntoResponse};

    use super::*;

    fn bitbucket_pull(id: u64, state: &str) -> Value {
        json!({"id": id, "title": "Change", "state": state, "draft": true,
            "source": {"branch": {"name": "feature"}, "commit": {"hash": "a".repeat(40)}, "repository": {"full_name": "Team/Repo"}},
            "destination": {"branch": {"name": "main"}, "commit": {"hash": "b".repeat(40)}, "repository": {"full_name": "Team/Repo"}},
            "links": {"html": {"href": format!("https://bitbucket.org/team/repo/pull-requests/{id}")}}, "updated_on": "2026-01-01T00:00:00Z"})
    }

    #[test]
    fn pull_requests_map_to_the_github_shape() {
        let open = pull(&bitbucket_pull(3, "OPEN")).unwrap();
        assert_eq!(
            (
                open.number,
                open.repository.as_str(),
                open.state.as_str(),
                open.merged_at.clone(),
                open.body.as_deref(),
                open.is_cross_repository
            ),
            (3, "team/repo", "open", None, Some(""), Some(false))
        );
        assert_eq!(
            pull(&bitbucket_pull(3, "MERGED"))
                .unwrap()
                .merged_at
                .as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(
            pull(&bitbucket_pull(3, "DECLINED")).unwrap().state,
            "closed"
        );
        let mut foreign = bitbucket_pull(3, "OPEN");
        foreign["links"]["html"]["href"] = json!("https://evil.example/pull/3");
        assert!(pull(&foreign).is_err());
    }

    #[tokio::test]
    async fn release_port_reads_pages_statuses_and_classifies_failures() {
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = requests.clone();
        let app = Router::new().fallback(move |OriginalUri(uri): OriginalUri, headers: axum::http::HeaderMap| {
            let log = log.clone();
            async move {
                let key = uri.path_and_query().unwrap().as_str().to_owned();
                log.lock().unwrap().push(format!("{key} {}", headers.get("authorization").and_then(|value| value.to_str().ok()).unwrap_or("")));
                let body = match key.as_str() {
                    "/2.0/repositories/team/repo/pullrequests?pagelen=50&state=OPEN" => json!({"values": [bitbucket_pull(1, "OPEN")], "next": "/2.0/repositories/team/repo/pullrequests?page=2"}),
                    "/2.0/repositories/team/repo/pullrequests?page=2" => json!({"values": [bitbucket_pull(2, "OPEN")]}),
                    "/2.0/repositories/team/repo/pullrequests/1" => bitbucket_pull(1, "OPEN"),
                    path if path.starts_with("/2.0/repositories/team/repo/commit/") => json!({"values": [{"name": "ci", "state": "SUCCESSFUL", "url": null}, {"name": "lint", "state": "FAILED"}, {"name": "e2e", "state": "INPROGRESS"}]}),
                    "/2.0/repositories/team/repo/refs/branches/missing" => return StatusCode::NOT_FOUND.into_response(),
                    "/2.0/user" => return StatusCode::UNAUTHORIZED.into_response(),
                    _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                };
                Json(body).into_response()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // SAFETY: test-only credential variables with names unique to this test.
        unsafe { std::env::set_var("SUPLEX_TEST_BITBUCKET_TOKEN", "secret") };
        let client = BitbucketClient::with_origin(
            &json!({"kind": "bitbucket", "tokenEnvironment": "SUPLEX_TEST_BITBUCKET_TOKEN"}),
            &origin,
        );
        let open = client
            .list_open_pull_requests("team/repo", 5)
            .await
            .unwrap();
        assert_eq!(
            open.iter().map(|row| row.number).collect::<Vec<_>>(),
            [1, 2]
        );
        let observed = client
            .observe_pull_request("team/repo", "feature", Some(1))
            .await
            .unwrap();
        assert_eq!(
            (
                observed.exists,
                observed.checks.total,
                observed.checks.successful,
                observed.checks.failing,
                observed.checks.pending
            ),
            (true, 3, 1, 1, 1)
        );
        assert_eq!(
            client
                .get_branch_head("team/repo", "missing")
                .await
                .unwrap(),
            None
        );
        let denied = client.check_authentication().await.unwrap_err();
        assert_eq!(
            denied
                .downcast_ref::<GithubFailure>()
                .map(|failure| failure.code),
            Some("authentication-required")
        );
        let unavailable = client.get_pull_request("team/repo", 9).await.unwrap_err();
        assert_eq!(
            unavailable
                .downcast_ref::<GithubFailure>()
                .map(|failure| failure.code),
            Some("provider-unavailable")
        );
        assert!(
            requests
                .lock()
                .unwrap()
                .iter()
                .all(|line| line.ends_with("Bearer secret"))
        );
        let allow: BeforeWrite<'_> = &|| Box::pin(async { Ok(()) });
        assert!(
            client
                .upload("team/repo", "../escape", b"x", "image/png", allow)
                .await
                .is_err()
        );
        server.abort();
    }

    #[tokio::test]
    async fn release_port_maps_delivery_calls_to_bitbucket_and_stops_at_drafts() {
        let created = Arc::new(Mutex::new(None::<Value>));
        let log = created.clone();
        let app = Router::new().fallback(
            move |method: axum::http::Method,
                  OriginalUri(uri): OriginalUri,
                  body: axum::body::Bytes| {
                let log = log.clone();
                async move {
                    let path = uri.path_and_query().unwrap().as_str().to_owned();
                    if method == axum::http::Method::POST
                        && path == "/2.0/repositories/team/repo/pullrequests"
                    {
                        *log.lock().unwrap() = serde_json::from_slice(&body).ok();
                        return Json(bitbucket_pull(4, "OPEN")).into_response();
                    }
                    if path.starts_with("/2.0/repositories/team/repo/pullrequests?pagelen=50") {
                        let mut other = bitbucket_pull(2, "OPEN");
                        other["destination"]["branch"]["name"] = json!("release");
                        return Json(json!({"values": [bitbucket_pull(1, "OPEN"), other]}))
                            .into_response();
                    }
                    StatusCode::NOT_FOUND.into_response()
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // SAFETY: test-only credential variable with a name unique to this test.
        unsafe { std::env::set_var("SUPLEX_TEST_BITBUCKET_PORT_TOKEN", "secret") };
        let connection =
            json!({"kind": "bitbucket", "tokenEnvironment": "SUPLEX_TEST_BITBUCKET_PORT_TOKEN"});
        assert!(ReleasePort::bitbucket(&json!({"kind": "github"})).is_none());
        assert!(ReleasePort::bitbucket(&connection).is_some());
        let port = ReleasePort::Bitbucket(BitbucketClient::with_origin(&connection, &origin));
        assert!(port.github().is_none() && port.token().is_none());
        let pull = port
            .create_draft_pull_request("team/repo", "feature", "main", "Title", "Body")
            .await
            .unwrap();
        assert_eq!(pull.number, 4);
        let request = created.lock().unwrap().clone().unwrap();
        assert_eq!(
            (
                &request["source"]["branch"]["name"],
                &request["destination"]["branch"]["name"],
                &request["title"],
                &request["description"],
                &request["draft"]
            ),
            (
                &json!("feature"),
                &json!("main"),
                &json!("Title"),
                &json!("Body"),
                &json!(true)
            )
        );
        let listed = port
            .list_pull_requests("team/repo", "feature", "main")
            .await
            .unwrap();
        assert_eq!(
            listed.iter().map(|pull| pull.number).collect::<Vec<_>>(),
            [1]
        );
        let refused = port
            .mark_ready_for_review("team/repo", 4)
            .await
            .unwrap_err();
        assert_eq!(
            refused.to_string(),
            "Bitbucket delivery supports draft pull requests only"
        );
        assert!(
            port.merge_conditionally("team/repo", 4, &"a".repeat(40), true)
                .await
                .is_err()
        );
        server.abort();
    }
}
