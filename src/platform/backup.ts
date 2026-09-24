import { createHash, randomBytes } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import type { SuplexConfig } from "./config.js";
import { SuplexDatabase } from "./database.js";
import type { HealthCheck } from "./health.js";

const execFileAsync = promisify(execFile);
const backupVersion = 1;
const backupRoot = "suplex-backup";

export const BACKUP_HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const BACKUP_NAME = /^suplex-backup-[0-9TZ-]+\.tar\.gz$/;

export interface BackupEntry {
  name: string;
  bytes: number;
  createdAt: string;
}

export interface BackupManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  components: Record<string, { path: string; count: number; bytes: number }>;
  entries: BackupManifestEntry[];
  database: { path: string; integrity: "ok" };
  secretsExcluded: string[];
  requiredConfiguration: string[];
}

export interface BackupVerification {
  valid: boolean;
  archivePath: string;
  manifest?: BackupManifest;
  errors: string[];
  verifiedAt: string;
  durationMs: number;
}

export interface BackupRestoreResult extends BackupVerification {
  restoreDurationMs: number;
}

export interface BackupCreateInput {
  destination: string;
}

export class BackupFailure extends Error {
  constructor(readonly code: "exists" | "invalid" | "unsafe" | "verification") {
    super(`Suplex backup ${code}`);
    this.name = "BackupFailure";
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function filesUnder(root: string, prefix = ""): Promise<BackupManifestEntry[]> {
  const entries: BackupManifestEntry[] = [];
  for (const name of await readdir(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    const relativePath = prefix ? `${prefix}/${name.name}` : name.name;
    if (name.isDirectory()) entries.push(...await filesUnder(path, relativePath));
    else if (name.isFile()) {
      const bytes = await readFile(path);
      entries.push({ path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
    } else {
      throw new BackupFailure("unsafe");
    }
  }
  return entries;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function emptyDirectory(path: string): Promise<boolean> {
  try { return (await readdir(path)).length === 0; } catch { return true; }
}

function safeArchiveName(path: string): boolean {
  return (path === backupRoot || path.startsWith(`${backupRoot}/`))
    && !path.includes("\\")
    && !path.split("/").includes("..")
    && !path.startsWith("/");
}

function safeManifestPath(path: string): boolean {
  return Boolean(path) && safeArchiveName(`${backupRoot}/${path}`);
}

function configuration(config: SuplexConfig): Record<string, string | number | boolean> {
  return {
    accessMode: config.accessMode,
    tailscaleExposure: config.tailscaleExposure,
    bindAddress: config.bindAddress,
    reachableAddress: config.reachableAddress,
    port: config.port,
    dataRoot: config.dataRoot,
    databasePath: config.databasePath,
    artifactRoot: config.artifactRoot,
    runtimeRoot: config.runtimeRoot,
    repositoryRoot: config.repositoryRoot,
    worktreeRoot: config.worktreeRoot,
    installationId: config.installationId,
  };
}

async function recordVerification(config: SuplexConfig, verification: BackupVerification): Promise<void> {
  await mkdir(config.dataRoot, { recursive: true });
  await writeFile(join(config.dataRoot, "backup-status.json"), JSON.stringify({ verifiedAt: verification.verifiedAt, valid: verification.valid, archivePath: verification.archivePath, errors: verification.errors, durationMs: verification.durationMs }, null, 2), { mode: 0o600 });
}

function removeAuthenticationState(snapshotPath: string): void {
  const snapshot = new Database(snapshotPath);
  try {
    snapshot.transaction(() => {
      snapshot.prepare("DELETE FROM suplex_challenges").run();
      snapshot.prepare("DELETE FROM suplex_sessions").run();
      snapshot.prepare("DELETE FROM suplex_credentials").run();
      snapshot.prepare("DELETE FROM suplex_invitations").run();
      snapshot.prepare("DELETE FROM suplex_external_agent_credentials").run();
      snapshot.prepare("DELETE FROM suplex_external_agent_pairing_codes").run();
      snapshot.prepare("DELETE FROM suplex_oauth_access_tokens").run();
      snapshot.prepare("DELETE FROM suplex_oauth_refresh_tokens").run();
      snapshot.prepare("DELETE FROM suplex_oauth_token_families").run();
      snapshot.prepare("DELETE FROM suplex_oauth_authorization_codes").run();
      snapshot.prepare("DELETE FROM suplex_oauth_pending_authorizations").run();
      const cursor = snapshot.prepare("UPDATE suplex_oauth_grants SET cursor_key = ? WHERE id = ?");
      for (const grant of snapshot.prepare("SELECT id FROM suplex_oauth_grants").all() as Array<{ id: string }>) cursor.run(randomBytes(32).toString("base64url"), grant.id);
    })();
  } finally {
    snapshot.close();
  }
}

export class BackupService {
  constructor(private readonly config: SuplexConfig) {}

  get directory(): string {
    return join(this.config.dataRoot, "backups");
  }

  /** The stored archive's path, or undefined when the name is not one this service writes. */
  pathOf(name: string): string | undefined {
    return BACKUP_NAME.test(name) ? join(this.directory, name) : undefined;
  }

  async list(): Promise<BackupEntry[]> {
    const names = await readdir(this.directory).catch(() => []);
    const entries = await Promise.all(names.filter((name) => BACKUP_NAME.test(name)).map(async (name) => {
      const info = await stat(join(this.directory, name));
      return { name, bytes: info.size, createdAt: info.mtime.toISOString() };
    }));
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Creates and verifies a backup in the host's backup directory. */
  async createInLibrary(now = new Date()): Promise<BackupEntry> {
    await mkdir(this.config.artifactRoot, { recursive: true });
    const name = `suplex-backup-${now.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}.tar.gz`;
    const created = await this.create({ destination: join(this.directory, name) });
    const verification = await this.verify(created.archivePath);
    if (!verification.valid) {
      await rm(created.archivePath, { force: true });
      throw new BackupFailure("verification");
    }
    return { name, bytes: created.archiveBytes, createdAt: now.toISOString() };
  }

  async create(input: BackupCreateInput): Promise<{ archivePath: string; manifest: BackupManifest; archiveBytes: number; durationMs: number }> {
    const started = Date.now();
    const destination = resolve(input.destination);
    if (await exists(destination)) throw new BackupFailure("exists");
    if (!(await exists(this.config.databasePath)) || !(await exists(this.config.artifactRoot))) throw new BackupFailure("invalid");
    await mkdir(dirname(destination), { recursive: true });

    const staging = await mkdtemp(join(tmpdir(), "suplex-backup-create-"));
    const root = join(staging, backupRoot);
    try {
      await mkdir(join(root, "app"), { recursive: true });
      await mkdir(join(root, "config"), { recursive: true });
      const snapshotPath = join(root, "app", "suplex.sqlite");
      const database = new Database(this.config.databasePath, { readonly: true });
      try { await database.backup(snapshotPath); } finally { database.close(); }
      removeAuthenticationState(snapshotPath);
      await cp(this.config.artifactRoot, join(root, "app", "artifacts"), { recursive: true, force: false });
      await writeFile(join(root, "config", "config.json"), JSON.stringify({ version: backupVersion, config: configuration(this.config), requiresReauthentication: true }, null, 2), { mode: 0o600 });

      const entries = await filesUnder(root);
      const manifest: BackupManifest = {
        version: backupVersion,
        createdAt: new Date().toISOString(),
        components: {
          application: component(entries, "app/"),
          artifacts: component(entries, "app/artifacts/"),
          configuration: component(entries, "config/"),
        },
        entries,
        database: { path: "app/suplex.sqlite", integrity: "ok" },
        secretsExcluded: ["credential registrations", "passkeys", "sessions", "challenges", "invitation tokens", "external agent credentials", "OAuth tokens and authorization codes", "OAuth pending authorizations", "OAuth cursor keys", "provider API keys", "external agent pairing codes", "cookies", "private keys", "provider tokens", "Engine API keys", "generated environment files"],
        requiredConfiguration: ["accessMode", "reachableAddress", "databasePath", "artifactRoot", "installationId"],
      };
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await execFileAsync("tar", ["-czf", destination, "-C", staging, backupRoot], { timeout: 60_000, maxBuffer: 64 * 1024 });
      return { archivePath: destination, manifest, archiveBytes: (await stat(destination)).size, durationMs: Date.now() - started };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async verify(archivePath: string): Promise<BackupVerification> {
    const started = Date.now();
    const archive = resolve(archivePath);
    const errors: string[] = [];
    let manifest: BackupManifest | undefined;
    const staging = await mkdtemp(join(tmpdir(), "suplex-backup-verify-"));
    try {
      if (!(await exists(archive))) throw new BackupFailure("invalid");
      const listing = (await execFileAsync("tar", ["-tzf", archive], { timeout: 30_000, maxBuffer: 256 * 1024 * 1024 })).stdout.split(/\r?\n/).filter(Boolean);
      if (listing.some((name) => !safeArchiveName(name.replace(/\/$/, "")))) {
        errors.push("archive contains an unsafe path");
        throw new BackupFailure("unsafe");
      }
      await execFileAsync("tar", ["-xzf", archive, "-C", staging, "--no-same-owner"], { timeout: 60_000, maxBuffer: 64 * 1024 });
      const root = join(staging, backupRoot);
      manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as BackupManifest;
      if (manifest.version !== backupVersion) errors.push("unsupported backup version");
      const manifestEntries = Array.isArray(manifest.entries) ? manifest.entries : [];
      const actualEntries = (await filesUnder(root)).filter((entry) => entry.path !== "manifest.json");
      const expectedPaths = new Set<string>();
      for (const entry of manifestEntries) {
        if (!safeManifestPath(entry.path)) {
          errors.push(`unsafe manifest path: ${entry.path}`);
          continue;
        }
        if (expectedPaths.has(entry.path)) errors.push(`duplicate manifest entry: ${entry.path}`);
        expectedPaths.add(entry.path);
      }
      const actualPaths = new Set(actualEntries.map((entry) => entry.path));
      for (const path of expectedPaths) if (!actualPaths.has(path)) errors.push(`missing entry: ${path}`);
      for (const path of actualPaths) if (!expectedPaths.has(path)) errors.push(`unexpected entry: ${path}`);
      for (const entry of manifestEntries) {
        if (!safeManifestPath(entry.path)) continue;
        const path = join(root, entry.path);
        try {
          const bytes = await readFile(path);
          if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) errors.push(`hash mismatch: ${entry.path}`);
        } catch { errors.push(`missing entry: ${entry.path}`); }
      }
      const configPath = join(root, "config", "config.json");
      const configValue = JSON.parse(await readFile(configPath, "utf8")) as { version?: number; config?: Record<string, unknown>; requiresReauthentication?: boolean };
      if (configValue.version !== backupVersion || !configValue.requiresReauthentication) errors.push("required configuration is missing");
      for (const required of manifest.requiredConfiguration ?? []) if (configValue.config?.[required] === undefined) errors.push(`missing configuration: ${required}`);
      const databaseRelativePath = manifest.database?.path ?? "app/suplex.sqlite";
      if (!safeManifestPath(databaseRelativePath)) throw new BackupFailure("unsafe");
      const databasePath = join(root, databaseRelativePath);
      const database = new Database(databasePath, { readonly: true });
      try {
        const integrity = database.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") errors.push("database integrity check failed");
        const artifacts = database.prepare("SELECT storage_path, byte_size, sha256 FROM suplex_artifacts").all() as Array<{ storage_path: string; byte_size: number; sha256: string }>;
        for (const artifact of artifacts) {
          const relativeArtifactPath = `app/artifacts/${artifact.storage_path}`;
          if (!safeManifestPath(relativeArtifactPath)) {
            errors.push(`unsafe artifact path: ${artifact.storage_path}`);
            continue;
          }
          try {
            const bytes = await readFile(join(root, relativeArtifactPath));
            if (bytes.byteLength !== artifact.byte_size || sha256(bytes) !== artifact.sha256) errors.push(`artifact hash mismatch: ${artifact.storage_path}`);
          } catch {
            errors.push(`missing artifact: ${artifact.storage_path}`);
          }
        }
      } finally { database.close(); }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "backup could not be read");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const verification: BackupVerification = { valid: errors.length === 0, archivePath: archive, ...(manifest ? { manifest } : {}), errors, verifiedAt: new Date().toISOString(), durationMs: Date.now() - started };
    await recordVerification(this.config, verification);
    return verification;
  }

  async restore(archivePath: string, destination: string): Promise<BackupRestoreResult> {
    const started = Date.now();
    const target = resolve(destination);
    if (await exists(target) && !(await emptyDirectory(target))) throw new BackupFailure("exists");
    const verification = await this.verify(archivePath);
    if (!verification.valid) throw new BackupFailure("verification");
    await mkdir(target, { recursive: true });
    await execFileAsync("tar", ["-xzf", resolve(archivePath), "-C", target, "--no-same-owner"], { timeout: 60_000, maxBuffer: 64 * 1024 });
    return { ...verification, restoreDurationMs: Date.now() - started };
  }

  /**
   * Replaces the live database and adds the backup's artifacts. Current users,
   * passkeys and sessions are kept, because the backup excludes them and the
   * administrator who restores must stay signed in.
   */
  async restoreInPlace(archivePath: string): Promise<BackupRestoreResult> {
    const staging = await mkdtemp(join(tmpdir(), "suplex-backup-restore-"));
    try {
      const result = await this.restore(archivePath, staging);
      const root = join(staging, backupRoot);
      const stagedPath = join(root, "app", "suplex.sqlite");
      new SuplexDatabase(stagedPath).close(); // migrates the backup to this build's schema
      const staged = new Database(stagedPath);
      try {
        staged.pragma("foreign_keys = ON");
        staged.prepare("ATTACH DATABASE ? AS live").run(this.config.databasePath);
        const columns = (table: string): string[] => (staged.pragma(`table_info('${table}')`) as Array<{ name: string }>).map((column) => `"${column.name}"`);
        staged.transaction(() => {
          staged.prepare(`INSERT OR IGNORE INTO main.suplex_users SELECT ${columns("suplex_users").join(", ")} FROM live.suplex_users`).run();
          // A backup from another host can hold the same username under another id; passkeys follow the username.
          for (const table of ["suplex_credentials", "suplex_sessions"]) {
            const names = columns(table);
            const values = names.map((name) => name === "\"user_id\"" ? "restored.id" : `row.${name}`);
            staged.prepare(`INSERT OR IGNORE INTO main.${table} (${names.join(", ")}) SELECT ${values.join(", ")} FROM live.${table} row JOIN live.suplex_users current ON current.id = row.user_id JOIN main.suplex_users restored ON restored.username = current.username`).run();
          }
        })();
        staged.exec("DETACH DATABASE live");
        await cp(join(root, "app", "artifacts"), this.config.artifactRoot, { recursive: true, force: true });
        // SQLite's backup API swaps the pages under open connections, which see the restored data on their next read.
        await staged.backup(this.config.databasePath);
      } finally { staged.close(); }
      return result;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

function component(entries: BackupManifestEntry[], prefix: string): { path: string; count: number; bytes: number } {
  const selected = entries.filter((entry) => entry.path.startsWith(prefix));
  return { path: prefix.replace(/\/$/, ""), count: selected.length, bytes: selected.reduce((total, entry) => total + entry.bytes, 0) };
}

export async function checkBackupHealth(config: SuplexConfig, now: () => number = Date.now): Promise<HealthCheck> {
  try {
    const value = JSON.parse(await readFile(join(config.dataRoot, "backup-status.json"), "utf8")) as { valid?: boolean; verifiedAt?: string; errors?: string[] };
    const verifiedAt = typeof value.verifiedAt === "string" ? value.verifiedAt : "";
    const verifiedAtMs = Date.parse(verifiedAt);
    const valid = value.valid === true && Boolean(verifiedAt) && !Number.isNaN(verifiedAtMs);
    const ageMs = valid ? Math.max(0, now() - verifiedAtMs) : -1;
    const fresh = valid && ageMs <= BACKUP_HEALTH_MAX_AGE_MS;
    return {
      id: "backup",
      label: "Backup verification",
      status: fresh ? "healthy" : valid ? "warning" : "unhealthy",
      summary: fresh ? "The latest recorded backup verification passed" : valid ? "The latest recorded backup verification is stale" : "No verified backup is recorded",
      details: { verifiedAt: verifiedAt || "never", ageMs, errors: value.errors?.join(", ") ?? "" },
    };
  } catch {
    return { id: "backup", label: "Backup verification", status: "warning", summary: "No backup has been made yet", remedy: "Create a backup in Settings → Backups", details: { verifiedAt: "never", ageMs: -1, errors: "missing-status" } };
  }
}
