import type { AccountLoginResponse } from "../../../contracts/generated/AccountLoginResponse.js";
import type { AccountLoginStatusResponse } from "../../../contracts/generated/AccountLoginStatusResponse.js";
import type { AccountResponse } from "../../../contracts/generated/AccountResponse.js";
import { readJsonUnchecked } from "../../../lib/api.js";

export type AccountProvider = "google" | "github" | "email";

export function getAccount(): Promise<AccountResponse> {
  return readJsonUnchecked<AccountResponse>("/api/account");
}

export function startAccountLogin(provider: AccountProvider, email?: string): Promise<AccountLoginResponse> {
  return readJsonUnchecked<AccountLoginResponse>("/api/account/login", { method: "POST", body: JSON.stringify(email ? { provider, email } : { provider }) });
}

export function pollAccountLogin(attemptId: string): Promise<AccountLoginStatusResponse> {
  return readJsonUnchecked<AccountLoginStatusResponse>(`/api/account/login/${encodeURIComponent(attemptId)}`);
}

export async function logoutAccount(): Promise<void> {
  await readJsonUnchecked<unknown>("/api/account/logout", { method: "POST", body: "{}" });
}
