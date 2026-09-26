fn page_template() -> &'static str {
    r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#ffffff">
    <style>html { background: #ffffff; } html.dark { background: #0a0a0a; } .suplex-boot { position: fixed; inset: 0; display: grid; place-items: center; opacity: 0; animation: suplex-boot-in 200ms 400ms forwards; } .suplex-boot span { width: 20px; height: 20px; border: 2px solid #e5e5e5; border-top-color: #737373; border-radius: 50%; animation: suplex-boot-spin 700ms linear infinite; } html.dark .suplex-boot span { border-color: #262626; border-top-color: #a3a3a3; } @keyframes suplex-boot-in { to { opacity: 1; } } @keyframes suplex-boot-spin { to { transform: rotate(360deg); } } @media (prefers-reduced-motion: reduce) { .suplex-boot span { animation-duration: 2s; } }</style>
    <script>(() => { let saved = null; try { saved = localStorage.getItem("suplex.theme"); } catch {} const dark = saved === "dark" || saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches; const root = document.documentElement; root.classList.toggle("dark", dark); root.style.colorScheme = dark ? "dark" : "light"; document.querySelector('meta[name="theme-color"]').content = dark ? "#0a0a0a" : "#ffffff"; })();</script>
    <title>Suplex · Sign in</title>
    <link rel="stylesheet" href="/assets/suplex-ui.css">
  </head>
  <body>
    <div id="suplex-app"><div class="suplex-boot" role="status" aria-label="Suplex loads the app"><span></span></div></div>
    <noscript>Suplex requires JavaScript for passkey authentication.</noscript>
    <script>window.__SUPLEX_VIEW__ = "auth";</script>
    <script type="module" src="/assets/suplex-ui.js"></script>
  </body>
</html>"##
}

pub fn auth_page() -> String {
    development_html(
        page_template(),
        std::env::var("SUPLEX_FRONTEND_DEV_URL").ok().as_deref(),
    )
}

fn development_html(html: &str, dev_url: Option<&str>) -> String {
    let Some(url) = dev_url
        .and_then(|value| url::Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
        })
    else {
        return html.to_owned();
    };
    let origin = url.origin().ascii_serialization();
    html.replace(
        "    <link rel=\"stylesheet\" href=\"/assets/suplex-ui.css\">\n",
        "",
    )
    .replace(
        "<script type=\"module\" src=\"/assets/suplex-ui.js\"></script>",
        &format!(
            r#"<script type="module">
import RefreshRuntime from "{origin}/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {{}};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>
    <script type="module" src="{origin}/@vite/client"></script>
    <script type="module" src="{origin}/src/frontend/main.tsx"></script>"#
        ),
    )
}

pub fn application_page(view: &str) -> String {
    let title = match view {
        "auth" => "Sign in",
        "oauth-consent" => "Approve connection",
        "admin" => "Administration",
        "projects" => "Projects",
        "project-prompts" => "Project prompts",
        "project-templates" => "Project templates",
        "tasks" => "Tasks",
        "board" => "Board",
        "timeline" => "Timeline",
        "profile" => "Profile",
        "setup" => "Set up",
        "onboarding" => "Onboarding",
        "health" => "Host health",
        _ => "Company settings",
    };
    auth_page()
        .replacen(
            "<title>Suplex · Sign in</title>",
            &format!("<title>Suplex · {title}</title>"),
            1,
        )
        .replacen(
            "window.__SUPLEX_VIEW__ = \"auth\";",
            &format!("window.__SUPLEX_VIEW__ = \"{view}\";"),
            1,
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_is_applied_before_assets_and_boot_status_survives_until_react_loads() {
        for view in ["tasks", "health"] {
            let html = application_page(view);
            let bootstrap = html.find("localStorage.getItem(\"suplex.theme\")").unwrap();
            for asset in ["/assets/suplex-ui.css", "/assets/suplex-ui.js"] {
                assert!(bootstrap < html.find(asset).unwrap());
            }
            assert!(html.contains(
                "const root = document.documentElement; root.classList.toggle(\"dark\", dark)"
            ));
            assert!(html.contains("content = dark ? \"#0a0a0a\" : \"#ffffff\""));
            assert_eq!(html.matches("root.classList.toggle").count(), 1);
            assert!(html.contains("<div id=\"suplex-app\"><div class=\"suplex-boot\" role=\"status\" aria-label=\"Suplex loads the app\"><span></span></div></div>"));
        }
    }

    #[test]
    fn development_page_loads_vite_and_react_refresh_from_loopback() {
        let html = development_html(page_template(), Some("http://127.0.0.1:55013"));
        assert!(html.contains("http://127.0.0.1:55013/@vite/client"));
        assert!(html.contains("http://127.0.0.1:55013/src/frontend/main.tsx"));
        assert!(html.contains("__vite_plugin_react_preamble_installed__"));
        assert!(!html.contains("/assets/suplex-ui"));
        for invalid in [
            "https://example.com",
            "http://localhost:1234/injected",
            "http://user@localhost:1234",
            "bad",
        ] {
            assert_eq!(
                development_html(page_template(), Some(invalid)),
                page_template()
            );
        }
        assert_eq!(development_html(page_template(), None), page_template());
    }
}
