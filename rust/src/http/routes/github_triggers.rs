//! GitHub trigger rule routes (`src/http/routes/github-triggers.ts`).

use crate::http::error::ApiError;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};

use crate::{
    http::{
        AppState,
        contracts::typed::github_triggers::{
            GithubTriggerCompanyParams, GithubTriggerCreate, GithubTriggerParams,
            GithubTriggerPatch,
        },
        validation::{Valid, ValidPath},
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
    ValidPath(GithubTriggerCompanyParams { company_id }): ValidPath<GithubTriggerCompanyParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = triggers::list(&state, &user_id, &company_id).map(|rules| json!({"rules": rules}));
    respond(result, StatusCode::OK, cookies)
}

async fn create(
    State(state): State<AppState>,
    ValidPath(GithubTriggerCompanyParams { company_id }): ValidPath<GithubTriggerCompanyParams>,
    headers: HeaderMap,
    Valid(input): Valid<GithubTriggerCreate>,
) -> Response {
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
    ValidPath(GithubTriggerParams {
        company_id,
        rule_id,
    }): ValidPath<GithubTriggerParams>,
    headers: HeaderMap,
    Valid(patch): Valid<GithubTriggerPatch>,
) -> Response {
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
    ValidPath(GithubTriggerParams {
        company_id,
        rule_id,
    }): ValidPath<GithubTriggerParams>,
    headers: HeaderMap,
) -> Response {
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
    ValidPath(GithubTriggerParams {
        company_id,
        rule_id,
    }): ValidPath<GithubTriggerParams>,
    headers: HeaderMap,
) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = triggers::activity(&state, &user_id, &company_id, &rule_id)
        .map(|activity| json!({"activity": activity}));
    respond(result, StatusCode::OK, cookies)
}
