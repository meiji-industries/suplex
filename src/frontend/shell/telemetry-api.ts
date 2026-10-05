import type { TelemetryResponse } from "../contracts/generated/TelemetryResponse.js";
import { readJsonUnchecked } from "../lib/api.js";

export function getTelemetry(): Promise<TelemetryResponse> {
  return readJsonUnchecked<TelemetryResponse>("/api/telemetry");
}

const telemetryRefreshKey = "suplex.telemetry.refresh";

/** Records that an administrator saw the notice. */
export async function acknowledgeTelemetry(): Promise<void> {
  await readJsonUnchecked<unknown>("/api/admin/telemetry/notice", { method: "POST" });
  notifyTelemetryChanged();
}

export function notifyTelemetryChanged(): void {
  window.dispatchEvent(new Event("suplex:telemetry-change"));
  try { window.localStorage.setItem(telemetryRefreshKey, String(Date.now())); } catch { /* The same-tab event still refreshes telemetry. */ }
}

export { telemetryRefreshKey };
