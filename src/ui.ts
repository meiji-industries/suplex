import type { HealthSnapshot } from "./health.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function renderFallbackCheck(check: HealthSnapshot["checks"][number]): string {
  return `<article class="health-card" data-status="${escapeHtml(check.status)}"><h2>${escapeHtml(check.label)}</h2><p>${escapeHtml(check.summary)}</p></article>`;
}

export function renderHealthPage(snapshot: HealthSnapshot): string {
  const serialized = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f8f8fa">
    <title>Forge · Host health</title>
    <link rel="stylesheet" href="/assets/forge-ui.css">
  </head>
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
    <script type="module" src="/assets/forge-ui.js"></script>
  </body>
</html>`;
}

export function renderApplicationPage(view: "auth" | "admin" | "projects" | "tasks" | "attention" | "company-settings"): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f8f8fa">
    <title>Forge · ${view === "auth" ? "Sign in" : view === "admin" ? "Administration" : view === "projects" ? "Projects" : view === "tasks" ? "Tasks" : view === "attention" ? "Attention" : "Company settings"}</title>
    <link rel="stylesheet" href="/assets/forge-ui.css">
  </head>
  <body>
    <div id="forge-app"></div>
    <noscript>Forge requires JavaScript for passkey authentication.</noscript>
    <script>window.__FORGE_VIEW__ = ${JSON.stringify(view)};</script>
    <script type="module" src="/assets/forge-ui.js"></script>
  </body>
</html>`;
}
