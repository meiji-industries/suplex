import { readdir, readFile } from "node:fs/promises";
import { Window as HappyWindow } from "happy-dom";
import { expect, test, vi } from "vitest";

const root = new URL("../", import.meta.url);
const consentSource = await readFile(new URL("apps/server/src/hosted/consent.js", root), "utf8");
const framerSource = await readFile(new URL("apps/server/src/hosted/framer-attribution.js", root), "utf8");
const KEY = "suplex.analytics.consent.v1";

type Clickable = { click(): void; href: string; getAttribute(name: string): string | null };
type SiteWindow = Window & typeof globalThis & {
  SuplexAnalytics: { grantConsent(): void; denyConsent(): void; clearConsent(): void };
  SuplexConsent: { value(): string | null; grant(): void; deny(): void; clear(): void };
  posthog?: { _i: Array<[string, Record<string, unknown>]> };
  gtag?: (...args: unknown[]) => void;
};

interface Site {
  url: string;
  html: string;
  stored?: string | undefined;
  gpc?: boolean | undefined;
  // getsuplex.ai runs the PostHog file too. Framer can load either script first.
  framer?: "before" | "after" | undefined;
}

function open({ url, html, stored, gpc, framer }: Site) {
  const window = new HappyWindow({ url });
  window.document.write(`<!doctype html><title>Page</title><script></script>${html}`);
  if (stored) window.localStorage.setItem(KEY, stored);
  if (gpc) Object.defineProperty(window.navigator, "globalPrivacyControl", { configurable: true, value: true });
  if (framer === "before") window.eval(framerSource);
  window.eval(consentSource);
  if (framer === "after") window.eval(framerSource);
  return window;
}

function api(window: HappyWindow) {
  return window as unknown as SiteWindow;
}

function element(window: HappyWindow, selector: string) {
  return window.document.querySelector(selector) as unknown as Clickable;
}

function banner(window: HappyWindow) {
  return window.document.querySelector("#suplex-analytics-consent");
}

function bannerButton(window: HappyWindow, label: "Accept" | "Reject") {
  const buttons = Array.from(window.document.querySelectorAll("#suplex-analytics-consent button"));
  return buttons.find(button => button.textContent === label) as unknown as { click(): void };
}

function loadPosthog(window: HappyWindow) {
  const options = api(window).posthog!._i[0]![1];
  const client = { capture: vi.fn(), get_distinct_id: () => "0190a1b2-c3d4-7e5f", opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn() };
  (options.loaded as (loaded: unknown) => void)(client);
  return client;
}

for (const framer of ["before", "after"] as const) {
  test(`a getsuplex.ai choice reaches suplex.sh through the link (consent.js loads ${framer === "before" ? "second" : "first"})`, () => {
    const website = open({
      url: "https://getsuplex.ai/",
      html: "<a id='trial' href='https://suplex.sh/start?plan=pro'>Start trial</a><a id='pricing' href='/#pricing'>Pricing</a>",
      framer,
    });
    expect(banner(website)?.textContent).toContain("Suplex collects usage data to improve the product.");
    bannerButton(website, "Accept").click();
    expect(website.localStorage.getItem(KEY)).toBe("granted");
    expect(api(website).posthog?._i[0]![0]).toMatch(/^phc_/);
    loadPosthog(website);
    const trial = element(website, "#trial");
    trial.click();
    const arrival = new URL(trial.href);
    expect(arrival.searchParams.get("consent")).toBe("granted");
    expect(arrival.searchParams.get("plan")).toBe("pro");
    expect(arrival.searchParams.get("visitor")).toBe("0190a1b2-c3d4-7e5f");
    expect(element(website, "#pricing").getAttribute("href")).toBe("/#pricing");
    website.close();

    // suplex.sh stores the choice and shows no banner. Its server keeps `consent` in each link.
    const signup = open({
      url: arrival.toString(),
      html: `<a id='email' href='/start?plan=pro&amp;with=email&amp;consent=granted&amp;visitor=0190a1b2-c3d4-7e5f'>Email</a>`,
    });
    expect(signup.localStorage.getItem(KEY)).toBe("granted");
    expect(banner(signup)).toBeNull();
    expect(signup.document.querySelector("#suplex-analytics-settings")?.textContent).toBe("Analytics settings");
    signup.close();
  });

  test(`a suplex.sh choice reaches getsuplex.ai and PostHog follows it (consent.js loads ${framer === "before" ? "second" : "first"})`, () => {
    // The visitor arrived with consent=denied, then accepted in the banner after a reset.
    const signup = open({
      url: "https://suplex.sh/terms?consent=denied&_gl=1*abc",
      html: "<a id='home' href='https://getsuplex.ai/'>Suplex</a><a id='privacy' href='/privacy?consent=denied&amp;_gl=1*abc'>Privacy</a><a id='other' href='https://example.com/'>Other</a>",
    });
    expect(signup.localStorage.getItem(KEY)).toBe("denied");
    expect(banner(signup)).toBeNull();
    const privacy = element(signup, "#privacy");
    // Analytics settings drops the old choice from same-site links; storage carries the new one.
    (signup.document.querySelector("#suplex-analytics-settings") as unknown as { click(): void }).click();
    expect(new URL(privacy.href).searchParams.has("consent")).toBe(false);
    bannerButton(signup, "Accept").click();
    expect(signup.localStorage.getItem(KEY)).toBe("granted");
    privacy.click();
    expect(new URL(privacy.href).searchParams.has("consent")).toBe(false);
    expect(new URL(privacy.href).searchParams.get("_gl")).toBe("1*abc");
    expect(element(signup, "#other").getAttribute("href")).toBe("https://example.com/");
    const home = element(signup, "#home");
    home.click();
    expect(home.href).toBe("https://getsuplex.ai/?consent=granted");
    signup.close();

    const website = open({ url: home.href, html: "<a id='download' href='https://suplex.sh/download?platform=macos-arm64'>Download</a>", framer });
    expect(website.localStorage.getItem(KEY)).toBe("granted");
    expect(banner(website)).toBeNull();
    expect(api(website).posthog?._i[0]![0]).toMatch(/^phc_/);
    const client = loadPosthog(website);
    expect(client.opt_in_capturing).toHaveBeenCalled();
    expect(client.capture).toHaveBeenCalledWith("$pageview", expect.objectContaining({ surface: "website" }));
    website.close();

    // A later denied choice on suplex.sh turns PostHog off on arrival, as Reject does.
    const denied = open({ url: "https://getsuplex.ai/?consent=denied", html: "", stored: "granted", framer });
    expect(denied.localStorage.getItem(KEY)).toBe("denied");
    if (framer === "before") {
      const loaded = loadPosthog(denied);
      expect(loaded.opt_out_capturing).toHaveBeenCalled();
    } else {
      expect(api(denied).posthog).toBeUndefined();
    }
    expect(denied.document.querySelector("#suplex-analytics-settings")).not.toBeNull();
    denied.close();
  });
}

