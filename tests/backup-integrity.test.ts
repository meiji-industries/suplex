import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BackupService, checkBackupHealth } from "../src/platform/backup.js";
import { createTestConfig } from "../src/platform/config.js";
import { SuplexDatabase } from "../src/platform/database.js";
import { runCommand } from "../src/platform/command-runner.js";
import { z } from "zod";

async function exec(command: string, args: string[], options?: { cwd?: string }) {
  const result = await runCommand({
    taskId: null,
    stepId: null,
    command,
    args,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
  });
  if (result.exitCode !== 0) throw Object.assign(new Error(`Command failed: ${result.command}`), result);
  return result;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "suplex-backup-integrity-"));
  const config = createTestConfig(root, { artifactRoot: join(root, "artifacts"), dataRoot: join(root, "data") });
  await mkdir(config.artifactRoot, { recursive: true });
  const database = new SuplexDatabase(config.databasePath);
  const now = new Date().toISOString();
  database.authTransaction(db => {
    db.prepare("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', ?)").run(now);
    db.prepare("INSERT INTO suplex_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-a', 'company-a', 'task-brief', 'brief.md', 'text/plain', 4, ?, 'company-a/brief-a', ?)").run("d".repeat(64), now);
  });
  return { root, config, database };
}

async function rewriteArchive(source: string, destination: string, mutate: (root: string) => Promise<void>): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "suplex-backup-mutate-"));
  try {
    await exec("tar", ["-xzf", source, "-C", staging]);
    await mutate(join(staging, "suplex-backup"));
    await exec("tar", ["-czf", destination, "-C", staging, "suplex-backup"]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

test("backup archive verifies hashes and restores only into a separate clean location", async () => {
  const value = await fixture();
  const restored = join(value.root, "restored");
  const archive = join(value.root, "backup.tar.gz");
  try {
    await mkdir(join(value.config.artifactRoot, "company-a"), { recursive: true });
    await writeFile(join(value.config.artifactRoot, "company-a", "brief-a"), "body");
    value.database.authQuery((db) => db.prepare("UPDATE suplex_artifacts SET byte_size = 4, sha256 = ? WHERE id = 'brief-a'").run(createHash("sha256").update("body").digest("hex")));
    const service = new BackupService(value.config);
    const created = await service.create({ destination: archive });
    expect(created.manifest.secretsExcluded).toContain("provider tokens");
    expect(created.archiveBytes).toBeGreaterThan(0);
    const verification = await service.verify(archive);
    expect(verification).toMatchObject({ valid: true, errors: [] });
    expect((await checkBackupHealth(value.config)).status).toBe("healthy");
    const restoredResult = await service.restore(archive, restored);
    expect(restoredResult.restoreDurationMs).toBeGreaterThanOrEqual(0);
    expect(await readFile(join(restored, "suplex-backup", "config", "config.json"), "utf8")).toContain("requiresReauthentication");
    await expect(service.restore(archive, restored)).rejects.toMatchObject({ code: "exists" });
    await writeFile(join(value.root, "truncated.tar.gz"), "not-an-archive");
    expect((await service.verify(join(value.root, "truncated.tar.gz"))).valid).toBe(false);

    const tampered = join(value.root, "tampered.tar.gz");
    await rewriteArchive(archive, tampered, async (root) => writeFile(join(root, "app", "artifacts", "company-a", "brief-a"), "changed"));
    expect((await service.verify(tampered)).errors).toContain("hash mismatch: app/artifacts/company-a/brief-a");

    const missingComponent = join(value.root, "missing-component.tar.gz");
    await rewriteArchive(archive, missingComponent, async (root) => rm(join(root, "app", "artifacts", "company-a", "brief-a")));
    expect((await service.verify(missingComponent)).errors).toContain("missing entry: app/artifacts/company-a/brief-a");

    const wrongVersion = join(value.root, "wrong-version.tar.gz");
    await rewriteArchive(archive, wrongVersion, async (root) => {
      const manifestPath = join(root, "manifest.json");
      const manifest = z.object({ version: z.number() }).passthrough().parse(JSON.parse(await readFile(manifestPath, "utf8")));
      manifest.version = 999;
      await writeFile(manifestPath, JSON.stringify(manifest));
    });
    expect((await service.verify(wrongVersion)).errors).toContain("unsupported backup version");

    expect((await service.verify(archive)).valid).toBe(true);
    expect((await checkBackupHealth(value.config)).status).toBe("healthy");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
