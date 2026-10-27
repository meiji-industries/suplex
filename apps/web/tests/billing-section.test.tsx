// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../lib/api.js", async importOriginal => ({ ...(await importOriginal()), readJsonUnchecked: api.readJson }));
const company = vi.hoisted(() => ({ applyBillingSummary: vi.fn(), user: { role: "admin" } as { role: string }, currentCompany: { id: "company-1" } }));
vi.mock("../shell/company-context.js", () => ({ useOptionalCompanyContext: () => company }));
vi.mock("../features/settings/settings-layout.js", () => ({
  SettingsSection: ({ title, children }: { title?: string; children: ReactNode }) => <section><h2>{title}</h2><div>{children}</div></section>,
  SettingRow: ({ label, description, children }: { label: string; description?: ReactNode; children?: ReactNode }) => (
    <div data-setting-row={label}><span>{label}</span>{description ? <span>{description}</span> : null}<span>{children}</span></div>
  ),
}));

import { ApiError } from "../lib/api.js";
import type { BillingSummary } from "../contracts/billing.js";
import { BillingSection, formatUsd } from "../features/settings/billing-section.js";

const free: BillingSummary = {
  plan: "free", limits: { companies: 1, projects: 2, runningTasks: 3, monthlyTasks: 50 }, usage: { companies: 1, projects: 1, runningTasks: 2, monthlyTasks: 12 },
  checked: true, accountLinked: true, canManageBilling: true, purchaseConfigured: true, trialAvailable: true,
  subscriptionStatus: "none", renewalAt: null, accessUntil: null, cancelAtPeriodEnd: false, paymentActionRequired: false, paymentActionUrl: null, purchasedSeats: 0, seatsUsed: 4, teamLapsed: false, interval: null,
};
const trial: BillingSummary = { ...free, plan: "pro", limits: { companies: 3, projects: 10, runningTasks: null, monthlyTasks: null }, trialAvailable: false, subscriptionStatus: "trialing", accessUntil: "2026-11-03T00:00:00.000Z" };
const pro: BillingSummary = { ...trial, subscriptionStatus: "active", renewalAt: "2026-11-03T00:00:00.000Z", purchasedSeats: 1 };
const team: BillingSummary = { ...pro, plan: "team", limits: { companies: null, projects: null, runningTasks: null, monthlyTasks: null }, purchasedSeats: 4 };

let roots: Root[] = [];
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
let tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<BillingSection />); });
  return container;
}

function button(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll("button")).find(candidate => candidate.textContent === label);
}

const posts = (path: string) => api.readJson.mock.calls.filter(([url, init]) => url === path && init?.method === "POST");

