export type { BillingCheckoutResponse } from "./generated/BillingCheckoutResponse.js";
export type { BillingPortalResponse } from "./generated/BillingPortalResponse.js";
export type { BillingSummary } from "./generated/BillingSummary.js";
export type { Plan } from "./generated/Plan.js";

// Pro for the Suplex account, before tax: USD 20 each month or USD 192 each year.
export const PRO_MONTHLY_AMOUNT = 2000;
export const PRO_ANNUAL_AMOUNT = 19200;
export type { BillingInterval } from "./generated/BillingInterval.js";
// Team, before tax: USD 75 each month for 3 seats, then USD 15 for each seat; USD 720 and USD 144 each year.
export const TEAM_INCLUDED_SEATS = 3;
export const TEAM_MONTHLY_AMOUNT = 7500;
export const TEAM_MONTHLY_SEAT_AMOUNT = 1500;
export const TEAM_ANNUAL_AMOUNT = 72000;
export const TEAM_ANNUAL_SEAT_AMOUNT = 14400;
export type PaidPlan = "pro" | "team";
