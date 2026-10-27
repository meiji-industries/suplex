import type { AccountLoginResponse } from "../../../contracts/generated/AccountLoginResponse.js";
import type { AccountLoginStatusResponse } from "../../../contracts/generated/AccountLoginStatusResponse.js";
import type { AccountEmailUpdatesResponse } from "../../../contracts/generated/AccountEmailUpdatesResponse.js";
import type { AccountResponse } from "../../../contracts/generated/AccountResponse.js";
import { readJsonUnchecked } from "../../../lib/api.js";

export type AccountProvider = "google" | "github" | "email";

export function getAccount(): Promise<AccountResponse> {
  return readJsonUnchecked<AccountResponse>("/api/account");
}

/** `recovery` is a `suplex recover` token: a remote login with it links the account as this host's owner. A login outside the desktop app sends the `web` client, so the hosted page does not open the app. */
export function startAccountLogin(provider: AccountProvider, email?: string, recovery?: string): Promise<AccountLoginResponse> {
  return readJsonUnchecked<AccountLoginResponse>("/api/account/login", { method: "POST", body: JSON.stringify({ provider, ...(email ? { email } : {}), ...(recovery ? { recovery } : {}), ...(window.suplexApp ? {} : { client: "web" }) }) });
}

export function pollAccountLogin(attemptId: string): Promise<AccountLoginStatusResponse> {
  return readJsonUnchecked<AccountLoginStatusResponse>(`/api/account/login/${encodeURIComponent(attemptId)}`);
}

export async function logoutAccount(): Promise<void> {
  await readJsonUnchecked<unknown>("/api/account/logout", { method: "POST", body: "{}" });
}

/** The exact text of each email updates choice. Suplex stores the text of the control the person used with each choice as proof of consent. */
export const EMAIL_UPDATES_LABEL = "Send me Suplex product updates and tips by email.";
export const EMAIL_UPDATES_NOTE = "You can unsubscribe at any time.";
export const EMAIL_UPDATES_SETTING_LABEL = "Product update emails";
export const EMAIL_UPDATES_SETTING_DESCRIPTION = `Suplex sends product updates and tips to your account email. ${EMAIL_UPDATES_NOTE}`;
export const EMAIL_UPDATES_WORDING = {
  onboarding: `${EMAIL_UPDATES_LABEL} ${EMAIL_UPDATES_NOTE}`,
  settings: `${EMAIL_UPDATES_SETTING_LABEL}. ${EMAIL_UPDATES_SETTING_DESCRIPTION}`,
} as const;

export function getEmailUpdates(): Promise<AccountEmailUpdatesResponse> {
  return readJsonUnchecked<AccountEmailUpdatesResponse>("/api/account/email-updates");
}

export function setEmailUpdates(subscribed: boolean, source: keyof typeof EMAIL_UPDATES_WORDING): Promise<AccountEmailUpdatesResponse> {
  return readJsonUnchecked<AccountEmailUpdatesResponse>("/api/account/email-updates", { method: "PUT", body: JSON.stringify({ subscribed, source, wording: EMAIL_UPDATES_WORDING[source] }) });
}
