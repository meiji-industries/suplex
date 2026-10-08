export type { BillingCheckoutResponse } from "./generated/BillingCheckoutResponse.js";
export type { BillingPortalResponse } from "./generated/BillingPortalResponse.js";
export type { BillingSummary } from "./generated/BillingSummary.js";
export type { Plan } from "./generated/Plan.js";

// Pro for the Suplex account, before tax: USD 20 each month or USD 192 each year.
export const PRO_MONTHLY_AMOUNT = 2000;
export const PRO_ANNUAL_AMOUNT = 19200;
export type BillingInterval = "month" | "year";
