// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("../src/frontend/lib/api.js", async importOriginal => ({ ...(await importOriginal()), readJsonUnchecked: api.readJson }));
const company = vi.hoisted(() => ({ setCompanyPlan: vi.fn() }));
vi.mock("../src/frontend/shell/company-context.js", () => ({ useOptionalCompanyContext: () => company }));
vi.mock("../src/frontend/features/settings/settings-layout.js", () => ({
  SettingsSection: ({ title, description, children }: { title?: string; description?: string; children: ReactNode }) => (
    <section><h2>{title}</h2>{description ? <p>{description}</p> : null}<div>{children}</div></section>
  ),
  SettingRow: ({ label, description, children }: { label: string; description?: string; children: ReactNode }) => (
    <div data-setting-row={label}><span>{label}</span>{description ? <span>{description}</span> : null}<span>{children}</span></div>
  ),
}));

import { ApiError } from "../src/frontend/lib/api.js";
import { BillingSection, formatUsd } from "../src/frontend/features/settings/billing-section.js";

const apiError = (message: string, statusCode: number, code?: string) => new ApiError(message, statusCode, undefined, undefined, code);

const base = { companyId: "c1", projectCount: 2, requiredSeats: 2, canManageBilling: true, purchaseConfigured: true };
const freeSummary = { ...base, plan: "free" as const, projectLimit: 2 as const, purchasedSeats: 0 as const, canCreateProject: false, checkedAt: "2026-09-14T00:00:00.000Z" };
const proSummary = {
  ...base, plan: "pro" as const, projectLimit: null, purchasedSeats: 3, canCreateProject: true, checkedAt: "2026-09-14T00:00:00.000Z",
  subscriptionStatus: "active", renewalAt: "2026-10-01T00:00:00.000Z", accessUntil: "2026-10-01T00:00:00.000Z",
  cancelAtPeriodEnd: false, paymentActionRequired: false, paymentActionUrl: null, unitAmount: 2000 as const, currency: "usd" as const, monthlySubtotal: 6000,
};
const unknownSummary = { ...base, plan: "unknown" as const, canCreateProject: null, checkedAt: null, reason: "billing_unavailable" as const };
const shortageSummary = { ...proSummary, projectLimit: 2 as const, purchasedSeats: 2, requiredSeats: 5, canCreateProject: false, restriction: "seat_limit_exceeded" as const, monthlySubtotal: 4000 };

function renderSection() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

async function mount(root: Root, companyId = "c1") {
  await act(async () => { root.render(<BillingSection companyId={companyId} />); });
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
}

const billingGets = () => api.readJson.mock.calls.filter(([url, init]) => String(url).endsWith("/billing") && init?.method === undefined).length;
const postsTo = (suffix: string) => api.readJson.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init?.method === "POST");
const idempotencyKeyOf = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>;

let roots: Root[] = [];
let tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api.readJson.mockReset();
  roots = [];
  window.sessionStorage.clear();
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
  expect(formatUsd(0)).toBe("$0");
  expect(formatUsd(2000)).toBe("$20");
  expect(formatUsd(1)).toBe("$0.01");
  expect(formatUsd(2550)).toBe("$25.50");
  expect(formatUsd(2599)).toBe("$25.99");
});

test("renders the free plan and offers Select Pro to an administrator", async () => {
  api.readJson.mockResolvedValue(freeSummary);
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const text = container.textContent ?? "";
  expect(text).toContain("Free");
  expect(text).toContain("2 / 2");
  expect(text).toContain("0 purchased, 2 active");
  expect(button(container, "Select Pro")).toBeDefined();
  expect(button(container, "Open billing")).toBeUndefined();
});

test("renders the pro plan with formatted price, subtotal, and renewal", async () => {
  api.readJson.mockResolvedValue(proSummary);
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const text = container.textContent ?? "";
  expect(text).toContain("Pro");
  expect(text).toContain("2 / Unlimited");
  expect(text).toContain("3 purchased, 2 active");
  expect(text).toContain("$20 per seat each month");
  expect(text).toContain("$60");
  expect(text).toContain("Open billing");
});

