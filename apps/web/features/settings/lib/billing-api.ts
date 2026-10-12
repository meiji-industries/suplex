import { readJsonUnchecked } from "../../../lib/api.js";
import type { BillingCheckoutResponse, BillingInterval, BillingPortalResponse, BillingSummary, PaidPlan, Plan } from "../../../contracts/billing.js";

export function getBillingSummary(): Promise<BillingSummary> {
  return readJsonUnchecked<BillingSummary>("/api/billing");
}

export function startTrial(): Promise<BillingSummary> {
  return readJsonUnchecked<BillingSummary>("/api/billing/trial", { method: "POST" });
}

/** Pro is one seat. Team buys `quantity` seats, at least its included seats. */
export function startCheckout(idempotencyKey: string, interval: BillingInterval = "month", plan: PaidPlan = "pro", quantity?: number): Promise<BillingCheckoutResponse> {
  const body = plan === "team" ? { plan, interval, quantity } : { interval };
  return readJsonUnchecked<BillingCheckoutResponse>("/api/billing/checkout", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(body) });
}

/** The Stripe page that confirms changing the live subscription to `plan`; Free cancels it. */
export function changePlan(plan: Plan, interval: BillingInterval, quantity: number): Promise<BillingPortalResponse> {
  const body = plan === "team" ? { plan, interval, quantity } : plan === "pro" ? { plan, interval } : { plan };
  return readJsonUnchecked<BillingPortalResponse>("/api/billing/change", { method: "POST", body: JSON.stringify(body) });
}

export function openBillingPortal(): Promise<BillingPortalResponse> {
  return readJsonUnchecked<BillingPortalResponse>("/api/billing/portal", { method: "POST" });
}
