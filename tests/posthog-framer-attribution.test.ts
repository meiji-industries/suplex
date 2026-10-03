import { readFile } from "node:fs/promises";
import { Window as HappyWindow } from "happy-dom";
import { expect, test, vi } from "vitest";

const source = await readFile(new URL("../integrations/posthog/framer-attribution.js", import.meta.url), "utf8");

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
  window.eval(source);
  return window;
}

test("defaults to no capture, masked replay, and no third-party pixel", () => {
  const window = fixture();
  const win = window as unknown as AnalyticsWindow;
  expect(win.posthog).toBeUndefined();
  expect(window.document.querySelector("#suplex-analytics-consent")?.textContent).toContain("Allow website analytics?");
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
    session_recording: { maskAllInputs: true, maskTextSelector: "*" },
  });
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
  const maskNetwork = (options.session_recording as { maskCapturedNetworkRequestFn(request: Record<string, unknown>): Record<string, unknown> }).maskCapturedNetworkRequestFn;
  const network = maskNetwork({ name: "https://api.example/data?token=private#secret", headers: { Authorization: "secret" }, requestBody: "private", responseBody: "secret" });
  expect(network).toMatchObject({ name: "https://api.example/data", url: "https://api.example/data", headers: {} });
  expect(JSON.stringify(network)).not.toMatch(/private|secret|Authorization/);
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

test("stops replay when consent is revoked before a flag callback", () => {
  const window = fixture();
  const win = window as unknown as AnalyticsWindow;
  win.SuplexAnalytics.grantConsent();
  const options = win.posthog._i[0]![1];
  let flagsChanged = () => {};
  const client = {
    capture: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(),
    onFeatureFlags: vi.fn((callback: () => void) => { flagsChanged = callback; }),
    isFeatureEnabled: vi.fn(() => true), set_config: vi.fn(),
    startSessionRecording: vi.fn(), stopSessionRecording: vi.fn(),
  };
  (options.loaded as (loadedClient: unknown) => void)(client);
  flagsChanged();
  expect(client.startSessionRecording).toHaveBeenCalledTimes(1);
  win.SuplexAnalytics.denyConsent();
  flagsChanged();
  expect(client.stopSessionRecording).toHaveBeenCalledTimes(2);
  expect(client.set_config).toHaveBeenLastCalledWith({ disable_session_recording: true });
  win.SuplexAnalytics.grantConsent();
  expect(client.startSessionRecording).toHaveBeenCalledTimes(2);
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
  (options.loaded as (loadedClient: unknown) => void)({ capture, opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(), onFeatureFlags: vi.fn(), isFeatureEnabled: vi.fn(), set_config: vi.fn(), startSessionRecording: vi.fn(), stopSessionRecording: vi.fn() });
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
    capture: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(),
    onFeatureFlags: vi.fn(), isFeatureEnabled: vi.fn(), set_config: vi.fn(),
    startSessionRecording: vi.fn(), stopSessionRecording: vi.fn(),
  };
  (options.loaded as (loadedClient: unknown) => void)(client);
  const settings = window.document.querySelector("#suplex-analytics-settings") as unknown as { click(): void };
  expect(settings).toBeTruthy();
  settings.click();
  expect(win.localStorage.getItem("suplex.analytics.consent.v1")).toBeNull();
  expect(client.stopSessionRecording).toHaveBeenCalledTimes(1);
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
    onFeatureFlags: vi.fn(),
    isFeatureEnabled: vi.fn(() => false),
    set_config: vi.fn(),
    startSessionRecording: vi.fn(),
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
  (options.loaded as (client: unknown) => void)({ capture, get_distinct_id: () => "0190a1b2-c3d4-7e5f", opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(), onFeatureFlags: vi.fn(), isFeatureEnabled: vi.fn(), set_config: vi.fn(), startSessionRecording: vi.fn() });
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
  window.close();
});
