//! Local or custom OpenAI-compatible endpoints, such as llama-server, MLX, or
//! Ollama. Each endpoint names one model. Its id is also the native provider
//! id that OpenCode, Pi, and OMP receive, so the Suplex model id is
//! `<endpoint id>/<model id>`. The API key stays in the database and in the
//! runtime configuration; no response, log, or task record holds it.

use crate::identity::IdentityError;
use crate::shared::time::now_millis_rfc3339;
use std::{error::Error, fmt, path::Path, time::Duration};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::platform::database::{DatabaseResult, OpenMode, SuplexDatabase};

/// Every endpoint id, and so every endpoint provider id, starts with this.
pub const ID_PREFIX: &str = "local-";
/// The longest model id that still makes a valid profile model.
const MODEL_ID_MAX: usize = 200;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_MAXIMUM_BYTES: usize = 4 * 1024 * 1024;

const SELECTION: &str = "SELECT id, label, base_url, api_key, model_id, created_at, updated_at FROM suplex_local_endpoints";

/// One stored endpoint. `Debug` hides the API key.
#[derive(Clone, PartialEq, Eq)]
pub struct LocalEndpoint {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model_id: String,
    pub created_at: String,
    pub updated_at: String,
}

impl fmt::Debug for LocalEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalEndpoint")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<hidden>"))
            .field("model_id", &self.model_id)
            .finish_non_exhaustive()
    }
}

impl LocalEndpoint {
    /// The Suplex model id that a profile selects.
    pub fn model(&self) -> String {
        format!("{}/{}", self.id, self.model_id)
    }

