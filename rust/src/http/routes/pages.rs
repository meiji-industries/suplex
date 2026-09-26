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
include!("../../../tests/routes/pages.rs");
