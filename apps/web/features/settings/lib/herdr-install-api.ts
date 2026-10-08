import type { HerdrInstallResponse } from "../../../contracts/generated/HerdrInstallResponse.js";
import { readJsonUnchecked } from "../../../lib/api.js";

/** Installs Herdr on the host when it is absent, then starts its server. */
export function installHerdr(): Promise<HerdrInstallResponse> {
  return readJsonUnchecked<HerdrInstallResponse>("/api/health/herdr/install", { method: "POST" });
}
