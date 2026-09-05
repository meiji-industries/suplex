import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthFailure, type AuthService } from "./auth.js";
import type { ForgeDatabase } from "./database.js";
import { AgentProfileInputSchema, AgentProfilePatchSchema, AgentProfileSchema, type AgentProfile } from "./agent-profile-contracts.js";

const selection = "SELECT id, name, role, avatar_seed AS avatarSeed, provider, model, reasoning_level AS reasoningLevel, service_tier AS serviceTier, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt FROM forge_profiles";

export class AgentProfileService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService) {}

  list(userId: string, includeArchived = false): AgentProfile[] {
    if (!this.auth.getUserForAuthority(userId)) throw new AuthFailure("Authentication required", 401);
    return this.database.authQuery(db => z.array(AgentProfileSchema).parse(db.prepare(`${selection}${includeArchived ? "" : " WHERE archived_at IS NULL"} ORDER BY name COLLATE NOCASE, id`).all()));
  }

  create(userId: string, input: z.input<typeof AgentProfileInputSchema>): AgentProfile {
    this.requireAdmin(userId);
    const values = AgentProfileInputSchema.parse(input);
    const id = `profile_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    this.database.authTransaction(db => {
      this.assertName(values.name);
      db.prepare("INSERT INTO forge_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, values.name, values.role, values.avatarSeed, values.provider, values.model, values.reasoningLevel, values.serviceTier, now, now);
      this.auth.recordAuditEvent(userId, "agent_profile_created", undefined, undefined, { profileId: id });
    });
    return this.get(id);
  }

  update(userId: string, id: string, patch: z.input<typeof AgentProfilePatchSchema>): AgentProfile {
    this.requireAdmin(userId);
    const changes = AgentProfilePatchSchema.parse(patch);
    return this.database.authTransaction(db => {
      const current = this.get(id);
      const { archived, ...settings } = changes;
      const values = AgentProfileInputSchema.strip().parse({ ...current, ...settings });
      this.assertName(values.name, id);
      if (archived || values.role !== current.role) {
        const project = db.prepare("SELECT id FROM forge_projects WHERE root_profile_id = ? OR worker_profile_id = ? LIMIT 1").get(id, id);
        if (project) throw new AuthFailure("Select another project default before changing this profile's role or archiving it", 409);
      }
      const now = new Date().toISOString();
      db.prepare("UPDATE forge_profiles SET name = ?, role = ?, avatar_seed = ?, provider = ?, model = ?, reasoning_level = ?, service_tier = ?, archived_at = ?, updated_at = ? WHERE id = ?").run(values.name, values.role, values.avatarSeed, values.provider, values.model, values.reasoningLevel, values.serviceTier, archived === undefined ? current.archivedAt : archived ? now : null, now, id);
      this.auth.recordAuditEvent(userId, "agent_profile_updated", undefined, undefined, { profileId: id });
      return this.get(id);
    });
  }

  duplicate(userId: string, id: string): AgentProfile {
    this.requireAdmin(userId);
    const source = this.get(id);
    const names = new Set(this.list(userId, true).map(profile => profile.name));
    const base = source.name.slice(0, 65);
    let name = `${base} (copy)`;
    for (let copy = 2; names.has(name); copy++) name = `${base} (copy ${copy})`;
    return this.create(userId, AgentProfileInputSchema.strip().parse({ ...source, name, avatarSeed: randomBytes(16).toString("hex") }));
  }

  private get(id: string): AgentProfile {
    const row = this.database.authQuery(db => db.prepare(`${selection} WHERE id = ?`).get(id));
    if (!row) throw new AuthFailure("Not found", 404);
    return AgentProfileSchema.parse(row);
  }

  private assertName(name: string, id = ""): void {
    if (this.database.authQuery(db => db.prepare("SELECT 1 FROM forge_profiles WHERE name = ? AND id <> ?").get(name, id))) throw new AuthFailure("This agent name is already in use", 409);
  }

  private requireAdmin(userId: string): void {
    if (this.auth.getUserForAuthority(userId)?.role !== "admin") throw new AuthFailure("Administrator access required", 403);
  }
}
