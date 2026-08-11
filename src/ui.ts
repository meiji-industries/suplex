import type { HealthSnapshot } from "./health.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function renderCheck(check: HealthSnapshot["checks"][number]): string {
  const details = Object.entries(check.details)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("");
  return `<article class="health-card" data-status="${check.status}">
    <div class="card-heading"><h2>${escapeHtml(check.label)}</h2><span class="status-pill">${check.status}</span></div>
    <p>${escapeHtml(check.summary)}</p>
    <dl>${details}</dl>
  </article>`;
}

export function renderHealthPage(snapshot: HealthSnapshot): string {
  const serialized = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const readiness = snapshot.ready ? "ready" : "not ready";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Forge host health</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #10131a; color: #eef1f7; }
      body { margin: 0; background: radial-gradient(circle at top right, #24314d, #10131a 45%); min-height: 100vh; }
      main { width: min(1100px, calc(100% - 2rem)); margin: 0 auto; padding: 2rem 0 4rem; }
      .eyebrow { color: #8fa9ff; font-size: .78rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      h1 { font-size: clamp(2rem, 8vw, 4rem); line-height: .98; margin: .25rem 0 1rem; max-width: 10ch; }
      .lede { color: #b7c0d1; max-width: 58ch; }
      .summary { align-items: center; background: #1b2332; border: 1px solid #35435f; border-radius: 1rem; display: flex; gap: 1rem; justify-content: space-between; margin: 2rem 0; padding: 1rem 1.1rem; }
      .summary strong { font-size: 1.1rem; }
      .summary small { color: #aeb9cb; display: block; margin-top: .25rem; overflow-wrap: anywhere; }
      .readiness { border-radius: 999px; font-size: .8rem; font-weight: 800; padding: .55rem .8rem; text-transform: uppercase; white-space: nowrap; }
      .readiness[data-ready="true"], .health-card[data-status="healthy"] .status-pill { background: #123d2f; color: #71e2ae; }
      .readiness[data-ready="false"], .health-card[data-status="unhealthy"] .status-pill { background: #4b2428; color: #ff9b9b; }
      .health-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      .health-card { background: rgba(25, 31, 44, .9); border: 1px solid #303b52; border-radius: 1rem; min-height: 11rem; padding: 1.1rem; }
      .health-card[data-status="healthy"] { border-color: #25664e; }
      .health-card[data-status="unhealthy"] { border-color: #7b3c43; }
      .card-heading { align-items: start; display: flex; gap: .75rem; justify-content: space-between; }
      h2 { font-size: 1rem; margin: 0; }
      .status-pill { border-radius: 999px; font-size: .68rem; font-weight: 800; padding: .35rem .5rem; text-transform: uppercase; }
      .health-card p { color: #c0c8d6; line-height: 1.45; }
      dl { display: grid; font-size: .75rem; gap: .3rem .75rem; grid-template-columns: auto 1fr; margin: 1rem 0 0; }
      dt { color: #7f8aa0; } dd { margin: 0; overflow-wrap: anywhere; text-align: right; }
      @media (max-width: 500px) { main { padding-top: 1.25rem; } .summary { align-items: start; flex-direction: column; } .readiness { align-self: stretch; text-align: center; } }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Forge · Host health</p>
      <h1>Truthful readiness.</h1>
      <p class="lede">A compact view of the local services Forge owns. Provider authentication is shown separately and never exposes credential material.</p>
      <section class="summary" aria-label="Forge readiness">
        <div><strong id="readiness-title">Forge is ${readiness}</strong><small id="reachable-address">Reachable at ${escapeHtml(snapshot.reachableAddress)}</small></div>
        <span class="readiness" data-ready="${snapshot.ready ? "true" : "false"}" id="readiness-pill">${readiness}</span>
      </section>
      <section class="health-grid" id="health-grid" aria-label="Health checks">${snapshot.checks.map(renderCheck).join("")}</section>
      <p class="lede" id="last-checked">Last checked ${escapeHtml(snapshot.generatedAt)}</p>
    </main>
    <script id="health-data" type="application/json">${serialized}</script>
    <script>
      const render = (snapshot) => {
        document.getElementById("readiness-title").textContent = "Forge is " + (snapshot.ready ? "ready" : "not ready");
        document.getElementById("reachable-address").textContent = "Reachable at " + snapshot.reachableAddress;
        const pill = document.getElementById("readiness-pill");
        pill.textContent = snapshot.ready ? "ready" : "not ready";
        pill.dataset.ready = String(snapshot.ready);
        document.getElementById("last-checked").textContent = "Last checked " + snapshot.generatedAt;
        document.querySelectorAll(".health-card").forEach((card, index) => {
          const check = snapshot.checks[index];
          if (!check) return;
          card.dataset.status = check.status;
          card.querySelector("h2").textContent = check.label;
          card.querySelector(".status-pill").textContent = check.status;
          card.querySelector("p").textContent = check.summary;
          const details = card.querySelector("dl");
          details.replaceChildren(...Object.entries(check.details).flatMap(([key, value]) => {
            const term = document.createElement("dt");
            term.textContent = key;
            const description = document.createElement("dd");
            description.textContent = String(value);
            return [term, description];
          }));
        });
      };
      fetch("/api/health").then((response) => response.json()).then(render).catch(() => undefined);
    </script>
  </body>
</html>`;
}
