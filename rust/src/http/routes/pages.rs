use crate::http::access::with_cookies;
use crate::http::error::ApiError;
use axum::{
    Router,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;

use crate::{
    http::{AppState, session, ui},
    identity::{auth::AuthUser, companies},
    projects::service,
};

use super::auth;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(root))
        .route("/oauth/consent", get(oauth_consent))
        .route("/admin", get(admin))
        .route("/admin/prompts", get(admin))
        .route("/admin/profiles", get(admin))
        .route("/admin/workflows", get(admin))
        .route("/admin/triggers", get(admin))
        .route("/admin/agents", get(admin))
        .route("/admin/models", get(admin))
        .route("/admin/providers", get(admin))
        .route("/admin/onboarding", get(admin_onboarding))
        .route("/admin/environment", get(admin))
        .route("/admin/backups", get(admin))
        .route("/admin/companies", get(admin))
        .route("/admin/invitations", get(admin))
        .route("/admin/passkeys", get(admin))
        .route("/companies/{company_id}/settings", get(company_settings))
        .route("/profile", get(profile))
        .route("/templates", get(project_templates))
        .route("/projects/{project_id}/prompts", get(project_prompts))
        .route("/projects/{project_id}/templates", get(project_templates))
        .route("/projects/{project_id}", get(projects))
        .route("/projects", get(projects))
        .route("/tasks/{task_id}", get(tasks))
        .route("/tasks", get(tasks))
        .route("/board/{task_id}", get(board))
        .route("/board", get(board))
        .route("/timeline", get(timeline))
        .route("/analytics", get(analytics))
        .route("/setup", get(setup))
        .route("/onboarding", get(onboarding))
        .route("/health", get(health))
}

fn redirect(location: &str) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, location.to_owned())]).into_response()
}

fn page(view: &str, cookies: Vec<String>) -> Response {
    let mut response = (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        ui::application_page(view),
    )
        .into_response();
    auth::append_cookies(&mut response, cookies);
    response
}

fn page_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(AuthUser, Vec<String>), Box<Response>> {
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(ApiError::response)
        .map_err(Box::new)?;
    match session.user {
        Some(user) => Ok((user, session.set_cookies)),
        None => Err(Box::new(redirect("/auth"))),
    }
}

fn authenticated_page(state: AppState, headers: HeaderMap, view: &str) -> Response {
    match page_user(&state, &headers) {
        Ok((_, cookies)) => page(view, cookies),
        Err(response) => *response,
    }
}

async fn root(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user, cookies) = match page_user(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let destination = match state.with_database(|database| service::list(database, &user.id, None))
    {
        Ok(projects) if projects.is_empty() => "/onboarding",
        Ok(_) => "/tasks",
        Err(source) => {
            return with_cookies(ApiError::response(source), cookies);
        }
    };
    let mut response = redirect(destination);
    auth::append_cookies(&mut response, cookies);
    response
}

fn consent_request(raw_query: Option<&str>) -> Option<String> {
    let mut request = None;
    for (key, value) in url::form_urlencoded::parse(raw_query.unwrap_or_default().as_bytes()) {
        if key == "request" {
            if request.is_some() {
                return None;
            }
            request = Some(value.into_owned());
        }
    }
    let request = request?;
    let suffix = request.strip_prefix("oauth_request_")?;
    (suffix.len() == 32
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(request)
}

async fn oauth_consent(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> Response {
    let Some(request_id) = consent_request(raw_query.as_deref()) else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Invalid authorization request",
        )
            .into_response();
    };
    let (_, cookies) = match page_user(&state, &headers) {
        Ok(value) => value,
        Err(response) if response.status() == StatusCode::FOUND => {
            let return_to = format!("/oauth/consent?request={request_id}");
            let encoded: String =
                url::form_urlencoded::byte_serialize(return_to.as_bytes()).collect();
            return redirect(&format!("/auth?returnTo={encoded}"));
        }
        Err(response) => return *response,
    };
    let mut response = page("oauth-consent", cookies);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}

