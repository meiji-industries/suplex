import { readFile } from "node:fs/promises";
import { Window as HappyWindow } from "happy-dom";
import { expect, test, vi } from "vitest";

const source = await readFile(new URL("../apps/server/src/hosted/framer-attribution.js", import.meta.url), "utf8");
// Framer loads the shared banner from https://suplex.sh/consent.js next to this file.
const consentSource = await readFile(new URL("../apps/server/src/hosted/consent.js", import.meta.url), "utf8");

type AnalyticsWindow = Window & typeof globalThis & {
  SuplexAnalytics: { grantConsent(): void; denyConsent(): void; clearConsent(): void };
  posthog: { _i: Array<[string, Record<string, unknown>]> };
  dataLayer?: unknown[];
};

function fixture(url = "https://suplex.sh/download?utm_source=github&utm_campaign=launch&gclid=abc_123&secret=do-not-send", privacySignal = false) {
  const window = new HappyWindow({ url });
  window.document.write("<!doctype html><title>Download</title><script></script><a id='download' href='https://suplex.sh/download?platform=macos-arm64&token=private'>Download</a>");
  Object.defineProperty(window.document, "referrer", { configurable: true, value: "https://news.example/story?private=yes" });
  if (privacySignal) Object.defineProperty(window.navigator, "globalPrivacyControl", { configurable: true, value: true });
  window.eval(consentSource);
  window.eval(source);
  return window;
}

test("defaults to no capture, no replay, and no third-party pixel", () => {
  const window = fixture();
  const win = window as unknown as AnalyticsWindow;
  expect(win.posthog).toBeUndefined();
  expect(window.document.querySelector("#suplex-analytics-consent")?.textContent).toContain("Suplex collects usage data to improve the product.");
  expect(Array.from(window.document.scripts).map(script => script.src).filter(Boolean)).toEqual([]);
  expect(win.localStorage.getItem("suplex.analytics.attribution.v1")).toBeNull();
  win.SuplexAnalytics.grantConsent();
  const [apiKey, options] = win.posthog._i[0]!;
  expect(apiKey).toMatch(/^phc_/);
  expect(options).toMatchObject({
    api_host: "https://meta.suplex.sh",
    ui_host: "https://us.posthog.com",
    defaults: "2026-05-30",
    respect_dnt: true,
    property_denylist: ["$current_url", "$initial_current_url", "$referrer", "$initial_referrer"],
    opt_out_capturing_by_default: true,
    capture_pageview: false,
    autocapture: false,
    disable_session_recording: true,
  });
  expect(options).not.toHaveProperty("session_recording");
  expect(Array.from(window.document.scripts).map(script => script.src).filter(Boolean)).toEqual(["https://meta.suplex.sh/static/array.js"]);
  window.close();
});

test("scrubs SDK-added URL properties before send", () => {
  const window = fixture();
  const win = window as unknown as AnalyticsWindow;
  win.SuplexAnalytics.grantConsent();
  const options = win.posthog._i[0]![1];
  const beforeSend = options.before_send as (event: { properties: Record<string, unknown> }) => { properties: Record<string, unknown> };
  const event = beforeSend({ properties: {
    $current_url: "https://suplex.sh/product?token=private#secret",
    $referrer: "https://search.example/results?q=private",
    $set_once: { $initial_current_url: "https://suplex.sh/?gclid=secret", $initial_referrer: "https://news.example/story?id=private" },
  } });
  expect(event.properties).toMatchObject({
    $current_url: "https://suplex.sh/product",
    $referrer: "https://search.example",
    $set_once: { $initial_current_url: "https://suplex.sh/", $initial_referrer: "https://news.example" },
  });
  expect(JSON.stringify(event)).not.toMatch(/private|secret/);
  window.close();
});

test("does not load or persist consent when Global Privacy Control is enabled", () => {
  const window = fixture(undefined, true);
  const win = window as unknown as AnalyticsWindow;
  expect(win.posthog).toBeUndefined();
  expect(window.document.querySelector("#suplex-analytics-consent")).toBeNull();
  expect(window.document.querySelector("#suplex-analytics-settings")).toBeNull();
  win.SuplexAnalytics.grantConsent();
  expect(win.localStorage.getItem("suplex.analytics.consent.v1")).toBeNull();
  expect(win.posthog).toBeUndefined();
  window.close();
});

test("revalidates persisted attribution against the bounded allowlist", () => {
  const window = fixture();
  const win = window as unknown as AnalyticsWindow;
  win.localStorage.setItem("suplex.analytics.attribution.v1", JSON.stringify({
    first: { source: "x".repeat(500), referrer_domain: "evil.example/path?secret=yes", unknown: "private" },
    last: { gclid: "invalid value with spaces" },
  }));
  win.SuplexAnalytics.grantConsent();
  const options = win.posthog._i[0]![1];
  const capture = vi.fn();
  (options.loaded as (loadedClient: unknown) => void)({ capture, opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn() });
  const properties = capture.mock.calls[0]![1] as Record<string, unknown>;
  expect(properties.attribution_first_source).toBe("x".repeat(120));
  expect(properties).not.toHaveProperty("attribution_first_referrer_domain");
  expect(JSON.stringify(properties)).not.toMatch(/unknown|private|invalid value/);
  window.close();
});

