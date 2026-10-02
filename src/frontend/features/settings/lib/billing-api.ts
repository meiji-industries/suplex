import { readJsonUnchecked } from "../../../lib/api.js";
import type { BillingCheckoutResponse, BillingPortalResponse, BillingSeatChangeBody, BillingSeatChangeResponse, BillingSummary, HostedSeatPreview } from "../../../contracts/billing.js";

function billingPath(companyId: string): string {
  return `/api/companies/${encodeURIComponent(companyId)}/billing`;
}

export function getBillingSummary(companyId: string): Promise<BillingSummary> {
  return readJsonUnchecked<BillingSummary>(billingPath(companyId));
}

export function startCheckout(companyId: string, quantity: number, idempotencyKey: string): Promise<BillingCheckoutResponse> {
  return readJsonUnchecked<BillingCheckoutResponse>(`${billingPath(companyId)}/checkout`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ quantity }) });
}

export function previewSeats(companyId: string, quantity: number): Promise<HostedSeatPreview> {
  return readJsonUnchecked<HostedSeatPreview>(`${billingPath(companyId)}/seats/preview`, { method: "POST", body: JSON.stringify({ quantity }) });
}

export function changeSeats(companyId: string, body: BillingSeatChangeBody, idempotencyKey: string): Promise<BillingSeatChangeResponse> {
  return readJsonUnchecked<BillingSeatChangeResponse>(`${billingPath(companyId)}/seats`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(body) });
}

export function openBillingPortal(companyId: string): Promise<BillingPortalResponse> {
  return readJsonUnchecked<BillingPortalResponse>(`${billingPath(companyId)}/portal`, { method: "POST" });
}
