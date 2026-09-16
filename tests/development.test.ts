import { expect, test } from "vitest";

import { AuthService } from "../src/identity/auth.js";
import { createTestConfig } from "../src/platform/config.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { seedDevelopmentData } from "../src/platform/development.js";

test("local setup creates My Company once", async () => {
  const database = new ForgeDatabase(":memory:");
  try {
    const config = { ...createTestConfig("/tmp/forge-development-test"), accessMode: "local" as const };
    const auth = new AuthService(database, config);
    await seedDevelopmentData(auth, config);
    await seedDevelopmentData(auth, config);
    expect(auth.listVisibleCompanies("user_development").map(company => company.name)).toEqual(["My Company"]);
  } finally {
    database.close();
  }
});