test("Global Privacy Control forces denied on both sites", () => {
  for (const [url, framer] of [["https://getsuplex.ai/?consent=granted", "after"], ["https://suplex.sh/start?consent=granted", undefined]] as const) {
    const window = open({ url, html: "<a id='out' href='https://suplex.sh/start'>Start</a><a id='back' href='https://getsuplex.ai/'>Home</a>", gpc: true, framer });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(banner(window)).toBeNull();
    expect(window.document.querySelector("#suplex-analytics-settings")).toBeNull();
    expect(api(window).posthog).toBeUndefined();
    api(window).SuplexConsent.grant();
    api(window).SuplexAnalytics?.grantConsent();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(api(window).SuplexConsent.value()).toBe("denied");
    const out = element(window, new URL(url).hostname === "getsuplex.ai" ? "#out" : "#back");
    out.click();
    expect(new URL(out.href).searchParams.get("consent")).toBe("denied");
    window.close();
  }
  // A choice stored before GPC was turned on never leaves the page as granted.
  const earlier = open({ url: "https://suplex.sh/start", html: "<a id='home' href='https://getsuplex.ai/'>Home</a>", stored: "granted", gpc: true });
  const home = element(earlier, "#home");
  home.click();
  expect(home.href).toBe("https://getsuplex.ai/?consent=denied");
  earlier.close();
});

test("the banner shows only when no choice is stored and no consent parameter arrives", () => {
  const cases: Array<[string, string | undefined, boolean, string | null]> = [
    ["https://suplex.sh/start", undefined, true, null],
    ["https://suplex.sh/start?consent=maybe", undefined, true, null],
    ["https://suplex.sh/start?consent=denied", undefined, false, "denied"],
    ["https://suplex.sh/start?consent=granted", undefined, false, "granted"],
    ["https://suplex.sh/start", "denied", false, "denied"],
    ["https://getsuplex.ai/", "granted", false, "granted"],
    ["https://getsuplex.ai/?consent=denied", undefined, false, "denied"],
  ];
  for (const [url, stored, shown, after] of cases) {
    const window = open({ url, html: "", stored });
    expect([url, stored, Boolean(banner(window))]).toEqual([url, stored, shown]);
    expect(window.localStorage.getItem(KEY)).toBe(after);
    expect(Boolean(window.document.querySelector("#suplex-analytics-settings"))).toBe(!shown);
    window.close();
  }
});

test("withdrawing a granted choice sends a denied Consent Mode update", () => {
  const window = new HappyWindow({ url: "https://suplex.sh/start" });
  window.document.write("<!doctype html><title>Start</title>");
  window.localStorage.setItem(KEY, "granted");
  const gtag = vi.fn();
  (window as unknown as SiteWindow).gtag = gtag;
  window.eval(consentSource);
  const win = window as unknown as SiteWindow;
  win.SuplexConsent.grant();
  expect(gtag).not.toHaveBeenCalled();
  win.SuplexConsent.clear();
  expect(gtag).toHaveBeenCalledWith("consent", "update", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  window.close();
});

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    // Tests may quote the banner; shipped source may not copy it.
    if (["node_modules", "dist", "target", "generated", "tests"].includes(entry.name)) return [];
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return nested.flat();
}

test("the banner text and style exist only in the shared consent script, which both sites load", async () => {
  const files = [...await sourceFiles(new URL("apps/", root)), ...await sourceFiles(new URL("packages/", root))];
  const holders: string[] = [];
  for (const file of files) {
    if (!/\.(js|ts|tsx|rs|html|css)$/.test(file.pathname)) continue;
    const text = await readFile(file, "utf8");
    if (["Suplex collects usage data to improve the product.", "suplex-analytics-consent", "max-width:420px;padding:12px"].some(marker => text.includes(marker))) {
      holders.push(file.pathname.slice(root.pathname.length));
    }
  }
  expect(holders).toEqual(["apps/server/src/hosted/consent.js"]);
  const layout = await readFile(new URL("apps/server/src/shared/page.html", root), "utf8");
  expect(layout).toContain("<script src=\"/consent.js\" defer></script>");
  for (const page of ["terms", "privacy", "support"]) {
    expect(await readFile(new URL(`apps/server/src/hosted/legal/${page}.html`, root), "utf8")).toContain("<script src=\"/consent.js\" defer></script>");
  }
  expect(framerSource).not.toMatch(/createElement\("button"\)|cssText/);
});
