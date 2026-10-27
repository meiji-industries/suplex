// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../lib/api.js", async importOriginal => ({ ...(await importOriginal()), readJsonUnchecked: api.readJson }));

import type { BillingSummary } from "../contracts/billing.js";
import type { ApiCompany } from "../lib/api.js";
import { CompanyProvider, useCompanyContext, type CompanyContextValue } from "../shell/company-context.js";

const summary = (plan: BillingSummary["plan"], extra: Partial<BillingSummary> = {}): BillingSummary => ({
  plan, limits: { companies: null, projects: null, runningTasks: null, monthlyTasks: null }, usage: { companies: 2, projects: 1, runningTasks: 0, monthlyTasks: 0 },
  checked: true, accountLinked: true, canManageBilling: false, purchaseConfigured: true, trialAvailable: false,
  subscriptionStatus: "active", renewalAt: null, accessUntil: null, cancelAtPeriodEnd: false, paymentActionRequired: false, paymentActionUrl: null, purchasedSeats: 3, seatsUsed: 2, teamLapsed: false, interval: "month", ...extra,
});
const company = (id: string, plan: ApiCompany["plan"], extra: Partial<ApiCompany> = {}): ApiCompany => ({ id, name: id, status: "active", issueCode: null, createdAt: "2026-10-01T00:00:00.000Z", plan, access: "edit", teamLapsed: false, ...extra });

let server: { companies: ApiCompany[]; billing: () => Promise<BillingSummary> };
let context: CompanyContextValue | undefined;
let root: Root | undefined;
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

function Probe(): null {
  context = useCompanyContext();
  return null;
}

const calls = (path: string) => api.readJson.mock.calls.filter(([url]) => url === path).length;
const plans = () => context!.companies.map(item => `${item.id}:${item.plan}:${item.teamLapsed ? "lapsed" : "paid"}:${item.access}`);

async function mount(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<CompanyProvider><Probe /></CompanyProvider>); });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/tasks");
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
  server = { companies: [company("acme", "free"), company("beta", "free")], billing: async () => summary("team") };
  api.readJson.mockReset();
  api.readJson.mockImplementation(async (url: string) => {
    if (url === "/api/auth/me") return { user: { id: "member-1", role: "member" } };
    if (url === "/api/companies") return { companies: server.companies };
    if (url === "/api/avatars") return { avatars: {} };
    if (url === "/api/billing") return server.billing();
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  visibility = "visible";
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  context = undefined;
  document.body.replaceChildren();
});

test("a Member sees Team in the shell once a checked plan read arrives after load", async () => {
  // The first company list still says Free; GET /api/billing reads suplex.sh.
  server.billing = async () => {
    server.companies = [company("acme", "team", { access: "read" }), company("beta", "team")];
    return summary("team");
  };
  await mount();
  expect(calls("/api/billing")).toBe(1);
  // Access is read again, without the loading state.
  expect(calls("/api/companies")).toBe(2);
  expect(context!.loading).toBe(false);
  expect(plans()).toEqual(["acme:team:paid:read", "beta:team:paid:edit"]);
  expect(context!.currentCompany?.plan).toBe("team");
});

test("an unchecked plan read leaves the shown plan unchanged", async () => {
  server.billing = async () => summary("free", { checked: false });
  await mount();
  expect(calls("/api/billing")).toBe(1);
  expect(calls("/api/companies")).toBe(1);
  expect(plans()).toEqual(["acme:free:paid:edit", "beta:free:paid:edit"]);
});

test("the Billing page and the shell apply a checked summary through one path, with teamLapsed", async () => {
  server.billing = async () => summary("free");
  await mount();
  expect(calls("/api/companies")).toBe(1);
  server.companies = [company("acme", "free", { teamLapsed: true, access: "read" }), company("beta", "free", { teamLapsed: true, access: "read" })];
  await act(async () => { context!.applyBillingSummary(summary("free", { teamLapsed: true })); });
  expect(plans()).toEqual(["acme:free:lapsed:read", "beta:free:lapsed:read"]);
  expect(context!.currentCompany?.teamLapsed).toBe(true);
  // The same plan again reads nothing more.
  await act(async () => { context!.applyBillingSummary(summary("free", { teamLapsed: true })); });
  expect(calls("/api/companies")).toBe(2);
});

test("the shell reads the plan on return to the tab, at most every 15 s, and every 5 minutes while visible", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  server.billing = async () => summary("free");
  await mount();
  expect(calls("/api/billing")).toBe(1);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(calls("/api/billing")).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(calls("/api/billing")).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(calls("/api/billing")).toBe(3);

  // A failed read keeps the plan; the interval reads again.
  server.billing = async () => { throw new Error("Down"); };
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(calls("/api/billing")).toBe(4);
  expect(plans()).toEqual(["acme:free:paid:edit", "beta:free:paid:edit"]);

  // A hidden tab does not read.
  visibility = "hidden";
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
  expect(calls("/api/billing")).toBe(4);
  server.billing = async () => {
    server.companies = [company("acme", "team"), company("beta", "team")];
    return summary("team");
  };
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(calls("/api/billing")).toBe(5);
  expect(context!.currentCompany?.plan).toBe("team");
});
