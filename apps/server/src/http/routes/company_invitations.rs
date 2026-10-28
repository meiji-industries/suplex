use crate::{
    accounts::{self, members},
    http::{
        AppState,
        access::{authorize_profile, with_cookies},
        error::ApiError,
    },
    identity::{auth::UserRole, companies, remote_access_repository},
    shared::{PublicFailure, time::rfc3339_millis},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CompanyInvitationsResponse {
    pub invitations: Vec<members::CompanyInvitation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InviteBody {
    full_name: String,
    email: String,
    role: UserRole,
}

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/companies/{company_id}/invitations",
        get(list).post(invite),
    )
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
) -> Response {
    let (actor, cookies) = match authorize_profile(&state, &headers, "GET", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|db| {
        companies::require_admin_company(db, &actor, &company_id)?;
        members::list(db, &company_id)
    });
    with_cookies(
        match result {
            Ok(invitations) => Json(CompanyInvitationsResponse { invitations }).into_response(),
            Err(error) => ApiError::response(error),
        },
        cookies,
    )
}

async fn invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
    Json(body): Json<InviteBody>,
) -> Response {
    let (actor, cookies) = match authorize_profile(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = send(&state, &actor, &company_id, &body).await;
    with_cookies(
        match result {
            Ok(invitations) => Json(CompanyInvitationsResponse { invitations }).into_response(),
            Err(error) => ApiError::response(error),
        },
        cookies,
    )
}

async fn send(
    state: &AppState,
    actor: &str,
    company_id: &str,
    body: &InviteBody,
) -> crate::platform::database::DatabaseResult<Vec<members::CompanyInvitation>> {
    let client = state
        .accounts
        .as_ref()
        .ok_or_else(accounts::not_configured)?;
    crate::billing::observe_team(state).await;
    let (owner, origin) =
        state.with_database(|db| -> crate::platform::database::DatabaseResult<_> {
            companies::require_admin_company(db, actor, company_id)?;
            let owner = accounts::linked(db)?
                .ok_or_else(|| PublicFailure::new(409, "Log in to Suplex before adding users"))?;
            let external = remote_access_repository::external_https_origin(db)?;
            let origin = remote_access_repository::effective_https_origin(
                external.as_deref(),
                &state.session_config.reachable_address,
            )
            .ok_or_else(|| {
                PublicFailure::new(409, "Configure Remote Access before adding users")
            })?;
            Ok((owner, origin))
        })?;
    let invitation = state.with_database(|db| {
        members::prepare(
            db,
            actor,
            company_id,
            &body.full_name,
            &body.email,
            body.role,
            &origin,
            Utc::now(),
        )
    })?;
    client
        .send_company_invitation(&owner.token, &invitation)
        .await?;
    state.with_database(|db| {
        db.connection().execute(
            "UPDATE suplex_company_invitations SET sent_at = COALESCE(sent_at, ?2) WHERE id = ?1",
            params![invitation.id, rfc3339_millis(Utc::now())],
        )?;
        members::list(db, company_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::routes::{
        auth::tests::{operator_account, state},
        avatars::tests::{call, json_body},
    };
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn retry_keeps_one_reserved_member_and_members_cannot_invite() {
        let calls = Arc::new(AtomicUsize::new(0));
        let requests = calls.clone();
        let hosted = Router::new().route(
            "/v1/company-invitations",
            axum::routing::post(
                move |headers: HeaderMap,
                      Json(body): Json<accounts::wire::CompanyInvitationBody>| {
                    let requests = requests.clone();
                    async move {
                        assert!(headers.get("authorization").is_some());
                        assert_eq!(body.email, "member@example.com");
                        if requests.fetch_add(1, Ordering::SeqCst) == 0 {
                            axum::http::StatusCode::SERVICE_UNAVAILABLE
                        } else {
                            axum::http::StatusCode::NO_CONTENT
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(axum::serve(listener, hosted).into_future());
        let (state, _) = state();
        let admin = operator_account(&state, Utc::now());
        state.with_database(|db| crate::billing::tests::grant_team(db));
        state.with_database(|db| db.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('company_invite','Invites','active','2026-10-03T00:00:00.000Z')", []).unwrap());
        let state = state.with_accounts(accounts::AccountClient::new(
            origin.parse().unwrap(),
            "test".into(),
        ));
        let app = crate::http::router(state.clone());
        let path = "/api/companies/company_invite/invitations";
        let cookie = format!("sid_v1={admin}");
        let body = json!({"fullName":"New Member", "email":"member@example.com", "role":"member"});
        assert_eq!(
            call(&app, "POST", path, Some(&cookie), Some(body.clone()))
                .await
                .0,
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        let (status, _, result) = call(&app, "POST", path, Some(&cookie), Some(body)).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let list = json_body(&result);
        assert_eq!(list["invitations"].as_array().unwrap().len(), 1);
        assert!(list["invitations"][0]["sentAt"].is_string());
        let member = state.with_database(|db| {
            members::accept(
                db,
                &accounts::wire::HostedAccount {
                    id: "user_67e55044-10b1-426f-9247-bb680e5fe0c9".into(),
                    email: "member@example.com".into(),
                    name: None,
                },
                Utc::now(),
            )
            .unwrap()
        });
        let (status, _, _) = call(&app, "GET", path, Some(&format!("sid_v1={member}")), None).await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }
}
