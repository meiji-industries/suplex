pub fn auth_page() -> &'static str {
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
