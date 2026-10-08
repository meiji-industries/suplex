#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

use crate::http::error::ApiError;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::Serialize;

use crate::{
    http::{
        contracts::typed::auth::{
            CompanyIdParams, CompanyIssueCodeBody, CompanyNameBody, CompanyStatusParams,
            MembershipBody, MembershipParams,
        },
        validation::{Valid, ValidPath},
    },
    identity::{auth::AuthUser, companies},
};

use super::{
    super::{AppState, session},
    auth as auth_routes,
};

#[derive(Serialize)]
struct CompanyList {
    companies: Vec<CompanyItem>,
}

/// A company with the installation's plan for the switcher, from local data.
#[derive(Serialize)]
struct CompanyItem {
    #[serde(flatten)]
    company: companies::Company,
    plan: crate::billing::Plan,
}

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

use crate::http::access::authenticated;

use crate::http::access::with_cookies as respond_with_cookies;

/// The request origin (for writes), then the session; `operation` runs as that user.
fn respond<T: Serialize>(
    state: &AppState,
    headers: &HeaderMap,
    method: Option<&str>,
    status: StatusCode,
    operation: impl FnOnce(
        &mut crate::platform::database::SuplexDatabase,
        &AuthUser,
    ) -> Result<T, Box<dyn std::error::Error + Send + Sync>>,
) -> Response {
    if let Some(method) = method
        && !session::csrf_allowed(&state.session_config, headers, method, false)
    {
        return auth_routes::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user, cookies) = match authenticated(state, headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| operation(database, &user)) {
        Ok(_) if status == StatusCode::NO_CONTENT => status.into_response(),
        Ok(value) => (status, Json(value)).into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

async fn list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    respond(&state, &headers, None, StatusCode::OK, |database, user| {
        let plan = crate::billing::plan(database)?;
        let companies = companies::list_visible_companies(database, &user.id)?
            .into_iter()
            .map(|company| CompanyItem { company, plan })
            .collect();
        Ok(CompanyList { companies })
    })
}

async fn get_company(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
) -> Response {
    respond(&state, &headers, None, StatusCode::OK, |database, user| {
        companies::require_company_access(database, &user.id, &company_id)
    })
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(parsed): Valid<CompanyNameBody>,
) -> Response {
    crate::billing::observe(&state, crate::billing::Limit::Companies).await;
    respond(
        &state,
        &headers,
        Some("POST"),
        StatusCode::CREATED,
        |database, user| companies::create_company(database, &user.id, &parsed.name, Utc::now()),
    )
}

async fn rename(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    Valid(parsed): Valid<CompanyNameBody>,
) -> Response {
    respond(
        &state,
        &headers,
        Some("PATCH"),
        StatusCode::OK,
        |database, user| {
            companies::rename_company(database, &user.id, &company_id, &parsed.name, Utc::now())
        },
    )
}

async fn issue_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    Valid(parsed): Valid<CompanyIssueCodeBody>,
) -> Response {
    respond(
        &state,
        &headers,
        Some("PATCH"),
        StatusCode::OK,
        |database, user| {
            companies::set_company_issue_code(
                database,
                &user.id,
                &company_id,
                parsed.issue_code.as_deref(),
                Utc::now(),
            )
        },
    )
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(CompanyStatusParams { company_id, status }): ValidPath<CompanyStatusParams>,
) -> Response {
    respond(
        &state,
        &headers,
        Some("POST"),
        StatusCode::OK,
        |database, user| {
            companies::set_company_status(database, &user.id, &company_id, status, Utc::now())
        },
    )
}

async fn add_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    Valid(parsed): Valid<MembershipBody>,
) -> Response {
    if !session::csrf_allowed(&state.session_config, &headers, "POST", false) {
        return auth_routes::error(StatusCode::FORBIDDEN, "request_origin_invalid");
    }
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        companies::add_membership(database, &user.id, &parsed.user_id, &company_id, Utc::now())
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

async fn remove_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(MembershipParams {
        company_id,
        user_id,
    }): ValidPath<MembershipParams>,
) -> Response {
    respond(
        &state,
        &headers,
        Some("DELETE"),
        StatusCode::NO_CONTENT,
        |database, user| {
            companies::remove_membership(database, &user.id, &user_id, &company_id, Utc::now())
        },
    )
}

#[cfg(test)]
include!("../../../tests/routes/companies.rs");
