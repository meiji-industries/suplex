import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const directory = join(__dirname, "..", "src", "pages");
const page = (name: string): string => readFileSync(join(directory, name), "utf8");
const styles = readFileSync(join(directory, "pages.css"), "utf8");

test("every screen is a local page with no frameworks and no external resources", () => {
  const pages = readdirSync(directory).filter((name) => name.endsWith(".html"));
  expect(pages.sort()).toEqual(["choice.html", "connecting.html", "failed.html", "install.html", "ready.html"]);
  for (const name of [...pages, join("..", "connect.html")]) {
    const html = page(name);
    expect(html, name).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    expect(html, name).not.toMatch(/<script[^>]+src=/);
    expect(html, name).toMatch(/<html lang="en">/);
  }
});

test("the shared style is the app's dark look", () => {
  expect(styles).toContain("background: #0a0a0a");
  expect(styles).toContain("font: 13px/1.5 -apple-system, system-ui, sans-serif");
});

describe("choice", () => {
  const html = page("choice.html");
  test("carries C4's copy with the local card preselected", () => {
    expect(html).toContain("<title>Set up Suplex</title>");
    expect(html).toContain('<h1><img src="wordmark.svg" alt="Suplex"></h1>');
    expect(html).toContain('<input type="radio" name="mode" value="local" checked><strong>Run locally</strong>');
    expect(html).toContain("<p>Work directly in the app, or leave it running so other devices can connect remotely.</p>");
    expect(html).toContain('<input type="radio" name="mode" value="remote"><strong>Remote access</strong>');
    expect(html).toContain("<p>All tasks run on that machine, best if you are running Suplex on a remote development server.</p>");
  });
  test("is two cards in the middle 67% of the window, stacked under 720 px", () => {
    expect(styles).toContain("main { width: 67vw; margin: 0 auto;");
    expect(styles).toContain("@media (max-width: 720px) { main { width: auto;");
    expect(html).toContain(".cards { display: grid; grid-template-columns: 1fr 1fr;");
    expect(html).toContain("@media (max-width: 720px) { .cards { grid-template-columns: 1fr; } }");
  });
});

describe("install progress", () => {
  const html = page("install.html");
  test("counts steps, draws the running stage as half a step, and caps the log", () => {
    expect(html).toContain("${Math.min(done + (running ? 1 : 0), total)} of ${total} steps");
    expect(html).toContain("((done + (running ? 0.5 : 0)) / total) * 100");
    expect(html).toContain("const LOG_LINES = 500;");
    expect(html).toContain('<details class="log"><summary>Show log</summary>');
    expect(html).toContain('<button id="cancel" type="button">Cancel</button>');
  });
  test("shows elapsed time as m:ss and a mark per row", () => {
    expect(html).toContain('`${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`');
    expect(html).toContain('li.done .mark::before { content: "✓"');
    expect(html).toContain("animation: spin 700ms linear infinite");
  });
});

test("ready offers one Launch button", () => {
  expect(page("ready.html")).toContain("<h1>Suplex is ready</h1>");
  expect(page("ready.html")).toContain('<button class="primary" id="launch" type="button" autofocus>Launch Suplex <span aria-hidden="true">→</span></button>');
});

test("connecting is the cold boot interstitial", () => {
  expect(page("connecting.html")).toContain("<h1>CONNECTING</h1>");
});

test("failed leads with the reason, keeps the log open, and offers the three actions", () => {
  const html = page("failed.html");
  expect(html).toContain('<details class="log" open>');
  expect(html).toContain("failure.log.slice(-200)");
  for (const label of ["Retry", "Open logs", "Copy output"]) expect(html).toContain(`>${label}</button>`);
  expect(html).toContain('document.getElementById("reason").textContent = failure.reason;');
  expect(html).toContain('document.getElementById("remedy").textContent = failure.remedy ?? "";');
});

test("the remote form proves health before Save is offered", () => {
  const html = page(join("..", "connect.html"));
  expect(html).toContain('<button id="test" type="button">Test connection</button>');
  expect(html).toContain('<button id="save" class="primary" type="submit" disabled>Save</button>');
  expect(html).toContain("await window.suplexDesktop.testConnection(candidate)");
  expect(html).toContain("if (result.ok) { proven = candidate; save.disabled = false;");
  expect(html).toContain("window.suplexDesktop.back()");
});
