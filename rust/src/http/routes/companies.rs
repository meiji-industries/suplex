use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::json;

use crate::identity::{auth::AuthUser, companies};

use super::{
    super::{AppState, session},
    auth as auth_routes,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/companies", get(list))
        .route("/api/companies/{company_id}", get(get_company))
        .route("/api/admin/companies", post(create))
        .route(
            "/api/admin/companies/{company_id}",
            axum::routing::patch(rename),
        )
        .route(
            "/api/admin/companies/{company_id}/issue-code",
            axum::routing::patch(issue_code),
        )
        .route(
            "/api/admin/companies/{company_id}/status/{status}",
            post(status),
        )
        .route(
            "/api/admin/companies/{company_id}/members",
            post(add_membership),
        )
        .route(
            "/api/admin/companies/{company_id}/members/{user_id}",
            axum::routing::delete(remove_membership),
        )
}

fn authenticated(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(AuthUser, Vec<String>), Box<Response>> {
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(auth_routes::service_error)
        .map_err(Box::new)?;
    let Some(user) = session.user else {
        return Err(Box::new(auth_routes::error(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        )));
    };
    Ok((user, session.set_cookies))
}

fn respond_with_cookies(response: Response, cookies: Vec<String>) -> Response {
    let mut response = response;
    auth_routes::append_cookies(&mut response, cookies);
    response
}

fn csrf_failure(state: &AppState, headers: &HeaderMap, method: &str) -> Option<Response> {
    (!session::csrf_allowed(&state.session_config, headers, method, false))
        .then(|| auth_routes::error(StatusCode::FORBIDDEN, "request_origin_invalid"))
}

async fn list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| companies::list_visible_companies(database, &user.id))
    {
        Ok(companies) => Json(json!({ "companies": companies })).into_response(),
        Err(error) => auth_routes::service_error(error),
    };
    respond_with_cookies(response, cookies)
}

async fn get_company(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
) -> Response {
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        companies::require_company_access(database, &user.id, &company_id)
    }) {
        Ok(company) => Json(json!(company)).into_response(),
        Err(error) => auth_routes::service_error(error),
    };
    respond_with_cookies(response, cookies)
}

async fn create(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(error) = csrf_failure(&state, &headers, "POST") {
        return error;
    }
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response =
        match state.with_database(|database| companies::require_admin(database, &user.id)) {
            Ok(()) => auth_routes::not_ported(),
            Err(error) => auth_routes::service_error(error),
        };
    respond_with_cookies(response, cookies)
}

fn admin_company(
    state: &AppState,
    headers: &HeaderMap,
    company_id: &str,
    method: &str,
) -> Response {
    if let Some(error) = csrf_failure(state, headers, method) {
        return error;
    }
    let (user, cookies) = match authenticated(state, headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| companies::require_admin_company(database, &user.id, company_id))
    {
        Ok(_) => auth_routes::not_ported(),
        Err(error) => auth_routes::service_error(error),
    };
    respond_with_cookies(response, cookies)
}

async fn rename(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
) -> Response {
    admin_company(&state, &headers, &company_id, "PATCH")
}

async fn issue_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
) -> Response {
    admin_company(&state, &headers, &company_id, "PATCH")
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((company_id, _status)): Path<(String, String)>,
) -> Response {
    admin_company(&state, &headers, &company_id, "POST")
}

async fn add_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
) -> Response {
    admin_company(&state, &headers, &company_id, "POST")
}

async fn remove_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((company_id, _user_id)): Path<(String, String)>,
) -> Response {
    admin_company(&state, &headers, &company_id, "DELETE")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{body::to_bytes, http::HeaderValue};
    use sha2::{Digest, Sha256};

    #[tokio::test]
    async fn company_routes_apply_live_user_and_membership_scope_before_501() {
        let filename = std::env::temp_dir().join(format!(
            "suplex_company_route_{}_{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let admin = auth::development_sign_in(&mut database, Utc::now()).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member_route', 'Member', 'user_v1_member_route', 'member', 'active', ?1, ?1, 1)",
            [Utc::now().to_rfc3339()],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_route', 'Route Company', 'active', ?1)",
            [Utc::now().to_rfc3339()],
        ).unwrap();
        let member_token = "member_route_token";
        let member_hash = Sha256::digest(member_token.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        database.connection().execute(
            "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('member_route_session', ?1, 'member_route', ?2, ?3, 1)",
            rusqlite::params![member_hash, (Utc::now() + chrono::Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true), Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "https://suplex.example.test:4111".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let anonymous = HeaderMap::new();
        assert_eq!(
            list(State(state.clone()), anonymous).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let mut admin_headers = HeaderMap::new();
        admin_headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        admin_headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        let existing = get_company(
            State(state.clone()),
            admin_headers.clone(),
            Path("company_route".to_owned()),
        )
        .await;
        assert_eq!(existing.status(), StatusCode::OK);
        assert_eq!(
            get_company(
                State(state.clone()),
                admin_headers.clone(),
                Path("missing".to_owned())
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            create(State(state.clone()), admin_headers.clone())
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        admin_headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        let unported = create(State(state.clone()), admin_headers.clone()).await;
        assert_eq!(unported.status(), StatusCode::NOT_IMPLEMENTED);
        let body = to_bytes(unported.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["code"],
            "experimental_not_ported"
        );
        let mut member_headers = HeaderMap::new();
        member_headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        member_headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=member_route_token"),
        );
        member_headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        assert_eq!(
            get_company(
                State(state.clone()),
                member_headers.clone(),
                Path("company_route".to_owned())
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            create(State(state.clone()), member_headers.clone())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            list(State(state.clone()), member_headers).await.status(),
            StatusCode::OK
        );
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
