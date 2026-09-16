import type { AuthService } from "../identity/auth.js";
import type { ForgeConfig } from "./config.js";

/** Dev auto-login and local mode both sign in the Operator on loopback; give that user a first company so every view has one to load. */
export async function seedDevelopmentData(auth: AuthService, config: ForgeConfig): Promise<void> {
  if (!config.developmentAutoLogin && config.accessMode !== "local") return;
  const user = auth.ensureDevelopmentUser();
  if (auth.listVisibleCompanies(user.id).length === 0) auth.createCompany(user.id, config.developmentAutoLogin ? "Development" : "Forge");
}
