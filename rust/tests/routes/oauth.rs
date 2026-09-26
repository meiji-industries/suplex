#[cfg(test)]
pub(crate) mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    use crate::http::routes::external_agent_administration::tests::{HOST, ORIGIN, Server, server};

    pub(crate) const REDIRECT: &str = "http://127.0.0.1:9317/callback";
    pub(crate) const RESOURCE: &str = "https://suplex.example.test:4111/mcp";
    const CSRF: &str = "csrf-token-0123456789abcdefghijklmnopqrstuvwxyz";

    fn challenge(verifier: &str) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    }

    fn query_value(url: &str, name: &str) -> Option<String> {
        let parsed = url::Url::parse(url)
            .or_else(|_| url::Url::parse(&format!("https://base{url}")))
            .unwrap();
        parsed
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }

    pub(crate) async fn register(server: &Server, name: &str) -> String {
        let (status, client) = server
            .send(reqwest::Method::POST, "/oauth/register", None, Some(json!({"client_name": name, "redirect_uris": [REDIRECT], "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "token_endpoint_auth_method": "none", "client_uri": "https://claude.ai", "scope": "suplex:mcp"})))
            .await;
        assert_eq!(status, 201, "{client}");
        client["client_id"].as_str().unwrap().to_owned()
    }

    fn authorize_path(client_id: &str, verifier: &str, state: &str) -> String {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (name, value) in [
            ("client_id", client_id),
            ("redirect_uri", REDIRECT),
            ("response_type", "code"),
            ("state", state),
            ("scope", "suplex:mcp"),
            ("resource", RESOURCE),
            ("code_challenge", &challenge(verifier)),
            ("code_challenge_method", "S256"),
        ] {
            serializer.append_pair(name, value);
        }
        format!("/oauth/authorize?{}", serializer.finish())
    }

    pub(crate) fn session(server: &Server) -> String {
        format!("{}; csrf_v1={CSRF}", server.admin_cookie)
    }

    async fn start(server: &Server, client_id: &str, verifier: &str, state: &str) -> String {
        let cookie = session(server);
        let started = server
            .request(
                reqwest::Method::GET,
                &authorize_path(client_id, verifier, state),
                &[("cookie", &cookie)],
                None,
            )
            .await;
        assert_eq!(started.status(), 302);
        query_value(started.headers()["location"].to_str().unwrap(), "request").unwrap()
    }

    pub(crate) async fn authorize(
        server: &Server,
        client_id: &str,
        verifier: &str,
        state: &str,
    ) -> String {
        let request = start(server, client_id, verifier, state).await;
        let cookie = session(server);
        let consent = server
            .request(
                reqwest::Method::GET,
                &format!("/api/oauth/consent/{request}"),
                &[("cookie", &cookie)],
                None,
            )
            .await;
        assert_eq!(consent.status(), 200);
        assert_eq!(consent.headers()["referrer-policy"], "no-referrer");
        let consent = consent.json::<Value>().await.unwrap();
        assert_eq!(
            (
                consent["redirectOrigin"].as_str(),
                consent["scope"].as_str()
            ),
            (Some("http://127.0.0.1:9317"), Some("suplex:mcp"))
        );
        let approval = server
            .request(
                reqwest::Method::POST,
                &format!("/api/oauth/consent/{request}/approve"),
                &[("cookie", &cookie), ("origin", ORIGIN), ("x-csrf-v1", CSRF)],
                Some(json!({"companyId": "company_api", "projectIds": ["project_api"]})),
            )
            .await;
        assert_eq!(approval.status(), 200);
        let target = approval.json::<Value>().await.unwrap()["redirectTo"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(query_value(&target, "state").as_deref(), Some(state));
        assert_eq!(
            query_value(&target, "iss").as_deref(),
            Some("https://suplex.example.test:4111")
        );
        query_value(&target, "code").unwrap()
    }

    pub(crate) async fn form(server: &Server, path: &str, fields: &[(&str, &str)]) -> (u16, Value) {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields)
            .finish();
        let response = server
            .client
            .post(format!("{}{path}", server.base))
            .header("host", HOST)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (
            status,
            response.json::<Value>().await.unwrap_or(Value::Null),
        )
    }

    pub(crate) async fn exchange(
        server: &Server,
        client_id: &str,
        code: &str,
        verifier: &str,
    ) -> (u16, Value) {
        form(
            server,
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("client_id", client_id),
                ("redirect_uri", REDIRECT),
                ("resource", RESOURCE),
                ("code_verifier", verifier),
            ],
        )
        .await
    }

    async fn mcp_status(server: &Server, token: &str) -> u16 {
        let bearer = format!("Bearer {token}");
        let initialize = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}});
        server
            .request(
                reqwest::Method::POST,
                "/mcp",
                &[
                    ("authorization", bearer.as_str()),
                    ("accept", "application/json, text/event-stream"),
                ],
                Some(initialize),
            )
            .await
            .status()
            .as_u16()
    }

    fn agent_of(server: &Server, client_id: &str) -> String {
        server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT agent_id FROM suplex_oauth_grants WHERE client_id = ?1",
                    [client_id],
                    |row| row.get(0),
                )
                .unwrap()
        })
    }

    fn revoke_agent(server: &Server, agent_id: &str) {
        let admin = server.state.with_database(|database| {
            database
                .connection()
                .query_row(
                    "SELECT id FROM suplex_users WHERE role = 'admin'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        });
        server
            .state
            .with_database(|database| {
                crate::identity::external_agents::revoke(
                    database,
                    &admin,
                    agent_id,
                    chrono::Utc::now(),
                )
            })
            .unwrap();
    }

    #[tokio::test]
    async fn discovery_registration_consent_pkce_rotation_replay_revocation_and_reapproval() {
        let server = server(None).await;
        let (status, metadata) = server
            .send(
                reqwest::Method::GET,
                "/.well-known/oauth-protected-resource/mcp",
                None,
                None,
            )
            .await;
        assert_eq!(
            (status, metadata["resource"].as_str()),
            (200, Some(RESOURCE))
        );
        let anonymous = server
            .request(reqwest::Method::POST, "/mcp", &[], Some(json!({})))
            .await;
        assert_eq!(anonymous.status(), 401);
        assert!(
            anonymous.headers()["www-authenticate"]
                .to_str()
                .unwrap()
                .contains("oauth-protected-resource/mcp")
        );

        let client = register(&server, "Claude").await;
        let verifier = "v".repeat(43);
        let code = authorize(&server, &client, &verifier, "opaque-state").await;
        let (status, wrong) = exchange(&server, &client, &code, &"w".repeat(43)).await;
        assert_eq!(
            (status, wrong["error"].as_str()),
            (400, Some("invalid_grant"))
        );
        assert_eq!(
            exchange(&server, "oauth_client_wrong", &code, &verifier)
                .await
                .0,
            400
        );
        let (status, tokens) = exchange(&server, &client, &code, &verifier).await;
        assert_eq!(
            (
                status,
                tokens["token_type"].as_str(),
                tokens["expires_in"].as_i64()
            ),
            (200, Some("Bearer"), Some(3600)),
            "{tokens}"
        );
        assert_eq!(exchange(&server, &client, &code, &verifier).await.0, 400);
        let first_refresh = tokens["refresh_token"].as_str().unwrap().to_owned();

        let (status, expanded) = form(
            &server,
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &first_refresh),
                ("client_id", &client),
                ("resource", RESOURCE),
                ("scope", "suplex:mcp suplex:admin"),
            ],
        )
        .await;
        assert_eq!(
            (status, expanded["error"].as_str()),
            (400, Some("invalid_scope"))
        );
        let (status, rotated) = form(
            &server,
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &first_refresh),
                ("client_id", &client),
                ("resource", RESOURCE),
                ("scope", "suplex:mcp"),
                ("extension", "ignored"),
            ],
        )
        .await;
        assert_eq!(status, 200, "{rotated}");
        assert_eq!(
            form(
                &server,
                "/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &first_refresh),
                    ("client_id", &client),
                    ("resource", RESOURCE)
                ]
            )
            .await
            .0,
            400
        );
        assert_eq!(
            mcp_status(&server, rotated["access_token"].as_str().unwrap()).await,
            401
        );

        let agent = agent_of(&server, &client);
        let active = authorize(&server, &client, &verifier, "active-before-revoke").await;
        let (_, active_tokens) = exchange(&server, &client, &active, &verifier).await;
        revoke_agent(&server, &agent);
        assert_eq!(
            form(
                &server,
                "/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    (
                        "refresh_token",
                        active_tokens["refresh_token"].as_str().unwrap()
                    ),
                    ("client_id", &client),
                    ("resource", RESOURCE)
                ]
            )
            .await
            .0,
            400
        );
        let again = authorize(&server, &client, &verifier, "reapprove").await;
        assert_eq!(exchange(&server, &client, &again, &verifier).await.0, 200);
        assert_eq!(agent_of(&server, &client), agent);
        let outstanding = authorize(&server, &client, &verifier, "outstanding").await;
        revoke_agent(&server, &agent);
        let fresh = authorize(&server, &client, &verifier, "fresh").await;
        assert_eq!(
            exchange(&server, &client, &outstanding, &verifier).await.0,
            400
        );
        assert_eq!(exchange(&server, &client, &fresh, &verifier).await.0, 200);
    }

    #[tokio::test]
    async fn denial_keeps_state_and_consent_needs_csrf_admin_and_session() {
        let server = server(None).await;
        let client = register(&server, "Claude").await;
        let verifier = "v".repeat(43);
        let request = start(&server, &client, &verifier, "deny-state").await;
        let page = server
            .request(
                reqwest::Method::GET,
                &format!("/oauth/consent?request={request}"),
                &[],
                None,
            )
            .await;
        assert_eq!(page.status(), 302);
        assert_eq!(
            page.headers()["location"],
            format!("/auth?returnTo=%2Foauth%2Fconsent%3Frequest%3D{request}").as_str()
        );
        let cookie = session(&server);
        let no_csrf = server
            .request(
                reqwest::Method::POST,
                &format!("/api/oauth/consent/{request}/approve"),
                &[("cookie", &cookie), ("origin", ORIGIN)],
                Some(json!({"companyId": "company_api", "projectIds": ["project_api"]})),
            )
            .await;
        assert_eq!(no_csrf.status(), 403);
        let member = format!("{}; csrf_v1={CSRF}", server.member_cookie);
        let non_admin = server
            .request(
                reqwest::Method::POST,
                &format!("/api/oauth/consent/{request}/approve"),
                &[("cookie", &member), ("origin", ORIGIN), ("x-csrf-v1", CSRF)],
                Some(json!({"companyId": "company_api", "projectIds": ["project_api"]})),
            )
            .await;
        assert_eq!(non_admin.status(), 403);
        let grants: i64 = server.state.with_database(|database| {
            database
                .connection()
                .query_row("SELECT COUNT(*) FROM suplex_oauth_grants", [], |row| {
                    row.get(0)
                })
                .unwrap()
        });
        assert_eq!(grants, 0);
        let denied = server
            .request(
                reqwest::Method::POST,
                &format!("/api/oauth/consent/{request}/deny"),
                &[("cookie", &cookie), ("origin", ORIGIN), ("x-csrf-v1", CSRF)],
                Some(json!({})),
            )
            .await;
        let target = denied.json::<Value>().await.unwrap()["redirectTo"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            (
                query_value(&target, "error").as_deref(),
                query_value(&target, "state").as_deref()
            ),
            (Some("access_denied"), Some("deny-state"))
        );
        let invalid = server.request(reqwest::Method::GET, "/oauth/authorize?client_id=missing&redirect_uri=x&response_type=code&resource=r&code_challenge=c&code_challenge_method=S256", &[], None).await;
        assert_eq!(invalid.status(), 400);
        assert_eq!(
            invalid.json::<Value>().await.unwrap(),
            json!({"error": "invalid_request", "error_description": "Client or redirect URI is invalid"})
        );
    }

    #[tokio::test]
    async fn bearer_checks_follow_live_host_authority_grants_and_token_state() {
        let server = server(None).await;
        let client = register(&server, "Claude").await;
        let verifier = "p".repeat(43);
        let code = authorize(&server, &client, &verifier, "state").await;
        let token = exchange(&server, &client, &code, &verifier).await.1["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let bearer = format!("Bearer {token}");
        let wrong_host = server
            .client
            .post(format!("{}/mcp", server.base))
            .header("host", "attacker.test")
            .header("authorization", &bearer)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_host.status(), 403);
        let wrong_origin = server
            .request(
                reqwest::Method::POST,
                "/mcp",
                &[
                    ("origin", "https://attacker.test"),
                    ("authorization", &bearer),
                ],
                Some(json!({})),
            )
            .await;
        assert_eq!(wrong_origin.status(), 403);
        let malformed = server
            .request(
                reqwest::Method::POST,
                "/mcp",
                &[("authorization", "Bearer wrong")],
                Some(json!({})),
            )
            .await;
        assert_eq!(malformed.status(), 401);
        assert!(
            malformed.headers()["www-authenticate"]
                .to_str()
                .unwrap()
                .contains("resource_metadata")
        );
        assert_eq!(mcp_status(&server, &token).await, 200);
        let oauth =
            crate::identity::oauth::OAuth::new(&server.state.session_config.reachable_address);
        let agent = agent_of(&server, &client);
        server.state.with_database(|database| database.connection().execute("UPDATE suplex_external_agents SET client_profile_id = 'missing-profile' WHERE id = ?1", [&agent]).unwrap());
        let principal = server
            .state
            .with_database(|database| {
                oauth.authenticate_access_token(database, &token, chrono::Utc::now())
            })
            .unwrap();
        assert_eq!(
            (
                principal.agent_id.as_str(),
                principal.profile_id.as_deref(),
                principal.project_ids.as_slice()
            ),
            (
                agent.as_str(),
                Some("missing-profile"),
                ["project_api".to_owned()].as_slice()
            )
        );
        server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_users SET role = 'member' WHERE role = 'admin'",
                    [],
                )
                .unwrap()
        });
        assert!(
            server
                .state
                .with_database(|database| oauth.authenticate_access_token(
                    database,
                    &token,
                    chrono::Utc::now()
                ))
                .is_err()
        );
        server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_users SET role = 'admin' WHERE id <> 'member_user'",
                    [],
                )
                .unwrap()
        });
        assert_eq!(mcp_status(&server, &token).await, 200);
        server.state.with_database(|database| {
            database
                .connection()
                .execute(
                    "UPDATE suplex_oauth_access_tokens SET expires_at = '1970-01-01T00:00:00.000Z'",
                    [],
                )
                .unwrap()
        });
        assert_eq!(mcp_status(&server, &token).await, 401);
        let fresh = authorize(&server, &client, &verifier, "revoke-endpoint").await;
        let fresh_token = exchange(&server, &client, &fresh, &verifier).await.1["access_token"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            form(
                &server,
                "/oauth/revoke",
                &[("token", &fresh_token), ("client_id", &client)]
            )
            .await
            .0,
            200
        );
        assert_eq!(mcp_status(&server, &fresh_token).await, 401);
        assert_eq!(
            server
                .request(reqwest::Method::GET, "/mcp", &[], None)
                .await
                .status(),
            405
        );
    }

    #[tokio::test]
    async fn same_named_clients_stay_isolated_and_registration_throttles_per_source() {
        let server = server(None).await;
        let verifier = "n".repeat(43);
        let first = register(&server, "Claude").await;
        let second = register(&server, "Claude").await;
        for (client, state) in [(&first, "first"), (&second, "second")] {
            let code = authorize(&server, client, &verifier, state).await;
            assert_eq!(exchange(&server, client, &code, &verifier).await.0, 200);
        }
        let names: Vec<String> = server.state.with_database(|database| {
            let mut statement = database.connection().prepare("SELECT a.name FROM suplex_oauth_grants g JOIN suplex_agents a ON a.id = g.agent_id").unwrap();
            statement.query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        });
        assert_eq!(names.len(), 2);
        assert_ne!(names[0], names[1]);
        for _ in 2..20 {
            register(&server, "Rate test").await;
        }
        let (status, limited) = server
            .send(
                reqwest::Method::POST,
                "/oauth/register",
                None,
                Some(json!({"client_name": "Rate test", "redirect_uris": [REDIRECT]})),
            )
            .await;
        assert_eq!(
            (status, limited["error"].as_str()),
            (429, Some("temporarily_unavailable"))
        );
        server
            .state
            .oauth_registrations
            .lock()
            .unwrap()
            .insert("192.0.2.2".into(), Vec::new());
        assert!(super::throttle(&server.state, "192.0.2.2").is_ok());
    }
}
