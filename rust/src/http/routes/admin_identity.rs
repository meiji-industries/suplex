use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{http::contracts, identity::admin};

use super::{
    super::{AppState, session},
    auth,
};

#[derive(Serialize)]
struct Invitations {
    invitations: Vec<admin::InvitationSummary>,
}
#[derive(Serialize)]
struct Users {
    users: Vec<crate::identity::auth::AuthUser>,
}
#[derive(Serialize)]
struct Credentials {
    credentials: Vec<admin::CredentialSummary>,
}
#[derive(Serialize)]
struct AuditEvents {
    events: Vec<admin::AuditEvent>,
}

fn validation_params(contract: &str, params: Value) -> Result<(), Box<Response>> {
    match contracts::validate(contract, Some(&params)) {
        Some(Ok(_)) => Ok(()),
        Some(Err(issues)) => Err(Box::new(auth::validation_error(issues))),
        None => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

fn authenticated(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
) -> Result<(String, Vec<String>), Box<Response>> {
    if !session::csrf_allowed(&state.session_config, headers, method, false) {
        return Err(Box::new(auth::error(
            StatusCode::FORBIDDEN,
            "request_origin_invalid",
        )));
    }
    let session = state
        .with_database(|database| {
            session::session_user(database, headers, Some(&state.session_config), Utc::now())
        })
        .map_err(auth::service_error)
        .map_err(Box::new)?;
    let Some(user) = session.user else {
        return Err(Box::new(auth::error(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        )));
    };
    Ok((user.id, session.set_cookies))
}

fn with_cookies(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/invitations",
            get(list_invitations).post(invite_user),
        )
        .route("/api/admin/users", get(list_users))
        .route("/api/admin/credentials", get(list_credentials))
        .route(
            "/api/admin/credentials/{credential_id}/revoke",
            post(revoke_credential),
        )
        .route("/api/admin/users/{user_id}/revoke", post(revoke_user))
        .route("/api/admin/audit", get(list_audit))
}

async fn invite_user(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let parsed = match auth::validated_body(&headers, &body, "auth.DisplayNameBodySchema") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let (actor, cookies) = match authenticated(&state, &headers, "POST") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        admin::invite_user(
            database,
            &actor,
            parsed["displayName"].as_str().unwrap_or_default(),
            Utc::now(),
        )
    }) {
        Ok(invitation) => (StatusCode::CREATED, Json(invitation)).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

async fn list_invitations(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "GET") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| admin::list_invitations(database, &actor, Utc::now()))
    {
        Ok(invitations) => Json(Invitations { invitations }).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

async fn list_users(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "GET") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| admin::list_users(database, &actor)) {
        Ok(users) => Json(Users { users }).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

async fn list_credentials(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "GET") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| admin::list_credentials(database, &actor)) {
        Ok(credentials) => Json(Credentials { credentials }).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

async fn revoke_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(credential_id): Path<String>,
) -> Response {
    if let Err(error) = validation_params(
        "common.CredentialIdParamsSchema",
        json!({"credentialId": credential_id}),
    ) {
        return *error;
    }
    let (actor, cookies) = match authenticated(&state, &headers, "POST") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        admin::revoke_credential(database, &actor, &credential_id, Utc::now())
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

async fn revoke_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Response {
    if let Err(error) = validation_params("common.UserIdParamsSchema", json!({"userId": user_id})) {
        return *error;
    }
    let (actor, cookies) = match authenticated(&state, &headers, "POST") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state
        .with_database(|database| admin::revoke_user(database, &actor, &user_id, Utc::now()))
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

async fn list_audit(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, cookies) = match authenticated(&state, &headers, "GET") {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| admin::list_audit_events(database, &actor))
    {
        Ok(events) => Json(AuditEvents { events }).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::auth as identity_auth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{body::to_bytes, http::HeaderValue};

    #[tokio::test]
    async fn invitation_body_validation_precedes_csrf_and_admin_routes_preserve_raw_order() {
        let path = std::env::temp_dir().join(format!(
            "{}.sqlite",
            identity_auth::random_hex_id("suplex_admin_route").unwrap()
        ));
        let mut database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        let signed_in = identity_auth::development_sign_in(&mut database, Utc::now()).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "https://suplex.example.test:4111".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", signed_in.session_token)).unwrap(),
        );
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        let invalid = invite_user(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"displayName":42}"#),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let no_origin = invite_user(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"displayName":"API member"}"#),
        )
        .await;
        assert_eq!(no_origin.status(), StatusCode::FORBIDDEN);
        headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        let created = invite_user(
            State(state.clone()),
            headers.clone(),
            Bytes::from_static(br#"{"displayName":"API member"}"#),
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED);
        let raw =
            String::from_utf8(to_bytes(created.into_body(), 4096).await.unwrap().to_vec()).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let token = value["token"].as_str().unwrap();
        let user_id = value["user"]["id"].as_str().unwrap();
        let expires_at = value["expiresAt"].as_str().unwrap();
        assert!(token.starts_with("invite_v1_user_"));
        assert_eq!(token.len(), "invite_v1_user_".len() + 43);
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(expires_at)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            expires_at
        );
        assert!(expires_at.ends_with('Z'));
        assert_eq!(
            raw.replace(token, "TOKEN")
                .replace(user_id, "user_ID")
                .replace(expires_at, "TIMESTAMP"),
            r#"{"token":"TOKEN","kind":"user","expiresAt":"TIMESTAMP","user":{"id":"user_ID","displayName":"API member","username":"user_v1_user_ID","avatarSeed":"user_v1_user_ID","role":"member","status":"pending","companyIds":[]}}"#
        );
        assert_eq!(
            list_users(State(state.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            list_invitations(State(state.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        let credential_id = identity_auth::random_hex_id("credential").unwrap();
        state.with_database(|database| database.connection().execute(
            "INSERT INTO suplex_credentials (id, user_id, credential_id, public_key, counter, transports, created_at) VALUES (?1, ?2, 'route-member-passkey', X'00', 0, '[]', ?3)",
            rusqlite::params![credential_id, user_id, Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
        )).unwrap();
        assert_eq!(
            list_credentials(State(state.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            revoke_credential(
                State(state.clone()),
                headers.clone(),
                Path(credential_id.clone())
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            revoke_credential(State(state.clone()), headers.clone(), Path(credential_id))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            list_audit(State(state.clone()), headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            revoke_user(
                State(state.clone()),
                headers.clone(),
                Path(user_id.to_owned())
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            revoke_user(State(state), headers, Path(user_id.to_owned()))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
