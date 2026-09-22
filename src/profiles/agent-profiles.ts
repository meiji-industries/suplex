import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthFailure, type AuthService } from "../identity/auth.js";
import type { SuplexDatabase } from "../platform/database.js";
import { ProjectAgentTaskPolicySchema } from "../http/contracts/projects.js";
import { AgentProfileInputSchema, AgentProfilePatchSchema, AgentProfileSchema, type AgentProfile } from "./agent-profile-contracts.js";

const selection = "SELECT id, name, role, avatar_seed AS avatarSeed, provider, model, reasoning_level AS reasoningLevel, service_tier AS serviceTier, provider_instance_id AS providerInstanceId, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt FROM suplex_profiles";

export class AgentProfileService {
  constructor(private readonly database: SuplexDatabase, private readonly auth: AuthService) {}

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
      this.assertInstance(values.provider, values.providerInstanceId ?? null);
      db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, provider_instance_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, values.name, values.role, values.avatarSeed, values.provider, values.model, values.reasoningLevel, values.serviceTier, values.providerInstanceId ?? null, now, now);
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
        const project = db.prepare("SELECT id FROM suplex_projects WHERE root_profile_id = ? OR worker_profile_id = ? LIMIT 1").get(id, id);
        if (project) throw new AuthFailure("Select another project default before changing this profile's role or archiving it", 409);
      }
      const now = new Date().toISOString();
      this.assertInstance(values.provider, values.providerInstanceId ?? null);
      db.prepare("UPDATE suplex_profiles SET name = ?, role = ?, avatar_seed = ?, provider = ?, model = ?, reasoning_level = ?, service_tier = ?, provider_instance_id = ?, archived_at = ?, updated_at = ? WHERE id = ?").run(values.name, values.role, values.avatarSeed, values.provider, values.model, values.reasoningLevel, values.serviceTier, values.providerInstanceId ?? null, archived === undefined ? current.archivedAt : archived ? now : null, now, id);
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

  /** Tasks keep profile snapshots, so they continue after the agent is gone. */
  delete(userId: string, id: string): void {
    this.requireAdmin(userId);
    this.database.authTransaction(db => {
      this.get(id);
      // A default selection would break task creation, trigger dispatch, and later edits, so the admin replaces it first.
      const configured = (table: string) => `SELECT 1 FROM ${table} WHERE json_extract(configuration_json, '$.rootProfileId') = @id OR json_extract(configuration_json, '$.workerProfileId') = @id OR EXISTS (SELECT 1 FROM json_each(configuration_json, '$.advisorProfileIds') WHERE value = @id) LIMIT 1`;
      const references = ([
        ["projects", "SELECT 1 FROM suplex_projects WHERE root_profile_id = @id OR worker_profile_id = @id LIMIT 1"],
        ["workflows", configured("suplex_workflows")],
        ["task templates", configured("suplex_task_templates")],
      ] as const).filter(([, sql]) => db.prepare(sql).get({ id })).map(([kind]) => kind);
      if (references.length) throw new AuthFailure(`Select another agent for the ${new Intl.ListFormat("en").format(references)} that use this agent before you delete it`, 409);
      // Allowlists only permit choices, so removing the agent keeps each project policy valid.
      const without = (ids: string[]) => ids.filter(value => value !== id);
      const projects = db.prepare("SELECT id, root_profile_id, worker_profile_id, agent_task_policy_json FROM suplex_projects WHERE agent_task_policy_json <> '{}'").all() as Array<{ id: string; root_profile_id: string; worker_profile_id: string; agent_task_policy_json: string }>;
      for (const project of projects) {
        const parsed = ProjectAgentTaskPolicySchema.safeParse(JSON.parse(project.agent_task_policy_json));
        if (!parsed.success) continue;
        const policy = parsed.data;
        const pruned = {
          ...policy,
          rootProfileIds: without(policy.rootProfileIds).length ? without(policy.rootProfileIds) : [project.root_profile_id],
          workerProfileIds: without(policy.workerProfileIds).length ? without(policy.workerProfileIds) : [project.worker_profile_id],
          advisorProfileIds: Object.fromEntries(Object.entries(policy.advisorProfileIds).map(([role, ids]) => [role, without(ids)])),
        };
        if (JSON.stringify(pruned) !== JSON.stringify(policy)) db.prepare("UPDATE suplex_projects SET agent_task_policy_json = ? WHERE id = ?").run(JSON.stringify(pruned), project.id);
      }
      db.prepare("DELETE FROM suplex_avatars WHERE owner_id = ?").run(id);
      db.prepare("DELETE FROM suplex_profiles WHERE id = ?").run(id);
      this.auth.recordAuditEvent(userId, "agent_profile_deleted", undefined, undefined, { profileId: id });
    });
  }

  private get(id: string): AgentProfile {
    const row = this.database.authQuery(db => db.prepare(`${selection} WHERE id = ?`).get(id));
    if (!row) throw new AuthFailure("Not found", 404);
    return AgentProfileSchema.parse(row);
  }

  private assertName(name: string, id = ""): void {
    if (this.database.authQuery(db => db.prepare("SELECT 1 FROM suplex_profiles WHERE name = ? AND id <> ?").get(name, id))) throw new AuthFailure("This agent name is already in use", 409);
  }

  private assertInstance(provider: string, instanceId: string | null): void {
    if (!instanceId) return;
    const instance = this.database.authQuery(db => db.prepare("SELECT provider FROM suplex_provider_instances WHERE id = ?").get(instanceId) as { provider: string } | undefined);
    if (!instance) throw new AuthFailure("The selected provider instance does not exist", 422);
    if (instance.provider !== provider) throw new AuthFailure("The selected provider instance belongs to a different provider", 422);
  }

  private requireAdmin(userId: string): void {
    if (this.auth.getUserForAuthority(userId)?.role !== "admin") throw new AuthFailure("Administrator access required", 403);
  }
}