test("renders unknown plan without inventing seat or project capacity", async () => {
  api.readJson.mockResolvedValue(unknownSummary);
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const text = container.textContent ?? "";
  expect(text).toContain("Unknown purchased, 2 active");
  expect(text).toContain("2 / Unknown");
  expect(text).not.toContain("0 purchased");
  expect(button(container, "Select Pro")).toBeUndefined();
  expect(button(container, "Open billing")).toBeUndefined();
});

test("explains the seat shortage while keeping the Pro label", async () => {
  api.readJson.mockResolvedValue(shortageSummary);
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const text = container.textContent ?? "";
  expect(text).toContain("Pro");
  expect(text).toContain("Purchased seats do not cover the active accounts. Suplex blocks new projects beyond the Free allowance until you add seats.");
  expect(text).toContain("2 purchased, 5 active");
});

test("shows an error state on a failed fetch", async () => {
  api.readJson.mockRejectedValueOnce(apiError("Suplex cannot check the subscription", 503, "billing_unavailable"));
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  expect(container.textContent).toContain("Suplex cannot check the subscription. Reload the page to retry.");
});

test("does not offer a purchase when billing is not configured", async () => {
  api.readJson.mockResolvedValue({ ...freeSummary, purchaseConfigured: false });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  expect(container.textContent).toContain("Billing is not configured.");
  expect(container.textContent).toContain("An operator configures the hosted billing service.");
  expect(button(container, "Select Pro")).toBeUndefined();
});

test("a free plan with subscriptionStatus none still offers Select Pro", async () => {
  api.readJson.mockResolvedValue({ ...freeSummary, subscriptionStatus: "none" });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  expect(button(container, "Select Pro")).toBeDefined();
  expect(button(container, "Open billing")).toBeUndefined();
});

test("Select Pro after an abandoned checkout recovers through the hosted command without stored state", async () => {
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/checkout")) return { status: "redirect", url: "https://checkout.example/session_resumed" };
    return { ...freeSummary, subscriptionStatus: "none" };
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  await act(async () => { button(container, "Select Pro")!.click(); });
  await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="Seats"]')!.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  expect(postsTo("/billing/checkout")).toHaveLength(1);
  expect(tab.location.href).toBe("https://checkout.example/session_resumed");
  expect(window.sessionStorage.length).toBe(0);
  expect(window.localStorage?.length ?? 0).toBe(0);
});

test.each(["canceled", "incomplete_expired"])("a free plan with a terminal %s subscription offers Select Pro and Open billing", async (subscriptionStatus) => {
  api.readJson.mockResolvedValue({ ...freeSummary, subscriptionStatus, accessUntil: "2026-08-01T00:00:00.000Z", cancelAtPeriodEnd: false, paymentActionRequired: false, paymentActionUrl: null });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  expect(button(container, "Select Pro")).toBeDefined();
  expect(button(container, "Open billing")).toBeDefined();
});

test.each(["incomplete", "past_due", "unpaid", "paused"])("a free plan with a recoverable %s subscription keeps payment and management controls without a new purchase", async (subscriptionStatus) => {
  api.readJson.mockResolvedValue({ ...freeSummary, subscriptionStatus, paymentActionRequired: true, paymentActionUrl: "https://billing.example/pay" });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  expect(button(container, "Select Pro")).toBeUndefined();
  expect(button(container, "Open billing")).toBeDefined();
  const link = container.querySelector<HTMLAnchorElement>('a[href="https://billing.example/pay"]');
  expect(link?.target).toBe("_blank");
});

test("a free plan with a source-active but fully refunded subscription keeps management controls without a new purchase", async () => {
  api.readJson.mockResolvedValue({ ...freeSummary, subscriptionStatus: "active", cancelAtPeriodEnd: false, paymentActionRequired: false, paymentActionUrl: null });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  expect(container.textContent).toContain("The subscription has no paid access.");
  expect(button(container, "Select Pro")).toBeUndefined();
  expect(button(container, "Open billing")).toBeDefined();
});

