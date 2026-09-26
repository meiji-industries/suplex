use crate::http::error::ApiError;
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

use crate::{
    http::contracts::{self, typed},
    identity::companies,
};

use super::{
    super::{AppState, session},
    auth as auth_routes,
};

#[derive(Serialize)]
struct CompanyList {
    companies: Vec<companies::Company>,
}

fn validated_params(contract: &str, params: Value) -> Result<Value, Box<Response>> {
    match contracts::validate(contract, Some(&params)) {
        Some(Ok(value)) => Ok(value),
        Some(Err(issues)) => Err(Box::new(auth_routes::validation_error(issues))),
        None => Err(Box::new(auth_routes::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
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
        Ok(companies) => Json(CompanyList { companies }).into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

async fn get_company(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
) -> Response {
    if let Err(response) = validated_params(
        "common.CompanyIdParamsSchema",
        json!({ "companyId": company_id }),
    ) {
        return *response;
    }
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        companies::require_company_access(database, &user.id, &company_id)
    }) {
        Ok(company) => Json(company).into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

async fn create(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let parsed =
        match auth_routes::validated_typed_body(&headers, &body, typed::auth::parse_company_name) {
            Ok(value) => value,
            Err(response) => return *response,
        };
    if let Some(error) = csrf_failure(&state, &headers, "POST") {
        return error;
    }
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let name = &parsed.name;
    let response = match state
        .with_database(|database| companies::create_company(database, &user.id, name, Utc::now()))
    {
        Ok(company) => (StatusCode::CREATED, Json(company)).into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

async fn rename(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_params(
        "common.CompanyIdParamsSchema",
        json!({ "companyId": company_id }),
    ) {
        return *response;
    }
    let parsed =
        match auth_routes::validated_typed_body(&headers, &body, typed::auth::parse_company_name) {
            Ok(value) => value,
            Err(response) => return *response,
        };
    if let Some(error) = csrf_failure(&state, &headers, "PATCH") {
        return error;
    }
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        companies::rename_company(database, &user.id, &company_id, &parsed.name, Utc::now())
    }) {
        Ok(company) => Json(company).into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

async fn issue_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_params(
        "common.CompanyIdParamsSchema",
        json!({ "companyId": company_id }),
    ) {
        return *response;
    }
    let parsed = match auth_routes::validated_typed_body(
        &headers,
        &body,
        typed::auth::parse_company_issue_code,
    ) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Some(error) = csrf_failure(&state, &headers, "PATCH") {
        return error;
    }
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        companies::set_company_issue_code(
            database,
            &user.id,
            &company_id,
            parsed.issue_code.as_deref(),
            Utc::now(),
        )
    }) {
        Ok(company) => Json(company).into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((company_id, status)): Path<(String, String)>,
) -> Response {
    if let Err(response) = validated_params(
        "common.CompanyStatusParamsSchema",
        json!({ "companyId": company_id, "status": status }),
    ) {
        return *response;
    }
    if let Some(error) = csrf_failure(&state, &headers, "POST") {
        return error;
    }
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        companies::set_company_status(database, &user.id, &company_id, &status, Utc::now())
    }) {
        Ok(company) => Json(company).into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

async fn add_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(company_id): Path<String>,
    body: Bytes,
) -> Response {
    if let Err(response) = validated_params(
        "common.CompanyIdParamsSchema",
        json!({ "companyId": company_id }),
    ) {
        return *response;
    }
    let parsed =
        match auth_routes::validated_typed_body(&headers, &body, typed::auth::parse_membership) {
            Ok(value) => value,
            Err(response) => return *response,
        };
    if let Some(error) = csrf_failure(&state, &headers, "POST") {
        return error;
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
    Path((company_id, user_id)): Path<(String, String)>,
) -> Response {
    if let Err(response) = validated_params(
        "common.CompanyIdParamsSchema",
        json!({ "companyId": company_id }),
    ) {
        return *response;
    }
    if let Err(response) =
        validated_params("common.UserIdParamsSchema", json!({ "userId": user_id }))
    {
        return *response;
    }
    if let Some(error) = csrf_failure(&state, &headers, "DELETE") {
        return error;
    }
    let (user, cookies) = match authenticated(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let response = match state.with_database(|database| {
        companies::remove_membership(database, &user.id, &user_id, &company_id, Utc::now())
    }) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => ApiError::response(error),
    };
    respond_with_cookies(response, cookies)
}

#[cfg(test)]
include!("../../../tests/routes/companies.rs");