beforeEach(() => {
  api.readJson.mockReset();
  company.applyBillingSummary.mockReset();
  company.user = { role: "admin" };
  tab = { opener: window, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
});
afterEach(async () => {
  vi.useRealTimers();
  visibility = "visible";
  vi.restoreAllMocks();
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  document.body.replaceChildren();
});

test("formats USD minor units as whole dollars or exact cents", () => {
  expect(formatUsd(2000)).toBe("$20");
  expect(formatUsd(2550)).toBe("$25.50");
});

test("Free shows usage against each limit and starts the trial without a tab", async () => {
  api.readJson.mockImplementation(async (url: string) => url === "/api/billing/trial" ? trial : free);
  const container = await mount();
  const text = container.textContent ?? "";
  expect(text).toContain("Free plan");
  for (const usage of ["1 / 1", "2 / 3", "12 / 50"]) expect(text).toContain(usage);
  expect(text).toContain("The 14-day Pro trial needs no credit card.");
  expect(button(container, "Open billing")).toBeUndefined();
  await act(async () => button(container, "Start 14-day trial")!.click());
  expect(posts("/api/billing/trial")).toHaveLength(1);
  expect(window.open).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Pro trial");
  expect(container.textContent).toContain("2 / Unlimited");
  expect(company.applyBillingSummary).toHaveBeenLastCalledWith(trial);
});

test("Select Pro opens Checkout in a tab and keeps its key after a failure", async () => {
  api.readJson.mockImplementation(async (url: string) => {
    if (url === "/api/billing") return { ...free, trialAvailable: false };
    if (posts("/api/billing/checkout").length === 1) throw new ApiError("Down", 503, undefined, undefined, "billing_unavailable");
    return { status: "redirect", url: "https://checkout.stripe.com/c/pay/1" };
  });
  const container = await mount();
  expect(button(container, "Start 14-day trial")).toBeUndefined();
  await act(async () => button(container, "Select Pro")!.click());
  expect(container.textContent).toContain("Suplex cannot check the subscription.");
  expect(tab.close).toHaveBeenCalledOnce();
  await act(async () => button(container, "Select Pro")!.click());
  const keys = posts("/api/billing/checkout").map(([, init]) => (init.headers as Record<string, string>)["Idempotency-Key"]);
  expect(keys[0]).toBe(keys[1]);
  expect(posts("/api/billing/checkout")[0]![1].body).toBe(JSON.stringify({ interval: "month" }));
  expect(tab.location.href).toBe("https://checkout.stripe.com/c/pay/1");
});

test("Annual shows the yearly price and buys it with a new key", async () => {
  api.readJson.mockImplementation(async (url: string) => url === "/api/billing" ? { ...free, trialAvailable: false } : { status: "redirect", url: "https://checkout.stripe.com/c/pay/1" });
  const container = await mount();
  await act(async () => button(container, "Select Pro")!.click());
  await act(async () => button(container, "Annual (save 20%)")!.click());
  expect(container.textContent).toContain("$192/yr");
  await act(async () => button(container, "Select Pro")!.click());
  const [monthly, annual] = posts("/api/billing/checkout").map(([, init]) => init);
  expect(annual.body).toBe(JSON.stringify({ interval: "year" }));
  expect(annual.headers["Idempotency-Key"]).not.toBe(monthly.headers["Idempotency-Key"]);
});

test("Pro offers the billing portal and opens Stripe to confirm a switch to Team", async () => {
  api.readJson.mockImplementation(async (url: string) => url === "/api/billing/portal" ? { url: "https://billing.stripe.com/p/1" } : url === "/api/billing/change" ? { url: "https://billing.stripe.com/p/2" } : { ...pro, interval: "month" });
  const container = await mount();
  expect(container.textContent).toContain("Pro plan");
  expect(container.textContent).toContain("Renews on");
  expect(container.textContent).toContain("Current plan");
  expect(button(container, "Select Pro")).toBeUndefined();
  await act(async () => button(container, "Open billing")!.click());
  expect(tab.location.href).toBe("https://billing.stripe.com/p/1");
  await act(async () => button(container, "Switch to Team")!.click());
  expect(posts("/api/billing/change")[0]![1].body).toBe(JSON.stringify({ plan: "team", interval: "month", quantity: 4 }));
  expect(tab.location.href).toBe("https://billing.stripe.com/p/2");
  await act(async () => button(container, "Annual (save 20%)")!.click());
  await act(async () => button(container, "Switch to annual")!.click());
  expect(posts("/api/billing/change")[1]![1].body).toBe(JSON.stringify({ plan: "pro", interval: "year" }));
  await act(async () => button(container, "Cancel plan")!.click());
  expect(posts("/api/billing/change")[2]![1].body).toBe(JSON.stringify({ plan: "free" }));
});

test("Team buys a seat for each user, at least 3, and shows seats in use", async () => {
  api.readJson.mockImplementation(async (url: string) => url === "/api/billing" ? free : { status: "redirect", url: "https://checkout.stripe.com/c/pay/1" });
  const container = await mount();
  expect(container.textContent).toContain("$90/mo for 4 seats");
  await act(async () => button(container, "Select Team")!.click());
  expect(posts("/api/billing/checkout")[0]![1].body).toBe(JSON.stringify({ plan: "team", interval: "month", quantity: 4 }));
  api.readJson.mockImplementation(async () => team);
  const teamView = await mount();
  expect(teamView.textContent).toContain("Team plan");
  expect(teamView.textContent).toContain("Current plan");
  expect(teamView.querySelector('[data-setting-row="Seats"]')?.textContent).toContain("4 of 4");
});

test("a lapsed Team says that work is read-only", async () => {
  api.readJson.mockImplementation(async () => ({ ...free, teamLapsed: true, trialAvailable: false }));
  const container = await mount();
  expect(container.textContent).toContain("Team ended");
  expect(container.textContent).toContain("Work is read-only until you select Team again.");
});

test("a member or a host without a Suplex account sees the plan without actions", async () => {
  api.readJson.mockResolvedValue({ ...free, canManageBilling: false });
  let container = await mount();
  expect(button(container, "Select Pro")).toBeUndefined();
  api.readJson.mockResolvedValue({ ...free, accountLinked: false, trialAvailable: false });
  container = await mount();
  expect(container.textContent).toContain("Log in to your Suplex account to start a trial or select Pro.");
  expect(button(container, "Select Pro")).toBeUndefined();
});

function link(scope: ParentNode, label: string): HTMLAnchorElement | undefined {
  return Array.from(scope.querySelectorAll("a")).find(candidate => candidate.textContent === label);
}

test("Team with free seats links an administrator to invite and manage users", async () => {
  api.readJson.mockResolvedValue({ ...team, seatsUsed: 1 });
  const container = await mount();
  const row = container.querySelector('[data-setting-row="Seats"]')!;
  expect(link(row, "Invite")?.getAttribute("href")).toBe("/admin?invite=1&company=company-1");
  expect(link(row, "Manage")?.getAttribute("href")).toBe("/admin?company=company-1");
  expect(row.textContent).toMatch(/InviteManage1 of 4$/);
});

test("Team with all seats used offers Manage without Invite", async () => {
  api.readJson.mockResolvedValue(team);
  const container = await mount();
  const row = container.querySelector('[data-setting-row="Seats"]')!;
  expect(link(row, "Invite")).toBeUndefined();
  expect(link(row, "Manage")?.getAttribute("href")).toBe("/admin?company=company-1");
});

test("a member sees the seat count without Invite or Manage", async () => {
  company.user = { role: "member" };
  api.readJson.mockResolvedValue({ ...team, seatsUsed: 1 });
  const container = await mount();
  const row = container.querySelector('[data-setting-row="Seats"]')!;
  expect(row.textContent).toContain("1 of 4");
  expect(link(row, "Invite")).toBeUndefined();
  expect(link(row, "Manage")).toBeUndefined();
});

test("plans other than Team show no Seats row", async () => {
  api.readJson.mockResolvedValue(pro);
  const container = await mount();
  expect(container.querySelector('[data-setting-row="Seats"]')).toBeNull();
});

const reads = () => api.readJson.mock.calls.filter(([url, init]) => url === "/api/billing" && init === undefined).length;
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

test("the page reads the plan every 15 s while it is visible and shows a change without the loading state", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  api.readJson.mockResolvedValue(free);
  const container = await mount();
  expect(reads()).toBe(1);
  api.readJson.mockResolvedValue(team);
  await tick(15_000);
  expect(reads()).toBe(2);
  expect(container.querySelector("[aria-busy]")).toBeNull();
  expect(container.textContent).toContain("Team plan");
  expect(company.applyBillingSummary).toHaveBeenLastCalledWith(team);

  // A hidden page does not read. Showing it again reads at once.
  visibility = "hidden";
  await tick(45_000);
  expect(reads()).toBe(2);
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(reads()).toBe(3);

  // Unmounting stops the reads.
  await act(async () => { roots.pop()!.unmount(); });
  await tick(60_000);
  expect(reads()).toBe(3);
});

