//! Local or custom OpenAI-compatible endpoints. Only an administrator reads or
//! changes them, and no response holds the API key.

use crate::http::access::with_cookies;
use crate::http::error::ApiError;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};

use crate::{
    http::{
        AppState,
        contracts::typed::projects::{LocalEndpointCreateBody, LocalEndpointTestBody},
        validation::Valid,
    },
    profiles::local_endpoints::{self, LocalEndpoint, LocalEndpointListResponse},
};

use super::profiles::authorize;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/local-endpoints",
            get(list_endpoints).post(create_endpoint),
        )
        .route("/api/admin/local-endpoints/test", post(test_endpoint))
        .route(
            "/api/admin/local-endpoints/{endpoint_id}",
            delete(delete_endpoint),
        )
}

fn private(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

async fn list_endpoints(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (_, cookies) = match authorize(&state, &headers, "GET", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| local_endpoints::list(database)) {
        Ok(endpoints) => private(
            Json(LocalEndpointListResponse {
                endpoints: endpoints.iter().map(LocalEndpoint::response).collect(),
            })
            .into_response(),
        ),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn create_endpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(input): Valid<LocalEndpointCreateBody>,
) -> Response {
    let (_, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| local_endpoints::create(database, &input)) {
        Ok(endpoint) => private((StatusCode::CREATED, Json(endpoint.response())).into_response()),
        Err(error) => ApiError::response(error),
    };
    with_cookies(response, cookies)
}

async fn delete_endpoint(
    State(state): State<AppState>,
    Path(endpoint_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (_, cookies) = match authorize(&state, &headers, "DELETE", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response =
        match state.with_database(|database| local_endpoints::delete(database, &endpoint_id)) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => ApiError::response(error),
        };
    with_cookies(response, cookies)
}

/// Asks the endpoint for its models. Suplex stores nothing.
async fn test_endpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Valid(input): Valid<LocalEndpointTestBody>,
) -> Response {
    let (_, cookies) = match authorize(&state, &headers, "POST", true) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result =
        local_endpoints::test(&input.base_url, input.api_key.as_deref(), &input.model_id).await;
    with_cookies(private(Json(result).into_response()), cookies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::routes::avatars::tests::{call, json_body};
    use chrono::Utc;
    use serde_json::json;

    #[tokio::test]
    async fn only_an_administrator_manages_endpoints_and_no_response_holds_the_key() {
        let (state, filename) = crate::http::routes::auth::tests::state();
        let now = Utc::now();
        let admin = crate::http::routes::auth::tests::operator_account(&state, now);
        let member = state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'M', 'member', 'member', 'active', ?1, ?1, 1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_endpoints', 'Endpoints', 'active', ?1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_memberships (company_id, user_id, created_at) VALUES ('company_endpoints', 'member', ?1)", [now.to_rfc3339()]).unwrap();
            crate::http::routes::auth::tests::verified_session(database, "member", now).unwrap()
        });
        crate::http::routes::auth::tests::require_remote_login(&state);
        let app = crate::http::router(state.clone());
        let admin = format!("sid_v1={admin}");
        let member = format!("sid_v1={member}");
        let body =
            json!({"baseUrl":"http://127.0.0.1:9/v1","apiKey":"secret-key","modelId":"qwen3"});
        for (method, path, body) in [
            ("GET", "/api/admin/local-endpoints", None),
            ("POST", "/api/admin/local-endpoints", Some(&body)),
            ("POST", "/api/admin/local-endpoints/test", Some(&body)),
            (
                "DELETE",
                "/api/admin/local-endpoints/local-000000000000",
                None,
            ),
        ] {
            assert_eq!(
                call(&app, method, path, Some(&member), body.cloned())
                    .await
                    .0,
                StatusCode::FORBIDDEN,
                "{method} {path}"
            );
            assert_eq!(
                call(&app, method, path, None, body.cloned()).await.0,
                StatusCode::UNAUTHORIZED,
                "{method} {path}"
            );
        }

        let (status, headers, created) = call(
            &app,
            "POST",
            "/api/admin/local-endpoints",
            Some(&admin),
            Some(body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(headers["cache-control"], "private, no-store");
        let created = json_body(&created);
        assert_eq!(created["label"], "Local endpoint 127.0.0.1:9");
        assert_eq!(created["hasApiKey"], true);
        assert!(!created.to_string().contains("secret-key"));
        let id = created["id"].as_str().unwrap().to_owned();

        let (status, _, listed) = call(
            &app,
            "GET",
            "/api/admin/local-endpoints",
            Some(&admin),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json_body(&listed)["endpoints"][0]["id"], id.as_str());
        assert!(!String::from_utf8_lossy(&listed).contains("secret-key"));

        let (status, _, tested) = call(
            &app,
            "POST",
            "/api/admin/local-endpoints/test",
            Some(&admin),
            Some(body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let tested = json_body(&tested);
        assert_eq!(tested["status"], "error");
        assert!(!tested.to_string().contains("secret-key"));

        // The endpoint is its own provider row, and its model is selectable.
        let (_, _, providers) = call(&app, "GET", "/api/admin/providers", Some(&admin), None).await;
        assert!(!String::from_utf8_lossy(&providers).contains("secret-key"));
        let providers = json_body(&providers);
        let row = providers["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == id.as_str())
            .unwrap()
            .clone();
        assert_eq!(row["kind"], "local-endpoint");
        assert_eq!(row["status"], "configured");
        assert_eq!(row["modelCount"], 1);
        assert_eq!(row["connection"]["status"], "not-connected");
        for path in ["/api/admin/models", "/api/models"] {
            let (_, _, models) = call(&app, "GET", path, Some(&member), None).await;
            let models = json_body(&models);
            let model = models["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|model| model["providerLabel"] == "Local endpoint 127.0.0.1:9")
                .unwrap()
                .clone();
            assert_eq!(model["id"], format!("{id}/qwen3"));
            assert_eq!(model["provider"], row["harness"]);
        }

        let invalid = json!({"baseUrl":"not a url","modelId":"qwen 3"});
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/admin/local-endpoints",
                Some(&admin),
                Some(invalid)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let path = format!("/api/admin/local-endpoints/{id}");
        assert_eq!(
            call(&app, "DELETE", &path, Some(&admin), None).await.0,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(&app, "DELETE", &path, Some(&admin), None).await.0,
            StatusCode::NOT_FOUND
        );
        drop(app);
        drop(state);
        let _ = std::fs::remove_file(filename);
    }
}
