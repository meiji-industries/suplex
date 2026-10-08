//! Linear issues through the Linear GraphQL API, scoped to one team.

use super::*;
use crate::{integrations::provider_http, shared::hash::sha256_hex};
use serde_json::{Value, json};

const API: &str = "https://api.linear.app/graphql";
const UPLOAD_ORIGIN: &str = "https://uploads.linear.app";
const ISSUE_FIELDS: &str = "id identifier title url description team { key } state { name } priorityLabel labels { nodes { name } } assignee { name } project { name }";

fn field(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn graph_error(errors: &[Value]) -> Box<dyn Error + Send + Sync> {
    let mut kinds = String::new();
    let mut status_code = None;
    let mut messages = Vec::new();
    for error in errors {
        let extensions = &error["extensions"];
        kinds.push_str(&format!(
            "{} {} ",
            extensions["code"].as_str().unwrap_or_default(),
            extensions["type"].as_str().unwrap_or_default()
        ));
        status_code = status_code.or_else(|| extensions["statusCode"].as_u64());
        messages.push(error["message"].as_str().unwrap_or_default().to_owned());
    }
    let message = messages.join("; ");
    let (kinds, lower) = (kinds.to_lowercase(), message.to_lowercase());
    let status = if kinds.contains("authentication")
        || lower.contains("not authenticated")
        || lower.contains("unauthorized")
    {
        Some(401)
    } else if kinds.contains("forbidden")
        || kinds.contains("permission")
        || lower.contains("forbidden")
        || lower.contains("permission")
    {
        Some(403)
    } else if kinds.contains("not_found")
        || kinds.contains("not found")
        || lower.contains("not found")
    {
        Some(404)
    } else {
        status_code.and_then(|code| u16::try_from(code).ok())
    };
    match status {
        Some(status) => Box::new(ProviderHttpFailure { status }),
        None => format!("Linear returned a GraphQL error: {message}").into(),
    }
}

pub struct LinearTracker {
    team: String,
    token_environment: String,
    http: reqwest::Client,
    api: url::Url,
    upload_origin: String,
    secure_upload: bool,
}

impl LinearTracker {
    pub(super) fn new(connection: &Value) -> Self {
        let connection: super::Connection =
            serde_json::from_value(connection.clone()).unwrap_or_default();
        Self {
            team: connection.team,
            token_environment: connection.token_environment,
            http: provider_http::client(),
            api: url::Url::parse(API).expect("Linear API URL"),
            upload_origin: UPLOAD_ORIGIN.into(),
            secure_upload: true,
        }
    }

    #[cfg(test)]
    fn for_test(team: &str, token_environment: &str, base: &str) -> Self {
        Self {
            team: team.into(),
            token_environment: token_environment.into(),
            http: provider_http::client(),
            api: url::Url::parse(&format!("{base}/graphql")).unwrap(),
            upload_origin: base.into(),
            secure_upload: false,
        }
    }

    async fn graph(&self, query: &str, variables: Value) -> TrackerResult<Value> {
        let authorization = environment_credential(&self.token_environment)?;
        let response = self
            .http
            .post(self.api.clone())
            .header("Accept", "application/json")
            .header("Authorization", authorization)
            .header("Content-Type", "application/json")
            .body(json!({"query": query, "variables": variables}).to_string())
            .send()
            .await?;
        let status = response.status();
        let bytes = provider_http::bounded_body(response, provider_http::MAXIMUM_BYTES).await?;
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if let Some(errors) = body["errors"]
            .as_array()
            .filter(|errors| !errors.is_empty())
        {
            return Err(graph_error(errors));
        }
        if !status.is_success() {
            return Err(Box::new(ProviderHttpFailure {
                status: status.as_u16(),
            }));
        }
        Ok(body["data"].clone())
    }

    fn in_scope(&self, issue: &Value) -> TrackerResult<()> {
        let key = issue["key"].as_str().unwrap_or_default();
        if issue["kind"] == "linear"
            && issue["team"] == self.team.as_str()
            && key.starts_with(&format!("{}-", self.team))
        {
            Ok(())
        } else {
            Err(Box::new(IssueTrackerScopeFailure))
        }
    }

    fn association(&self, row: &Value) -> TrackerResult<Value> {
        let association = json!({"kind":"linear", "team":field(row,"/team/key"), "id":field(row,"/id"), "key":field(row,"/identifier"), "title":field(row,"/title"), "url":field(row,"/url")});
        self.in_scope(&association)?;
        Ok(association)
    }

    async fn issue_by_id(&self, id: &str) -> TrackerResult<(Value, Value)> {
        let data = self
            .graph(
                &format!("query Issue($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} }} }}"),
                json!({"id":id}),
            )
            .await?;
        let row = data["issue"].clone();
        if !row.is_object() {
            return Err(Box::new(ProviderHttpFailure { status: 404 }));
        }
        let association = self.association(&row)?;
        Ok((row, association))
    }

    pub async fn search(&self, query: &str) -> TrackerResult<Vec<Value>> {
        let text = query.trim().chars().take(200).collect::<String>();
        let upper = text.to_uppercase();
        let is_key = upper
            .strip_prefix(&format!("{}-", self.team))
            .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()));
        if is_key {
            return Ok(vec![self.issue_by_id(&upper).await?.1]);
        }
        let (declaration, filter) = if text.is_empty() {
            ("", "")
        } else {
            (
                ", $query: String!",
                ", or: [{ title: { containsIgnoreCase: $query } }, { description: { containsIgnoreCase: $query } }]",
            )
        };
        let mut variables = json!({"teamKey":self.team});
        if !text.is_empty() {
            variables["query"] = json!(text);
        }
        let data = self.graph(&format!("query Search($teamKey: String!{declaration}) {{ teams(filter: {{ key: {{ eq: $teamKey }} }}) {{ nodes {{ key }} }} issues(first: 30, orderBy: updatedAt, filter: {{ team: {{ key: {{ eq: $teamKey }} }}{filter} }}) {{ nodes {{ id identifier title url team {{ key }} }} }} }}"), variables).await?;
        if !data["teams"]["nodes"]
            .as_array()
            .is_some_and(|teams| teams.iter().any(|team| team["key"] == self.team.as_str()))
        {
            return Err(Box::new(IssueTrackerScopeFailure));
        }
        Ok(data["issues"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| field(row, "/team/key") == self.team)
            .filter_map(|row| self.association(row).ok())
            .collect())
    }

    async fn comments(&self, issue_id: &str) -> TrackerResult<Vec<Value>> {
        let mut result = Vec::new();
        let mut after = Value::Null;
        for _ in 0..100 {
            let data = self.graph("query Comments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { id body user { id } } pageInfo { hasNextPage endCursor } } } }", json!({"id":issue_id,"after":after})).await?;
            if !data["issue"].is_object() {
                return Err(Box::new(ProviderHttpFailure { status: 404 }));
            }
            let page = &data["issue"]["comments"];
            result.extend(page["nodes"].as_array().cloned().unwrap_or_default());
            if page["pageInfo"]["hasNextPage"] != true {
                return Ok(result);
            }
            after = page["pageInfo"]["endCursor"].clone();
            if !after.is_string() {
                return Err(fail("Linear returned an incomplete comment page"));
            }
        }
        Err(fail("The issue has more comments than Suplex can load"))
    }

    pub async fn read(&self, issue: &Value) -> TrackerResult<Value> {
        self.in_scope(issue)?;
        let (row, current) = self
            .issue_by_id(issue["id"].as_str().unwrap_or_default())
            .await?;
        let comments = self.comments(&field(&current, "/id")).await?;
        let labels = row
            .pointer("/labels/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|label| label["name"].as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let details = [
            ("State", field(&row, "/state/name")),
            ("Priority", field(&row, "/priorityLabel")),
            ("Labels", labels),
            ("Assignee", field(&row, "/assignee/name")),
            ("Project", field(&row, "/project/name")),
        ]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(n, v)| format!("{n}: {v}"))
        .collect::<Vec<_>>()
        .join("\n");
        let bodies = comments
            .iter()
            .map(|comment| field(comment, "/body"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let text = cap_context(format!(
            "{}: {}\n{}\n\n{}\n\n{details}\n\nComments\n{bodies}",
            field(&current, "/key"),
            field(&current, "/title"),
            field(&current, "/url"),
            field(&row, "/description")
        ));
        Ok(
            json!({"issue":current,"text":text,"capturedAt":crate::shared::time::now_millis_rfc3339()}),
        )
    }

    pub async fn upload(
        &self,
        issue: &Value,
        filename: &str,
        bytes: &[u8],
        mime_type: &str,
        before_write: BeforeWrite<'_>,
    ) -> TrackerResult<String> {
        self.in_scope(issue)?;
        if !valid_evidence_name(filename, &sha256_hex(bytes))
            || bytes.is_empty()
            || bytes.len() > MAX_TASK_IMAGE_BYTES
        {
            return Err(fail("Invalid task evidence attachment"));
        }
        self.issue_by_id(issue["id"].as_str().unwrap_or_default())
            .await?;
        before_write().await?;
        let data = self.graph("mutation Upload($filename: String!, $contentType: String!, $size: Int!) { fileUpload(filename: $filename, contentType: $contentType, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }", json!({"filename":filename,"contentType":mime_type,"size":bytes.len()})).await?;
        let file = &data["fileUpload"]["uploadFile"];
        let parse = |name: &str| {
            url::Url::parse(file[name].as_str().unwrap_or_default())
                .map_err(|_| fail("Linear did not provide an upload URL"))
        };
        let (upload_url, asset_url) = (parse("uploadUrl")?, parse("assetUrl")?);
        let safe_upload = (upload_url.scheme() == "https" || !self.secure_upload)
            && upload_url.username().is_empty()
            && upload_url.password().is_none();
        let safe_asset = asset_url.origin().ascii_serialization() == self.upload_origin
            && asset_url.username().is_empty()
            && asset_url.password().is_none();
        if !safe_upload || !safe_asset {
            return Err(fail("Linear returned an unsafe evidence URL"));
        }
        let mut request = self.http.put(upload_url);
        for header in file["headers"].as_array().into_iter().flatten() {
            if let (Some(key), Some(value)) = (header["key"].as_str(), header["value"].as_str())
                && !key.eq_ignore_ascii_case("authorization")
            {
                request = request.header(key, value);
            }
        }
        let response = request
            .header("Content-Type", mime_type)
            .header("Cache-Control", "public, max-age=31536000")
            .body(bytes.to_vec())
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(Box::new(ProviderHttpFailure {
                status: response.status().as_u16(),
            }));
        }
        Ok(asset_url.to_string())
    }

    pub async fn publish(
        &self,
        issue: &Value,
        task_id: &str,
        body: &str,
        before_write: BeforeWrite<'_>,
        known_comment_id: Option<&str>,
    ) -> TrackerResult<String> {
        self.in_scope(issue)?;
        let issue_id = issue["id"].as_str().unwrap_or_default();
        let marker = evidence_marker(task_id);
        let viewer_data = self
            .graph("query Viewer { viewer { id } }", json!({}))
            .await?;
        let viewer = field(&viewer_data, "/viewer/id");
        if viewer.is_empty() {
            return Err(fail("Linear account is malformed"));
        }
        let text = format!("{body}\n\n{marker}");
        let owned = self
            .comments(issue_id)
            .await?
            .into_iter()
            .filter(|comment| field(comment, "/user/id") == viewer)
            .collect::<Vec<_>>();
        let existing = owned
            .iter()
            .find(|comment| Some(field(comment, "/id").as_str()) == known_comment_id)
            .or_else(|| {
                owned.iter().find(|comment| {
                    let value = field(comment, "/body");
                    value == text || is_complete_evidence_comment(&value, &marker)
                })
            });
        if let Some(existing) = existing
            && field(existing, "/body") == text
        {
            return Ok(field(existing, "/id"));
        }
        let existing = existing.map(|comment| field(comment, "/id"));
        self.issue_by_id(issue_id).await?;
        before_write().await?;
        let written = match &existing {
            Some(id) => {
                let data=self.graph("mutation Update($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { comment { id body user { id } } } }",json!({"id":id,"body":text})).await?;
                data["commentUpdate"]["comment"]["id"].clone()
            }
            None => {
                let data=self.graph("mutation Create($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { comment { id body user { id } } } }",json!({"issueId":issue_id,"body":text})).await?;
                data["commentCreate"]["comment"]["id"].clone()
            }
        };
        let id = written
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| fail("Linear did not create the evidence comment"))?;
        let source = text
            .lines()
            .find(|line| line.starts_with("Source: "))
            .map(str::to_owned);
        let confirmed = self
            .comments(issue_id)
            .await?
            .into_iter()
            .find(|comment| field(comment, "/id") == id && field(comment, "/user/id") == viewer)
            .is_some_and(|comment| {
                let value = field(&comment, "/body");
                value == text
                    || (is_complete_evidence_comment(&value, &marker)
                        && source
                            .as_ref()
                            .is_some_and(|source| value.lines().any(|line| line == source)))
            });
        if !confirmed {
            return Err(fail(
                "The tracker has not confirmed the issue evidence comment",
            ));
        }
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    type Log = Arc<Mutex<Vec<(String, Option<String>, Value)>>>;
    const ID: &str = "11111111-1111-4111-8111-111111111111";

    async fn fake_linear(
        reply: impl Fn(&str, &Value) -> (u16, Value) + Send + Sync + 'static,
    ) -> (String, Log, tokio::task::JoinHandle<()>) {
        let log: Log = Arc::default();
        let reply = Arc::new(reply);
        let app = axum::Router::new().fallback({
            let log = log.clone();
            move |uri: axum::http::Uri, headers: axum::http::HeaderMap, bytes: axum::body::Bytes| {
                let (log, reply) = (log.clone(), reply.clone());
                async move {
                    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                    let authorization = headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    log.lock()
                        .unwrap()
                        .push((uri.path().to_owned(), authorization, body.clone()));
                    let (status, value) = reply(uri.path(), &body);
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        value.to_string(),
                    )
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        (
            base,
            log,
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
        )
    }
    fn node(team: &str) -> Value {
        json!({"id":ID,"identifier":format!("{team}-12"),"title":"Fix","url":format!("https://linear.app/acme/issue/{team}-12/fix"),"description":null,"team":{"key":team}})
    }
    fn issue() -> Value {
        json!({"kind":"linear","team":"ENG","id":ID,"key":"ENG-12","title":"Fix","url":"https://linear.app/acme/issue/ENG-12/fix"})
    }
    fn tracker(base: &str) -> LinearTracker {
        unsafe { std::env::set_var("SUPLEX_TEST_LINEAR", "lin_api_secret") };
        LinearTracker::for_test("ENG", "SUPLEX_TEST_LINEAR", base)
    }

    #[tokio::test]
    async fn search_scopes_team_and_text_and_exact_key_loads_by_identifier() {
        let (base, log, server) = fake_linear(|_, body| {
            let query = body["query"].as_str().unwrap_or_default();
            if query.contains("query Issue") { (200, json!({"data":{"issue":node("ENG")}})) }
            else { (200, json!({"data":{"teams":{"nodes":[{"key":"ENG"}]},"issues":{"nodes":[node("ENG")]}}})) }
        }).await;
        let tracker = tracker(&base);
        assert_eq!(tracker.search("fix this").await.unwrap().len(), 1);
        let first = log.lock().unwrap()[0].clone();
        assert!(
            first.2["query"]
                .as_str()
                .unwrap()
                .contains("team: { key: { eq: $teamKey } }")
        );
        assert!(
            first.2["query"]
                .as_str()
                .unwrap()
                .contains("containsIgnoreCase")
        );
        assert_eq!(first.1.as_deref(), Some("lin_api_secret"));
        assert_eq!(
            first.2["variables"],
            json!({"teamKey":"ENG","query":"fix this"})
        );
        assert_eq!(tracker.search("eng-12").await.unwrap()[0]["key"], "ENG-12");
        assert_eq!(log.lock().unwrap()[1].2["variables"]["id"], "ENG-12");
        tracker.search("   ").await.unwrap();
        let empty = log.lock().unwrap().last().unwrap().2.clone();
        assert_eq!(empty["variables"], json!({"teamKey":"ENG"}));
        assert!(
            !empty["query"]
                .as_str()
                .unwrap()
                .contains("containsIgnoreCase")
        );
        server.abort();
    }

    #[tokio::test]
    async fn foreign_issue_is_refused_without_request_and_null_is_not_found() {
        let (base, log, server) = fake_linear(|_, _| (200, json!({"data":{"issue":null}}))).await;
        let tracker = tracker(&base);
        let foreign = json!({"kind":"linear","team":"OPS","id":ID,"key":"OPS-12"});
        assert!(
            tracker
                .read(&foreign)
                .await
                .unwrap_err()
                .downcast_ref::<IssueTrackerScopeFailure>()
                .is_some()
        );
        assert!(log.lock().unwrap().is_empty());
        let error = tracker.search("ENG-12").await.unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<ProviderHttpFailure>()
                .map(|failure| failure.status),
            Some(404)
        );
        server.abort();
    }

    #[tokio::test]
    async fn graph_error_maps_authentication_response() {
        let (base, _, server) = fake_linear(|_, _| (400, json!({"errors":[{"message":"Authentication required","extensions":{"code":"AUTHENTICATION_ERROR"}}]}))).await;
        let error = tracker(&base).search("x").await.unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<ProviderHttpFailure>()
                .map(|failure| failure.status),
            Some(401)
        );
        server.abort();
    }

    #[tokio::test]
    async fn read_paginates_comments() {
        let calls = Arc::new(Mutex::new(0usize));
        let page_calls = calls.clone();
        let (base, _, server) = fake_linear(move |_, body| {
            let query = body["query"].as_str().unwrap_or_default();
            if query.contains("query Issue") { (200, json!({"data":{"issue": {"id":ID,"identifier":"ENG-12","title":"Fix","url":"https://linear.app/acme/issue/ENG-12/fix","description":null,"team":{"key":"ENG"},"state":{"name":"Open"},"labels":{"nodes":[]},"assignee":null,"project":null}}})) }
            else { let mut call=page_calls.lock().unwrap(); *call+=1; if *call==1 { (200,json!({"data":{"issue":{"comments":{"nodes":[{"id":"1","body":"first","user":{"id":"u"}}],"pageInfo":{"hasNextPage":true,"endCursor":"next"}}}}})) } else { (200,json!({"data":{"issue":{"comments":{"nodes":[{"id":"2","body":"second","user":{"id":"u"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}})) } }
        }).await;
        let read = tracker(&base).read(&issue()).await.unwrap();
        assert!(read["text"].as_str().unwrap().contains("first\n\nsecond"));
        assert!(!read["text"].as_str().unwrap().contains("null"));
        server.abort();
    }

    #[tokio::test]
    async fn upload_uses_signed_url_without_api_authorization_and_rejects_bad_asset() {
        let origin = Arc::new(Mutex::new(String::new()));
        let reply_origin = origin.clone();
        let (base, log, server) = fake_linear(move |path, body| {
            if path == "/storage/put" { return (200,json!({})); }
            let query=body["query"].as_str().unwrap_or_default();
            if query.contains("query Issue") { (200,json!({"data":{"issue":node("ENG")}})) }
            else { let base=reply_origin.lock().unwrap().clone(); (200,json!({"data":{"fileUpload":{"uploadFile":{"uploadUrl":format!("{base}/storage/put"),"assetUrl":format!("{base}/asset/1"),"headers":[]}}}})) }
        }).await;
        *origin.lock().unwrap() = base.clone();
        let bytes = b"png";
        let filename = format!("suplex-proof-{}.png", sha256_hex(bytes));
        let allow = || -> std::pin::Pin<Box<dyn Future<Output = TrackerResult<()>> + Send>> {
            Box::pin(async { Ok(()) })
        };
        assert_eq!(
            tracker(&base)
                .upload(&issue(), &filename, bytes, "image/png", &allow)
                .await
                .unwrap(),
            format!("{base}/asset/1")
        );
        assert_eq!(
            log.lock()
                .unwrap()
                .iter()
                .find(|row| row.0 == "/storage/put")
                .unwrap()
                .1,
            None
        );
        server.abort();
    }

    #[tokio::test]
    async fn upload_refuses_foreign_asset_before_put() {
        let origin = Arc::new(Mutex::new(String::new()));
        let reply_origin = origin.clone();
        let (base, log, server) = fake_linear(move |path, body| {
            assert_ne!(path, "/storage/put");
            let query = body["query"].as_str().unwrap_or_default();
            if query.contains("query Issue") {
                (200, json!({"data":{"issue":node("ENG")}}))
            } else {
                let base = reply_origin.lock().unwrap().clone();
                (200, json!({"data":{"fileUpload":{"uploadFile":{"uploadUrl":format!("{base}/storage/put"),"assetUrl":"https://evil.example/asset","headers":[]}}}}))
            }
        }).await;
        *origin.lock().unwrap() = base.clone();
        let bytes = b"png";
        let filename = format!("suplex-proof-{}.png", sha256_hex(bytes));
        let allow = || -> std::pin::Pin<Box<dyn Future<Output = TrackerResult<()>> + Send>> {
            Box::pin(async { Ok(()) })
        };
        assert_eq!(
            tracker(&base)
                .upload(&issue(), &filename, bytes, "image/png", &allow)
                .await
                .unwrap_err()
                .to_string(),
            "Linear returned an unsafe evidence URL"
        );
        assert!(
            !log.lock()
                .unwrap()
                .iter()
                .any(|row| row.0 == "/storage/put")
        );
        server.abort();
    }

    #[tokio::test]
    async fn publish_updates_owned_evidence_and_requires_confirmed_source() {
        let comment_calls = Arc::new(Mutex::new(0usize));
        let comment_reply = comment_calls.clone();
        let body = "## What changed\n\nX\n\nSource: 0123456789012345678901234567890123456789\n\n## Before\n\nB\n\n## After\n\nA\n\n## How to verify\n\n- step";
        let expected = format!("{body}\n\n[Suplex task task_one]");
        let expected_reply = expected.clone();
        let (base, log, server) = fake_linear(move |_, request| {
            let query=request["query"].as_str().unwrap_or_default();
            if query.contains("query Viewer") { (200,json!({"data":{"viewer":{"id":"me"}}})) }
            else if query.contains("query Issue") { (200,json!({"data":{"issue":node("ENG")}})) }
            else if query.contains("mutation Update") { (200,json!({"data":{"commentUpdate":{"comment":{"id":"old"}}}})) }
            else if query.contains("query Comments") { let mut count=comment_reply.lock().unwrap(); *count+=1; let comment=if *count==1 { json!({"id":"old","body":"## What changed\n\nX\n\nSource: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\n## Before\n\nB\n\n## After\n\nA\n\n## How to verify\n\n- step\n\n[Suplex task task_one]","user":{"id":"me"}}) } else { json!({"id":"old","body":expected_reply,"user":{"id":"me"}}) }; (200,json!({"data":{"issue":{"comments":{"nodes":[comment],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}})) }
            else { panic!("unexpected query {query}") }
        }).await;
        let allow = || -> std::pin::Pin<Box<dyn Future<Output = TrackerResult<()>> + Send>> {
            Box::pin(async { Ok(()) })
        };
        assert_eq!(
            tracker(&base)
                .publish(&issue(), "task_one", body, &allow, None)
                .await
                .unwrap(),
            "old"
        );
        let queries = log
            .lock()
            .unwrap()
            .iter()
            .map(|row| row.2["query"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert!(
            queries
                .iter()
                .any(|query| query.contains("mutation Update"))
        );
        assert!(
            !queries
                .iter()
                .any(|query| query.contains("mutation Create"))
        );
        server.abort();
    }

    #[tokio::test]
    async fn foreign_marker_creates_a_new_comment() {
        let calls = Arc::new(Mutex::new(0usize));
        let reply_calls = calls.clone();
        let body = "## What changed\n\nX\n\nSource: 0123456789012345678901234567890123456789\n\n## Before\n\nB\n\n## After\n\nA\n\n## How to verify\n\n- step";
        let expected = format!("{body}\n\n[Suplex task task_one]");
        let expected_reply = expected.clone();
        let (base, log, server) = fake_linear(move |_, request| {
            let query = request["query"].as_str().unwrap_or_default();
            if query.contains("query Viewer") { (200, json!({"data":{"viewer":{"id":"me"}}})) }
            else if query.contains("query Issue") { (200, json!({"data":{"issue":node("ENG")}})) }
            else if query.contains("mutation Create") { (200, json!({"data":{"commentCreate":{"comment":{"id":"new"}}}})) }
            else if query.contains("query Comments") { let mut count=reply_calls.lock().unwrap(); *count+=1; let comment=if *count==1 { json!({"id":"foreign","body":expected_reply,"user":{"id":"someone-else"}}) } else { json!({"id":"new","body":expected_reply,"user":{"id":"me"}}) }; (200,json!({"data":{"issue":{"comments":{"nodes":[comment],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}})) }
            else { panic!("unexpected query {query}") }
        }).await;
        let allow = || -> std::pin::Pin<Box<dyn Future<Output = TrackerResult<()>> + Send>> {
            Box::pin(async { Ok(()) })
        };
        assert_eq!(
            tracker(&base)
                .publish(&issue(), "task_one", body, &allow, None)
                .await
                .unwrap(),
            "new"
        );
        let queries = log
            .lock()
            .unwrap()
            .iter()
            .map(|row| row.2["query"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert!(
            queries
                .iter()
                .any(|query| query.contains("mutation Create"))
        );
        assert!(
            !queries
                .iter()
                .any(|query| query.contains("mutation Update"))
        );
        server.abort();
    }

    #[tokio::test]
    async fn stale_confirmation_is_refused_and_normalized_markdown_is_accepted() {
        for normalized in [false, true] {
            let calls = Arc::new(Mutex::new(0usize));
            let reply_calls = calls.clone();
            let body = "## What changed\n\nX\n\nSource: 0123456789012345678901234567890123456789\n\n## Before\n\nB\n\n## After\n\nA\n\n## How to verify\n\n- step";
            let old = "## What changed\n\nX\n\nSource: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\n## Before\n\nB\n\n## After\n\nA\n\n## How to verify\n\n- step\n\n[Suplex task task_one]";
            let fresh = format!(
                "{}\n\n[Suplex task task_one]",
                body.replace("- step", "* step")
            );
            let (base, _, server) = fake_linear(move |_, request| {
                let query=request["query"].as_str().unwrap_or_default();
                if query.contains("query Viewer") { (200,json!({"data":{"viewer":{"id":"me"}}})) }
                else if query.contains("query Issue") { (200,json!({"data":{"issue":node("ENG")}})) }
                else if query.contains("mutation Update") { (200,json!({"data":{"commentUpdate":{"comment":{"id":"old"}}}})) }
                else if query.contains("query Comments") { let mut count=reply_calls.lock().unwrap(); *count+=1; let value=if *count==1 || !normalized { old } else { fresh.as_str() }; (200,json!({"data":{"issue":{"comments":{"nodes":[{"id":"old","body":value,"user":{"id":"me"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}})) }
                else { panic!("unexpected query {query}") }
            }).await;
            let allow = || -> std::pin::Pin<Box<dyn Future<Output = TrackerResult<()>> + Send>> {
                Box::pin(async { Ok(()) })
            };
            let result = tracker(&base)
                .publish(&issue(), "task_one", body, &allow, None)
                .await;
            if normalized {
                assert_eq!(result.unwrap(), "old");
            } else {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("has not confirmed")
                );
            }
            server.abort();
        }
    }
}
