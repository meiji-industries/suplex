//! The bundled setup pages, failure page, and bridge: local-only assets, their copy and bridge calls, and the
//! content security policy that serves them. Behavior in WKWebView is covered by `native_smoke.rs`.

use std::path::PathBuf;

fn source(path: &str) -> String {
    std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(path),
    )
    .unwrap()
}

const PAGES: [&str; 7] = [
    "pages/choice.html",
    "pages/connecting.html",
    "pages/failed.html",
    "pages/install.html",
    "pages/ready.html",
    "pages/unavailable.html",
    "connect.html",
];

#[test]
fn every_page_is_local_with_no_external_resources_or_chromium_only_css() {
    let listed: Vec<String> =
        std::fs::read_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/pages"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".html"))
            .collect();
    assert_eq!(listed.len(), 6, "{listed:?}");
    for page in PAGES {
        let html = source(&format!("src/{page}"));
        assert!(html.contains("<html lang=\"en\">"), "{page}");
        for external in ["src=\"http", "src=\"//", "href=\"//", "<script src"] {
            assert!(!html.contains(external), "{page} loads {external}");
        }
        for chromium in ["-webkit-app-region", "titlebar-area", " onclick="] {
            assert!(!html.contains(chromium), "{page} uses {chromium}");
        }
        assert!(
            html.contains("data-tauri-drag-region=\"deep\""),
            "{page} drags the window from its background"
        );
    }
    let styles = source("src/pages/pages.css");
    assert!(
        styles.contains("background: #0a0a0a")
            && styles.contains("font: 13px/1.5 -apple-system, system-ui, sans-serif")
    );
    assert!(!styles.contains("app-region"));
}

#[test]
fn the_content_security_policy_allows_only_bundled_scripts() {
    let config: serde_json::Value =
        serde_json::from_str(&source("src-tauri/tauri.conf.json")).unwrap();
    let csp = config["app"]["security"]["csp"].as_str().unwrap();
    assert!(
        csp.contains("script-src 'self'")
            && csp.contains("default-src 'self'")
            && csp.contains("object-src 'none'"),
        "{csp}"
    );
    let directive = |name: &str| {
        csp.split(';')
            .map(str::trim)
            .find(|part| part.starts_with(name))
            .unwrap_or_default()
            .to_owned()
    };
    assert_eq!(
        directive("script-src"),
        "script-src 'self'",
        "no remote scripts or unsafe evaluation"
    );
    assert_eq!(
        directive("connect-src"),
        "connect-src ipc: http://ipc.localhost",
        "only Tauri IPC"
    );
    assert!(!csp.contains("unsafe-eval"), "{csp}");
    assert_eq!(config["app"]["withGlobalTauri"], false);
    assert!(
        config["build"].get("devUrl").is_none(),
        "host pages must never count as the app's own origin"
    );
    assert_eq!(
        config["app"]["security"]["capabilities"],
        serde_json::json!(["setup", "unavailable"]),
        "host grants exist only at runtime"
    );
}

#[test]
fn choice_keeps_its_copy_saved_hosts_and_proven_remote_continue() {
    let html = source("src/pages/choice.html");
    for text in [
        "<title>Set up Suplex</title>",
        "<h2 id=\"where\">Where do you work?</h2>",
        "<strong>Run locally</strong>",
        "<strong>Remote access</strong>",
        "card.className = \"card saved\";",
        "window.suplexDesktop.selectHost(origin)",
        "window.suplexDesktop.removeHost(origin)",
        "<fieldset id=\"remote\" disabled>",
        "await window.suplexDesktop.testConnection(candidate)",
        "next.disabled = chosen() === null || (chosen() === \"remote\" && (url.value === \"\" || url.value !== proven));",
        "window.suplexDesktop.choose(\"local\")",
    ] {
        assert!(html.contains(text), "{text}");
    }
}

#[test]
fn install_ready_failed_and_connect_keep_their_actions() {
    let install = source("src/pages/install.html");
    assert!(
        install.contains("const LOG_LINES = 500;")
            && install.contains("<button id=\"cancel\" type=\"button\">Cancel</button>")
    );
    assert!(install.contains("window.suplexDesktop.on((event) =>"));
    assert!(source("src/pages/ready.html").contains("window.suplexDesktop.launch()"));
    let failed = source("src/pages/failed.html");
    for text in [
        "failure.log.slice(-200)",
        ">Retry</button>",
        ">Open logs</button>",
        ">Copy output</button>",
        "document.getElementById(\"reason\").textContent = failure.reason;",
    ] {
        assert!(failed.contains(text), "{text}");
    }
    let connect = source("src/connect.html");
    assert!(connect
        .contains("<button id=\"save\" class=\"primary\" type=\"submit\" disabled>Save</button>"));
    assert!(connect.contains("if (result.ok) { proven = candidate; save.disabled = false;"));
}

#[test]
fn the_failure_page_shows_its_host_as_text_retries_every_five_seconds_and_copies_the_command() {
    let html = source("src/pages/unavailable.html");
    for text in [
        "aria-label=\"This Suplex window cannot reach the Suplex host\"",
        "document.getElementById(\"address\").textContent = target;",
        "setInterval(retry, 5000);",
        "pnpm run suplex start",
        "Suplex retries every 5 seconds.",
        "aria-label=\"Select a Suplex host\"",
        "href=\"https://github.com/meiji-industries/suplex#set-up-an-installation\"",
        "Copy failed. Select the command and copy it.",
    ] {
        assert!(html.contains(text), "{text}");
    }
    assert!(
        !html.contains("innerHTML"),
        "the host address is never parsed as markup"
    );
}

#[test]
fn the_bridge_exposes_each_object_only_for_its_view_kind_and_origin() {
    let bridge = source("src/bridge.js");
    assert!(bridge.contains("if (window.top !== window) return;"));
    assert!(bridge.contains("if (here !== config.origin) return;"));
    for (kind, object) in [
        ("setup", "suplexDesktop"),
        ("unavailable", "suplexUnavailable"),
        ("host", "suplexApp"),
    ] {
        assert!(
            bridge.contains(&format!("config.kind === \"{kind}\""))
                && bridge.contains(&format!("window.{object} = Object.freeze(")),
            "{kind}"
        );
    }
    assert!(
        !bridge.contains("__TAURI__") || bridge.contains("__TAURI_INTERNALS__"),
        "withGlobalTauri stays off"
    );
}
