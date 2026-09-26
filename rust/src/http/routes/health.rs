//! Host health uses the installation's live resources. Contextual provider
//! selection is authorized even while provider-specific probes are unported.

use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use axum::{
    Json, Router,
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use garde::Validate;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::http::{AppState, contracts::typed::finding, session, validation};

use super::auth;

pub use crate::platform::health::snapshot;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

#[derive(Default, Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
struct HealthQuery {
    #[garde(inner(length(min = 1)))]
    project_id: Option<String>,
    #[garde(inner(length(min = 1)))]
    profile_ids: Option<String>,
    #[serde(flatten)]
    #[garde(skip)]
    unknown: serde_json::Map<String, Value>,
}

fn query(raw: Option<&str>) -> Result<HealthQuery, Box<Response>> {
    let mut values = serde_json::Map::new();
    let mut duplicate_project = false;
    let mut duplicate_profiles = false;
    for (name, value) in url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        match values.entry(name.into_owned()) {
            serde_json::map::Entry::Vacant(entry) => {
                entry.insert(Value::String(value.into_owned()));
            }
            serde_json::map::Entry::Occupied(entry) => match entry.key().as_str() {
                "projectId" => duplicate_project = true,
                "profileIds" => duplicate_profiles = true,
                _ => (),
            },
        }
    }
    if duplicate_project {
        values.remove("projectId");
    }
    if duplicate_profiles {
        values.remove("profileIds");
    }
    let parsed: HealthQuery = serde_json::from_value(Value::Object(values)).map_err(|_| {
        Box::new(validation::validation_error_public(vec![finding(
            "invalid_type",
            &[],
        )]))
    })?;
    let mut findings = Vec::new();
    if duplicate_project {
        findings.push(finding("invalid_type", &[json!("projectId")]));
    }
    if duplicate_profiles {
        findings.push(finding("invalid_type", &[json!("profileIds")]));
    }
    if let Err(report) = parsed.validate() {
        for (path, _) in report.iter() {
            let field = match path.to_string().as_str() {
                "project_id" | ".project_id" => "projectId",
                "profile_ids" | ".profile_ids" => "profileIds",
                _ => continue,
            };
            findings.push(finding("too_small", &[json!(field)]));
        }
    }
    if !parsed.unknown.is_empty() {
        findings.push(finding("unrecognized_keys", &[]));
    }
    if !findings.is_empty() {
        return Err(Box::new(validation::validation_error_public(findings)));
    }
    Ok(parsed)
}

