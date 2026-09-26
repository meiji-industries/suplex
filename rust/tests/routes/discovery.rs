#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::routes::external_agent_administration::tests::server;

    /// Ports `tests/discovery-artifacts.test.ts` and the public half of the machine-discovery journey.
    #[tokio::test]
    async fn public_artifacts_are_anonymous_secret_free_and_name_closed_runtime_routes() {
        let server = server(None).await;
        let paths = [
            "/llms.txt",
            "/.well-known/suplex/api-catalog.json",
            "/.well-known/suplex/agent-skills.json",
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-authorization-server",
        ];
        for path in paths {
            let response = server.request(reqwest::Method::GET, path, &[], None).await;
            assert_eq!(response.status(), 200, "{path}");
            assert_eq!(response.headers()["cache-control"], "public, max-age=300");
            let body = response.text().await.unwrap();
            for secret in ["fha_", "fhp_", "foa_", "for_", "sid_v1", "Bearer fha"] {
                assert!(!body.contains(secret), "{path} contains {secret}");
            }
        }
        let text = server
            .request(reqwest::Method::GET, "/llms.txt", &[], None)
            .await
            .text()
            .await
            .unwrap();
        assert!(
            text.starts_with("# Suplex\n")
                && text.contains("Read /api/agent/openapi.json after pairing")
        );
        let (_, catalog) = server
            .send(
                reqwest::Method::GET,
                "/.well-known/suplex/api-catalog.json",
                None,
                None,
            )
            .await;
        assert_eq!(catalog["pairing"][0]["path"], "/api/agent/pairing/exchange");
        let (_, resource) = server
            .send(
                reqwest::Method::GET,
                "/.well-known/oauth-protected-resource/mcp",
                None,
                None,
            )
            .await;
        assert_eq!(
            resource,
            json!({"resource": "https://suplex.example.test:4111/mcp", "authorization_servers": ["https://suplex.example.test:4111"], "scopes_supported": ["suplex:mcp"], "bearer_methods_supported": ["header"]})
        );
        for entry in catalog["runtime"].as_array().unwrap() {
            let path = entry["path"]
                .as_str()
                .unwrap()
                .replace("{taskId}", "task_missing");
            let method =
                reqwest::Method::from_bytes(entry["method"].as_str().unwrap().as_bytes()).unwrap();
            let body = (method != reqwest::Method::GET).then(|| json!({}));
            let (status, _) = server.send(method.clone(), &path, None, body).await;
            assert_eq!(status, 401, "{method} {path}");
        }
    }
}