test("Select Pro posts the quantity with an Idempotency-Key and opens checkout in a new tab", async () => {
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/checkout")) return { status: "redirect", url: "https://checkout.example/session_1" };
    return freeSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  await act(async () => { button(container, "Select Pro")!.click(); });
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Seats"]');
  expect(input?.value).toBe("2");
  expect(container.textContent).toContain("$40 each month before tax.");
  await act(async () => { input!.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  const checkoutCalls = postsTo("/billing/checkout");
  expect(checkoutCalls).toHaveLength(1);
  expect(checkoutCalls[0]![1]?.body).toBe(JSON.stringify({ quantity: 2 }));
  expect((idempotencyKeyOf(checkoutCalls[0]!)["Idempotency-Key"] ?? "").length).toBeGreaterThanOrEqual(8);
  expect(window.open).toHaveBeenCalledWith("", "_blank");
  expect(tab.opener).toBeNull();
  expect(tab.location.href).toBe("https://checkout.example/session_1");
});

test("a retried checkout reuses the idempotency key for the same intent", async () => {
  let failures = 1;
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/checkout")) {
      if (failures > 0) { failures -= 1; throw apiError("Network failed", 0); }
      return { status: "redirect", url: "https://checkout.example/session_2" };
    }
    return freeSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  await act(async () => { button(container, "Select Pro")!.click(); });
  const submit = () => container.querySelector<HTMLInputElement>('input[aria-label="Seats"]')!.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => { submit().click(); });
  expect(container.textContent).toContain("Network failed");
  await act(async () => { submit().click(); });
  const checkoutCalls = postsTo("/billing/checkout");
  expect(checkoutCalls).toHaveLength(2);
  expect(idempotencyKeyOf(checkoutCalls[0]!)["Idempotency-Key"]).toBe(idempotencyKeyOf(checkoutCalls[1]!)["Idempotency-Key"]);
});