test("focus reads the plan at once, also when Suplex did not open Stripe", async () => {
  api.readJson.mockResolvedValue(free);
  const container = await mount();
  api.readJson.mockResolvedValue(pro);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(reads()).toBe(2);
  expect(container.textContent).toContain("Pro plan");
});

test("a failed background read keeps the last summary; only the first read shows the error", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  api.readJson.mockResolvedValue(pro);
  const container = await mount();
  api.readJson.mockRejectedValue(new Error("Down"));
  await tick(15_000);
  expect(reads()).toBe(2);
  expect(container.textContent).toContain("Pro plan");
  expect(container.textContent).not.toContain("Reload the page to retry.");

  api.readJson.mockRejectedValue(new Error("Down"));
  const failed = await mount();
  expect(failed.textContent).toContain("Down. Reload the page to retry.");
});

test("a background read waits while an action runs and does not replace its answer", async () => {
  let answerTrial: (value: BillingSummary) => void = () => undefined;
  api.readJson.mockImplementation((url: string) => url === "/api/billing/trial" ? new Promise(resolve => { answerTrial = resolve; }) : Promise.resolve(free));
  const container = await mount();
  await act(async () => { button(container, "Start 14-day trial")!.click(); });
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(reads()).toBe(1);
  await act(async () => { answerTrial(trial); });
  expect(container.textContent).toContain("Pro trial");
});

