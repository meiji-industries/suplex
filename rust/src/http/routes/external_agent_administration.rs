//! Administrator routes for external agents: create, list, grants, pairing codes, rotation, revocation.

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::Utc;
use serde_json::{Value, json};

use crate::{
    http::{
        AppState, agent_api_runtime,
        contracts::typed::{self, ContractResult, agent_api},
    },
    identity::external_agents,
};

use super::auth;

pub fn router() -> Router<AppState> {
    let mut router = Router::new();
    for prefix in ["/api/admin/external-agents", "/api/admin/hermes-agents"] {
        router = router
            .route(prefix, get(list).post(create))
            .route(
                &format!("{prefix}/{{agent_id}}/projects"),
                put(replace_projects),
            )
            .route(
                &format!("{prefix}/{{agent_id}}/pairing-code"),
                post(pairing_code),
            )
            .route(&format!("{prefix}/{{agent_id}}/rotate"), post(rotate))
            .route(&format!("{prefix}/{{agent_id}}/revoke"), post(revoke));
    }
    router
}

fn parsed<T>(result: ContractResult<T>) -> Result<T, Box<Response>> {
    match result {
        Ok(value) => Ok(value),
        Err(typed::ContractFailure::Issues(findings)) => {
            Err(Box::new(agent_api_runtime::validation(findings, false)))
        }
        Err(_) => Err(Box::new(auth::error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))),
    }
}

fn body<T>(
    headers: &HeaderMap,
    bytes: &Bytes,
    parse: fn(Option<&Value>) -> ContractResult<T>,
) -> Result<T, Box<Response>> {
    let value = auth::parsed_body(headers, bytes)?;
    parsed(parse(value.as_ref()))
}

/// The authenticated plugin: validation first, then origin, then the live session.
use crate::http::access::authorize_method as session_user;

fn respond(result: Result<Response, Box<dyn std::error::Error>>, cookies: Vec<String>) -> Response {
    let mut response = result.unwrap_or_else(|error| agent_api_runtime::failure(error, false));
    auth::append_cookies(&mut response, cookies);
    response
}

fn no_store(status: StatusCode, value: impl serde::Serialize) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(value),
    )
        .into_response()
}

fn agent_id(id: String) -> Result<String, Box<Response>> {
    parsed(agent_api::parse_agent_id_params(Some(
        &json!({"agentId": id}),
    )))
    .map(|params| params.agent_id)
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let query = match parsed(agent_api::parse_admin_list(Some(&agent_api::query_object(
        query.as_deref(),
    )))) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "GET") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        external_agents::list(database, &user, query.company_id.as_deref())
    });
    respond(
        result.map(|agents| Json(json!({"agents": agents})).into_response()),
        cookies,
    )
}

async fn create(State(state): State<AppState>, headers: HeaderMap, bytes: Bytes) -> Response {
    let request = match body(&headers, &bytes, agent_api::parse_admin_create) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        external_agents::create(
            database,
            &user,
            external_agents::CreateInput {
                name: &request.name,
                company_id: &request.company_id,
                project_ids: &request.project_ids,
                avatar_seed: request.avatar_seed.as_deref(),
            },
            Utc::now(),
        )
    });
    respond(
        result.map(|issued| no_store(StatusCode::CREATED, issued)),
        cookies,
    )
}

async fn replace_projects(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let (id, request) = match agent_id(id)
        .and_then(|id| Ok((id, body(&headers, &bytes, agent_api::parse_admin_projects)?)))
    {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "PUT") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        external_agents::replace_projects(database, &user, &id, &request.project_ids, Utc::now())
    });
    respond(
        result.map(|agent| Json(json!({"agent": agent})).into_response()),
        cookies,
    )
}

async fn pairing_code(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let id = match agent_id(id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| {
        external_agents::issue_initial_pairing(database, &user, &id, Utc::now())
    });
    respond(result.map(|code| no_store(StatusCode::OK, code)), cookies)
}

async fn rotate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let id = match agent_id(id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result =
        state.with_database(|database| external_agents::rotate(database, &user, &id, Utc::now()));
    respond(result.map(|code| no_store(StatusCode::OK, code)), cookies)
}

