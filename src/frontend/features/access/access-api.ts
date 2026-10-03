import type { AccessResponse } from "../../contracts/generated/AccessResponse.js";
import type { AccessSettings } from "../../contracts/generated/AccessSettings.js";
import { readJsonUnchecked } from "../../lib/api.js";

export function readAccess(signal?: AbortSignal): Promise<AccessResponse> {
  return readJsonUnchecked<AccessResponse>("/api/admin/access", signal ? { signal } : undefined);
}

export function saveAccess(settings: AccessSettings): Promise<AccessResponse> {
  return readJsonUnchecked<AccessResponse>("/api/admin/access", { method: "PUT", body: JSON.stringify(settings) });
}
