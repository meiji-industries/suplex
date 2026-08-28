import type { AuthService } from "./auth.js";
import type { ForgeDatabase } from "./database.js";
import type { RoleAssignments } from "./projects.js";
import { TaskFailure, type DeliveryTarget, type VisualEvidence, type TaskService } from "./tasks.js";
import { finding, id, json, parseRoleAgents } from "./task-utils.js";

export type TaskTemplateSource = { kind: "pull_request"; number: number } | { kind: "branch"; branch: string };

export interface TaskTemplate {
  id: string;
  projectId: string;
  name: string;
  description: string;
  roleAgents: RoleAssignments;
  supplementalReview: boolean;
  autoApprovePlan: boolean;
  deliveryTarget: DeliveryTarget;
  runProjectTests: boolean;
  visualEvidence: VisualEvidence;
  source?: TaskTemplateSource;
  createdAt: string;
  updatedAt: string | null;
}

export interface TaskTemplateInput {
  name: string;
  description: string;
  roleAgents: RoleAssignments;
  supplementalReview: boolean;
  autoApprovePlan: boolean;
  deliveryTarget: DeliveryTarget;
  runProjectTests: boolean;
  visualEvidence: VisualEvidence;
  source?: TaskTemplateSource | null | undefined;
}

interface TaskTemplateRow {
  id: string;
  company_id: string;
  project_id: string;
  name: string;
  description: string;
  role_agents: string;
  supplemental_review: number;
  auto_approve_plan: number;
  delivery_target: DeliveryTarget;
  run_project_tests: number;
  visual_evidence: VisualEvidence;
  source_json: string | null;
  created_at: string;
  updated_at: string | null;
}

function parseSource(value: string | null): TaskTemplateSource | undefined {
  if (!value) return undefined;
  const source = json<unknown>(value, {});
  if (typeof source !== "object" || source === null || !("kind" in source)) return undefined;
  if (source.kind === "pull_request" && "number" in source && typeof source.number === "number") return { kind: "pull_request", number: source.number };
  if (source.kind === "branch" && "branch" in source && typeof source.branch === "string") return { kind: "branch", branch: source.branch };
  return undefined;
}

function publicTemplate(row: TaskTemplateRow): TaskTemplate {
  const source = parseSource(row.source_json);
  return { id: row.id, projectId: row.project_id, name: row.name, description: row.description, roleAgents: parseRoleAgents(row.role_agents), supplementalReview: Boolean(row.supplemental_review), autoApprovePlan: Boolean(row.auto_approve_plan), deliveryTarget: row.delivery_target, runProjectTests: Boolean(row.run_project_tests), visualEvidence: row.visual_evidence, ...(source ? { source } : {}), createdAt: row.created_at, updatedAt: row.updated_at };
}

