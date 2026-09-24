import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthFailure, type AuthService } from "../identity/auth.js";
import type { SuplexDatabase } from "../platform/database.js";
import { ProjectAgentTaskPolicySchema } from "../http/contracts/projects.js";
import { resolveClaudeExecutable, resolveCodexExecutable, resolveDevinExecutable } from "../platform/executable-resolver.js";
import { AgentProfileInputSchema, AgentProfilePatchSchema, AgentProfileSchema, type AgentProfile } from "./agent-profile-contracts.js";

const selection = "SELECT id, name, role, avatar_seed AS avatarSeed, provider, model, reasoning_level AS reasoningLevel, service_tier AS serviceTier, provider_instance_id AS providerInstanceId, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt FROM suplex_profiles";

type AgentSettings = Pick<AgentProfile, "provider" | "model" | "reasoningLevel" | "serviceTier">;
type DefaultAgents = { root: AgentSettings; worker: AgentSettings };

const agent = (provider: AgentSettings["provider"], model: string, reasoningLevel: AgentSettings["reasoningLevel"]): AgentSettings => ({ provider, model, reasoningLevel, serviceTier: "default" });
/** Fresh-install agents in order of preference; the first provider whose CLI is installed wins. */
const DEFAULT_AGENTS: readonly DefaultAgents[] = [
  { root: agent("claude-code", "claude-opus-5-5", "high"), worker: agent("claude-code", "claude-opus-5-5", "medium") },
  { root: agent("codex", "gpt-6-astra", "medium"), worker: agent("codex", "gpt-6-sol", "medium") },
  { root: agent("devin", "swe-2", "high"), worker: agent("devin", "swe-2", "medium") },
];
/** What the migrations seed; it stays when no listed CLI is installed. */
const SEEDED_AGENTS: DefaultAgents = { root: agent("codex", "gpt-5.6-sol", "medium"), worker: { ...agent("codex", "gpt-5.6-luna", "max"), serviceTier: "priority" } };
/** Earlier fresh-install defaults. They still count as untouched, but a fresh install never receives them again. */
const PREVIOUS_AGENTS: readonly DefaultAgents[] = [
  { root: agent("claude-code", "claude-fable-5-1", "medium"), worker: agent("claude-code", "claude-opus-5-5", "medium") },
];
const RESOLVERS: Record<string, () => Promise<string>> = { "claude-code": resolveClaudeExecutable, codex: resolveCodexExecutable, devin: resolveDevinExecutable };
async function cliInstalled(provider: string): Promise<boolean> {
  const resolve = RESOLVERS[provider];
  return resolve ? resolve().then(() => true, () => false) : false;
}
const sameSettings = (profile: AgentProfile | undefined, settings: AgentSettings): boolean =>
  profile !== undefined && profile.archivedAt === null && !profile.providerInstanceId && (Object.keys(settings) as (keyof AgentSettings)[]).every(key => profile[key] === settings[key]);

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

  /**
   * Point the seeded Coordinator and Worker at the best installed CLI. Only a fresh install changes: no task has run and
   * both agents still hold one set of defaults, so an admin's own choice always stays.
   */
  async chooseDefaults(userId: string, installed: (provider: string) => Promise<boolean> = cliInstalled): Promise<void> {
    this.requireAdmin(userId);
    let chosen: DefaultAgents | undefined;
    for (const candidate of DEFAULT_AGENTS) if (await installed(candidate.root.provider)) { chosen = candidate; break; }
    if (!chosen) return;
    this.database.authTransaction(db => {
      if (db.prepare("SELECT 1 FROM suplex_tasks LIMIT 1").get()) return;
      const profiles = z.array(AgentProfileSchema).parse(db.prepare(`${selection} WHERE id IN ('profile_native_root', 'profile_native_worker')`).all());
      const root = profiles.find(profile => profile.id === "profile_native_root");
      const worker = profiles.find(profile => profile.id === "profile_native_worker");
      if (![SEEDED_AGENTS, ...DEFAULT_AGENTS, ...PREVIOUS_AGENTS].some(defaults => sameSettings(root, defaults.root) && sameSettings(worker, defaults.worker))) return;
      if (sameSettings(root, chosen.root) && sameSettings(worker, chosen.worker)) return;
      const now = new Date().toISOString();
      for (const [id, settings] of [["profile_native_root", chosen.root], ["profile_native_worker", chosen.worker]] as const) {
        db.prepare("UPDATE suplex_profiles SET provider = ?, model = ?, reasoning_level = ?, service_tier = ?, updated_at = ? WHERE id = ?").run(settings.provider, settings.model, settings.reasoningLevel, settings.serviceTier, now, id);
        this.auth.recordAuditEvent(userId, "agent_profile_updated", undefined, undefined, { profileId: id });
      }
    });
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
