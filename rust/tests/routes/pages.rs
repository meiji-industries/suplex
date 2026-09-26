#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::database::{OpenMode, SuplexDatabase};
    use axum::body::to_bytes;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_state() -> (AppState, std::path::PathBuf) {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "suplex-rust-pages-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed)
        ));
        let database = SuplexDatabase::open(&path, OpenMode::Migrate).unwrap();
        (
            AppState::new(
                database,
                session::SessionConfig {
                    port: 4113,
                    reachable_address: "http://127.0.0.1:4113".to_owned(),
                    tailscale_exposure: "off".to_owned(),
                },
            ),
            path,
        )
    }

    #[test]
    fn oauth_request_validation_keeps_the_source_shape() {
        assert!(consent_request(None).is_none());
        assert!(
            consent_request(Some(
                "request=oauth_request_0000000000000000000000000000000x"
            ))
            .is_none()
        );
        assert_eq!(
            consent_request(Some(
                "request=oauth_request_0123456789abcdef0123456789abcdef"
            )),
            Some("oauth_request_0123456789abcdef0123456789abcdef".to_owned())
        );
    }

    #[test]
    fn application_shell_uses_the_page_view_and_built_assets() {
        let html = ui::application_page("onboarding");
        assert!(html.contains("<title>Suplex · Onboarding</title>"));
        assert!(html.contains("window.__SUPLEX_VIEW__ = \"onboarding\";"));
        assert!(html.contains("/assets/suplex-ui.js"));
        assert!(html.contains("/assets/suplex-ui.css"));
    }

    #[tokio::test]
    async fn root_and_application_pages_follow_live_session_and_project_state() {
        let (state, path) = test_state();
        let anonymous = root(State(state.clone()), HeaderMap::new()).await;
        assert_eq!(anonymous.status(), StatusCode::FOUND);
        assert_eq!(anonymous.headers().get(header::LOCATION).unwrap(), "/auth");

        let mut loopback = HeaderMap::new();
        loopback.insert(header::HOST, "127.0.0.1:4113".parse().unwrap());
        let onboarding = root(State(state.clone()), loopback.clone()).await;
        assert_eq!(onboarding.status(), StatusCode::FOUND);
        assert_eq!(
            onboarding.headers().get(header::LOCATION).unwrap(),
            "/onboarding"
        );
        assert!(
            onboarding
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count()
                >= 2
        );

        let projects = projects(State(state.clone()), loopback).await;
        assert_eq!(projects.status(), StatusCode::OK);
        let body = to_bytes(projects.into_body(), 32_768).await.unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("window.__SUPLEX_VIEW__ = \"projects\";"));
        assert!(html.contains("/assets/suplex-ui.js"));

        drop(state);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn consent_page_validates_request_before_session_and_preserves_return_path() {
        let (state, path) = test_state();
        let invalid = oauth_consent(
            State(state.clone()),
            HeaderMap::new(),
            RawQuery(Some("request=invalid".to_owned())),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(invalid.into_body(), 1024).await.unwrap();
        assert_eq!(body, "Invalid authorization request");

        let request = "oauth_request_0123456789abcdef0123456789abcdef";
        let anonymous = oauth_consent(
            State(state),
            HeaderMap::new(),
            RawQuery(Some(format!("request={request}"))),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::FOUND);
        assert_eq!(
            anonymous
                .headers()
                .get(header::LOCATION)
                .unwrap()
                .to_str()
                .unwrap(),
            format!("/auth?returnTo=%2Foauth%2Fconsent%3Frequest%3D{request}")
        );
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn denied_company_page_and_health_keep_session_cookies() {
        let (state, path) = test_state();
        let mut loopback = HeaderMap::new();
        loopback.insert(header::HOST, "127.0.0.1:4113".parse().unwrap());
        let denied = company_settings(
            State(state.clone()),
            Path("company_missing".to_owned()),
            loopback.clone(),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            denied.headers().get_all(header::SET_COOKIE).iter().count(),
            2
        );

        let page = health(State(state), loopback).await;
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers().get_all(header::SET_COOKIE).iter().count(), 2);
        let body = to_bytes(page.into_body(), 32 * 1024).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.contains("Suplex · Host health"));
        assert!(body.contains("window.__SUPLEX_HEALTH__ = {"));
        assert!(body.contains(r#"<article class="health-card" data-status="#));
        assert!(!body.contains("__SUPLEX_VIEW__"));
        let rendered = super::super::health::health_page(&serde_json::json!({
            "reachableAddress":"http://127.0.0.1:4113","ready":false,
            "checks":[{"status":"warning","label":"<Git>","summary":"</script>"}],
        }));
        assert!(rendered.contains("<h2>&lt;Git&gt;</h2><p>&lt;/script&gt;</p>"));
        assert!(rendered.contains("<p>Attention needed</p>"));
        assert!(rendered.contains(r#""summary":"\u003c/script>""#));
        let _ = std::fs::remove_file(path);
    }
}