export class TaskTemplateService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly tasks: TaskService) {}

  list(actorUserId: string, projectId: string): TaskTemplate[] {
    const company = this.database.authQuery((db) => db.prepare("SELECT company_id FROM forge_projects WHERE id = ?").get(projectId) as { company_id: string } | undefined);
    if (!company) throw new TaskFailure("Not found", [], 404);
    this.auth.requireCompanyAccess(actorUserId, company.company_id);
    return this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_task_templates WHERE project_id = ? ORDER BY name COLLATE NOCASE, id").all(projectId) as TaskTemplateRow[]).map(publicTemplate));
  }

  private templateName(rawName: string): string {
    const name = rawName.trim();
    if (!name || name.length > 80) throw new TaskFailure("Template name is invalid", [finding("invalid-template-name", "name", "Enter a name from 1 to 80 characters")], 422);
    return name;
  }

  private insert(row: TaskTemplateRow): void {
    try {
      this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_templates (id, company_id, project_id, name, description, role_agents, supplemental_review, auto_approve_plan, delivery_target, run_project_tests, visual_evidence, source_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.company_id, row.project_id, row.name, row.description, row.role_agents, row.supplemental_review, row.auto_approve_plan, row.delivery_target, row.run_project_tests, row.visual_evidence, row.source_json, row.created_at, row.updated_at));
    } catch (error) {
      if (error instanceof Error && error.message.includes("forge_task_templates.project_id, forge_task_templates.name")) throw new TaskFailure("Template name is already in use", [finding("duplicate-template-name", "name", "A template with this name already exists in the project")], 409);
      throw error;
    }
  }

  private row(companyId: string, projectId: string, input: TaskTemplateInput): TaskTemplateRow {
    return { id: id("template"), company_id: companyId, project_id: projectId, name: this.templateName(input.name), description: input.description, role_agents: JSON.stringify(input.roleAgents), supplemental_review: Number(input.supplementalReview), auto_approve_plan: Number(input.autoApprovePlan), delivery_target: input.deliveryTarget, run_project_tests: Number(input.runProjectTests), visual_evidence: input.visualEvidence, source_json: input.source ? JSON.stringify(input.source) : null, created_at: new Date().toISOString(), updated_at: null };
  }

  create(actorUserId: string, projectId: string, input: TaskTemplateInput): TaskTemplate {
    const project = this.database.authQuery((db) => db.prepare("SELECT company_id FROM forge_projects WHERE id = ?").get(projectId) as { company_id: string } | undefined);
    if (!project) throw new TaskFailure("Not found", [], 404);
    this.auth.requireCompanyAccess(actorUserId, project.company_id);
    const row = this.row(project.company_id, projectId, input);
    this.insert(row);
    return publicTemplate(row);
  }

  createFromTask(actorUserId: string, taskId: string, rawName: string): TaskTemplate {
    const task = this.tasks.getTask(actorUserId, taskId);
    this.auth.requireCompanyAccess(actorUserId, task.companyId);
    const source = task.source?.kind === "pull_request" ? { kind: "pull_request" as const, number: task.source.number } : task.source?.kind === "branch" ? { kind: "branch" as const, branch: task.source.branch } : undefined;
    const row = this.row(task.companyId, task.projectId, { name: rawName, description: task.description, roleAgents: task.roleAgents, supplementalReview: task.supplementalReview, autoApprovePlan: task.autoApprovePlan, deliveryTarget: task.deliveryTarget, runProjectTests: task.executionControls.runProjectTests, visualEvidence: task.executionControls.visualEvidence, source });
    this.insert(row);
    return publicTemplate(row);
  }

  update(actorUserId: string, templateId: string, patch: Partial<{ [Key in keyof TaskTemplateInput]: TaskTemplateInput[Key] | undefined }>): TaskTemplate {
    const current = this.database.authQuery((db) => db.prepare("SELECT * FROM forge_task_templates WHERE id = ?").get(templateId) as TaskTemplateRow | undefined);
    if (!current) throw new TaskFailure("Not found", [], 404);
    this.auth.requireCompanyAccess(actorUserId, current.company_id);
    const next: TaskTemplateRow = {
      ...current,
      name: patch.name === undefined ? current.name : this.templateName(patch.name),
      description: patch.description ?? current.description,
      role_agents: patch.roleAgents === undefined ? current.role_agents : JSON.stringify(patch.roleAgents),
      supplemental_review: patch.supplementalReview === undefined ? current.supplemental_review : Number(patch.supplementalReview),
      auto_approve_plan: patch.autoApprovePlan === undefined ? current.auto_approve_plan : Number(patch.autoApprovePlan),
      delivery_target: patch.deliveryTarget ?? current.delivery_target,
      run_project_tests: patch.runProjectTests === undefined ? current.run_project_tests : Number(patch.runProjectTests),
      visual_evidence: patch.visualEvidence ?? current.visual_evidence,
      source_json: patch.source === undefined ? current.source_json : patch.source ? JSON.stringify(patch.source) : null,
      updated_at: new Date().toISOString(),
    };
    try {
      this.database.authTransaction((db) => db.prepare("UPDATE forge_task_templates SET name = ?, description = ?, role_agents = ?, supplemental_review = ?, auto_approve_plan = ?, delivery_target = ?, run_project_tests = ?, visual_evidence = ?, source_json = ?, updated_at = ? WHERE id = ?").run(next.name, next.description, next.role_agents, next.supplemental_review, next.auto_approve_plan, next.delivery_target, next.run_project_tests, next.visual_evidence, next.source_json, next.updated_at, templateId));
    } catch (error) {
      if (error instanceof Error && error.message.includes("forge_task_templates.project_id, forge_task_templates.name")) throw new TaskFailure("Template name is already in use", [finding("duplicate-template-name", "name", "A template with this name already exists in the project")], 409);
      throw error;
    }
    return publicTemplate(next);
  }

  delete(actorUserId: string, templateId: string): void {
    const template = this.database.authQuery((db) => db.prepare("SELECT * FROM forge_task_templates WHERE id = ?").get(templateId) as TaskTemplateRow | undefined);
    if (!template) throw new TaskFailure("Not found", [], 404);
    this.auth.requireCompanyAccess(actorUserId, template.company_id);
    this.database.authTransaction((db) => db.prepare("DELETE FROM forge_task_templates WHERE id = ?").run(templateId));
  }
}
