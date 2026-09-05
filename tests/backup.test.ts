import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { BACKUP_HEALTH_MAX_AGE_MS, BackupService, checkBackupHealth } from "../src/backup.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

test("backup snapshots exclude provider API keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-provider-backup-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts") });
  await mkdir(config.artifactRoot, { recursive: true });
  const database = new ForgeDatabase(config.databasePath);
  try {
    expect(database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE name = 'forge_provider_credentials'").all())).toEqual([]);
    const archive = join(root, "backup.tar.gz");
    await new BackupService(config).create({ destination: archive });
    const restored = join(root, "restored");
    await new BackupService(config).restore(archive, restored);
    const snapshot = new ForgeDatabase(join(restored, "forge-backup", "app", "forge.sqlite"));
    try { expect(snapshot.authQuery((db) => db.prepare("SELECT name FROM sqlite_master WHERE name = 'forge_provider_credentials'").all().length)).toBe(0); } finally { snapshot.close(); }
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

const fixedNow = Date.parse("2026-08-29T12:00:00.000Z");

async function backupHealth(value?: object) {
  const root = await mkdtemp(join(tmpdir(), "forge-backup-health-"));
  try {
    if (value) await writeFile(join(root, "backup-status.json"), JSON.stringify(value));
    return await checkBackupHealth(createTestConfig(root), () => fixedNow);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("backup health remains healthy at the exact maximum-age boundary", async () => {
  const verifiedAt = new Date(fixedNow - BACKUP_HEALTH_MAX_AGE_MS).toISOString();
  expect(await backupHealth({ valid: true, verifiedAt })).toMatchObject({
    status: "healthy",
    details: { verifiedAt, ageMs: BACKUP_HEALTH_MAX_AGE_MS },
  });
});

test("backup health warns for an optional backup one millisecond past the maximum age", async () => {
  const verifiedAt = new Date(fixedNow - BACKUP_HEALTH_MAX_AGE_MS - 1).toISOString();
  expect(await backupHealth({ valid: true, verifiedAt })).toMatchObject({
    status: "warning",
    details: { verifiedAt, ageMs: BACKUP_HEALTH_MAX_AGE_MS + 1 },
  });
});

test("backup health is unhealthy when no verification is recorded", async () => {
  expect(await backupHealth()).toMatchObject({
    status: "unhealthy",
    details: { verifiedAt: "never", ageMs: -1, errors: "missing-status" },
  });
});

test.each([
  ["failed verification", { valid: false, verifiedAt: new Date(fixedNow).toISOString(), errors: ["hash mismatch"] }],
  ["invalid verification timestamp", { valid: true, verifiedAt: "not-a-date" }],
])("backup health is unhealthy for %s", async (_label, value) => {
  expect(await backupHealth(value)).toMatchObject({ status: "unhealthy", details: { ageMs: -1 } });
});
