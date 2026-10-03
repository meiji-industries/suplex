import type { TelemetryResponse } from "../contracts/generated/TelemetryResponse.js";
import { readJsonUnchecked } from "../lib/api.js";

export function getTelemetry(): Promise<TelemetryResponse> {
  return readJsonUnchecked<TelemetryResponse>("/api/telemetry");
}

const telemetryRefreshKey = "suplex.telemetry.refresh";

/** Records that an administrator saw the notice. `null` keeps the host anonymous. */
export async function acknowledgeTelemetry(email: string | null, sessionReplayEnabled: boolean): Promise<void> {
  await readJsonUnchecked<unknown>("/api/admin/telemetry/notice", { method: "POST", body: JSON.stringify({ email, sessionReplayEnabled }) });
  notifyTelemetryChanged();
}

export async function updateTelemetryReplay(enabled: boolean): Promise<void> {
  await readJsonUnchecked<unknown>("/api/admin/telemetry/replay", { method: "POST", body: JSON.stringify({ enabled }) });
  notifyTelemetryChanged();
}

export function notifyTelemetryChanged(): void {
  window.dispatchEvent(new Event("suplex:telemetry-change"));
  try { window.localStorage.setItem(telemetryRefreshKey, String(Date.now())); } catch { /* The same-tab event still refreshes telemetry. */ }
}

export { telemetryRefreshKey };
