//! Installable web app files: manifest, icons, and the push service worker. They hold no company data.

#![cfg_attr(not(test), deny(clippy::disallowed_types, clippy::disallowed_macros))]

use axum::{
    Router,
    http::header,
    response::{IntoResponse, Response},
    routing::get,
};

use crate::http::AppState;

const MANIFEST: &str = include_str!("../pwa/manifest.webmanifest");
const SERVICE_WORKER: &str = include_str!("../pwa/sw.js");
const ICON_192: &[u8] = include_bytes!("../pwa/icon-192.png");
const ICON_512: &[u8] = include_bytes!("../pwa/icon-512.png");
const APPLE_TOUCH_ICON: &[u8] = include_bytes!("../pwa/apple-touch-icon.png");

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/manifest.webmanifest",
            get(|| async { file("application/manifest+json", "no-cache", MANIFEST.as_bytes()) }),
        )
        .route(
            "/sw.js",
            get(|| async {
                file(
                    "text/javascript; charset=utf-8",
                    "no-cache",
                    SERVICE_WORKER.as_bytes(),
                )
            }),
        )
        .route(
            "/icon-192.png",
            get(|| async { file("image/png", "public, max-age=86400", ICON_192) }),
        )
        .route(
            "/icon-512.png",
            get(|| async { file("image/png", "public, max-age=86400", ICON_512) }),
        )
        .route(
            "/apple-touch-icon.png",
            get(|| async { file("image/png", "public, max-age=86400", APPLE_TOUCH_ICON) }),
        )
}

fn file(content_type: &'static str, cache_control: &'static str, body: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, cache_control),
        ],
        body,
    )
        .into_response()
}

include!("../../../tests/routes/pwa.rs");
