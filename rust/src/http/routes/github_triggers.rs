//! GitHub trigger rule routes (`src/http/routes/github-triggers.ts`).

use crate::http::error::ApiError;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::{self, github_triggers as contracts},
        validation,
    },
    integrations::{
        github_delivery::Github,
        github_triggers::{self as triggers, Failure},
    },
};

use super::{auth, profiles::authorize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/companies/{company_id}/github-triggers",
            get(list).post(create),
        )
        .route(
            "/api/companies/{company_id}/github-triggers/{rule_id}",
            axum::routing::patch(update),
        )
        .route(
            "/api/companies/{company_id}/github-triggers/{rule_id}/check",
            post(check),
        )
        .route(
            "/api/companies/{company_id}/github-triggers/{rule_id}/activity",
            get(activity),
        )
}

#[cfg(test)]
pub(crate) static TEST_GITHUB_API: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

async fn github() -> Result<Github, Failure> {
    #[cfg(test)]
    if let Some(base) = TEST_GITHUB_API.lock().unwrap().clone() {
        let access = crate::integrations::github::Access::for_api(&base, Some("test-token".into()))
            .map_err(|error| error.to_string())?;
        return Ok(Github::new(access));
    }
    Ok(Github::load().await?)
}

fn params(company_id: &str, rule_id: Option<&str>) -> Result<(), Box<Response>> {
    let input = match rule_id {
        Some(rule_id) => json!({"companyId": company_id, "ruleId": rule_id}),
        None => json!({"companyId": company_id}),
    };
    let parsed = match rule_id {
        Some(_) => contracts::parse_params(Some(&input)),
        None => contracts::parse_company_params(Some(&input)),
    };
    match parsed {
        Ok(_) => Ok(()),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(validation::validation_error_public(findings)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

fn respond(result: Result<Value, Failure>, status: StatusCode, cookies: Vec<String>) -> Response {
    let mut response = match result {
        Ok(value) => (status, Json(value)).into_response(),
        Err(error) => ApiError::response(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

async fn list(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = params(&company_id, None) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = triggers::list(&state, &user_id, &company_id).map(|rules| json!({"rules": rules}));
    respond(result, StatusCode::OK, cookies)
}

async fn create(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = params(&company_id, None) {
        return *response;
    }
    let input = match auth::validated_typed_body(&headers, &body, contracts::parse_create) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "POST", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = async {
        let github = github().await?;
        let rule = triggers::create(&state, &github, &user_id, &company_id, input).await?;
        Ok(serde_json::to_value(rule)?)
    }
    .await;
    respond(result, StatusCode::CREATED, cookies)
}

async fn update(
    State(state): State<AppState>,
    Path((company_id, rule_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = params(&company_id, Some(&rule_id)) {
        return *response;
    }
    let patch = match auth::validated_typed_body(&headers, &body, contracts::parse_patch) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "PATCH", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = async {
        let github = github().await?;
        let rule =
            triggers::update(&state, &github, &user_id, &company_id, &rule_id, patch).await?;
        Ok(serde_json::to_value(rule)?)
    }
    .await;
    respond(result, StatusCode::OK, cookies)
}

async fn check(
    State(state): State<AppState>,
    Path((company_id, rule_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = params(&company_id, Some(&rule_id)) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers, "POST", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = async {
        let github = github().await?;
        let activity = triggers::check(&state, &github, &user_id, &company_id, &rule_id).await?;
        Ok(json!({"activity": activity}))
    }
    .await;
    respond(result, StatusCode::OK, cookies)
}

async fn activity(
    State(state): State<AppState>,
    Path((company_id, rule_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = params(&company_id, Some(&rule_id)) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = triggers::activity(&state, &user_id, &company_id, &rule_id)
        .map(|activity| json!({"activity": activity}));
    respond(result, StatusCode::OK, cookies)
}
