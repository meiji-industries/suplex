import type { AuthService } from "./auth.js";
import type { ForgeConfig } from "./config.js";

export async function seedDevelopmentData(auth: AuthService, config: ForgeConfig): Promise<void> {
  if (!config.developmentAutoLogin) return;
  const user = auth.ensureDevelopmentUser();
  if (auth.listVisibleCompanies(user.id).length === 0) auth.createCompany(user.id, "Development");
}
