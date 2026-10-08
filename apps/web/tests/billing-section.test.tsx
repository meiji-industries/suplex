// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../lib/api.js", async importOriginal => ({ ...(await importOriginal()), readJsonUnchecked: api.readJson }));
const company = vi.hoisted(() => ({ setPlan: vi.fn() }));
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
  subscriptionStatus: "none", renewalAt: null, accessUntil: null, cancelAtPeriodEnd: false, paymentActionRequired: false, paymentActionUrl: null,
};
const trial: BillingSummary = { ...free, plan: "pro", limits: { companies: 3, projects: 10, runningTasks: null, monthlyTasks: null }, trialAvailable: false, subscriptionStatus: "trialing", accessUntil: "2026-11-03T00:00:00.000Z" };
const pro: BillingSummary = { ...trial, subscriptionStatus: "active", renewalAt: "2026-11-03T00:00:00.000Z" };

let roots: Root[] = [];
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
  company.setPlan.mockReset();
  tab = { opener: window, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
});
afterEach(async () => {
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
  expect(text).toContain("No credit card is necessary.");
  expect(button(container, "Open billing")).toBeUndefined();
  await act(async () => button(container, "Start the 14-day trial")!.click());
  expect(posts("/api/billing/trial")).toHaveLength(1);
  expect(window.open).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Pro trial");
  expect(container.textContent).toContain("2 / Unlimited");
  expect(company.setPlan).toHaveBeenLastCalledWith("pro");
});

test("Select Pro opens Checkout in a tab and keeps its key after a failure", async () => {
  api.readJson.mockImplementation(async (url: string) => {
    if (url === "/api/billing") return { ...free, trialAvailable: false };
    if (posts("/api/billing/checkout").length === 1) throw new ApiError("Down", 503, undefined, undefined, "billing_unavailable");
    return { status: "redirect", url: "https://checkout.stripe.com/c/pay/1" };
  });
  const container = await mount();
  expect(button(container, "Start the 14-day trial")).toBeUndefined();
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
  api.readJson.mockImplementation(async (url: string) => url === "/api/billing" ? free : { status: "redirect", url: "https://checkout.stripe.com/c/pay/1" });
  const container = await mount();
  await act(async () => button(container, "Select Pro")!.click());
  await act(async () => button(container, "Annual")!.click());
  expect(container.textContent).toContain("$192 each year ($16 each month).");
  await act(async () => button(container, "Select Pro")!.click());
  const [monthly, annual] = posts("/api/billing/checkout").map(([, init]) => init);
  expect(annual.body).toBe(JSON.stringify({ interval: "year" }));
  expect(annual.headers["Idempotency-Key"]).not.toBe(monthly.headers["Idempotency-Key"]);
});

test("Pro offers the billing portal and shows the renewal", async () => {
  api.readJson.mockImplementation(async (url: string) => url === "/api/billing/portal" ? { url: "https://billing.stripe.com/p/1" } : pro);
  const container = await mount();
  expect(container.textContent).toContain("Pro plan");
  expect(container.textContent).toContain("Renews on");
  expect(button(container, "Select Pro")).toBeUndefined();
  await act(async () => button(container, "Open billing")!.click());
  expect(tab.location.href).toBe("https://billing.stripe.com/p/1");
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
