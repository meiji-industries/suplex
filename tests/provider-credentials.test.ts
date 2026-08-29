import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { ProviderCredentialStore } from "../src/provider-credentials.js";

test("stores credentials privately and exposes only a masked key", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-provider-credentials-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    const credentials = new ProviderCredentialStore(database);
    credentials.set("openrouter", "sk-openrouter-secret");
    expect(credentials.get("openrouter")?.secret).toBe("sk-openrouter-secret");
    const description = credentials.describe("openrouter");
    expect(description).toMatchObject({ configured: true, maskedKey: "…cret" });
    expect(JSON.stringify(description)).not.toContain("sk-openrouter-secret");
    credentials.clear("openrouter");
    expect(credentials.describe("openrouter")).toMatchObject({ configured: false, maskedKey: null });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
