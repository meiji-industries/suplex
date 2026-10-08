#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use reqwest::header;

    use crate::http::routes::{auth, avatars::tests::{call, json_body}};

    #[tokio::test]
    async fn install_files_are_public_with_their_types() {
        let (state, filename) = auth::tests::state();
        auth::tests::require_remote_login(&state);
        let app = crate::http::router(state.clone());
        for (path, content_type, cache_control) in [
            ("/manifest.webmanifest", "application/manifest+json", "no-cache"),
            ("/sw.js", "text/javascript; charset=utf-8", "no-cache"),
            ("/icon-192.png", "image/png", "public, max-age=86400"),
            ("/icon-512.png", "image/png", "public, max-age=86400"),
            ("/apple-touch-icon.png", "image/png", "public, max-age=86400"),
        ] {
            let (status, headers, body) = call(&app, "GET", path, None, None).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert_eq!(headers[header::CONTENT_TYPE], content_type, "{path}");
            assert_eq!(headers[header::CACHE_CONTROL], cache_control, "{path}");
            assert!(!body.is_empty(), "{path}");
        }
        let manifest = json_body(&call(&app, "GET", "/manifest.webmanifest", None, None).await.2);
        assert_eq!(manifest["display"], "standalone");
        assert_eq!(manifest["icons"].as_array().unwrap().len(), 2);
        let worker = call(&app, "GET", "/sw.js", None, None).await.2;
        assert!(String::from_utf8(worker).unwrap().contains("notificationclick"));
        drop(app);
        drop(state);
        let _ = std::fs::remove_file(filename);
    }
}
