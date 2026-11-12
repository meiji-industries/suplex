import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// The conversion script that hosted pages render (apps/server/src/shared/page.rs).
const template = readFileSync(new URL("../apps/server/src/shared/conversion.js", import.meta.url), "utf8");
const HASH = "a".repeat(64);
const EVENT = { event: "signup_complete", method: "google", plan: "free" };

/** Renders the script as the server does and runs it against stand-ins for the browser globals. */
function push(options: { consent?: string | null; gpc?: boolean; hash?: string | null; storageFails?: boolean } = {}) {
  const source = template
    .replace("__SUPLEX_EMAIL_HASH__", JSON.stringify(options.hash === undefined ? HASH : options.hash))
    .replace("__SUPLEX_EVENT__", JSON.stringify(EVENT));
  const localStorage = {
    getItem: (key: string) => {
      if (options.storageFails) throw new Error("blocked");
      return key === "suplex.analytics.consent.v1" ? (options.consent ?? null) : null;
    },
  };
  const window: { localStorage: typeof localStorage; dataLayer?: unknown[] } = { localStorage, dataLayer: [{ event: "gtm.js" }] };
  const navigator = options.gpc ? { globalPrivacyControl: true } : {};
  new Function("window", "navigator", source)(window, navigator);
  return window.dataLayer!;
}

test("granted consent without GPC adds the email hash as user_data", () => {
  const layer = push({ consent: "granted" });
  expect(layer).toHaveLength(2);
  expect(layer[1]).toEqual({ ...EVENT, user_data: { sha256_email_address: HASH } });
});

test("denied, unset, or unreadable consent pushes the event without user_data", () => {
  for (const options of [{ consent: "denied" }, { consent: null }, { consent: "granted", storageFails: true }]) {
    const layer = push(options);
    expect(layer[1]).toEqual(EVENT);
    expect(layer[1]).not.toHaveProperty("user_data");
  }
});

test("Global Privacy Control removes user_data even with granted consent", () => {
  expect(push({ consent: "granted", gpc: true })[1]).toEqual(EVENT);
});

test("without an email hash the event has no user_data", () => {
  expect(push({ consent: "granted", hash: null })[1]).toEqual(EVENT);
});

test("the hash stays in the script: no global or dataLayer copy without consent", () => {
  const layer = push({ consent: "denied" });
  expect(JSON.stringify(layer)).not.toContain(HASH);
  expect(template).not.toMatch(/@|email_address\s*=/);
});
