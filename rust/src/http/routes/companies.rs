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

/// A company with its plan label for the switcher. The label comes from local
/// data only; `None` means Suplex has no recent plan for the company.
#[derive(Serialize)]
struct CompanyItem {
    #[serde(flatten)]
    company: companies::Company,
    plan: Option<&'static str>,
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
    ) -> Result<T, Box<dyn std::error::Error>>,
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
    let mut stale = Vec::new();
    let response = respond(&state, &headers, None, StatusCode::OK, |database, user| {
        let now = Utc::now();
        let companies = companies::list_visible_companies(database, &user.id)?
            .into_iter()
            .map(|company| {
                let (plan, refresh) = crate::billing::plan_label(database, &company.id, now)?;
                if refresh {
                    stale.push(company.id.clone());
                }
                Ok(CompanyItem { company, plan })
            })
            .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
        Ok(CompanyList { companies })
    });
    crate::billing::refresh_plans(&state, stale);
    response
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
            companies::set_company_status(database, &user.id, &company_id, &status, Utc::now())
        },
    )
}

async fn add_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
    ValidPath(CompanyIdParams { company_id }): ValidPath<CompanyIdParams>,
    Valid(parsed): Valid<MembershipBody>,
) -> Response {
    respond(
        &state,
        &headers,
        Some("POST"),
        StatusCode::NO_CONTENT,
        |database, user| {
            companies::add_membership(database, &user.id, &parsed.user_id, &company_id, Utc::now())
        },
    )
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