async fn revoke(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let id = match agent_id(id) {
        Ok(id) => id,
        Err(response) => return *response,
    };
    let (user, cookies) = match session_user(&state, &headers, "POST") {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result =
        state.with_database(|database| external_agents::revoke(database, &user, &id, Utc::now()));
    respond(
        result.map(|()| StatusCode::NO_CONTENT.into_response()),
        cookies,
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::shared::hash::sha256_hex;
    use crate::shared::time::rfc3339_millis;
    use rusqlite::params;
    use serde_json::{Value, json};

    use crate::{
        http::{AppState, routes::auth},
        identity::auth as identity_auth,
    };

    pub(crate) struct Server {
        pub base: String,
        pub state: AppState,
        pub admin_cookie: String,
        pub member_cookie: String,
        pub client: reqwest::Client,
        pub path: std::path::PathBuf,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.path.display()));
            }
        }
    }

    pub(crate) const ORIGIN: &str = "https://suplex.example.test:4111";
    pub(crate) const HOST: &str = "suplex.example.test:4111";

    /// A served app with an admin session, a member session, a company, and two projects.
    pub(crate) async fn server(state: Option<(AppState, std::path::PathBuf)>) -> Server {
        let (state, path) = state.unwrap_or_else(auth::tests::state);
        let now = chrono::Utc::now();
        let stamp = rfc3339_millis(now);
        let admin = state
            .with_database(|database| identity_auth::development_sign_in(database, now))
            .unwrap();
        state.with_database(|database| {
            let connection = database.connection();
            connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member_user', 'Member', 'user_v1_member_user', 'member', 'active', ?1, ?1, 1)", [&stamp]).unwrap();
            let hash = sha256_hex(b"member_session_token");
            connection.execute("INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('member_session', ?1, 'member_user', ?2, ?3, 1)", params![hash, (now + chrono::Duration::days(1)).to_rfc3339(), stamp]).unwrap();
            connection.execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_api', 'Agent API Company', 'active', ?1)", [&stamp]).unwrap();
            for (id, name) in [("project_api", "API Project"), ("project_api_2", "API Project 2")] {
                connection.execute("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES (?1, 'company_api', ?2, ?3, ?4, ?5, 'main', '', '', ?6, ?6)", params![id, name, format!("/tmp/{id}"), format!("/tmp/{id}-worktrees"), format!("meiji/{id}"), stamp]).unwrap();
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = crate::http::router(state.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Server {
            base,
            state,
            admin_cookie: format!("sid_v1={}", admin.session_token),
            member_cookie: "sid_v1=member_session_token".into(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            path,
            task,
        }
    }

    impl Server {
        pub(crate) async fn request(
            &self,
            method: reqwest::Method,
            path: &str,
            headers: &[(&str, &str)],
            body: Option<Value>,
        ) -> reqwest::Response {
            let mut request = self
                .client
                .request(method, format!("{}{path}", self.base))
                .header("host", HOST);
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            if let Some(body) = body {
                request = request.json(&body);
            }
            request.send().await.unwrap()
        }

        pub(crate) async fn send(
            &self,
            method: reqwest::Method,
            path: &str,
            cookie: Option<&str>,
            body: Option<Value>,
        ) -> (u16, Value) {
            let mut headers = vec![("origin", ORIGIN)];
            if let Some(cookie) = cookie {
                headers.push(("cookie", cookie));
            }
            let response = self.request(method, path, &headers, body).await;
            let status = response.status().as_u16();
            let text = response.text().await.unwrap();
            (status, serde_json::from_str(&text).unwrap_or(Value::Null))
        }
    }

    #[tokio::test]
    async fn admin_lifecycle_creates_lists_scopes_reissues_rotates_and_revokes() {
        let server = server(None).await;
        let admin = Some(server.admin_cookie.as_str());
        let (status, created) = server.send(reqwest::Method::POST, "/api/admin/external-agents", admin, Some(json!({"name": "External agent 1", "companyId": "company_api", "projectIds": ["project_api"]}))).await;
        assert_eq!(status, 201, "{created}");
        assert_eq!(
            (
                created["agent"]["name"].as_str(),
                created["agent"]["status"].as_str()
            ),
            (Some("External agent 1"), Some("pending"))
        );
        assert_eq!(created["agent"]["projectIds"], json!(["project_api"]));
        assert!(created["pairingCode"].as_str().unwrap().starts_with("fhp_"));
        let id = created["agent"]["id"].as_str().unwrap().to_owned();

        let (status, listed) = server
            .send(
                reqwest::Method::GET,
                "/api/admin/external-agents",
                admin,
                None,
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(listed["agents"].as_array().unwrap().len(), 1);
        assert!(listed["agents"][0].get("hermesProfileId").is_none());
        let (_, legacy) = server
            .send(
                reqwest::Method::GET,
                "/api/admin/hermes-agents",
                admin,
                None,
            )
            .await;
        assert_eq!(legacy, listed);

        let (status, scoped) = server
            .send(
                reqwest::Method::PUT,
                &format!("/api/admin/external-agents/{id}/projects"),
                admin,
                Some(json!({"projectIds": ["project_api", "project_api_2"]})),
            )
            .await;
        assert_eq!(
            (status, scoped["agent"]["projectIds"].clone()),
            (200, json!(["project_api", "project_api_2"]))
        );

        let (status, reissued) = server
            .send(
                reqwest::Method::POST,
                &format!("/api/admin/external-agents/{id}/pairing-code"),
                admin,
                Some(json!({})),
            )
            .await;
        assert_eq!(status, 200);
        assert_ne!(reissued["pairingCode"], created["pairingCode"]);

        let (status, paired) = server
            .send(
                reqwest::Method::POST,
                "/api/agent/pairing/exchange",
                None,
                Some(
                    json!({"pairingCode": reissued["pairingCode"], "profileId": "profile-test-1"}),
                ),
            )
            .await;
        assert_eq!(status, 200, "{paired}");
        assert_eq!(
            (
                paired["agent"]["status"].as_str(),
                paired["agent"]["profileId"].as_str()
            ),
            (Some("paired"), Some("profile-test-1"))
        );
        assert!(paired["credential"].as_str().unwrap().starts_with("fha_"));

        let (status, rotated) = server
            .send(
                reqwest::Method::POST,
                &format!("/api/admin/external-agents/{id}/rotate"),
                admin,
                Some(json!({})),
            )
            .await;
        assert_eq!(status, 200);
        let (status, _) = server
            .send(
                reqwest::Method::POST,
                "/api/agent/pair",
                None,
                Some(json!({"pairingCode": rotated["pairingCode"], "profileId": "profile-test-1"})),
            )
            .await;
        assert_eq!(status, 200);
        let (status, replay) = server
            .send(
                reqwest::Method::POST,
                "/api/hermes/pair",
                None,
                Some(json!({"pairingCode": rotated["pairingCode"]})),
            )
            .await;
        assert_eq!(
            (status, replay),
            (
                401,
                json!({"error": "Pairing failed", "code": "pairing_invalid"})
            )
        );

        let (status, _) = server
            .send(
                reqwest::Method::POST,
                &format!("/api/admin/external-agents/{id}/revoke"),
                admin,
                Some(json!({})),
            )
            .await;
        assert_eq!(status, 204);
        let (_, finally) = server
            .send(
                reqwest::Method::GET,
                "/api/admin/external-agents",
                admin,
                None,
            )
            .await;
        assert_eq!(finally["agents"][0]["status"], "revoked");
    }

    #[tokio::test]
    async fn only_live_administrators_manage_agents_and_validation_precedes_authority() {
        let server = server(None).await;
        let body =
            json!({"name": "Anon", "companyId": "company_api", "projectIds": ["project_api"]});
        assert_eq!(
            server
                .send(
                    reqwest::Method::GET,
                    "/api/admin/external-agents",
                    None,
                    None
                )
                .await
                .0,
            401
        );
        assert_eq!(
            server
                .send(
                    reqwest::Method::POST,
                    "/api/admin/external-agents",
                    None,
                    Some(body.clone())
                )
                .await
                .0,
            401
        );
        let member = Some(server.member_cookie.as_str());
        assert_eq!(
            server
                .send(
                    reqwest::Method::GET,
                    "/api/admin/external-agents",
                    member,
                    None
                )
                .await,
            (404, json!({"error": "Not found", "code": "not_found"}))
        );
        assert_eq!(
            server
                .send(
                    reqwest::Method::POST,
                    "/api/admin/external-agents",
                    member,
                    Some(body)
                )
                .await
                .0,
            404
        );
        let (status, invalid) = server
            .send(
                reqwest::Method::POST,
                "/api/admin/external-agents",
                None,
                Some(json!({"name": " "})),
            )
            .await;
        assert_eq!(status, 400);
        assert_eq!(invalid["error"], "Invalid request");
        assert!(invalid.get("code").is_none());
    }
}
