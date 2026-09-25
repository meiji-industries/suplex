use axum::{
    Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::{MethodFilter, on},
};
use chrono::Utc;

use crate::http::{AppState, session};

use super::auth;

use Access::{Administrator, Authenticated};

// Routes the TypeScript backend registers that Rust has not ported yet. Keep
// this list explicit so an unknown path still receives the normal 404 response.
// WebSocket routes are plain GET handlers here: they answer 501 before any
// upgrade. `scripts/rust-route-coverage.ts` checks this list stays complete.
const ROUTES: &[(Method, &str, Access)] = &[
    (Method::GET, "/api/admin/environment", Administrator),
    (Method::PATCH, "/api/admin/environment", Administrator),
    (Method::GET, "/api/admin/backups", Administrator),
    (Method::POST, "/api/admin/backups", Administrator),
    (Method::POST, "/api/admin/backups/restore", Administrator),
    (Method::GET, "/api/admin/backups/{name}", Administrator),
    (Method::POST, "/api/admin/factory-reset", Administrator),
    (Method::GET, "/api/admin/providers", Administrator),
    (Method::GET, "/api/admin/provider-instances", Administrator),
    (Method::POST, "/api/admin/provider-instances", Administrator),
    (
        Method::DELETE,
        "/api/admin/provider-instances/{instance_id}",
        Administrator,
    ),
    (Method::GET, "/api/admin/models", Authenticated),
    (
        Method::POST,
        "/api/admin/provider-instances/{instance_id}/login",
        Administrator,
    ),
    (
        Method::DELETE,
        "/api/admin/provider-login/{pane_id}",
        Administrator,
    ),
    (
        Method::GET,
        "/api/admin/provider-login/{pane_id}/terminal",
        Administrator,
    ),
    (
        Method::POST,
        "/api/admin/providers/{provider_id}/login",
        Administrator,
    ),
    (Method::POST, "/api/admin/workflows", Authenticated),
    (
        Method::PATCH,
        "/api/admin/workflows/{workflow_id}",
        Authenticated,
    ),
    (
        Method::POST,
        "/api/admin/workflows/{workflow_id}/duplicate",
        Authenticated,
    ),
    (Method::GET, "/api/avatars", Authenticated),
    (Method::GET, "/api/avatars/{owner_id}", Authenticated),
    (Method::PUT, "/api/avatars/{owner_id}", Authenticated),
    (
        Method::GET,
        "/api/companies/{company_id}/analytics",
        Authenticated,
    ),
    (
        Method::GET,
        "/api/companies/{company_id}/github-triggers",
        Authenticated,
    ),
    (
        Method::POST,
        "/api/companies/{company_id}/github-triggers",
        Authenticated,
    ),
    (
        Method::PATCH,
        "/api/companies/{company_id}/github-triggers/{rule_id}",
        Authenticated,
    ),
    (
        Method::GET,
        "/api/companies/{company_id}/github-triggers/{rule_id}/activity",
        Authenticated,
    ),
    (
        Method::POST,
        "/api/companies/{company_id}/github-triggers/{rule_id}/check",
        Authenticated,
    ),
    (
        Method::GET,
        "/api/companies/{company_id}/task-costs",
        Authenticated,
    ),
    (
        Method::GET,
        "/api/companies/{company_id}/timeline",
        Authenticated,
    ),
    (Method::GET, "/api/health", Authenticated),
    (Method::GET, "/api/models", Authenticated),
    (
        Method::GET,
        "/api/oauth/consent/{request_id}",
        Authenticated,
    ),
    (
        Method::POST,
        "/api/oauth/consent/{request_id}/approve",
        Authenticated,
    ),
    (
        Method::POST,
        "/api/oauth/consent/{request_id}/deny",
        Authenticated,
    ),
    (
        Method::GET,
        "/api/projects/{project_id}/issues",
        Authenticated,
    ),
    (
        Method::GET,
        "/api/projects/{project_id}/task-sources",
        Authenticated,
    ),
    (Method::POST, "/api/system/client-lifecycle", Authenticated),
    (
        Method::PATCH,
        "/api/task-templates/{template_id}",
        Authenticated,
    ),
    (
        Method::DELETE,
        "/api/task-templates/{template_id}",
        Authenticated,
    ),
    (Method::GET, "/api/tasks/{task_id}/checks", Authenticated),
    (
        Method::POST,
        "/api/tasks/{task_id}/continue-delivery",
        Authenticated,
    ),
    (
        Method::PUT,
        "/api/tasks/{task_id}/dependencies",
        Authenticated,
    ),
    (Method::POST, "/api/tasks/{task_id}/disarm", Authenticated),
    (Method::PATCH, "/api/tasks/{task_id}/issue", Authenticated),
    (
        Method::GET,
        "/api/tasks/{task_id}/pane/{role}/terminal",
        Authenticated,
    ),
    (Method::POST, "/api/tasks/{task_id}/refresh", Authenticated),
    (
        Method::POST,
        "/api/tasks/{task_id}/replace-coordinator",
        Authenticated,
    ),
    (
        Method::POST,
        "/api/tasks/{task_id}/save-as-template",
        Authenticated,
    ),
    (
        Method::POST,
        "/api/tasks/{task_id}/select-agent",
        Authenticated,
    ),
    (
        Method::GET,
        "/api/tasks/{task_id}/worktree/apps",
        Authenticated,
    ),
    (
        Method::POST,
        "/api/tasks/{task_id}/worktree/open",
        Authenticated,
    ),
    (Method::GET, "/api/update", Authenticated),
    (Method::POST, "/api/update/restart", Administrator),
];

