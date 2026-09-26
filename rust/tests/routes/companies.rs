#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::validation::{test_body, test_path};
    use axum::{body::Bytes, extract::Path};
    use serde_json::json;

    // The handlers validate their params and body in extractors; these
    // adapters run that validation for direct calls.
    async fn get_company(state: State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
        match test_path(json!({"companyId": id})) {
            Ok(path) => super::get_company(state, headers, path).await,
            Err(response) => *response,
        }
    }

    async fn create(state: State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
        match test_body(&headers, &body) {
            Ok(body) => super::create(state, headers, body).await,
            Err(response) => *response,
        }
    }

    async fn status(
        state: State<AppState>,
        headers: HeaderMap,
        Path((company_id, status)): Path<(String, String)>,
    ) -> Response {
        match test_path(json!({"companyId": company_id, "status": status})) {
            Ok(path) => super::status(state, headers, path).await,
            Err(response) => *response,
        }
    }

    async fn remove_membership(
        state: State<AppState>,
        headers: HeaderMap,
        Path((company_id, user_id)): Path<(String, String)>,
    ) -> Response {
        match test_path(json!({"companyId": company_id, "userId": user_id})) {
            Ok(path) => super::remove_membership(state, headers, path).await,
            Err(response) => *response,
        }
    }

    macro_rules! company_body {
        ($($name:ident),*) => {$(
            async fn $name(
                state: State<AppState>,
                headers: HeaderMap,
                Path(id): Path<String>,
                body: Bytes,
            ) -> Response {
                let path = match test_path(json!({"companyId": id})) {
                    Ok(path) => path,
                    Err(response) => return *response,
                };
                match test_body(&headers, &body) {
                    Ok(body) => super::$name(state, headers, path, body).await,
                    Err(response) => *response,
                }
            }
        )*};
    }

    company_body!(rename, issue_code, add_membership);
    use crate::shared::time::{now_millis_rfc3339, rfc3339_millis};
    use crate::{
        identity::auth,
        platform::database::{OpenMode, SuplexDatabase},
    };
    use axum::{body::to_bytes, http::HeaderValue};
    use sha2::{Digest, Sha256};

    #[tokio::test]
    async fn company_routes_apply_live_user_and_membership_scope() {
        let filename = std::env::temp_dir().join(format!(
            "suplex_company_route_{}_{}.sqlite",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let admin = auth::development_sign_in(&mut database, Utc::now()).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at, identity_version) VALUES ('member_route', 'Member', 'user_v1_member_route', 'member', 'active', ?1, ?1, 1)",
            [Utc::now().to_rfc3339()],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company_route', 'Route Company', 'active', ?1)",
            [Utc::now().to_rfc3339()],
        ).unwrap();
        let member_token = "member_route_token";
        let member_hash = Sha256::digest(member_token.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        database.connection().execute(
            "INSERT INTO suplex_sessions (id, token_hash, user_id, expires_at, created_at, token_version) VALUES ('member_route_session', ?1, 'member_route', ?2, ?3, 1)",
            rusqlite::params![member_hash, rfc3339_millis(Utc::now() + chrono::Duration::days(1)), now_millis_rfc3339()],
        ).unwrap();
        let state = AppState::new(
            database,
            session::SessionConfig {
                port: 4111,
                reachable_address: "https://suplex.example.test:4111".to_owned(),
                tailscale_exposure: "serve".to_owned(),
            },
        );
        let anonymous = HeaderMap::new();
        assert_eq!(
            list(State(state.clone()), anonymous).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let mut admin_headers = HeaderMap::new();
        admin_headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        admin_headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("sid_v1={}", admin.session_token)).unwrap(),
        );
        admin_headers.insert("content-type", HeaderValue::from_static("application/json"));
        let existing = get_company(
            State(state.clone()),
            admin_headers.clone(),
            Path("company_route".to_owned()),
        )
        .await;
        assert_eq!(existing.status(), StatusCode::OK);
        assert_eq!(
            get_company(
                State(state.clone()),
                admin_headers.clone(),
                Path("missing".to_owned())
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            create(
                State(state.clone()),
                admin_headers.clone(),
                Bytes::from_static(br#"{"name":"API A"}"#)
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        admin_headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        let created = create(
            State(state.clone()),
            admin_headers.clone(),
            Bytes::from_static(br#"{"name":"API A"}"#),
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED);
        let created_body =
            String::from_utf8(to_bytes(created.into_body(), 4096).await.unwrap().to_vec()).unwrap();
        let created_json: serde_json::Value = serde_json::from_str(&created_body).unwrap();
        let created_at = created_json["createdAt"].as_str().unwrap();
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(created_at)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            created_at
        );
        assert!(created_at.ends_with('Z'));
        let normalized = created_body
            .replace(created_json["id"].as_str().unwrap(), "company_ID")
            .replace(created_json["createdAt"].as_str().unwrap(), "TIMESTAMP");
        assert_eq!(
            normalized,
            r#"{"id":"company_ID","name":"API A","status":"active","issueCode":null,"createdAt":"TIMESTAMP"}"#
        );
        let created_id = created_json["id"].as_str().unwrap().to_owned();
        let mut member_headers = HeaderMap::new();
        member_headers.insert("host", HeaderValue::from_static("suplex.example.test:4111"));
        member_headers.insert(
            "cookie",
            HeaderValue::from_static("sid_v1=member_route_token"),
        );
        member_headers.insert(
            "origin",
            HeaderValue::from_static("https://suplex.example.test:4111"),
        );
        member_headers.insert("content-type", HeaderValue::from_static("application/json"));
        assert_eq!(
            get_company(
                State(state.clone()),
                member_headers.clone(),
                Path("company_route".to_owned())
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            create(
                State(state.clone()),
                member_headers.clone(),
                Bytes::from_static(br#"{"name":"Member New"}"#)
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            list(State(state.clone()), member_headers.clone())
                .await
                .status(),
            StatusCode::OK
        );
        let mut invalid_headers = admin_headers.clone();
        invalid_headers.remove("origin");
        let invalid_name = rename(
            State(state.clone()),
            invalid_headers.clone(),
            Path(created_id.clone()),
            Bytes::from_static(br#"{"name":42}"#),
        )
        .await;
        assert_eq!(invalid_name.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            rename(
                State(state.clone()),
                invalid_headers,
                Path(created_id.clone()),
                Bytes::from_static(br#"{"name":"No origin"}"#),
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        let renamed = rename(
            State(state.clone()),
            admin_headers.clone(),
            Path(created_id.clone()),
            Bytes::from_static(br#"{"name":"  API A renamed  "}"#),
        )
        .await;
        assert_eq!(renamed.status(), StatusCode::OK);
        let renamed_body = to_bytes(renamed.into_body(), 4096).await.unwrap();
        let renamed_raw = String::from_utf8(renamed_body.to_vec()).unwrap();
        assert!(renamed_raw.contains(&format!(r#""createdAt":"{created_at}""#)));
        assert_eq!(
            renamed_raw
                .replace(&created_id, "company_ID")
                .replace(created_json["createdAt"].as_str().unwrap(), "TIMESTAMP"),
            r#"{"id":"company_ID","name":"API A renamed","status":"active","issueCode":null,"createdAt":"TIMESTAMP"}"#
        );
        let code = issue_code(
            State(state.clone()),
            admin_headers.clone(),
            Path(created_id.clone()),
            Bytes::from_static(br#"{"issueCode":" ad4m "}"#),
        )
        .await;
        assert_eq!(code.status(), StatusCode::OK);
        let code_body = to_bytes(code.into_body(), 4096).await.unwrap();
        let code_raw = String::from_utf8(code_body.to_vec()).unwrap();
        assert!(code_raw.contains(&format!(r#""createdAt":"{created_at}""#)));
        assert_eq!(
            code_raw
                .replace(&created_id, "company_ID")
                .replace(created_json["createdAt"].as_str().unwrap(), "TIMESTAMP"),
            r#"{"id":"company_ID","name":"API A renamed","status":"active","issueCode":"AD4M","createdAt":"TIMESTAMP"}"#
        );
        let paused = status(
            State(state.clone()),
            admin_headers.clone(),
            Path((created_id.clone(), "paused".to_owned())),
        )
        .await;
        assert_eq!(paused.status(), StatusCode::OK);
        let joined = add_membership(
            State(state.clone()),
            admin_headers.clone(),
            Path(created_id.clone()),
            Bytes::from_static(br#"{"userId":"member_route"}"#),
        )
        .await;
        assert_eq!(joined.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            get_company(
                State(state.clone()),
                member_headers.clone(),
                Path(created_id.clone())
            )
            .await
            .status(),
            StatusCode::OK
        );
        let duplicate = add_membership(
            State(state.clone()),
            admin_headers.clone(),
            Path(created_id.clone()),
            Bytes::from_static(br#"{"userId":"member_route"}"#),
        )
        .await;
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        let removed = remove_membership(
            State(state.clone()),
            admin_headers,
            Path((created_id.clone(), "member_route".to_owned())),
        )
        .await;
        assert_eq!(removed.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            get_company(State(state.clone()), member_headers, Path(created_id))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        drop(state);
        let _ = std::fs::remove_file(&filename);
        let _ = std::fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(filename.with_extension("sqlite-shm"));
    }
}
