import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { BackupService } from "../src/backup.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProviderCredentialStore } from "../src/provider-credentials.js";

test("backup snapshots exclude provider API keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-provider-backup-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  await mkdir(config.artifactRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  try {
    new ProviderCredentialStore(database).set("openrouter", "sk-openrouter-backup-secret");
    const archive = join(root, "backup.tar.gz");
    await new BackupService(config).create({ destination: archive });
    const restored = join(root, "restored");
    await new BackupService(config).restore(archive, restored);
    const snapshot = new ForgeDatabase(join(restored, "forge-backup", "app", "forge.sqlite"));
    try { expect(snapshot.authQuery((db) => (db.prepare("SELECT count(*) AS count FROM forge_provider_credentials").get() as { count: number }).count)).toBe(0); } finally { snapshot.close(); }
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
