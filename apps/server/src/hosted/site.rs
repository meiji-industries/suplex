//! suplex.sh: `/download`, `/install.sh`, `/install.ps1`, `/bootstrap.sh`, `/terms`, `/privacy`, `/support`, and a
//! redirect to the website at getsuplex.ai, a Framer site, for every other
//! path. The pages are compiled in; nothing is read from disk.

use axum::{
    Router,
    extract::{Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::json;

use crate::accounts::hosted::{Accounts, VISITOR_COOKIE, valid_visitor};

const WEBSITE: &str = "https://getsuplex.ai/";
const INSTALL_SCRIPT: &str = include_str!("install.sh");
const WINDOWS_INSTALL_SCRIPT: &str = include_str!("install.ps1");
const BOOTSTRAP_SCRIPT: &str = include_str!("bootstrap.sh");
const TERMS_PAGE: &str = include_str!("legal/terms.html");
const PRIVACY_PAGE: &str = include_str!("legal/privacy.html");
const SUPPORT_PAGE: &str = include_str!("legal/support.html");

/// The release feed directory, its manifest, and its formats. The first
/// format is the default download.
fn feed(platform: &str) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    Some(match platform {
        "macos-arm64" => ("mac/arm64", "latest-mac.yml", &["dmg", "zip"]),
        "macos-x64" => ("mac/x64", "latest-mac.yml", &["dmg", "zip"]),
        "linux-arm64" => ("linux/arm64", "latest-linux.yml", &["tar.gz"]),
        "linux-x64" => ("linux/x64", "latest-linux.yml", &["tar.gz"]),
        "linux-desktop-arm64" => ("linux/arm64", "latest-linux-desktop.yml", &["deb", "rpm"]),
        "linux-desktop-x64" => ("linux/x64", "latest-linux-desktop.yml", &["deb", "rpm"]),
        "windows-x64" => ("windows/x64", "latest-windows.yml", &["exe"]),
        "windows-arm64" => ("windows/arm64", "latest-windows.yml", &["exe"]),
        // suplex-bootstrap, the cloud server wizard (scripts/build-bootstrap.sh).
        "bootstrap-macos-arm64" => ("bootstrap/macos-arm64", "latest.yml", &["tar.gz"]),
        "bootstrap-macos-x64" => ("bootstrap/macos-x64", "latest.yml", &["tar.gz"]),
        "bootstrap-linux-arm64" => ("bootstrap/linux-arm64", "latest.yml", &["tar.gz"]),
        "bootstrap-linux-x64" => ("bootstrap/linux-x64", "latest.yml", &["tar.gz"]),
        _ => return None,
    })
}

#[derive(Deserialize)]
struct DownloadQuery {
    platform: Option<String>,
    format: Option<String>,
    visitor: Option<String>,
}

/// Redirects to the file named in the live release manifest, so the link
/// follows each release.
// Reads the manifest on every download; cache it for a minute if
// download volume grows.
async fn download(
    State(accounts): State<Accounts>,
    Query(query): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Response {
    let platform = query.platform.as_deref().unwrap_or("macos-arm64");
    let Some((directory, manifest, formats)) = feed(platform) else {
        return (StatusCode::NOT_FOUND, "Unknown platform.").into_response();
    };
    let format = query.format.as_deref().unwrap_or(formats[0]);
    if !formats.contains(&format) {
        return (StatusCode::NOT_FOUND, "Unknown format.").into_response();
    }
    let base = format!("{}/stable/{directory}/", accounts.endpoints.downloads);
    let text = match accounts.http.get(format!("{base}{manifest}")).send().await {
        Ok(response) if response.status().is_success() => response.text().await.ok(),
        _ => None,
    };
    let Some(text) = text else {
        return (StatusCode::BAD_GATEWAY, "No release is published.").into_response();
    };
    let file = regex::Regex::new(&format!(r"url:\s*(\S+\.{})", regex::escape(format)))
        .ok()
        .and_then(|pattern| pattern.captures(&text))
        .and_then(|captures| captures.get(1))
        .map(|file| file.as_str())
        .filter(|file| !file.contains('/') && !file.contains(".."));
    let Some(file) = file else {
        return (
            StatusCode::BAD_GATEWAY,
            format!("No {format} in the latest release."),
        )
            .into_response();
    };
    let mut response = (
        StatusCode::FOUND,
        [(header::LOCATION, format!("{base}{file}"))],
    )
        .into_response();
    if headers.get("dnt").is_some_and(|value| value == "1") {
        return response;
    }
    remember_visitor(&accounts, &headers, query.visitor.as_deref(), &mut response);
    // Anonymous: a fresh id and no person profile (docs/telemetry.md).
    let source = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|agent| agent.starts_with("curl/") || agent.contains("PowerShell/"));
    let tracked = accounts.hosted.query(|db| {
        accounts.track(
            db,
            "download_started",
            &uuid::Uuid::new_v4().to_string(),
            json!({
                "$lib": "suplex-web",
                "$process_person_profile": false,
                "$geoip_disable": true,
                "platform": platform,
                "source": if source { "install_script" } else { "browser" },
            }),
        )
    });
    if tracked.is_err() {
        eprintln!("site: download_started enqueue failed");
    }
    response
}

/// Keeps a valid website visitor id in a first-party cookie for a year, so a
/// later login joins the visitor to the account. `DNT: 1` keeps nothing.
pub fn remember_visitor(
    accounts: &Accounts,
    headers: &HeaderMap,
    visitor: Option<&str>,
    response: &mut Response,
) {
    if headers.get("dnt").is_some_and(|value| value == "1") {
        return;
    }
    let Some(visitor) = visitor.filter(|visitor| valid_visitor(visitor)) else {
        return;
    };
    let secure = if accounts.hosted.config.origin.starts_with("https:") {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "{VISITOR_COOKIE}={visitor}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax{secure}"
    );
    if let Ok(cookie) = cookie.parse() {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
}

fn script(text: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=300"),
        ],
        text,
    )
        .into_response()
}

async fn website() -> Response {
    (StatusCode::FOUND, [(header::LOCATION, WEBSITE)]).into_response()
}

/// `www.` hosts redirect to `BILLING_PUBLIC_ORIGIN`, never to the request
/// host. Other hosts are served without a redirect.
pub async fn redirect_www(State(origin): State<String>, request: Request, next: Next) -> Response {
    let www = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host.starts_with("www."));
    if !www {
        return next.run(request).await;
    }
    let path = request
        .uri()
        .path_and_query()
        .map_or("/", |path| path.as_str());
    (
        StatusCode::MOVED_PERMANENTLY,
        [(header::LOCATION, format!("{origin}{path}"))],
    )
        .into_response()
}

pub fn router(accounts: Accounts) -> Router {
    Router::new()
        .route("/download", get(download))
        .route("/install.sh", get(|| async { script(INSTALL_SCRIPT) }))
        .route("/bootstrap.sh", get(|| async { script(BOOTSTRAP_SCRIPT) }))
        .route(
            "/install.ps1",
            get(|| async { script(WINDOWS_INSTALL_SCRIPT) }),
        )
        .route("/terms", get(|| async { Html(TERMS_PAGE) }))
        .route("/privacy", get(|| async { Html(PRIVACY_PAGE) }))
        .route("/support", get(|| async { Html(SUPPORT_PAGE) }))
        .fallback(website)
        .with_state(accounts)
}

#[cfg(test)]
include!("../../tests/accounts/site.rs");
