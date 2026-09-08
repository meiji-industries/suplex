import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthService } from "../identity/auth.js";
import type { ForgeDatabase } from "../platform/database.js";
import { TaskFailure, type TaskService } from "./tasks.js";
import { CreateTaskTemplateBodySchema, TaskTemplateResponseSchema, UpdateTaskTemplateBodySchema } from "../http/contracts/task-templates.js";
import { normalizeWorkflowInput, WorkflowInputFailure, type RawWorkflowInput } from "../coordination/workflows.js";

export type TaskTemplateInput = z.input<typeof CreateTaskTemplateBodySchema>;
export type TaskTemplate = z.infer<typeof TaskTemplateResponseSchema>;
const Row = z.object({ id: z.string(), project_id: z.string(), configuration_json: z.string(), created_at: z.string(), updated_at: z.string() });
function normalized<T extends RawWorkflowInput>(input: T): ReturnType<typeof normalizeWorkflowInput<T>> {
  try { return normalizeWorkflowInput(input, { requireSource: false }); }
  catch (error) { if (error instanceof WorkflowInputFailure) throw new TaskFailure(error.message, error.statusCode); throw error; }
}

function template(raw: unknown): TaskTemplate {
  const row = Row.parse(raw);
  return TaskTemplateResponseSchema.parse({ ...CreateTaskTemplateBodySchema.parse(JSON.parse(row.configuration_json)), id: row.id, projectId: row.project_id, createdAt: row.created_at, updatedAt: row.updated_at });
}

export class TaskTemplateService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly tasks: TaskService) {}

  list(userId: string, projectId: string): TaskTemplate[] {
    this.requireProject(userId, projectId);
    return this.database.authQuery(db => db.prepare("SELECT * FROM forge_task_templates WHERE project_id = ? ORDER BY name COLLATE NOCASE, id").all(projectId).map(template));
  }

  create(userId: string, projectId: string, input: TaskTemplateInput): TaskTemplate {
    this.requireProject(userId, projectId);
    const configuration = CreateTaskTemplateBodySchema.parse(normalized(input));
    const id = `template_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    this.database.authTransaction(db => {
      this.assertName(projectId, configuration.name);
      db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, projectId, configuration.name, JSON.stringify(configuration), now, now);
    });
    return { ...configuration, id, projectId, createdAt: now, updatedAt: now };
  }

  createFromTask(userId: string, taskId: string, name: string): TaskTemplate {
    const task = this.tasks.getTask(userId, taskId);
    const advisorProfileIds = Object.fromEntries(Object.entries(task.advisorProfiles).map(([role, profile]) => [role, profile.profileId]));
    return this.create(userId, task.projectId, { name, description: task.description, rootProfileId: task.rootProfile.profileId, workerProfileId: task.workerProfile.profileId, deliveryTarget: task.deliveryTarget, runProjectTests: task.configuration.runProjectTests, visualEvidence: task.configuration.visualEvidence, workflow: task.workflow, advisorProfileIds });
  }

  update(userId: string, templateId: string, patch: z.input<typeof UpdateTaskTemplateBodySchema>): TaskTemplate {
    const current = this.get(userId, templateId);
    const changes = UpdateTaskTemplateBodySchema.parse(patch);
    const values: Record<string, unknown> = { ...current, ...changes };
    // Switching to repair replaces inherited target/tests with the repair defaults; explicit contradictions still fail.
    if (changes.workflow === "refine_pull_request" && current.workflow !== "refine_pull_request") {
      if (changes.deliveryTarget === undefined) values.deliveryTarget = "merged";
      if (changes.runProjectTests === undefined) values.runProjectTests = true;
    }
    if (changes.workflow !== undefined && changes.workflow !== current.workflow && changes.advisorProfileIds === undefined) values.advisorProfileIds = {};
    const configuration = CreateTaskTemplateBodySchema.strip().parse(normalized({ ...values, rootProfileId: values.rootProfileId ?? undefined, workerProfileId: values.workerProfileId ?? undefined }));
    const updatedAt = new Date().toISOString();
    this.database.authTransaction(db => {
      this.assertName(current.projectId, configuration.name, templateId);
      db.prepare("UPDATE forge_task_templates SET name = ?, configuration_json = ?, updated_at = ? WHERE id = ?").run(configuration.name, JSON.stringify(configuration), updatedAt, templateId);
    });
    return { ...configuration, id: current.id, projectId: current.projectId, createdAt: current.createdAt, updatedAt };
  }

  delete(userId: string, templateId: string): void {
    this.get(userId, templateId);
    this.database.authTransaction(db => db.prepare("DELETE FROM forge_task_templates WHERE id = ?").run(templateId));
  }

  private assertName(projectId: string, name: string, id = ""): void {
    if (this.database.authQuery(db => db.prepare("SELECT 1 FROM forge_task_templates WHERE project_id = ? AND name = ? AND id <> ?").get(projectId, name, id))) throw new TaskFailure("This template name is already in use", 409);
  }

  private get(userId: string, templateId: string): TaskTemplate {
    const raw = this.database.authQuery(db => db.prepare("SELECT * FROM forge_task_templates WHERE id = ?").get(templateId));
    if (!raw) throw new TaskFailure("Not found", 404);
    const current = template(raw);
    this.requireProject(userId, current.projectId);
    return current;
  }

  private requireProject(userId: string, projectId: string): void {
    const row = this.database.authQuery(db => db.prepare("SELECT company_id FROM forge_projects WHERE id = ?").get(projectId));
    if (!row) throw new TaskFailure("Not found", 404);
    this.auth.requireCompanyAccess(userId, z.object({ company_id: z.string() }).parse(row).company_id);
  }
}
