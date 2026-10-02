import type { HostedSeatPreview } from "./generated/HostedSeatPreview.js";

export type { BillingCheckoutResponse } from "./generated/BillingCheckoutResponse.js";
export type { BillingPortalResponse } from "./generated/BillingPortalResponse.js";
export type { BillingSeatChangeResponse } from "./generated/BillingSeatChangeResponse.js";
export type { BillingSummary } from "./generated/BillingSummary.js";
export type { HostedSeatPreview };

export const BILLING_SEAT_UNIT_AMOUNT = 2000;

// An increase is bound to its quote. A decrease confirms that Suplex does not refund the paid period.
export type BillingSeatChangeBody =
  | { quantity: number; previewId: string }
  | { quantity: number; confirmNoRefund: true };
