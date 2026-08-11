import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import type { ForgeConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const backupVersion = 1;
const backupRoot = "forge-backup";

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

export interface BackupCreateInput {
  destination: string;
  temporalPersistencePath: string;
}

export class BackupFailure extends Error {
  constructor(readonly code: "exists" | "invalid" | "unsafe" | "missing-temporal" | "verification") {
    super(`Forge backup ${code}`);
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
  return (path === backupRoot || path.startsWith(`${backupRoot}/`)) && !path.split("/").includes("..") && !path.startsWith("/");
}

function configuration(config: ForgeConfig): Record<string, string | number | boolean> {
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
    temporalAddress: config.temporalAddress,
    temporalNamespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    deliveryRepairCycleLimit: config.deliveryRepairCycleLimit,
    externalTurnCapacity: config.externalTurnCapacity,
    installationId: config.installationId,
  };
}

async function recordVerification(config: ForgeConfig, verification: BackupVerification): Promise<void> {
  await mkdir(config.dataRoot, { recursive: true });
  await writeFile(join(config.dataRoot, "backup-status.json"), JSON.stringify({ verifiedAt: verification.verifiedAt, valid: verification.valid, archivePath: verification.archivePath, errors: verification.errors }, null, 2), { mode: 0o600 });
}

export class BackupService {
  constructor(private readonly config: ForgeConfig) {}

  async create(input: BackupCreateInput): Promise<{ archivePath: string; manifest: BackupManifest; durationMs: number }> {
    const started = Date.now();
    const destination = resolve(input.destination);
    if (await exists(destination)) throw new BackupFailure("exists");
    if (!input.temporalPersistencePath.trim() || !(await exists(input.temporalPersistencePath))) throw new BackupFailure("missing-temporal");
    if (!(await exists(this.config.databasePath)) || !(await exists(this.config.artifactRoot))) throw new BackupFailure("invalid");
    await mkdir(dirname(destination), { recursive: true });

    const staging = await mkdtemp(join(tmpdir(), "forge-backup-create-"));
    const root = join(staging, backupRoot);
    try {
      await mkdir(join(root, "app"), { recursive: true });
      await mkdir(join(root, "config"), { recursive: true });
      await mkdir(join(root, "temporal"), { recursive: true });
      const snapshotPath = join(root, "app", "forge.sqlite");
      const database = new Database(this.config.databasePath, { readonly: true });
      try { await database.backup(snapshotPath); } finally { database.close(); }
      await cp(this.config.artifactRoot, join(root, "app", "artifacts"), { recursive: true, force: false });
      const temporalStats = await stat(input.temporalPersistencePath);
      if (temporalStats.isDirectory()) await cp(input.temporalPersistencePath, join(root, "temporal", "persistence"), { recursive: true, force: false });
      else await cp(input.temporalPersistencePath, join(root, "temporal", "persistence"), { force: false });
      await writeFile(join(root, "config", "config.json"), JSON.stringify({ version: backupVersion, config: configuration(this.config), requiresReauthentication: true }, null, 2), { mode: 0o600 });

      const entries = await filesUnder(root);
      const manifest: BackupManifest = {
        version: backupVersion,
        createdAt: new Date().toISOString(),
        components: {
          application: component(entries, "app/"),
          artifacts: component(entries, "app/artifacts/"),
          temporal: component(entries, "temporal/"),
          configuration: component(entries, "config/"),
        },
        entries,
        database: { path: "app/forge.sqlite", integrity: "ok" },
        secretsExcluded: ["credentials", "passkeys", "sessions", "cookies", "private keys", "tokens", "generated environment files"],
        requiredConfiguration: ["accessMode", "reachableAddress", "databasePath", "artifactRoot", "temporalAddress", "temporalNamespace", "taskQueue", "installationId"],
      };
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await execFileAsync("tar", ["-czf", destination, "-C", staging, backupRoot], { timeout: 60_000, maxBuffer: 64 * 1024 });
      return { archivePath: destination, manifest, durationMs: Date.now() - started };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async verify(archivePath: string): Promise<BackupVerification> {
    const started = Date.now();
    const archive = resolve(archivePath);
    const errors: string[] = [];
    let manifest: BackupManifest | undefined;
    const staging = await mkdtemp(join(tmpdir(), "forge-backup-verify-"));
    try {
      if (!(await exists(archive))) throw new BackupFailure("invalid");
      const listing = (await execFileAsync("tar", ["-tzf", archive], { timeout: 30_000, maxBuffer: 512 * 1024 })).stdout.split(/\r?\n/).filter(Boolean);
      if (listing.some((name) => !safeArchiveName(name.replace(/\/$/, "")))) errors.push("archive contains an unsafe path");
      await execFileAsync("tar", ["-xzf", archive, "-C", staging, "--no-same-owner"], { timeout: 60_000, maxBuffer: 64 * 1024 });
      const root = join(staging, backupRoot);
      manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as BackupManifest;
      if (manifest.version !== backupVersion) errors.push("unsupported backup version");
      for (const entry of manifest.entries ?? []) {
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
      const databasePath = join(root, manifest.database?.path ?? "app/forge.sqlite");
      const database = new Database(databasePath, { readonly: true });
      try {
        const integrity = database.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") errors.push("database integrity check failed");
        const artifacts = database.prepare("SELECT storage_path FROM forge_artifacts").all() as Array<{ storage_path: string }>;
        for (const artifact of artifacts) if (!(await exists(join(root, "app", "artifacts", artifact.storage_path)))) errors.push(`missing artifact: ${artifact.storage_path}`);
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

  async restore(archivePath: string, destination: string): Promise<BackupVerification> {
    const target = resolve(destination);
    if (await exists(target) && !(await emptyDirectory(target))) throw new BackupFailure("exists");
    const verification = await this.verify(archivePath);
    if (!verification.valid) throw new BackupFailure("verification");
    await mkdir(target, { recursive: true });
    await execFileAsync("tar", ["-xzf", resolve(archivePath), "-C", target, "--no-same-owner"], { timeout: 60_000, maxBuffer: 64 * 1024 });
    return verification;
  }
}

function component(entries: BackupManifestEntry[], prefix: string): { path: string; count: number; bytes: number } {
  const selected = entries.filter((entry) => entry.path.startsWith(prefix));
  return { path: prefix.replace(/\/$/, ""), count: selected.length, bytes: selected.reduce((total, entry) => total + entry.bytes, 0) };
}

export async function checkBackupHealth(config: ForgeConfig): Promise<import("./health.js").HealthCheck> {
  try {
    const value = JSON.parse(await readFile(join(config.dataRoot, "backup-status.json"), "utf8")) as { valid?: boolean; verifiedAt?: string; errors?: string[] };
    const verifiedAt = typeof value.verifiedAt === "string" ? value.verifiedAt : "";
    const valid = value.valid === true && Boolean(verifiedAt) && !Number.isNaN(Date.parse(verifiedAt));
    return { id: "backup", label: "Backup verification", status: valid ? "healthy" : "unhealthy", summary: valid ? "The latest recorded backup verification passed" : "No verified backup is recorded", details: { verifiedAt: verifiedAt || "never", ageMs: valid ? Math.max(0, Date.now() - Date.parse(verifiedAt)) : -1, errors: value.errors?.join(", ") ?? "" } };
  } catch {
    return { id: "backup", label: "Backup verification", status: "unhealthy", summary: "No verified backup is recorded", details: { verifiedAt: "never", ageMs: -1, errors: "missing-status" } };
  }
}
