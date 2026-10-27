// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { EmailUpdatesSetting } from "../features/profiles/email-updates-setting.js";
import { EMAIL_UPDATES_LABEL, EMAIL_UPDATES_NOTE, setEmailUpdates } from "../features/account/lib/account-api.js";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const sentBodies = (fetch: ReturnType<typeof vi.fn>): unknown[] => fetch.mock.calls.flatMap(([, init]) => (init as RequestInit | undefined)?.body ? [JSON.parse(String((init as RequestInit).body))] : []);

test("the Settings switch saves the label and description that Settings shows", async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ available: true, subscribed: init?.method === "PUT" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<EmailUpdatesSetting />));
  const row = container.querySelector("[data-setting-row]")!;
  const [label, description] = Array.from(row.querySelectorAll(":scope > div:first-child > div")).map(element => element.textContent);
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(sentBodies(fetch)).toEqual([{ subscribed: true, source: "settings", wording: `${label}. ${description}` }]);
});

test("the onboarding choice saves the onboarding checkbox text", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ available: true, subscribed: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await setEmailUpdates(true, "onboarding");
  expect(sentBodies(fetch)).toEqual([{ subscribed: true, source: "onboarding", wording: `${EMAIL_UPDATES_LABEL} ${EMAIL_UPDATES_NOTE}` }]);
});
