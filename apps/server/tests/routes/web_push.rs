#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::*;
    use crate::http::routes::avatars::tests::{call, json_body};

    #[tokio::test]
    async fn key_and_subscriptions_belong_to_the_session_user() {
        let (state, filename) = auth::tests::state();
        let now = Utc::now();
        let admin = auth::tests::operator_account(&state, now);
        let member = state.with_database(|database| {
            database.connection().execute("INSERT INTO suplex_users (id,display_name,username,role,status,created_at,updated_at,identity_version) VALUES ('push_member','Member','push-member','member','active',?1,?1,1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('push_company','Push','active',?1)", [now.to_rfc3339()]).unwrap();
            database.connection().execute("INSERT INTO suplex_memberships (user_id,company_id,created_at) VALUES ('push_member','push_company',?1)", [now.to_rfc3339()]).unwrap();
            auth::tests::verified_session(database, "push_member", now).unwrap()
        });
        auth::tests::require_remote_login(&state);
        let app = crate::http::router(state.clone());
        let admin = format!("sid_v1={admin}");
        let member = format!("sid_v1={member}");
        let (admin, member) = (Some(admin.as_str()), Some(member.as_str()));

        assert_eq!(call(&app, "GET", "/api/web-push/key", None, None).await.0, StatusCode::UNAUTHORIZED);
        let (status, headers, body) = call(&app, "GET", "/api/web-push/key", admin, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[CACHE_CONTROL], "private, no-store");
        let key = json_body(&body)["publicKey"].as_str().unwrap().to_owned();
        let (status, _, body) = call(&app, "GET", "/api/web-push/key", member, None).await;
        assert_eq!((status, json_body(&body)["publicKey"].clone()), (StatusCode::OK, json!(key)), "{}", String::from_utf8_lossy(&body));

        let p256dh = web_push::VapidKey::generate().public_base64url();
        let subscribe = |endpoint: &str| json!({"endpoint": endpoint, "expirationTime": null, "keys": {"p256dh": p256dh, "auth": "BTBZMqHH6r4Tts7J_aSIgg"}});
        assert_eq!(call(&app, "PUT", "/api/web-push/subscription", None, Some(subscribe("https://web.push.apple.com/a"))).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(call(&app, "PUT", "/api/web-push/subscription", admin, Some(subscribe("https://web.push.apple.com/admin"))).await.0, StatusCode::NO_CONTENT);
        assert_eq!(call(&app, "PUT", "/api/web-push/subscription", member, Some(subscribe("https://web.push.apple.com/member"))).await.0, StatusCode::NO_CONTENT);
        let (status, _, body) = call(&app, "PUT", "/api/web-push/subscription", member, Some(subscribe("https://evil.example/"))).await;
        assert_eq!((status, json_body(&body)["error"].clone()), (StatusCode::BAD_REQUEST, json!("Push subscription is invalid")));
        assert_eq!(call(&app, "PUT", "/api/web-push/subscription", member, Some(json!({"endpoint": "https://web.push.apple.com/x"}))).await.0, StatusCode::BAD_REQUEST);

        // A user cannot delete another user's subscription; deleting an unknown endpoint succeeds.
        assert_eq!(call(&app, "DELETE", "/api/web-push/subscription", member, Some(json!({"endpoint": "https://web.push.apple.com/admin"}))).await.0, StatusCode::NO_CONTENT);
        assert_eq!(call(&app, "DELETE", "/api/web-push/subscription", member, Some(json!({"endpoint": "https://web.push.apple.com/member"}))).await.0, StatusCode::NO_CONTENT);
        let rows = state.with_database(|database| {
            let mut statement = database.connection().prepare("SELECT endpoint FROM suplex_web_push_subscriptions ORDER BY endpoint").unwrap();
            statement.query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        });
        assert_eq!(rows, ["https://web.push.apple.com/admin"]);
        drop(app);
        drop(state);
        let _ = std::fs::remove_file(filename);
    }
}