test("rejecting consent persists the choice without loading the SDK", () => {
  const window = fixture();
  const win = window as unknown as AnalyticsWindow;
  const buttons = Array.from(window.document.querySelectorAll("#suplex-analytics-consent button"));
  (buttons[0] as unknown as { click(): void }).click();
  expect(win.localStorage.getItem("suplex.analytics.consent.v1")).toBe("denied");
  expect(win.posthog).toBeUndefined();
  expect(Array.from(window.document.scripts).map(script => script.src).filter(Boolean)).toEqual([]);
  expect(window.document.querySelector("#suplex-analytics-settings")?.textContent).toBe("Analytics settings");
  window.close();
});

test("the visible settings button revokes consent and reopens the choice", () => {
  const window = fixture();
  const win = window as unknown as AnalyticsWindow;
  win.SuplexAnalytics.grantConsent();
  const options = win.posthog._i[0]![1];
  const client = {
    capture: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn()
  };
  (options.loaded as (loadedClient: unknown) => void)(client);
  const settings = window.document.querySelector("#suplex-analytics-settings") as unknown as { click(): void };
  expect(settings).toBeTruthy();
  settings.click();
  expect(win.localStorage.getItem("suplex.analytics.consent.v1")).toBeNull();
  expect(client.opt_out_capturing).toHaveBeenCalledTimes(1);
  expect(window.document.querySelector("#suplex-analytics-settings")).toBeNull();
  expect(window.document.querySelector("#suplex-analytics-consent")?.textContent).toContain("Accept");
  window.close();
});

test("captures only allowlisted, bounded attribution after consent", () => {
  const window = fixture();
  const win = window as unknown as AnalyticsWindow;
  win.SuplexAnalytics.grantConsent();
  const options = win.posthog._i[0]![1];
  const capture = vi.fn();
  const client = {
    capture,
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  };
  (options.loaded as (loadedClient: unknown) => void)(client);
  expect(capture).toHaveBeenCalledWith("$pageview", expect.objectContaining({
    surface: "website",
    page_path: "/download",
    attribution_first_source: "github",
    attribution_first_campaign: "launch",
    attribution_first_gclid: "abc_123",
    attribution_first_referrer_domain: "news.example",
  }));
  const pageview = capture.mock.calls[0]![1] as Record<string, unknown>;
  expect(JSON.stringify(pageview)).not.toContain("secret");
  expect(JSON.stringify(pageview)).not.toContain("private=yes");
  window.close();
});

test("emits consented download conversion without leaking the destination query", () => {
  const window = fixture("https://getsuplex.ai/");
  const win = window as unknown as AnalyticsWindow;
  win.SuplexAnalytics.grantConsent();
  const options = win.posthog._i[0]![1];
  const capture = vi.fn();
  (options.loaded as (client: unknown) => void)({ capture, get_distinct_id: () => "0190a1b2-c3d4-7e5f", opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn() });
  capture.mockClear();
  const link = window.document.querySelector("#download") as unknown as { click(): void; href: string };
  link.click();
  expect(capture).toHaveBeenCalledWith("website_download_clicked", expect.objectContaining({ platform: "macos-arm64", version: "unknown", destination_domain: "suplex.sh" }));
  expect(JSON.stringify(capture.mock.calls)).not.toContain("token=private");
  expect(win.dataLayer).toBeUndefined();
  expect(new URL(link.href).searchParams.get("visitor")).toBe("0190a1b2-c3d4-7e5f");

  capture.mockClear();
  const unapproved = window.document.createElement("a");
  unapproved.href = "https://downloads.example/download?platform=macos-arm64";
  window.document.body.appendChild(unapproved);
  unapproved.click();
  expect(capture).not.toHaveBeenCalled();
  expect(unapproved.href).not.toContain("visitor");

  const trial = window.document.createElement("a");
  trial.href = "https://suplex.sh/start?plan=pro";
  window.document.body.appendChild(trial);
  trial.click();
  expect(capture).toHaveBeenCalledWith("website_cta_clicked", expect.objectContaining({ cta: "start-trial", destination_domain: "suplex.sh" }));
  expect(new URL(trial.href).searchParams.get("visitor")).toBe("0190a1b2-c3d4-7e5f");
  window.close();
});