async fn company_settings(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (user, cookies) = match page_user(&state, &headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if user.role != "admin"
        || state
            .with_database(|database| {
                companies::require_company_access(database, &user.id, &company_id)
            })
            .is_err()
    {
        return with_cookies(
            (StatusCode::NOT_FOUND, "Not found").into_response(),
            cookies,
        );
    }
    page("company-settings", cookies)
}

macro_rules! page_handler {
    ($name:ident, $view:literal) => {
        async fn $name(State(state): State<AppState>, headers: HeaderMap) -> Response {
            authenticated_page(state, headers, $view)
        }
    };
}

page_handler!(admin, "admin");
page_handler!(admin_onboarding, "onboarding");
page_handler!(profile, "profile");
page_handler!(project_templates, "project-templates");
page_handler!(project_prompts, "project-prompts");
page_handler!(projects, "projects");
page_handler!(tasks, "tasks");
page_handler!(board, "board");
page_handler!(timeline, "timeline");
page_handler!(analytics, "analytics");
page_handler!(setup, "setup");
page_handler!(onboarding, "onboarding");
async fn health(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cookies = match page_user(&state, &headers) {
        Ok((_, cookies)) => cookies,
        Err(response) => return *response,
    };
    let snapshot = super::health::snapshot(&state, Vec::new(), None).await;
    let response = (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        super::health::health_page(&snapshot),
    )
        .into_response();
    with_cookies(response, cookies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::body::to_bytes;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_state() -> (AppState, std::path::PathBuf) {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-rust-pages-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed)
        ));
        let database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        (
            AppState::new(
                database,
                session::SessionConfig {
                    port: 4113,
                    reachable_address: "http://127.0.0.1:4113".to_owned(),
                    tailscale_exposure: "off".to_owned(),
                },
            ),
            path,
        )
    }

    #[test]
    fn oauth_request_validation_keeps_the_source_shape() {
        assert!(consent_request(None).is_none());
        assert!(
            consent_request(Some(
                "request=oauth_request_0000000000000000000000000000000x"
            ))
            .is_none()
        );
        assert_eq!(
            consent_request(Some(
                "request=oauth_request_0123456789abcdef0123456789abcdef"
            )),
            Some("oauth_request_0123456789abcdef0123456789abcdef".to_owned())
        );
    }

    #[test]
    fn application_shell_uses_the_page_view_and_built_assets() {
        let html = ui::application_page("onboarding");
        assert!(html.contains("<title>Suplex · Onboarding</title>"));
        assert!(html.contains("window.__SUPLEX_VIEW__ = \"onboarding\";"));
        assert!(html.contains("/assets/suplex-ui.js"));
        assert!(html.contains("/assets/suplex-ui.css"));
    }

    #[tokio::test]
    async fn root_and_application_pages_follow_live_session_and_project_state() {
        let (state, path) = test_state();
        let anonymous = root(State(state.clone()), HeaderMap::new()).await;
        assert_eq!(anonymous.status(), StatusCode::FOUND);
        assert_eq!(anonymous.headers().get(header::LOCATION).unwrap(), "/auth");

        let mut loopback = HeaderMap::new();
        loopback.insert(header::HOST, "127.0.0.1:4113".parse().unwrap());
        let onboarding = root(State(state.clone()), loopback.clone()).await;
        assert_eq!(onboarding.status(), StatusCode::FOUND);
        assert_eq!(
            onboarding.headers().get(header::LOCATION).unwrap(),
            "/onboarding"
        );
        assert!(
            onboarding
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count()
                >= 2
        );

        let projects = projects(State(state.clone()), loopback).await;
        assert_eq!(projects.status(), StatusCode::OK);
        let body = to_bytes(projects.into_body(), 32_768).await.unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("window.__SUPLEX_VIEW__ = \"projects\";"));
        assert!(html.contains("/assets/suplex-ui.js"));

        drop(state);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn consent_page_validates_request_before_session_and_preserves_return_path() {
        let (state, path) = test_state();
        let invalid = oauth_consent(
            State(state.clone()),
            HeaderMap::new(),
            RawQuery(Some("request=invalid".to_owned())),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(invalid.into_body(), 1024).await.unwrap();
        assert_eq!(body, "Invalid authorization request");

        let request = "oauth_request_0123456789abcdef0123456789abcdef";
        let anonymous = oauth_consent(
            State(state),
            HeaderMap::new(),
            RawQuery(Some(format!("request={request}"))),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::FOUND);
        assert_eq!(
            anonymous
                .headers()
                .get(header::LOCATION)
                .unwrap()
                .to_str()
                .unwrap(),
            format!("/auth?returnTo=%2Foauth%2Fconsent%3Frequest%3D{request}")
        );
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn denied_company_page_and_health_keep_session_cookies() {
        let (state, path) = test_state();
        let mut loopback = HeaderMap::new();
        loopback.insert(header::HOST, "127.0.0.1:4113".parse().unwrap());
        let denied = company_settings(
            State(state.clone()),
            Path("company_missing".to_owned()),
            loopback.clone(),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            denied.headers().get_all(header::SET_COOKIE).iter().count(),
            2
        );

        let page = health(State(state), loopback).await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers().get_all(header::SET_COOKIE).iter().count(), 2);
        let body = to_bytes(page.into_body(), 32 * 1024).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.contains("Suplex · Host health"));
        assert!(body.contains("window.__SUPLEX_HEALTH__ = {"));
        assert!(body.contains(r#"<article class="health-card" data-status="#));
        assert!(!body.contains("__SUPLEX_VIEW__"));
        let rendered = super::super::health::health_page(&serde_json::json!({
            "reachableAddress":"http://127.0.0.1:4113","ready":false,
            "checks":[{"status":"warning","label":"<Git>","summary":"</script>"}],
        }));
        assert!(rendered.contains("<h2>&lt;Git&gt;</h2><p>&lt;/script&gt;</p>"));
        assert!(rendered.contains("<p>Attention needed</p>"));
        assert!(rendered.contains(r#""summary":"\u003c/script>""#));
        let _ = std::fs::remove_file(path);
    }
}
