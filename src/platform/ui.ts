import type { HealthSnapshot } from "./health.js";

export type FrontendAssetMode = "built" | "development";

function frontendHead(mode: FrontendAssetMode): string {
  return mode === "built" ? '    <link rel="stylesheet" href="/assets/forge-ui.css">\n' : "";
}

function frontendEntry(mode: FrontendAssetMode): string {
  const source = mode === "development" ? "/src/frontend/main.tsx" : "/assets/forge-ui.js";
  return `    <script type="module" src="${source}"></script>`;
}

function themeBootstrap(): string {
  return `    <script>(() => { let saved = null; try { saved = localStorage.getItem("forge.theme"); } catch {} const dark = saved === "dark" || saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches; const root = document.documentElement; root.classList.toggle("dark", dark); root.style.colorScheme = dark ? "dark" : "light"; document.querySelector('meta[name="theme-color"]').content = dark ? "#0a0a0a" : "#ffffff"; })();</script>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function renderFallbackCheck(check: HealthSnapshot["checks"][number]): string {
  return `<article class="health-card" data-status="${escapeHtml(check.status)}"><h2>${escapeHtml(check.label)}</h2><p>${escapeHtml(check.summary)}</p></article>`;
}

export function renderHealthPage(snapshot: HealthSnapshot, assetMode: FrontendAssetMode = "built"): string {
  const serialized = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#ffffff">
${themeBootstrap()}
    <title>Forge · Host health</title>
${frontendHead(assetMode)}  </head>
  <body>
    <div id="forge-app">
      <main aria-label="Forge host health">
        <p>Forge · Host health</p>
        <h1>Host health</h1>
        <p>Reachable at ${escapeHtml(snapshot.reachableAddress)}</p>
        <p>${snapshot.ready ? "Everything is operational" : "Attention needed"}</p>
        <section aria-label="Health checks">${snapshot.checks.map(renderFallbackCheck).join("")}</section>
      </main>
    </div>
    <noscript>Forge host health requires JavaScript for live refresh. The server-rendered checks above remain available.</noscript>
    <script>window.__FORGE_HEALTH__ = ${serialized};</script>
${frontendEntry(assetMode)}
  </body>
</html>`;
}

export function renderApplicationPage(view: "auth" | "oauth-consent" | "admin" | "projects" | "project-prompts" | "project-templates" | "tasks" | "board" | "timeline" | "analytics" | "company-settings" | "profile" | "setup" | "onboarding", assetMode: FrontendAssetMode = "built"): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#ffffff">
${themeBootstrap()}
    <title>Forge · ${view === "auth" ? "Sign in" : view === "oauth-consent" ? "Approve connection" : view === "admin" ? "Administration" : view === "projects" ? "Projects" : view === "project-prompts" ? "Project prompts" : view === "project-templates" ? "Project templates" : view === "tasks" ? "Tasks" : view === "board" ? "Board" : view === "timeline" ? "Timeline" : view === "profile" ? "Profile" : view === "setup" ? "Set up" : view === "onboarding" ? "Onboarding" : "Company settings"}</title>
${frontendHead(assetMode)}  </head>
  <body>
    <div id="forge-app"></div>
    <noscript>Forge requires JavaScript for passkey authentication.</noscript>
    <script>window.__FORGE_VIEW__ = ${JSON.stringify(view)};</script>
${frontendEntry(assetMode)}
  </body>
</html>`;
}
