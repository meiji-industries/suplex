use axum::{
    Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use chrono::Utc;

use crate::http::{AppState, session};

use super::auth;

// These paths are registered by the TypeScript administration plugin. Keep this
// list explicit so an unknown path still receives the normal 404 response.
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/environment",
            get(administrator).patch(administrator),
        )
        .route("/api/admin/backups", get(administrator).post(administrator))
        .route("/api/admin/backups/restore", post(administrator))
        .route("/api/admin/backups/{name}", get(administrator))
        .route("/api/admin/factory-reset", post(administrator))
        .route("/api/admin/providers", get(administrator))
        .route(
            "/api/admin/provider-instances",
            get(administrator).post(administrator),
        )
        .route(
            "/api/admin/provider-instances/{instance_id}",
            axum::routing::delete(administrator),
        )
        .route(
            "/api/admin/invitations",
            get(identity_admin).post(identity_admin),
        )
        .route("/api/admin/users", get(identity_admin))
        .route("/api/admin/credentials", get(identity_admin))
        .route(
            "/api/admin/credentials/{credential_id}/revoke",
            post(identity_admin),
        )
        .route("/api/admin/users/{user_id}/revoke", post(identity_admin))
        .route("/api/admin/audit", get(identity_admin))
        .route("/api/admin/models", get(authenticated))
}

#[derive(Clone, Copy)]
enum Access {
    Authenticated,
    Administrator,
    IdentityAdministrator,
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

async fn identity_admin(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    guarded(&state, &headers, &method, Access::IdentityAdministrator)
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
        Some(user) if matches!(access, Access::IdentityAdministrator) && user.role != "admin" => {
            auth::error(StatusCode::NOT_FOUND, "Not found")
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
        assert_eq!(
            guarded(
                &state,
                &headers,
                &Method::GET,
                Access::IdentityAdministrator
            )
            .status(),
            StatusCode::NOT_FOUND
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
}