// A getsuplex.ai ad landing: every click ID, every UTM value, and the Conversion Linker.
const LANDING = "https://getsuplex.ai/?gclid=Cj0K-test_1&gbraid=gb.1&wbraid=wb-1&msclkid=ms_1&fbclid=fb.1~x&utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_term=agents&utm_content=hero&_gl=1*abc*_ga*MTIz";
const CAMPAIGN: Record<string, string> = {
  gclid: "Cj0K-test_1",
  gbraid: "gb.1",
  wbraid: "wb-1",
  msclkid: "ms_1",
  fbclid: "fb.1~x",
  utm_source: "google",
  utm_medium: "cpc",
  utm_campaign: "spring",
  utm_term: "agents",
  utm_content: "hero",
};
const LINKS = [
  "<a id='start' href='https://suplex.sh/start'>Start free</a>",
  "<a id='privacy' href='https://suplex.sh/privacy'>Privacy</a>",
  "<a id='docs' href='https://suplex.sh/docs'>Docs</a>",
  "<a id='own' href='https://suplex.sh/start?plan=pro&amp;utm_source=own&amp;_gl=own'>Trial</a>",
  "<a id='other' href='https://example.com/start'>Other</a>",
  "<a id='product' href='/product'>Product</a>",
  "<form id='form' method='post' action='https://suplex.sh/start/email'><button id='submit'>Go</button></form>",
].join("");

type Site = {
  url?: string;
  stored?: string;
  gpc?: boolean;
  dnt?: boolean;
};

function landing({ url = LANDING, stored, gpc, dnt }: Site = {}) {
  const window = new HappyWindow({ url });
  window.document.write(`<!doctype html><title>Suplex</title><script></script>${LINKS}`);
  if (stored) window.localStorage.setItem("suplex.analytics.consent.v1", stored);
  if (gpc) Object.defineProperty(window.navigator, "globalPrivacyControl", { configurable: true, value: true });
  if (dnt) Object.defineProperty(window.navigator, "doNotTrack", { configurable: true, value: "1" });
  window.eval(consentSource);
  window.eval(source);
  // Framer moves to another page without a reload before the visitor chooses.
  window.history.replaceState({}, "", "/pricing");
  return window;
}

function href(window: HappyWindow, selector: string) {
  const element = window.document.querySelector(selector)!;
  return new URL(element.getAttribute(element.tagName === "FORM" ? "action" : "href")!, window.location.href);
}

function open(window: HappyWindow, selector: string, type: "click" | "auxclick" | "contextmenu" | "submit" = "click") {
  const element = window.document.querySelector(selector)!;
  // The test stops navigation after every capture listener ran.
  window.document.addEventListener(type, event => event.preventDefault(), { once: true });
  const event = type === "submit"
    ? new window.Event("submit", { bubbles: true, cancelable: true })
    : new window.MouseEvent(type, { bubbles: true, cancelable: true, button: type === "auxclick" ? 1 : type === "contextmenu" ? 2 : 0 });
  element.dispatchEvent(event as unknown as Event);
  return href(window, selector);
}

function accept(window: HappyWindow) {
  const buttons = Array.from(window.document.querySelectorAll("#suplex-analytics-consent button"));
  (buttons.find(button => button.textContent === "Accept") as unknown as { click(): void }).click();
}

function loadClient(window: HappyWindow) {
  const options = (window as unknown as AnalyticsWindow).posthog._i[0]![1];
  (options.loaded as (client: unknown) => void)({ capture: vi.fn(), get_distinct_id: () => "0190a1b2-c3d4-7e5f", opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn() });
}

const CARRIED = [...Object.keys(CAMPAIGN), "_gl", "visitor"];

test("an ad landing accepted after an in-page navigation carries its campaign to every suplex.sh link", () => {
  const window = landing();
  expect(window.localStorage.getItem("suplex.analytics.attribution.v1")).toBeNull();
  // Before consent nothing is added.
  expect([...open(window, "#start").searchParams.keys()]).toEqual([]);
  accept(window);
  const stored = JSON.parse(window.localStorage.getItem("suplex.analytics.attribution.v1")!);
  const touch = Object.fromEntries(Object.entries(CAMPAIGN).map(([key, value]) => [key.replace(/^utm_/, ""), value]));
  expect(stored).toEqual({ first: touch, last: touch });
  loadClient(window);

  const start = open(window, "#start");
  expect(start.pathname).toBe("/start");
  for (const [key, value] of Object.entries(CAMPAIGN)) expect(start.searchParams.get(key), key).toBe(value);
  expect(start.searchParams.get("consent")).toBe("granted");
  expect(start.searchParams.get("_gl")).toBe("1*abc*_ga*MTIz");
  expect(start.searchParams.get("visitor")).toBe("0190a1b2-c3d4-7e5f");
  // Opening the link again adds nothing twice.
  expect(open(window, "#start").toString()).toBe(start.toString());

  for (const [selector, type] of [["#privacy", "auxclick"], ["#docs", "contextmenu"], ["#form", "submit"]] as const) {
    const decorated = open(window, selector, type);
    for (const key of CARRIED) expect(decorated.searchParams.getAll(key), `${selector} ${key}`).toHaveLength(1);
    expect(decorated.searchParams.get("gclid")).toBe("Cj0K-test_1");
    expect(decorated.searchParams.get("consent")).toBe("granted");
  }

  // A value the link already has is kept.
  const own = open(window, "#own");
  expect(own.searchParams.getAll("utm_source")).toEqual(["own"]);
  expect(own.searchParams.getAll("_gl")).toEqual(["own"]);
  expect(own.searchParams.get("gclid")).toBe("Cj0K-test_1");
  expect(own.searchParams.get("plan")).toBe("pro");

  // Other sites and same-site links get nothing.
  expect(open(window, "#other").toString()).toBe("https://example.com/start");
  expect(window.document.querySelector("#product")!.getAttribute("href")).toBe("/product");
  window.close();
});

