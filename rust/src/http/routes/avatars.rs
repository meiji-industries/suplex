//! Avatar directory, image, and update routes (`src/http/routes/avatars.ts`).

use std::error::Error;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State, rejection::BytesRejection},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;

use crate::{
    http::{
        AppState,
        contracts::typed::{self, avatars as contracts},
        validation,
    },
    identity::avatars::{self, MAX_AVATAR_IMAGE_BASE64_LENGTH},
};

use super::{auth, profiles::authorize};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/avatars", get(list)).route(
        "/api/avatars/{owner_id}",
        get(image).put(update).layer(DefaultBodyLimit::max(
            MAX_AVATAR_IMAGE_BASE64_LENGTH + 64 * 1024,
        )),
    )
}

fn with_cookies(mut response: Response, cookies: Vec<String>) -> Response {
    auth::append_cookies(&mut response, cookies);
    response
}

fn owner_params(owner_id: &str) -> Result<(), Box<Response>> {
    match contracts::parse_owner_params(Some(&json!({"ownerId": owner_id}))) {
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

async fn list(State(state): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state.with_database(|database| avatars::list(database, &user_id)) {
        Ok(avatars) => Json(json!({"avatars": avatars})).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

async fn image(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(response) = owner_params(&owner_id) {
        return *response;
    }
    let (user_id, cookies) = match authorize(&state, &headers, "GET", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let result = state.with_database(|database| -> Result<Response, Box<dyn Error>> {
        if let Some(uploaded) = avatars::image(database, &user_id, &owner_id)? {
            return Ok(
                ([(header::CONTENT_TYPE, uploaded.mime_type)], uploaded.image).into_response(),
            );
        }
        let (kind, seed) = avatars::owner(database, &user_id, &owner_id)?;
        if kind == "project"
            && let Ok(Some(favicon)) = avatars::project_favicon(database, &user_id, &owner_id)
        {
            return Ok(([(header::CONTENT_TYPE, "image/x-icon")], favicon).into_response());
        }
        Ok((
            StatusCode::FOUND,
            [(header::LOCATION, avatars::dicebear_url(kind, &seed))],
        )
            .into_response())
    });
    let mut response = match result {
        Ok(response) => response,
        Err(error) => auth::service_error(error),
    };
    let values = response.headers_mut();
    values.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    values.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    with_cookies(response, cookies)
}

async fn update(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(body) => body,
        Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error":"Request is too large","findings":[{"code":"request-too-large","field":"images","message":"Attach fewer or smaller images and submit again"}]}))).into_response();
        }
        Err(_) => return auth::error(StatusCode::BAD_REQUEST, "Invalid request"),
    };
    if let Err(response) = owner_params(&owner_id) {
        return *response;
    }
    let patch = match auth::validated_typed_body(&headers, &body, contracts::parse_update) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (user_id, cookies) = match authorize(&state, &headers, "PUT", false) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let response = match state
        .with_database(|database| avatars::update(database, &user_id, &owner_id, &patch))
    {
        Ok(record) => Json(record).into_response(),
        Err(error) => auth::service_error(error),
    };
    with_cookies(response, cookies)
}

#[cfg(test)]
pub(crate) mod tests {
    use chrono::Utc;
    use serde_json::Value;

    use super::*;
    use crate::identity::auth as identity_auth;

    // Smallest valid PNG: 1x1 transparent pixel.
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    pub(crate) const ORIGIN: &str = "https://suplex.example.test:4111";

    /// One request through the full router over HTTP; redirects are returned, not followed.
    pub(crate) async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, reqwest::header::HeaderMap, Vec<u8>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, app.clone()).into_future());
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let mut request = client
            .request(method.parse().unwrap(), format!("http://{address}{uri}"))
            .header("origin", ORIGIN);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.bytes().await.unwrap().to_vec();
        server.abort();
        (status, headers, body)
    }

    pub(crate) fn json_body(body: &[u8]) -> Value {
        serde_json::from_slice(body).unwrap()
    }

    #[tokio::test]
    async fn avatars_share_one_table_directory_and_image_route() {
        let (state, filename) = auth::tests::state();
        let now = Utc::now();
        let time = now.to_rfc3339();
        let admin = state
            .with_database(|database| identity_auth::development_sign_in(database, now))
            .unwrap();
        let root = std::env::temp_dir().join(format!("suplex-avatars-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("repo/public")).unwrap();
        std::fs::write(root.join("repo/public/favicon.ico"), b"icon").unwrap();
        let member_token = state.with_database(|database| {
            let connection = database.connection();
            connection.execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_avatar', 'Avatar Company', 'active', ?1)", [&time]).unwrap();
            connection.execute("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project_avatar', 'company_avatar', 'Avatar Project', ?1, ?2, 'meiji/avatar', 'main', '', '', ?3, ?3)", rusqlite::params![root.join("repo").to_str().unwrap(), root.join("worktrees").to_str().unwrap(), time]).unwrap();
            connection.execute("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member', 'Member', 'member', 'member', 'active', ?1, ?1, 1)", [&time]).unwrap();
            identity_auth::create_session(database, "member", now).unwrap()
        });
        let app = crate::http::router(state.clone());
        let admin_cookie = format!("sid_v1={}", admin.session_token);
        let member_cookie = format!("sid_v1={member_token}");
        let admin_cookie = Some(admin_cookie.as_str());
        let member_cookie = Some(member_cookie.as_str());

        let (status, _, body) = call(&app, "GET", "/api/avatars", admin_cookie, None).await;
        assert_eq!(
            (status, json_body(&body)),
            (StatusCode::OK, json!({"avatars":{}}))
        );

        let (_, _, body) = call(
            &app,
            "PUT",
            "/api/avatars/company_avatar",
            admin_cookie,
            Some(json!({"shape":"circle"})),
        )
        .await;
        assert_eq!(
            json_body(&body),
            json!({"shape":"circle","imageVersion":null})
        );

        let image = json!({"image":{"mimeType":"image/png","base64":PNG}});
        let (status, _, body) = call(
            &app,
            "PUT",
            "/api/avatars/project_avatar",
            admin_cookie,
            Some(image.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let body = json_body(&body);
        assert_eq!(body["shape"], Value::Null);
        assert!(body["imageVersion"].is_string());
        let own = json!({"shape":"square","image":{"mimeType":"image/png","base64":PNG}});
        assert_eq!(
            call(&app, "PUT", "/api/avatars/member", member_cookie, Some(own))
                .await
                .0,
            StatusCode::OK
        );

        let (status, headers, body) = call(
            &app,
            "GET",
            "/api/avatars/project_avatar",
            admin_cookie,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], "image/png");
        assert_eq!(headers[header::CACHE_CONTROL], "private, max-age=3600");
        use base64::Engine;
        assert_eq!(
            body,
            base64::engine::general_purpose::STANDARD
                .decode(PNG)
                .unwrap()
        );
        let (status, headers, _) = call(
            &app,
            "GET",
            &format!("/api/avatars/{}", admin.user.id),
            admin_cookie,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FOUND);
        assert!(
            headers[header::LOCATION]
                .to_str()
                .unwrap()
                .contains("pixel-art-neutral")
        );

        let (_, _, body) = call(&app, "GET", "/api/avatars", admin_cookie, None).await;
        let mut owners = json_body(&body)["avatars"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        owners.sort();
        assert_eq!(owners, ["company_avatar", "member", "project_avatar"]);

        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/avatars/company_avatar",
                member_cookie,
                Some(json!({"shape":"square"}))
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                &format!("/api/avatars/{}", admin.user.id),
                member_cookie,
                Some(json!({"shape":"square"}))
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                "/api/avatars/nobody",
                admin_cookie,
                Some(json!({"shape":"square"}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let bad = json!({"image":{"mimeType":"image/png","base64":"bm90IGEgcG5n"}});
        let (status, _, body) = call(
            &app,
            "PUT",
            "/api/avatars/project_avatar",
            admin_cookie,
            Some(bad),
        )
        .await;
        assert_eq!(
            (status, json_body(&body)["code"].clone()),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                json!("invalid-image-data")
            )
        );
        assert_eq!(
            call(&app, "GET", "/api/avatars/project_avatar", None, None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let (status, _, body) = call(
            &app,
            "PUT",
            "/api/avatars/project_avatar",
            admin_cookie,
            Some(json!({"shape":"oval"})),
        )
        .await;
        assert_eq!(
            (status, json_body(&body)["findings"][0]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(".shape"))
        );

        let (_, _, body) = call(
            &app,
            "PUT",
            "/api/avatars/project_avatar",
            admin_cookie,
            Some(json!({"image":null})),
        )
        .await;
        assert_eq!(json_body(&body), json!({"shape":null,"imageVersion":null}));
        let (_, _, body) = call(&app, "GET", "/api/avatars", admin_cookie, None).await;
        assert!(json_body(&body)["avatars"].get("project_avatar").is_none());
        // A project without an upload serves its repository favicon.
        let (status, headers, body) = call(
            &app,
            "GET",
            "/api/avatars/project_avatar",
            admin_cookie,
            None,
        )
        .await;
        assert_eq!(
            (
                status,
                headers[header::CONTENT_TYPE].to_str().unwrap(),
                body.as_slice()
            ),
            (StatusCode::OK, "image/x-icon", b"icon".as_slice())
        );

        drop(app);
        drop(state);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_file(&filename);
    }
}
