import type { AccountLoginResponse } from "../../../contracts/generated/AccountLoginResponse.js";
import type { AccountLoginStatusResponse } from "../../../contracts/generated/AccountLoginStatusResponse.js";
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
