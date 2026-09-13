import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AuthFailure, type AuthService } from "../identity/auth.js";
import type { ForgeDatabase } from "../platform/database.js";
import { supportsProviderInstances } from "../runtimes/task-harness.js";
import { ProviderInstanceSchema, type ProviderInstance } from "../http/contracts/providers.js";

const selection = "SELECT id, provider, label, home_directory AS homeDirectory, created_at AS createdAt, updated_at AS updatedAt FROM forge_provider_instances";

export function providerInstancesDirectory(databasePath: string): string { return join(dirname(databasePath), "provider-instances"); }
export async function providerInstanceDirectories(databasePath: string): Promise<string[]> {
  try { return (await readdir(providerInstancesDirectory(databasePath), { withFileTypes: true })).flatMap(entry => entry.isDirectory() ? [join(providerInstancesDirectory(databasePath), entry.name)] : []); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
}

export class ProviderInstanceService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService) {}
  list(userId: string): ProviderInstance[] {
    this.requireAdmin(userId);
    return this.database.authQuery(db => z.array(ProviderInstanceSchema).parse(db.prepare(`${selection} ORDER BY provider, label COLLATE NOCASE, id`).all()));
  }
  async create(userId: string, input: { provider: string; label: string }): Promise<ProviderInstance> {
    this.requireAdmin(userId);
    const provider = z.string().min(1).parse(input.provider);
    const label = z.string().trim().min(1).max(128).parse(input.label);
    if (!supportsProviderInstances(provider)) throw new AuthFailure("This provider does not support local instances", 422);
    const id = `instance_${randomUUID().replaceAll("-", "")}`;
    const homeDirectory = join(providerInstancesDirectory(this.database.filename()), id);
    await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    this.database.authTransaction(db => db.prepare("INSERT INTO forge_provider_instances (id, provider, label, home_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, provider, label, homeDirectory, now, now));
    return this.get(id);
  }
  async delete(userId: string, id: string): Promise<void> {
    this.requireAdmin(userId);
    const instance = this.get(id);
    const inUse = this.database.authQuery(db => db.prepare("SELECT 1 FROM forge_profiles WHERE provider_instance_id = ? LIMIT 1").get(id));
    if (inUse) throw new AuthFailure("This provider instance is used by an agent profile", 409);
    this.database.authTransaction(db => db.prepare("DELETE FROM forge_provider_instances WHERE id = ?").run(id));
    await rm(instance.homeDirectory, { recursive: true, force: true });
  }
  private get(id: string): ProviderInstance {
    const row = this.database.authQuery(db => db.prepare(`${selection} WHERE id = ?`).get(id));
    if (!row) throw new AuthFailure("Not found", 404);
    return ProviderInstanceSchema.parse(row);
  }
  private requireAdmin(userId: string): void { if (this.auth.getUserForAuthority(userId)?.role !== "admin") throw new AuthFailure("Administrator access required", 403); }
}
