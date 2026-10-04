import { readJsonUnchecked } from "../../../lib/api.js";
import type { BillingCheckoutResponse, BillingPortalResponse, BillingSummary } from "../../../contracts/billing.js";

export function getBillingSummary(): Promise<BillingSummary> {
  return readJsonUnchecked<BillingSummary>("/api/billing");
}

export function startTrial(): Promise<BillingSummary> {
  return readJsonUnchecked<BillingSummary>("/api/billing/trial", { method: "POST" });
}

export function startCheckout(idempotencyKey: string): Promise<BillingCheckoutResponse> {
  return readJsonUnchecked<BillingCheckoutResponse>("/api/billing/checkout", { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
}

export function openBillingPortal(): Promise<BillingPortalResponse> {
  return readJsonUnchecked<BillingPortalResponse>("/api/billing/portal", { method: "POST" });
}