pub fn router() -> Router<AppState> {
    ROUTES
        .iter()
        .fold(Router::new(), |router, (method, path, access)| {
            let filter = MethodFilter::try_from(method.clone()).expect("stub method");
            router.route(
                path,
                match access {
                    Authenticated => on(filter, authenticated),
                    Administrator => on(filter, administrator),
                },
            )
        })
}

#[derive(Clone, Copy)]
enum Access {
    Authenticated,
    Administrator,
}

async fn authenticated(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    guarded(&state, &headers, &method, Access::Authenticated)
}

async fn administrator(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    guarded(&state, &headers, &method, Access::Administrator)
}

fn guarded(state: &AppState, headers: &HeaderMap, method: &Method, access: Access) -> Response {
    if !session::csrf_allowed(&state.session_config, headers, method.as_str(), false) {
        return auth::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let session = match state.with_database(|database| {
        session::session_user(database, headers, Some(&state.session_config), Utc::now())
    }) {
        Ok(session) => session,
        Err(error) => return auth::service_error(error),
    };
    let response = match session.user {
        None => auth::error(StatusCode::UNAUTHORIZED, "Authentication required"),
        Some(user) if matches!(access, Access::Administrator) && user.role != "admin" => {
            auth::error(StatusCode::FORBIDDEN, "Administrator access required")
        }
        Some(_) => auth::not_ported(),
    };
    let mut response = response;
    auth::append_cookies(&mut response, session.set_cookies);
    response
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use axum::{body::to_bytes, http::HeaderValue};
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
    };

    #[tokio::test]
    async fn registered_admin_stub_checks_session_role_and_csrf_before_501() {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-unported-route-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed),
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let now = Utc::now();
        let admin = identity_auth::development_sign_in(&mut database, now).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('stub_member', 'Member', 'user_v1_stub_member', 'member', 'active', ?1, ?1, 1)",
            [now.to_rfc3339()],
        ).unwrap();
        let member_hash = Sha256::digest(b"stub_member_token")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        database.connection().execute(
            "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('stub_member_session', ?1, 'stub_member', ?2, ?3, 1)",
            rusqlite::params![member_hash, (now + chrono::Duration::days(1)).to_rfc3339(), now.to_rfc3339()],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4113,
                reachable_address: "https://suplex.example.test:4113".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4113"));
        assert_eq!(
            guarded(&state, &headers, &Method::GET, Access::Administrator).status(),
            StatusCode::UNAUTHORIZED
        );
        headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=stub_member_token"),
        );
        assert_eq!(
            guarded(&state, &headers, &Method::GET, Access::Administrator).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            guarded(&state, &headers, &Method::GET, Access::Authenticated).status(),
            StatusCode::NOT_IMPLEMENTED
        );
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        assert_eq!(
            guarded(&state, &headers, &Method::POST, Access::Administrator).status(),
            StatusCode::FORBIDDEN
        );
        headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4113"),
        );
        let response = guarded(&state, &headers, &Method::POST, Access::Administrator);
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["code"],
            "experimental_not_ported"
        );
        drop(state);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[tokio::test]
    async fn every_known_unported_route_requires_a_session_then_returns_501() {
        let (state, filename) = auth::tests::state();
        let admin = state
            .with_database(|database| identity_auth::development_sign_in(database, Utc::now()))
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, crate::http::router(state)).into_future());
        let client = reqwest::Client::new();
        let cookie = format!("sid_v1={}", admin.session_token);
        let parameter = regex::Regex::new(r"\{[^}]+\}").unwrap();
        for (method, path, _) in ROUTES {
            let path = parameter.replace_all(path, "x");
            let request = |cookie: Option<&str>| {
                let request = client
                    .request(method.clone(), format!("http://{address}{path}"))
                    .header("origin", "https://suplex.example.test:4111");
                match cookie {
                    Some(cookie) => request.header("cookie", cookie),
                    None => request,
                }
            };
            let anonymous = request(None).send().await.unwrap();
            assert_eq!(
                anonymous.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {path}"
            );
            let signed_in = request(Some(&cookie)).send().await.unwrap();
            assert_eq!(
                signed_in.status(),
                StatusCode::NOT_IMPLEMENTED,
                "{method} {path}"
            );
            assert_eq!(
                signed_in.json::<serde_json::Value>().await.unwrap(),
                serde_json::json!({
                    "error": "Experimental Rust backend has not ported this route",
                    "code": "experimental_not_ported",
                }),
                "{method} {path}"
            );
        }
        server.abort();
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
