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
