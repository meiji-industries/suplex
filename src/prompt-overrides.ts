import { randomUUID } from "node:crypto";

import type { AuthService } from "./auth.js";
import type { ForgeDatabase } from "./database.js";
import { loadPromptCatalog, type PromptPath, type PromptTemplate } from "./prompts.js";
import { resolvePromptSet, validateOverrideContent, type OverrideMode, type PromptOverrideRow, type ResolvedPrompt } from "./prompt-resolution.js";
import type { ProjectService } from "./projects.js";

export class PromptOverrideFailure extends Error {
  constructor(readonly publicMessage: string, readonly statusCode: number, readonly findings: Array<{ code: string; message: string }> = []) {
    super(publicMessage);
    this.name = "PromptOverrideFailure";
  }
}
export type ResolvedPromptSet = { prompts: Map<PromptPath, string>; provenance: Record<string, ResolvedPrompt>; overrides: string[] };

type Scope = "global" | "project";
type OverrideDatabaseRow = { id: string; scope: Scope; project_id: string | null; template_id: string; mode: OverrideMode; content: string; base_template_sha256: string; current_revision: number; updated_by_user_id: string; created_at: string; updated_at: string };
type RevisionRow = { id: string; override_id: string; revision: number; mode: OverrideMode; content: string; base_template_sha256: string; actor_user_id: string; note: string | null; restored_from_revision: number | null; created_at: string };

function overrideRow(row: OverrideDatabaseRow): PromptOverrideRow {
  return { id: row.id, templateId: row.template_id, mode: row.mode, content: row.content, baseTemplateSha256: row.base_template_sha256, currentRevision: row.current_revision };
}