test("a seat increase previews exact amounts and confirms with the preview id", async () => {
  const preview = { previewId: "pv_1", expiresAt: "2026-09-14T01:00:00.000Z", currentQuantity: 3, requestedQuantity: 5, amountDueNow: 2500, nextSubtotal: 10000, currency: "usd", prorationTimestamp: 1758000000 };
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/seats/preview")) return preview;
    if (init?.method === "POST" && String(url).endsWith("/billing/seats")) return { status: "applied", summary: { ...proSummary, purchasedSeats: 5, monthlySubtotal: 10000 } };
    return proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]');
  expect(input?.value).toBe("3");
  await act(async () => { setInput(input!, "5"); });
  await act(async () => { input!.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  expect(postsTo("/billing/seats/preview")).toHaveLength(1);
  expect(postsTo("/billing/seats/preview")[0]![1]?.body).toBe(JSON.stringify({ quantity: 5 }));
  const text = container.textContent ?? "";
  expect(text).toContain("New total 5 seats. Due now $25");
  expect(text).toContain("Each month after $100 before tax.");
  await act(async () => { button(container, "Save seats")!.click(); });
  const seatCalls = postsTo("/billing/seats");
  expect(seatCalls).toHaveLength(1);
  expect(seatCalls[0]![1]?.body).toBe(JSON.stringify({ quantity: 5, previewId: "pv_1" }));
  expect(container.textContent).toContain("5 purchased, 2 active");
});

test("a retried seat confirmation reuses the same idempotency key", async () => {
  const preview = { previewId: "pv_1", expiresAt: "2026-09-14T01:00:00.000Z", currentQuantity: 3, requestedQuantity: 5, amountDueNow: 2500, nextSubtotal: 10000, currency: "usd", prorationTimestamp: 1758000000 };
  let failures = 1;
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/seats/preview")) return preview;
    if (init?.method === "POST" && String(url).endsWith("/billing/seats")) {
      if (failures > 0) { failures -= 1; throw apiError("Network failed", 0); }
      return { status: "applied", summary: { ...proSummary, purchasedSeats: 5, monthlySubtotal: 10000 } };
    }
    return proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]')!;
  await act(async () => { setInput(input, "5"); });
  await act(async () => { input.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await act(async () => { button(container, "Save seats")!.click(); });
  expect(container.textContent).toContain("Network failed");
  await act(async () => { button(container, "Save seats")!.click(); });
  const seatCalls = postsTo("/billing/seats");
  expect(seatCalls).toHaveLength(2);
  expect(idempotencyKeyOf(seatCalls[0]!)["Idempotency-Key"]).toBe(idempotencyKeyOf(seatCalls[1]!)["Idempotency-Key"]);
  expect(seatCalls[0]![1]?.body).toBe(seatCalls[1]![1]?.body);
});

test("a changed quote displays the new quote for re-confirmation", async () => {
  const previewOne = { previewId: "pv_1", expiresAt: "2026-09-14T01:00:00.000Z", currentQuantity: 3, requestedQuantity: 5, amountDueNow: 2500, nextSubtotal: 10000, currency: "usd", prorationTimestamp: 1758000000 };
  const previewTwo = { ...previewOne, previewId: "pv_2", amountDueNow: 3000 };
  let previews = 0;
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/seats/preview")) { previews += 1; return previews === 1 ? previewOne : previewTwo; }
    if (init?.method === "POST" && String(url).endsWith("/billing/seats")) {
      const body = JSON.parse(String(init.body)) as { previewId: string };
      if (body.previewId === "pv_1") throw apiError("The quote changed", 409, "billing_quote_changed");
      return { status: "applied", summary: { ...proSummary, purchasedSeats: 5, monthlySubtotal: 10000 } };
    }
    return proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]')!;
  await act(async () => { setInput(input, "5"); });
  await act(async () => { input.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await act(async () => { button(container, "Save seats")!.click(); });
  expect(container.textContent).toContain("The quote changed. Review the new amounts before you save.");
  expect(container.textContent).toContain("Due now $30");
  await act(async () => { button(container, "Save seats")!.click(); });
  const seatCalls = postsTo("/billing/seats");
  expect(seatCalls).toHaveLength(2);
  expect(seatCalls[1]![1]?.body).toBe(JSON.stringify({ quantity: 5, previewId: "pv_2" }));
});

test("a seat decrease requires confirmation and sends confirmNoRefund", async () => {
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/seats")) return { status: "applied", summary: { ...proSummary, purchasedSeats: 2, monthlySubtotal: 4000 } };
    return proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]')!;
  await act(async () => { setInput(input, "2"); });
  await act(async () => { input.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  expect(postsTo("/billing/seats")).toHaveLength(0);
  expect(document.body.textContent).toContain("Suplex does not refund the remaining paid period. The lower total applies at the next renewal.");
  const dialog = document.body.querySelector('[data-slot="alert-dialog-content"]');
  expect(dialog).not.toBeNull();
  await act(async () => { button(dialog as ParentNode, "Save seats")!.click(); });
  const seatCalls = postsTo("/billing/seats");
  expect(seatCalls).toHaveLength(1);
  expect(seatCalls[0]![1]?.body).toBe(JSON.stringify({ quantity: 2, confirmNoRefund: true }));
  expect(container.textContent).toContain("2 purchased, 2 active");
});

test("a stale response for the previous company never lands on the new view", async () => {
  let resolveA: (value: unknown) => void = () => undefined;
  api.readJson.mockImplementation(async (url: string) => {
    if (String(url).includes("/a/")) return new Promise((resolve) => { resolveA = resolve; });
    return { ...proSummary, companyId: "b", projectCount: 7, purchasedSeats: 9 };
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root, "a");
  await act(async () => { root.render(<BillingSection companyId="b" />); });
  expect(container.textContent).toContain("7 / Unlimited");
  expect(container.textContent).toContain("9 purchased, 2 active");
  await act(async () => { resolveA(freeSummary); });
  expect(container.textContent).toContain("7 / Unlimited");
  expect(container.textContent).not.toContain("0 purchased, 2 active");
});

test("payment_required keeps the old seats and renders the payment link", async () => {
  const preview = { previewId: "pv_1", expiresAt: "2026-09-14T01:00:00.000Z", currentQuantity: 3, requestedQuantity: 5, amountDueNow: 2500, nextSubtotal: 10000, currency: "usd", prorationTimestamp: 1758000000 };
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/seats/preview")) return preview;
    if (init?.method === "POST" && String(url).endsWith("/billing/seats")) return { status: "payment_required", url: "https://billing.example/authenticate", summary: proSummary };
    return proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]')!;
  await act(async () => { setInput(input, "5"); });
  await act(async () => { input.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await act(async () => { button(container, "Save seats")!.click(); });
  const link = container.querySelector<HTMLAnchorElement>('a[href="https://billing.example/authenticate"]');
  expect(link).not.toBeNull();
  expect(link!.target).toBe("_blank");
  expect(container.textContent).toContain("3 purchased, 2 active");
});

test("Open billing opens the portal in a new tab, and a failure closes the tab", async () => {
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/portal")) return { url: "https://billing.example/portal" };
    return proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  await act(async () => { button(container, "Open billing")!.click(); });
  expect(tab.location.href).toBe("https://billing.example/portal");
  expect(container.querySelector('a[href="https://billing.example/portal"]')).toBeNull();
  api.readJson.mockRejectedValueOnce(apiError("Suplex cannot check the subscription", 503, "billing_unavailable"));
  tab = { opener: window, location: { href: "" }, close: vi.fn() };
  vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
  await act(async () => { button(container, "Open billing")!.click(); });
  expect(tab.close).toHaveBeenCalled();
  expect(tab.location.href).toBe("");
});

test("a window focus after checkout refreshes the summary", async () => {
  let summaries = 0;
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/checkout")) return { status: "redirect", url: "https://checkout.example/session_3" };
    summaries += 1;
    return summaries === 1 ? freeSummary : proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  await act(async () => { button(container, "Select Pro")!.click(); });
  await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="Seats"]')!.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  const before = billingGets();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(billingGets()).toBeGreaterThan(before);
  expect(container.textContent).toContain("3 purchased, 2 active");
});

test("members see the summary without billing actions", async () => {
  api.readJson.mockResolvedValue({ ...proSummary, canManageBilling: false });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  expect(container.textContent).toContain("Pro");
  expect(button(container, "Open billing")).toBeUndefined();
  expect(button(container, "Save seats")).toBeUndefined();
});

test("a member on the free plan sees no purchase or check actions", async () => {
  api.readJson.mockResolvedValue({ ...freeSummary, canManageBilling: false });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  expect(container.textContent).toContain("Free");
  expect(button(container, "Select Pro")).toBeUndefined();
  expect(button(container, "Open billing")).toBeUndefined();
});

test("canceling a confirmation and previewing the same quantity again uses a new idempotency key", async () => {
  const previewOne = { previewId: "pv_1", expiresAt: "2026-09-14T01:00:00.000Z", currentQuantity: 3, requestedQuantity: 5, amountDueNow: 2500, nextSubtotal: 10000, currency: "usd", prorationTimestamp: 1758000000 };
  const previewTwo = { ...previewOne, previewId: "pv_2" };
  let previews = 0;
  let failures = 1;
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/seats/preview")) { previews += 1; return previews === 1 ? previewOne : previewTwo; }
    if (init?.method === "POST" && String(url).endsWith("/billing/seats")) {
      if (failures > 0) { failures -= 1; throw apiError("Network failed", 0); }
      return { status: "applied", summary: { ...proSummary, purchasedSeats: 5, monthlySubtotal: 10000 } };
    }
    return proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]')!;
  await act(async () => { setInput(input, "5"); });
  await act(async () => { input.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await act(async () => { button(container, "Save seats")!.click(); });
  expect(container.textContent).toContain("Network failed");
  // Canceling clears the unsent command intent.
  await act(async () => { button(container, "Cancel")!.click(); });
  expect(container.textContent).not.toContain("Due now");
  await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]')!.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  expect(postsTo("/billing/seats/preview")).toHaveLength(2);
  await act(async () => { button(container, "Save seats")!.click(); });
  const seatCalls = postsTo("/billing/seats");
  expect(seatCalls).toHaveLength(2);
  expect(seatCalls[1]![1]?.body).toBe(JSON.stringify({ quantity: 5, previewId: "pv_2" }));
  // A fresh preview is a fresh command even at the same quantity.
  expect(idempotencyKeyOf(seatCalls[0]!)["Idempotency-Key"]).not.toBe(idempotencyKeyOf(seatCalls[1]!)["Idempotency-Key"]);
  expect(container.textContent).toContain("5 purchased, 2 active");
});

test("billing_operation_not_applied clears the seat command and a new preview gets a new key", async () => {
  const previewOne = { previewId: "pv_1", expiresAt: "2026-09-14T01:00:00.000Z", currentQuantity: 3, requestedQuantity: 5, amountDueNow: 2500, nextSubtotal: 10000, currency: "usd", prorationTimestamp: 1758000000 };
  const previewTwo = { ...previewOne, previewId: "pv_3" };
  let previews = 0;
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/seats/preview")) { previews += 1; return previews === 1 ? previewOne : previewTwo; }
    if (init?.method === "POST" && String(url).endsWith("/billing/seats")) {
      const body = JSON.parse(String(init.body)) as { previewId: string };
      if (body.previewId === "pv_1") throw apiError("The change was not applied", 409, "billing_operation_not_applied");
      return { status: "applied", summary: { ...proSummary, purchasedSeats: 5, monthlySubtotal: 10000 } };
    }
    return proSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]')!;
  await act(async () => { setInput(input, "5"); });
  await act(async () => { input.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await act(async () => { button(container, "Save seats")!.click(); });
  expect(container.textContent).toContain("The change was not applied. Review a new quote and try again.");
  // The terminal command is cleared: the quote form is back for a new preview.
  expect(container.textContent).not.toContain("Due now");
  await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="Purchased seats"]')!.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await act(async () => { button(container, "Save seats")!.click(); });
  const seatCalls = postsTo("/billing/seats");
  expect(seatCalls).toHaveLength(2);
  expect(seatCalls[1]![1]?.body).toBe(JSON.stringify({ quantity: 5, previewId: "pv_3" }));
  expect(idempotencyKeyOf(seatCalls[0]!)["Idempotency-Key"]).not.toBe(idempotencyKeyOf(seatCalls[1]!)["Idempotency-Key"]);
  expect(container.textContent).toContain("5 purchased, 2 active");
});

test("billing_operation_not_applied on checkout keeps the form open and a retry uses a new key", async () => {
  let failures = 1;
  api.readJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).endsWith("/billing/checkout")) {
      if (failures > 0) { failures -= 1; throw apiError("The purchase was not applied", 409, "billing_operation_not_applied"); }
      return { status: "redirect", url: "https://checkout.example/session_new" };
    }
    return freeSummary;
  });
  const { container, root } = renderSection(); roots.push(root);
  await mount(root);
  await act(async () => { button(container, "Select Pro")!.click(); });
  const submit = () => container.querySelector<HTMLInputElement>('input[aria-label="Seats"]')!.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => { submit().click(); });
  expect(container.textContent).toContain("The purchase was not applied. Review the seat count and try again.");
  await act(async () => { submit().click(); });
  const checkoutCalls = postsTo("/billing/checkout");
  expect(checkoutCalls).toHaveLength(2);
  expect(idempotencyKeyOf(checkoutCalls[0]!)["Idempotency-Key"]).not.toBe(idempotencyKeyOf(checkoutCalls[1]!)["Idempotency-Key"]);
  expect(tab.location.href).toBe("https://checkout.example/session_new");
});

test("a live summary updates the switcher plan label, and an unknown plan keeps the last one", async () => {
  company.setCompanyPlan.mockClear();
  api.readJson.mockResolvedValue(proSummary);
  const pro = renderSection(); roots.push(pro.root);
  await mount(pro.root);
  expect(company.setCompanyPlan).toHaveBeenCalledWith("c1", "pro");
  company.setCompanyPlan.mockClear();
  api.readJson.mockResolvedValue(unknownSummary);
  const unknown = renderSection(); roots.push(unknown.root);
  await mount(unknown.root, "c2");
  expect(company.setCompanyPlan).not.toHaveBeenCalled();
});