async fn health(
    State(state): State<AppState>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> Response {
    health_with_github(state, raw_query, headers, None).await
}

async fn health_with_github(
    state: AppState,
    raw_query: Option<String>,
    headers: HeaderMap,
    github_override: Option<Value>,
) -> Response {
    let query = match query(raw_query.as_deref()) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let session = match state.with_database(|database| {
        session::session_user(database, &headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return ApiError::response(error),
    };
    let Some(user) = session.user else {
        return auth::error(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    let providers = match state.with_database(|database| {
        crate::platform::health::provider_context(
            database,
            &user,
            query.project_id.as_deref(),
            query.profile_ids.as_deref(),
        )
    }) {
        Ok(providers) => providers,
        Err(error) => return with_cookies(error.into_response(), session.set_cookies),
    };
    let mut response = Json(snapshot(&state, providers, github_override).await).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// `renderHealthPage` from `platform/ui.ts`: the application shell with the
/// snapshot inlined and a no-script summary.
pub fn health_page(snapshot: &Value) -> String {
    let text = |value: &Value| escape_html(value.as_str().unwrap_or_default());
    let cards = snapshot["checks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|check| {
            format!(
                r#"<article class="health-card" data-status="{}"><h2>{}</h2><p>{}</p></article>"#,
                text(&check["status"]),
                text(&check["label"]),
                text(&check["summary"])
            )
        })
        .collect::<String>();
    let fallback = format!(
        r#"<noscript>
      <main aria-label="Suplex host health">
        <p>Suplex · Host health</p>
        <h1>Host health</h1>
        <p>Reachable at {}</p>
        <p>{}</p>
        <section aria-label="Health checks">{cards}</section>
        <p>Suplex host health requires JavaScript for live refresh.</p>
      </main>
    </noscript>
    <script>window.__SUPLEX_HEALTH__ = {};</script>"#,
        text(&snapshot["reachableAddress"]),
        if snapshot["ready"] == true {
            "Everything is operational"
        } else {
            "Attention needed"
        },
        snapshot.to_string().replace('<', "\\u003c")
    );
    crate::http::ui::application_page("health")
        .replacen(
            r#"<div id="suplex-app"><div class="suplex-boot" role="status" aria-label="Suplex loads the app"><span></span></div></div>"#,
            r#"<div id="suplex-app"></div>"#,
            1,
        )
        .replacen(
            "<noscript>Suplex requires JavaScript for passkey authentication.</noscript>\n    <script>window.__SUPLEX_VIEW__ = \"health\";</script>",
            &fallback,
            1,
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::health::{check, tailscale_hostname};
    use crate::{
        http::session::SessionConfig,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::body::to_bytes;

    #[tokio::test]
    async fn health_query_keeps_public_field_order_for_empty_duplicate_and_unknown_keys() {
        let invalid = match query(Some("projectId=&other=x")) {
            Err(response) => response,
            Ok(_) => panic!("invalid health query was accepted"),
        };
        let body: Value =
            serde_json::from_slice(&to_bytes((*invalid).into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(
            body["findings"],
            json!([
                {"code":"invalid-too_small","field":".projectId","message":"Request value is invalid"},
                {"code":"invalid-unrecognized_keys","field":".","message":"Request value is invalid"},
            ])
        );
        let duplicate = match query(Some("projectId=x&projectId=y&profileIds=")) {
            Err(response) => response,
            Ok(_) => panic!("duplicate health query was accepted"),
        };
        let body: Value =
            serde_json::from_slice(&to_bytes((*duplicate).into_body(), 4096).await.unwrap())
                .unwrap();
        assert_eq!(
            body["findings"],
            json!([
                {"code":"invalid-invalid_type","field":".projectId","message":"Request value is invalid"},
                {"code":"invalid-too_small","field":".profileIds","message":"Request value is invalid"},
            ])
        );
    }

    #[tokio::test]
    async fn health_uses_live_owned_checks_and_authorizes_requested_context() {
        let root = std::env::temp_dir().join(format!("suplex-health-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let database = SuplexDatabase::open(&root.join("test.sqlite"), OpenMode::Migrate).unwrap();
        let state = AppState::new(
            database,
            SessionConfig {
                port: 4113,
                reachable_address: "http://127.0.0.1:4113".into(),
                tailscale_exposure: "off".into(),
            },
        )
        .with_artifact_root(root.join("artifacts"))
        .with_project_roots(root.join("repositories"), root.join("worktrees"));
        state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_environment_settings SET min_free_disk_gb = 0 WHERE id = 'host'",
                    [],
                )
                .unwrap();
        });
        std::fs::create_dir_all(root.join("worktrees")).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:4113".parse().unwrap());
        let fake_github = check(
            "gh-auth",
            "GitHub",
            "warning",
            "Sign in to GitHub",
            json!({"method":"device","source":"none","status":"sign_in_required"}),
        );
        let response = health_with_github(
            state.clone(),
            None,
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 128 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["reachableAddress"], "http://127.0.0.1:4113");
        assert_eq!(body["ready"], true);
        assert_eq!(body["checks"][0]["id"], "database");
        assert_eq!(body["checks"][0]["status"], "healthy");
        assert_eq!(body["checks"][1]["id"], "artifact-root");
        assert_eq!(body["checks"][1]["status"], "healthy");
        assert_eq!(body["checks"][2]["status"], "healthy");
        assert_eq!(body["checks"][3]["id"], "git");
        assert!(
            body["checks"][3]["details"]["version"]
                .as_str()
                .unwrap()
                .starts_with("libgit2 ")
        );
        // Unit tests use a Herdr binary that is never installed.
        assert_eq!(body["checks"][4]["summary"], "Herdr is not installed");
        assert_eq!(body["checks"][5]["details"]["method"], "device");
        state.with_database(|database| {
            database.connection().execute("UPDATE suplex_environment_settings SET min_free_disk_gb = 1024 WHERE id = 'host'", []).unwrap();
        });
        let low = health_with_github(
            state.clone(),
            None,
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        let low: Value =
            serde_json::from_slice(&to_bytes(low.into_body(), 128 * 1024).await.unwrap()).unwrap();
        assert_eq!(low["checks"][2]["status"], "warning");
        assert!(
            regex::Regex::new(r"^Worktree root: \d+\.\d\d GB free; Artifact root: \d+\.\d\d GB free; minimum is 1024\.00 GB$")
                .unwrap()
                .is_match(low["checks"][2]["summary"].as_str().unwrap())
        );
        assert_eq!(
            low["checks"][2]["details"]["minFreeBytes"],
            1_099_511_627_776_u64
        );
        assert_eq!(low["checks"][6]["id"], "backup");
        assert_eq!(low["checks"][6]["summary"], "No backup has been made yet");
        assert_eq!(
            tailscale_hostname(br#"{"Self":{"DNSName":"host.tailnet.ts.net."}}"#).as_deref(),
            Some("host.tailnet.ts.net")
        );
        assert_eq!(
            tailscale_hostname(br#"{"Self":{"DNSName":"host.local."}}"#),
            None
        );
        let unknown = health_with_github(
            state.clone(),
            Some("profileIds=missing".into()),
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        let unknown_project = health_with_github(
            state.clone(),
            Some("projectId=missing".into()),
            headers.clone(),
            Some(fake_github.clone()),
        )
        .await;
        assert_eq!(unknown_project.status(), StatusCode::NOT_FOUND);
        let conflict = health_with_github(
            state.clone(),
            Some("projectId=x&profileIds=y".into()),
            headers.clone(),
            Some(fake_github),
        )
        .await;
        assert_eq!(conflict.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            health_with_github(
                state.clone(),
                Some("other=x".into()),
                HeaderMap::new(),
                None
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