export class PromptOverrideService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly projects: ProjectService, private readonly now: () => Date = () => new Date()) {}

  private authorize(actorUserId: string, scope: Scope, projectId?: string): { companyId?: string; projectId?: string } {
    if (scope === "global") {
      this.auth.listUsers(actorUserId);
      return {};
    }
    if (!projectId) throw new PromptOverrideFailure("Project id is required", 400);
    const project = this.projects.getProject(actorUserId, projectId);
    return { companyId: project.companyId, projectId: project.id };
  }

  private template(templateId: string): PromptTemplate {
    const template = loadPromptCatalog().get(templateId);
    if (!template) throw new PromptOverrideFailure("Prompt template not found", 404);
    return template;
  }

  private rows(scope: Scope, projectId?: string): OverrideDatabaseRow[] {
    const scopeKey = scope === "global" ? "global" : projectId!;
    return this.database.authQuery((db) => db.prepare("SELECT * FROM forge_prompt_overrides WHERE scope_key = ?").all(scopeKey) as OverrideDatabaseRow[]);
  }

  listForScope(actorUserId: string, scope: Scope, projectId?: string): PromptOverrideRow[] {
    const authorized = this.authorize(actorUserId, scope, projectId);
    return this.rows(scope, authorized.projectId).map(overrideRow);
  }

  revisions(actorUserId: string, scope: Scope, templateId: string, projectId?: string): RevisionRow[] {
    const authorized = this.authorize(actorUserId, scope, projectId);
    return this.database.authQuery((db) => db.prepare("SELECT r.* FROM forge_prompt_override_revisions r JOIN forge_prompt_overrides o ON o.id = r.override_id WHERE o.scope_key = ? AND o.template_id = ? ORDER BY r.revision DESC").all(scope === "global" ? "global" : authorized.projectId, templateId) as RevisionRow[]);
  }

  save(actorUserId: string, scope: Scope, templateId: string, input: { mode: OverrideMode; content: string; note?: string }, projectId?: string): PromptOverrideRow {
    const authorized = this.authorize(actorUserId, scope, projectId);
    const template = this.template(templateId);
    if (!template.editable) throw new PromptOverrideFailure("Prompt template is not editable", 403, [{ code: "template_not_editable", message: "Prompt template is not editable" }]);
    const findings = validateOverrideContent(template, input.content);
    if (findings.length) throw new PromptOverrideFailure("Prompt override is invalid", 422, findings);
    const scopeKey = scope === "global" ? "global" : authorized.projectId!;
    const now = this.now().toISOString();
    return this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT * FROM forge_prompt_overrides WHERE scope_key = ? AND template_id = ?").get(scopeKey, templateId) as OverrideDatabaseRow | undefined;
      const id = existing?.id ?? randomUUID();
      const revision = (existing?.current_revision ?? 0) + 1;
      if (existing) db.prepare("UPDATE forge_prompt_overrides SET mode = ?, content = ?, base_template_sha256 = ?, current_revision = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?").run(input.mode, input.content, template.guidanceSha256, revision, actorUserId, now, id);
      else db.prepare("INSERT INTO forge_prompt_overrides (id, scope, project_id, scope_key, template_id, mode, content, base_template_sha256, current_revision, updated_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, scope, authorized.projectId ?? null, scopeKey, templateId, input.mode, input.content, template.guidanceSha256, revision, actorUserId, now, now);
      db.prepare("INSERT INTO forge_prompt_override_revisions (id, override_id, revision, mode, content, base_template_sha256, actor_user_id, note, restored_from_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)").run(randomUUID(), id, revision, input.mode, input.content, template.guidanceSha256, actorUserId, input.note ?? null, now);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "prompt_override_saved", undefined, authorized.companyId, { scope, projectId: authorized.projectId ?? "", templateId, mode: input.mode, revision: String(revision) });
      return overrideRow(db.prepare("SELECT * FROM forge_prompt_overrides WHERE id = ?").get(id) as OverrideDatabaseRow);
    });
  }

  rollback(actorUserId: string, scope: Scope, templateId: string, revision: number, projectId?: string): PromptOverrideRow {
    const authorized = this.authorize(actorUserId, scope, projectId);
    const scopeKey = scope === "global" ? "global" : authorized.projectId!;
    const now = this.now().toISOString();
    return this.database.authTransaction((db) => {
      const existing = db.prepare("SELECT * FROM forge_prompt_overrides WHERE scope_key = ? AND template_id = ?").get(scopeKey, templateId) as OverrideDatabaseRow | undefined;
      const restored = existing && db.prepare("SELECT * FROM forge_prompt_override_revisions WHERE override_id = ? AND revision = ?").get(existing.id, revision) as RevisionRow | undefined;
      if (!existing || !restored) throw new PromptOverrideFailure("Prompt override revision not found", 404);
      const nextRevision = existing.current_revision + 1;
      db.prepare("UPDATE forge_prompt_overrides SET mode = ?, content = ?, base_template_sha256 = ?, current_revision = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?").run(restored.mode, restored.content, restored.base_template_sha256, nextRevision, actorUserId, now, existing.id);
      db.prepare("INSERT INTO forge_prompt_override_revisions (id, override_id, revision, mode, content, base_template_sha256, actor_user_id, note, restored_from_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)").run(randomUUID(), existing.id, nextRevision, restored.mode, restored.content, restored.base_template_sha256, actorUserId, revision, now);
      this.auth.recordAuditEventInTransaction(db, actorUserId, "prompt_override_rolled_back", undefined, authorized.companyId, { scope, projectId: authorized.projectId ?? "", templateId, mode: restored.mode, revision: String(nextRevision) });
      return overrideRow(db.prepare("SELECT * FROM forge_prompt_overrides WHERE id = ?").get(existing.id) as OverrideDatabaseRow);
    });
  }

  resolveForProject(projectId: string): ResolvedPromptSet {
    const catalog = loadPromptCatalog();
    const active = (rows: OverrideDatabaseRow[]) => new Map(rows.flatMap((row) => {
      const template = catalog.get(row.template_id);
      return template ? [[template.id, overrideRow(row)] as const] : [];
    }));
    const resolved = resolvePromptSet(catalog, { global: active(this.rows("global")), project: active(this.rows("project", projectId)) });
    return {
      prompts: new Map([...resolved.values()].map((prompt) => [catalog.get(prompt.templateId)!.path, prompt.text])),
      provenance: Object.fromEntries(resolved),
      overrides: [...resolved.values()].filter(({ steps }) => steps.some(({ layer, mode }) => layer !== "system" && mode !== "inherit")).map(({ templateId }) => templateId),
    };
  }
}