    pub fn response(&self) -> LocalEndpointResponse {
        LocalEndpointResponse {
            id: self.id.clone(),
            label: self.label.clone(),
            base_url: self.base_url.clone(),
            model_id: self.model_id.clone(),
            has_api_key: self.api_key.is_some(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// A saved endpoint without its API key.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalEndpointResponse {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub model_id: String,
    pub has_api_key: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct LocalEndpointListResponse {
    pub endpoints: Vec<LocalEndpointResponse>,
}

crate::shared::wire_enum! {
    /// What `GET {baseUrl}/models` showed.
    pub enum LocalEndpointTestStatus {
        Reachable = "reachable",
        ModelListed = "model-listed",
        Error = "error",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct LocalEndpointTestResponse {
    pub status: LocalEndpointTestStatus,
    pub summary: String,
    /// The model ids the endpoint lists, when it lists any.
    pub models: Vec<String>,
}

/// A validated create request.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEndpointInput {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model_id: String,
    pub label: Option<String>,
}

fn failure(message: &'static str, status_code: u16) -> Box<dyn Error + Send + Sync> {
    IdentityError::auth(message, status_code, "auth_failure").into()
}

/// The base URL without a trailing slash, when it is an HTTP or HTTPS URL.
pub fn normalize_base_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed).ok()?;
    (matches!(parsed.scheme(), "http" | "https") && parsed.host().is_some())
        .then(|| trimmed.to_owned())
}

/// The same characters that a profile model id accepts.
pub fn valid_model_id(model_id: &str) -> bool {
    let mut chars = model_id.chars();
    model_id.len() <= MODEL_ID_MAX
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'))
}

/// "Local endpoint" and the host and port of the base URL.
pub fn default_label(base_url: &str) -> String {
    let address = url::Url::parse(base_url).ok().and_then(|parsed| {
        let host = parsed.host_str()?.to_owned();
        Some(match parsed.port_or_known_default() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        })
    });
    match address {
        Some(address) => format!("Local endpoint {address}"),
        None => "Local endpoint".to_owned(),
    }
}

fn endpoint(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalEndpoint> {
    Ok(LocalEndpoint {
        id: row.get(0)?,
        label: row.get(1)?,
        base_url: row.get(2)?,
        api_key: row.get(3)?,
        model_id: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub fn list(database: &SuplexDatabase) -> DatabaseResult<Vec<LocalEndpoint>> {
    let mut statement = database
        .connection()
        .prepare(&format!("{SELECTION} ORDER BY label COLLATE NOCASE, id"))?;
    Ok(statement
        .query_map([], endpoint)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(database: &SuplexDatabase, id: &str) -> DatabaseResult<Option<LocalEndpoint>> {
    Ok(database
        .connection()
        .query_row(&format!("{SELECTION} WHERE id = ?1"), [id], endpoint)
        .optional()?)
}

pub fn create(
    database: &mut SuplexDatabase,
    input: &LocalEndpointInput,
) -> DatabaseResult<LocalEndpoint> {
    let base_url = normalize_base_url(&input.base_url)
        .ok_or_else(|| failure("Write a base URL that starts with http:// or https://", 422))?;
    let model_id = input.model_id.trim();
    if !valid_model_id(model_id) {
        return Err(failure(
            "Write the model id with only letters, digits, and the characters . _ : / -",
            422,
        ));
    }
    let label = input
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map_or_else(|| default_label(&base_url), str::to_owned);
    let api_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    let id = format!(
        "{ID_PREFIX}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let now = now_millis_rfc3339();
    database.transaction(true, |database| {
        database.connection().execute(
            "INSERT INTO suplex_local_endpoints (id, label, base_url, api_key, model_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, label, base_url, api_key, model_id, now],
        )?;
        Ok(())
    })?;
    get(database, &id)?.ok_or_else(|| failure("Not found", 404))
}

/// An agent profile that still selects the endpoint keeps it.
pub fn delete(database: &mut SuplexDatabase, id: &str) -> DatabaseResult<()> {
    if get(database, id)?.is_none() {
        return Err(failure("Not found", 404));
    }
    database.transaction(true, |database| {
        let referenced: bool = database.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM suplex_profiles WHERE archived_at IS NULL AND substr(model, 1, length(?1) + 1) = ?1 || '/')",
            [id],
            |row| row.get(0),
        )?;
        if referenced {
            return Err(failure(
                "An agent uses this endpoint. Select another model for that agent first",
                409,
            ));
        }
        database
            .connection()
            .execute("DELETE FROM suplex_local_endpoints WHERE id = ?1", [id])?;
        Ok(())
    })
}

/// The endpoint id in a Suplex model id such as `local-1a2b/qwen3`.
pub fn endpoint_id(model: &str) -> Option<&str> {
    model
        .split_once('/')
        .map(|(provider, _)| provider)
        .filter(|provider| provider.starts_with(ID_PREFIX))
}

/// The endpoint that a profile model selects, read from the task database.
/// `None` for a model of any other provider.
pub fn for_model(database_path: &Path, model: &str) -> DatabaseResult<Option<LocalEndpoint>> {
    let Some(id) = endpoint_id(model) else {
        return Ok(None);
    };
    let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
    let found = get(&database, id)?;
    match found {
        Some(found) if found.model() == model => Ok(Some(found)),
        Some(_) => Err("The model of this local endpoint changed. Select the model again.".into()),
        None => Err("This local endpoint was deleted. Select another model for the agent.".into()),
    }
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ListedModel>,
}

#[derive(Deserialize)]
struct ListedModel {
    id: String,
}

fn test_result(
    status: LocalEndpointTestStatus,
    summary: String,
    models: Vec<String>,
) -> LocalEndpointTestResponse {
    LocalEndpointTestResponse {
        status,
        summary,
        models,
    }
}

/// Classifies one `GET {baseUrl}/models` answer.
pub fn classify(status: u16, body: &[u8], model_id: &str) -> LocalEndpointTestResponse {
    match status {
        200..=299 => {}
        401 | 403 => {
            return test_result(
                LocalEndpointTestStatus::Error,
                format!("The endpoint refused the request (HTTP {status}). Check the API key."),
                Vec::new(),
            );
        }
        404 => {
            return test_result(
                LocalEndpointTestStatus::Error,
                "The endpoint has no /models path (HTTP 404). Check the base URL. It usually ends with /v1.".to_owned(),
                Vec::new(),
            );
        }
        _ => {
            return test_result(
                LocalEndpointTestStatus::Error,
                format!("The endpoint returned HTTP {status}."),
                Vec::new(),
            );
        }
    }
    let Ok(list) = serde_json::from_slice::<ModelList>(body) else {
        return test_result(
            LocalEndpointTestStatus::Reachable,
            "The endpoint is reachable, but Suplex could not read its model list.".to_owned(),
            Vec::new(),
        );
    };
    let models = list
        .data
        .into_iter()
        .map(|model| model.id)
        .collect::<Vec<_>>();
    if models.iter().any(|listed| listed == model_id) {
        test_result(
            LocalEndpointTestStatus::ModelListed,
            format!("The endpoint is reachable and lists {model_id}."),
            models,
        )
    } else {
        test_result(
            LocalEndpointTestStatus::Reachable,
            format!("The endpoint is reachable, but it does not list {model_id}."),
            models,
        )
    }
}

/// `GET {baseUrl}/models` with a short timeout. The summary never holds the
/// API key or the request URL.
pub async fn test(
    base_url: &str,
    api_key: Option<&str>,
    model_id: &str,
) -> LocalEndpointTestResponse {
    let Some(base_url) = normalize_base_url(base_url) else {
        return test_result(
            LocalEndpointTestStatus::Error,
            "Write a base URL that starts with http:// or https://.".to_owned(),
            Vec::new(),
        );
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(PROBE_TIMEOUT)
        .build();
    let Ok(client) = client else {
        return test_result(
            LocalEndpointTestStatus::Error,
            "Suplex could not prepare the request.".to_owned(),
            Vec::new(),
        );
    };
    let mut request = client.get(format!("{base_url}/models"));
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let summary = if error.is_timeout() {
                "The endpoint did not answer in 5 seconds."
            } else if error.is_connect() {
                "Suplex could not connect to the endpoint. Check that the server runs and that the base URL is correct."
            } else {
                "The request to the endpoint failed."
            };
            return test_result(
                LocalEndpointTestStatus::Error,
                summary.to_owned(),
                Vec::new(),
            );
        }
    };
    let status = response.status().as_u16();
    match crate::integrations::provider_http::bounded_body(response, PROBE_MAXIMUM_BYTES).await {
        Ok(body) => classify(status, &body, model_id),
        Err(_) => test_result(
            LocalEndpointTestStatus::Error,
            "Suplex could not read the answer of the endpoint.".to_owned(),
            Vec::new(),
        ),
    }
}

/// The test outcome in the provider sign-in vocabulary.
pub fn connection(test: &LocalEndpointTestResponse) -> Value {
    let status = if test.status == LocalEndpointTestStatus::ModelListed {
        "connected"
    } else {
        "not-connected"
    };
    json!({"status": status, "summary": test.summary})
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn stub(status: u16, body: &'static str) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/v1/models",
            axum::routing::get(move |headers: axum::http::HeaderMap| async move {
                let authorized = headers
                    .get("authorization")
                    .is_none_or(|value| value == "Bearer secret-key");
                let status = if authorized { status } else { 401 };
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    [("content-type", "application/json")],
                    body,
                )
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}/v1"), server)
    }

    #[tokio::test]
    async fn the_test_reports_reachable_model_listed_and_error_in_plain_words() {
        let listed = r#"{"object":"list","data":[{"id":"qwen3-coder"},{"id":"gemma"}]}"#;
        let (base, server) = stub(200, listed).await;
        let found = test(&format!("{base}/"), Some("secret-key"), "qwen3-coder").await;
        assert_eq!(
            found,
            LocalEndpointTestResponse {
                status: LocalEndpointTestStatus::ModelListed,
                summary: "The endpoint is reachable and lists qwen3-coder.".into(),
                models: vec!["qwen3-coder".into(), "gemma".into()],
            }
        );
        assert_eq!(connection(&found)["status"], "connected");
        let missing = test(&base, None, "llama").await;
        assert_eq!(missing.status, LocalEndpointTestStatus::Reachable);
        assert_eq!(
            missing.summary,
            "The endpoint is reachable, but it does not list llama."
        );
        assert_eq!(
            connection(&missing),
            json!({"status":"not-connected","summary":missing.summary})
        );
        let refused = test(&base, Some("wrong-key"), "qwen3-coder").await;
        assert_eq!(refused.status, LocalEndpointTestStatus::Error);
        assert!(refused.summary.contains("Check the API key"));
        assert!(
            !serde_json::to_string(&refused)
                .unwrap()
                .contains("wrong-key")
        );
        server.abort();

        let (base, server) = stub(200, "not json").await;
        assert_eq!(
            test(&base, None, "qwen3-coder").await.summary,
            "The endpoint is reachable, but Suplex could not read its model list."
        );
        server.abort();

        let (base, server) = stub(404, "{}").await;
        assert!(
            test(&base, None, "x")
                .await
                .summary
                .contains("It usually ends with /v1")
        );
        server.abort();

        // Nothing listens on a port that was just released.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let closed = test(
            &format!("http://user:secret-key@127.0.0.1:{port}/v1"),
            Some("secret-key"),
            "x",
        )
        .await;
        assert_eq!(closed.status, LocalEndpointTestStatus::Error);
        assert!(
            closed
                .summary
                .starts_with("Suplex could not connect to the endpoint.")
        );
        assert!(!closed.summary.contains("secret-key"));
        assert_eq!(
            test("ftp://host/v1", None, "x").await.summary,
            "Write a base URL that starts with http:// or https://."
        );
    }

    #[test]
    fn labels_ids_and_models_follow_the_profile_rules() {
        assert_eq!(
            default_label("http://127.0.0.1:8080/v1"),
            "Local endpoint 127.0.0.1:8080"
        );
        assert_eq!(
            default_label("https://models.example.com/v1"),
            "Local endpoint models.example.com:443"
        );
        assert_eq!(
            normalize_base_url(" http://localhost:1234/v1/ "),
            Some("http://localhost:1234/v1".into())
        );
        assert_eq!(normalize_base_url("localhost:1234"), None);
        assert!(valid_model_id("mlx-community/Qwen3-30B-A3B-4bit"));
        assert!(valid_model_id("qwen3:30b"));
        assert!(!valid_model_id("qwen 3"));
        assert!(!valid_model_id(&"a".repeat(201)));
        assert_eq!(
            endpoint_id("local-1a2b3c4d5e6f/mlx/qwen"),
            Some("local-1a2b3c4d5e6f")
        );
        assert_eq!(endpoint_id("anthropic/claude"), None);
        assert_eq!(endpoint_id("local-1a2b"), None);
    }

    #[test]
    fn endpoints_persist_without_exposing_the_key_and_profiles_keep_them() {
        let filename =
            std::env::temp_dir().join(format!("suplex-endpoints-{}.sqlite", uuid::Uuid::new_v4()));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let created = create(
            &mut database,
            &LocalEndpointInput {
                base_url: "http://127.0.0.1:8080/v1/".into(),
                api_key: Some(" secret-key ".into()),
                model_id: " qwen3 ".into(),
                label: None,
            },
        )
        .unwrap();
        assert!(created.id.starts_with(ID_PREFIX));
        assert_eq!(created.id.len(), ID_PREFIX.len() + 12);
        assert_eq!(created.base_url, "http://127.0.0.1:8080/v1");
        assert_eq!(created.api_key.as_deref(), Some("secret-key"));
        assert_eq!(created.label, "Local endpoint 127.0.0.1:8080");
        assert!(!format!("{created:?}").contains("secret-key"));
        let response = serde_json::to_string(&created.response()).unwrap();
        assert!(!response.contains("secret-key"));
        assert!(response.contains("\"hasApiKey\":true"));
        assert_eq!(list(&database).unwrap(), vec![created.clone()]);
        drop(database);
        assert_eq!(
            for_model(&filename, &created.model()).unwrap(),
            Some(created.clone())
        );
        assert_eq!(for_model(&filename, "anthropic/claude").unwrap(), None);
        assert!(for_model(&filename, &format!("{}/other", created.id)).is_err());

        let mut database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        let now = now_millis_rfc3339();
        database.connection().execute(
            "INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('profile_local', 'Local', 'worker', '00000000000000000000000000000000', 'opencode', ?1, 'medium', 'default', ?2, ?2)",
            params![created.model(), now],
        ).unwrap();
        assert!(delete(&mut database, &created.id).is_err());
        database
            .connection()
            .execute(
                "UPDATE suplex_profiles SET archived_at = ?1 WHERE id = 'profile_local'",
                [now],
            )
            .unwrap();
        delete(&mut database, &created.id).unwrap();
        assert!(list(&database).unwrap().is_empty());
        assert!(delete(&mut database, &created.id).is_err());
        drop(database);
        assert!(for_model(&filename, &created.model()).is_err());
        let _ = std::fs::remove_file(filename);
    }
}
