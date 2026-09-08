import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthFailure, type AuthService } from "../identity/auth.js";
import type { ForgeDatabase } from "../platform/database.js";
import { WorkflowRecordInputSchema, WorkflowRecordPatchSchema, WorkflowRecordSchema, type WorkflowRecord, type WorkflowRecordInput, type WorkflowRecordPatch } from "../http/contracts/workflows.js";
import { normalizeWorkflowInput, WorkflowInputFailure, workflowDefinition } from "./workflows.js";

const Row = z.object({ id: z.string(), name: z.string(), description: z.string(), engine: z.string(), configuration_json: z.string(), archived_at: z.string().nullable(), created_at: z.string(), updated_at: z.string() });
const Configuration = WorkflowRecordInputSchema.omit({ name: true, description: true, engine: true }).strip();

function record(raw: unknown): WorkflowRecord {
  const row = Row.parse(raw);
  return WorkflowRecordSchema.parse({ ...Configuration.parse(JSON.parse(row.configuration_json)), id: row.id, name: row.name, description: row.description, engine: row.engine, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at });
}

export class WorkflowRecordService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService) {}

  list(userId: string, includeArchived = false): WorkflowRecord[] {
    if (!this.auth.getUserForAuthority(userId)) throw new AuthFailure("Authentication required", 401);
    return this.database.authQuery(db => db.prepare(`SELECT * FROM forge_workflows${includeArchived ? "" : " WHERE archived_at IS NULL"} ORDER BY name COLLATE NOCASE, id`).all().map(record));
  }

  get(userId: string, id: string): WorkflowRecord {
    if (!this.auth.getUserForAuthority(userId)) throw new AuthFailure("Authentication required", 401);
    return this.read(id);
  }

  create(userId: string, input: WorkflowRecordInput): WorkflowRecord {
    this.requireAdmin(userId);
    const values = this.validate(WorkflowRecordInputSchema.parse(input));
    const id = `workflow_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    this.database.authTransaction(db => {
      this.assertName(values.name);
      db.prepare("INSERT INTO forge_workflows (id, name, description, engine, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, values.name, values.description, values.engine, JSON.stringify(Configuration.parse(values)), now, now);
      this.auth.recordAuditEvent(userId, "workflow_created", undefined, undefined, { workflowId: id });
    });
    return this.read(id);
  }

  update(userId: string, id: string, patch: WorkflowRecordPatch): WorkflowRecord {
    this.requireAdmin(userId);
    const { archived, ...changes } = WorkflowRecordPatchSchema.parse(patch);
    return this.database.authTransaction(db => {
      const current = this.read(id);
      const merged: Record<string, unknown> = { ...current, ...changes };
      // A new engine drops Advisor choices the caller did not restate; other defaults carry over.
      if (changes.engine !== undefined && changes.engine !== current.engine && changes.advisorProfileIds === undefined) merged.advisorProfileIds = {};
      for (const key of ["rootProfileId", "workerProfileId", "deliveryTarget", "runProjectTests", "visualEvidence"] as const) if (merged[key] === null) delete merged[key];
      const values = this.validate(WorkflowRecordInputSchema.strip().parse(merged));
      this.assertName(values.name, id);
      const now = new Date().toISOString();
      db.prepare("UPDATE forge_workflows SET name = ?, description = ?, engine = ?, configuration_json = ?, archived_at = ?, updated_at = ? WHERE id = ?").run(values.name, values.description, values.engine, JSON.stringify(Configuration.parse(values)), archived === undefined ? current.archivedAt : archived ? now : null, now, id);
      this.auth.recordAuditEvent(userId, "workflow_updated", undefined, undefined, { workflowId: id });
      return this.read(id);
    });
  }

  duplicate(userId: string, id: string): WorkflowRecord {
    this.requireAdmin(userId);
    const source = this.read(id);
    const names = new Set(this.list(userId, true).map(workflow => workflow.name));
    const base = source.name.slice(0, 65);
    let name = `${base} (copy)`;
    for (let copy = 2; names.has(name); copy++) name = `${base} (copy ${copy})`;
    return this.create(userId, WorkflowRecordInputSchema.strip().parse({ ...source, name }));
  }

  /** Advisor roles must belong to the engine, repair keeps its forced delivery, and every profile must exist with the right role. */
  private validate(values: z.infer<typeof WorkflowRecordInputSchema>): z.infer<typeof WorkflowRecordInputSchema> {
    try { normalizeWorkflowInput({ workflow: values.engine, advisorProfileIds: values.advisorProfileIds, deliveryTarget: values.deliveryTarget, runProjectTests: values.runProjectTests }, { requireSource: false }); }
    catch (error) { if (error instanceof WorkflowInputFailure) throw new AuthFailure(error.message, 422); throw error; }
    const checks: Array<[string | undefined, "root" | "worker", string]> = [[values.rootProfileId, "root", "Coordinator"], [values.workerProfileId, "worker", "Worker"], ...workflowDefinition(values.engine).advisorRoles.map(role => [values.advisorProfileIds[role], "root", "Advisor"] as [string | undefined, "root", string])];
    for (const [profileId, role, label] of checks) {
      if (profileId && !this.database.authQuery(db => db.prepare("SELECT 1 FROM forge_profiles WHERE id = ? AND role = ?").get(profileId, role))) throw new AuthFailure(`The selected ${label} agent does not exist`, 422);
    }
    return values;
  }

  private read(id: string): WorkflowRecord {
    const row = this.database.authQuery(db => db.prepare("SELECT * FROM forge_workflows WHERE id = ?").get(id));
    if (!row) throw new AuthFailure("Not found", 404);
    return record(row);
  }

  private assertName(name: string, id = ""): void {
    if (this.database.authQuery(db => db.prepare("SELECT 1 FROM forge_workflows WHERE name = ? AND id <> ?").get(name, id))) throw new AuthFailure("This workflow name is already in use", 409);
  }

  private requireAdmin(userId: string): void {
    if (this.auth.getUserForAuthority(userId)?.role !== "admin") throw new AuthFailure("Administrator access required", 403);
  }
}
