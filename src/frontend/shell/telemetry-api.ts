import type { TelemetryResponse } from "../contracts/generated/TelemetryResponse.js";
import { readJsonUnchecked } from "../lib/api.js";

export function getTelemetry(): Promise<TelemetryResponse> {
  return readJsonUnchecked<TelemetryResponse>("/api/telemetry");
}

/** Records that an administrator saw the notice. `null` keeps the host anonymous. */
export async function acknowledgeTelemetry(email: string | null): Promise<void> {
  await readJsonUnchecked<unknown>("/api/admin/telemetry/notice", { method: "POST", body: JSON.stringify({ email }) });
}
