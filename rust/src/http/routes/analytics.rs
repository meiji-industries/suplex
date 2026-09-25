//! Company analytics, task costs, and timeline (`src/http/routes/tasks.ts`).

use crate::tasks::TaskError;
use std::{error::Error, path::PathBuf};

use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    http::{AppState, contracts::typed::finding, validation},
    identity::companies,
    platform::database::SuplexDatabase,
    shared::js_json,
    tasks::{analytics, timeline},
};

use super::{auth, profiles::authorize};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/companies/{company_id}/analytics",
            get(company_analytics),
        )
        .route("/api/companies/{company_id}/task-costs", get(task_costs))
        .route(
            "/api/companies/{company_id}/timeline",
            get(company_timeline),
        )
}

fn company_id_valid(company_id: &str) -> Result<(), Box<Response>> {
    match company_id.encode_utf16().count() {
        0 => Err(Box::new(validation::validation_error_public(vec![
            finding("too_small", &[json!("companyId")]),
        ]))),
        257.. => Err(Box::new(validation::validation_error_public(vec![
            finding("too_big", &[json!("companyId")]),
        ]))),
        _ => Ok(()),
    }
}

fn respond(result: Result<Value, Box<dyn Error>>, cookies: Vec<String>) -> Response {
    let mut response = match result {
        Ok(value) => (
            [
                (header::CONTENT_TYPE, "application/json; charset=utf-8"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            js_json::stringify(&value),
        )
            .into_response(),
        Err(error) => auth::service_error(error),
    };
    auth::append_cookies(&mut response, cookies);
    response
}

fn read(
    state: &AppState,
    headers: &HeaderMap,
    company_id: &str,
    project: fn(Value) -> Value,
) -> Response {
    if let Err(response) = company_id_valid(company_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(state, headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state
        .with_database(|database| analytics::analytics(database, &user_id, company_id, Utc::now()));
    respond(result.map(project), cookies)
}

async fn company_analytics(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    read(&state, &headers, &company_id, |value| value)
}

async fn task_costs(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    read(&state, &headers, &company_id, |value| {
        analytics::task_costs(&value)
    })
}

fn saved_timelines(
    database: &SuplexDatabase,
    user_id: &str,
    company_id: &str,
) -> Result<(Vec<timeline::SavedTimeline>, PathBuf), Box<dyn Error>> {
    let mut ids = analytics::company_task_ids(database, user_id, company_id, false)?;
    ids.extend(analytics::company_task_ids(
        database, user_id, company_id, true,
    )?);
    let mut saved = Vec::new();
    for id in ids {
        companies::require_company_access(database, user_id, company_id)?;
        saved.push(timeline::read_saved(database, &id)?.ok_or_else(TaskError::not_found)?);
    }
    let path = database
        .connection()
        .path()
        .ok_or("Task database has no file path")?;
    Ok((saved, PathBuf::from(path)))
}

async fn company_timeline(
    State(state): State<AppState>,
    Path(company_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = company_id_valid(&company_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (saved, database_path) =
        match state.with_database(|database| saved_timelines(database, &user_id, &company_id)) {
            Ok(value) => value,
            Err(error) => return respond(Err(error), cookies),
        };
    let observed = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let mut tasks = Vec::new();
        let mut unavailable = 0;
        for task in saved {
            let value = serde_json::to_value(
                timeline::observe(&database_path, task).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            tasks.extend(value["tasks"].as_array().cloned().unwrap_or_default());
            unavailable += value["unavailableSessions"].as_u64().unwrap_or_default();
        }
        Ok(json!({"tasks": tasks, "unavailableSessions": unavailable}))
    })
    .await;
    let result = match observed {
        Ok(Ok(value)) => state
            .with_database(|database| {
                analytics::company_task_ids(database, &user_id, &company_id, false)
            })
            .map(|_| value),
        Ok(Err(error)) => Err(error.into()),
        Err(error) => Err(Box::new(error) as Box<dyn Error>),
    };
    let mut response = respond(result, cookies);
    if response.status() == StatusCode::OK {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::*;
    use crate::shared::time::rfc3339_millis;
    use crate::{
        http::routes::avatars::tests::{call, json_body},
        identity::auth as identity_auth,
        tasks::analytics::{AnalyticsSession, record},
    };

    #[tokio::test]
    async fn company_analytics_costs_and_timeline_read_saved_usage_for_visible_tasks() {
        let (state, filename) = auth::tests::state();
        let now = Utc::now();
        let time = rfc3339_millis(now);
        let admin = state
            .with_database(|database| identity_auth::development_sign_in(database, now))
            .unwrap();
        let member = state.with_database(|database| {
            let connection = database.connection();
            connection.execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('c','C','active',?1)", [&time]).unwrap();
            connection.execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('p','c','P','/tmp/r','/tmp/w',NULL,'main','','','root','worker','{}',?1,?1)", [&time]).unwrap();
            for (id, archived) in [("active_task", None), ("archived_task", Some(time.as_str()))] {
                connection.execute("INSERT INTO suplex_tasks (id,company_id,project_id,title,description,configuration_json,idempotency_key,request_hash,creator_user_id,created_at,updated_at,archived_at) VALUES (?1,'c','p',?1,'','{}',?1,'h','user_development',?2,?2,?3)", rusqlite::params![id, time, archived]).unwrap();
                connection.execute("INSERT INTO suplex_task_controls (task_id,objective,delivery_target,delivery_intent_json,status,root_profile_json,worker_profile_json,workflow,advisor_profiles_json,workflow_state_json,status_changed_at,created_at,updated_at) VALUES (?1,'T','local_worktree','{}','delivered','{\"profileId\":\"root\",\"model\":\"m\"}','{\"profileId\":\"worker\",\"model\":\"m\"}','standard','{}','{\"version\":1,\"reviews\":[],\"acceptedDelivery\":null,\"deliveryWait\":null,\"completion\":null}',?2,?2,?2)", rusqlite::params![id, time]).unwrap();
            }
            connection.execute("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,native_session_id,created_at,updated_at) VALUES ('s','active_task','root',1,1,'live','codex-a',?1,?1)", [&time]).unwrap();
            connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'Member', 'member', 'member', 'active', ?1, ?1, 1)", [&time]).unwrap();
            identity_auth::create_session(database, "member", now).unwrap()
        });
        state.with_database(|database| {
            let usage = crate::tasks::analytics::TaskUsage {
                session_id: "codex-a".into(),
                ..crate::tasks::analytics::tests::entry("msg_turn", 3.0)
            };
            record(database, "active_task", "s", &[usage], &time).unwrap();
        });
        let app = crate::http::router(state.clone());
        let cookie = format!("sid_v1={}", admin.session_token);
        let cookie = Some(cookie.as_str());

        let (status, headers, body) =
            call(&app, "GET", "/api/companies/c/analytics", cookie, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
        let body = json_body(&body);
        let tasks = body["tasks"].as_array().unwrap();
        assert_eq!(
            tasks
                .iter()
                .map(|task| task["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["active_task", "archived_task"]
        );
        assert_eq!(
            (
                tasks[0]["sessions"].clone(),
                tasks[0]["observedSessions"].clone(),
                tasks[1]["archived"].clone()
            ),
            (json!(1), json!(1), json!(true))
        );
        assert_eq!(tasks[0]["usage"][0]["cost"], json!(3));
        let _ = AnalyticsSession {
            session_id: String::new(),
            observed_at: None,
            error_at: None,
        };

        let (_, _, body) = call(&app, "GET", "/api/companies/c/task-costs", cookie, None).await;
        assert_eq!(
            json_body(&body),
            json!({"tasks":[
                {"id":"active_task","cost":3,"unpriced":false,"subsidized":false,"partial":false},
                {"id":"archived_task","cost":null,"unpriced":false,"subsidized":false,"partial":false},
            ]})
        );

        let (status, _, body) = call(&app, "GET", "/api/companies/c/timeline", cookie, None).await;
        assert_eq!(status, StatusCode::OK);
        let body = json_body(&body);
        assert_eq!(body["unavailableSessions"], 0);
        assert_eq!(body["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(body["tasks"][0]["activity"].as_array().unwrap().len(), 1);

        let member = format!("sid_v1={member}");
        for path in ["analytics", "task-costs", "timeline"] {
            let uri = format!("/api/companies/c/{path}");
            assert_eq!(
                call(&app, "GET", &uri, Some(&member), None).await.0,
                StatusCode::NOT_FOUND,
                "{path}"
            );
            assert_eq!(
                call(&app, "GET", &uri, None, None).await.0,
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
        drop(app);
        drop(state);
        let _ = std::fs::remove_file(filename);
    }
}