test("the newest touch with a campaign is the one links carry", () => {
  const window = landing({ url: "https://getsuplex.ai/?utm_source=newsletter", stored: "granted" });
  window.localStorage.setItem("suplex.analytics.attribution.v1", JSON.stringify({
    first: { source: "first", gclid: "first-click" },
    last: { referrer_domain: "news.example" },
  }));
  // A referrer-only last touch falls back to the first touch.
  expect(open(window, "#start").searchParams.get("gclid")).toBe("first-click");
  window.localStorage.setItem("suplex.analytics.attribution.v1", JSON.stringify({
    first: { source: "first", gclid: "first-click" },
    last: { source: "last", medium: "cpc" },
  }));
  const start = open(window, "#start");
  expect(start.searchParams.get("utm_source")).toBe("last");
  expect(start.searchParams.get("utm_medium")).toBe("cpc");
  expect(start.searchParams.has("gclid")).toBe(false);
  window.close();
});

test("without granted consent nothing is stored or added to any link", () => {
  const cases: Array<[string, Site, ((window: HappyWindow) => void) | undefined]> = [
    ["absent", {}, undefined],
    ["denied", {}, window => (Array.from(window.document.querySelectorAll("#suplex-analytics-consent button")).find(button => button.textContent === "Reject") as unknown as { click(): void }).click()],
    ["stored denied", { stored: "denied" }, undefined],
    ["GPC", { gpc: true }, window => (window as unknown as AnalyticsWindow).SuplexAnalytics.grantConsent()],
    ["GPC after a granted choice", { gpc: true, stored: "granted" }, undefined],
    ["DNT", { dnt: true }, window => (window as unknown as AnalyticsWindow).SuplexAnalytics.grantConsent()],
  ];
  for (const [name, site, act] of cases) {
    const window = landing(site);
    act?.(window);
    expect(window.localStorage.getItem("suplex.analytics.attribution.v1"), name).toBeNull();
    for (const [selector, type] of [["#start", "click"], ["#privacy", "auxclick"], ["#docs", "contextmenu"], ["#form", "submit"], ["#other", "click"]] as const) {
      const decorated = open(window, selector, type);
      for (const key of CARRIED) expect(decorated.searchParams.has(key), `${name} ${selector} ${key}`).toBe(false);
    }
    window.close();
  }
});

test("a withdrawn choice removes the parameters this file added", () => {
  const window = landing();
  accept(window);
  loadClient(window);
  expect(open(window, "#start").searchParams.get("gclid")).toBe("Cj0K-test_1");
  (window.document.querySelector("#suplex-analytics-settings") as unknown as { click(): void }).click();
  expect(window.localStorage.getItem("suplex.analytics.attribution.v1")).toBeNull();
  const start = open(window, "#start");
  for (const key of CARRIED) expect(start.searchParams.has(key), key).toBe(false);
  const own = open(window, "#own");
  expect(own.searchParams.get("utm_source")).toBe("own");
  expect(own.searchParams.get("_gl")).toBe("own");
  expect(own.searchParams.has("gclid")).toBe(false);
  window.close();
});

test("a click ID that is too long or unsafe is dropped, not cut", () => {
  const window = landing({ url: `https://getsuplex.ai/?gclid=${"a".repeat(257)}&fbclid=${"b".repeat(256)}&msclkid=bad%20id`, stored: "granted" });
  const start = open(window, "#start");
  expect(start.searchParams.has("gclid")).toBe(false);
  expect(start.searchParams.get("fbclid")).toBe("b".repeat(256));
  expect(start.searchParams.has("msclkid")).toBe(false);
  window.close();
});

test("neither website script can end an inline script element", () => {
  for (const text of [source, consentSource]) expect(text).not.toMatch(/<\/script/i);
});
