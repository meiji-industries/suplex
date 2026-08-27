import type { AuthService } from "./auth.js";
import type { ForgeDatabase } from "./database.js";
import type { RoleAssignments } from "./projects.js";
import { TaskFailure, type DeliveryTarget, type VisualEvidence, type TaskService } from "./tasks.js";
import { finding, id, parseRoleAgents } from "./task-utils.js";

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
  createdAt: string;
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
  created_at: string;
}

function publicTemplate(row: TaskTemplateRow): TaskTemplate {
  return { id: row.id, projectId: row.project_id, name: row.name, description: row.description, roleAgents: parseRoleAgents(row.role_agents), supplementalReview: Boolean(row.supplemental_review), autoApprovePlan: Boolean(row.auto_approve_plan), deliveryTarget: row.delivery_target, runProjectTests: Boolean(row.run_project_tests), visualEvidence: row.visual_evidence, createdAt: row.created_at };
}

export class TaskTemplateService {
  constructor(private readonly database: ForgeDatabase, private readonly auth: AuthService, private readonly tasks: TaskService) {}

  list(actorUserId: string, projectId: string): TaskTemplate[] {
    const company = this.database.authQuery((db) => db.prepare("SELECT company_id FROM forge_projects WHERE id = ?").get(projectId) as { company_id: string } | undefined);
    if (!company) throw new TaskFailure("Not found", [], 404);
    this.auth.requireCompanyAccess(actorUserId, company.company_id);
    return this.database.authQuery((db) => (db.prepare("SELECT * FROM forge_task_templates WHERE project_id = ? ORDER BY name COLLATE NOCASE, id").all(projectId) as TaskTemplateRow[]).map(publicTemplate));
  }

  createFromTask(actorUserId: string, taskId: string, rawName: string): TaskTemplate {
    const task = this.tasks.getTask(actorUserId, taskId);
    const name = rawName.trim();
    if (!name || name.length > 80) throw new TaskFailure("Template name is invalid", [finding("invalid-template-name", "name", "Enter a name from 1 to 80 characters")], 422);
    this.auth.requireCompanyAccess(actorUserId, task.companyId);
    const row: TaskTemplateRow = { id: id("template"), company_id: task.companyId, project_id: task.projectId, name, description: task.description, role_agents: JSON.stringify(task.roleAgents), supplemental_review: Number(task.supplementalReview), auto_approve_plan: Number(task.autoApprovePlan), delivery_target: task.deliveryTarget, run_project_tests: Number(task.executionControls.runProjectTests), visual_evidence: task.executionControls.visualEvidence, created_at: new Date().toISOString() };
    try {
      this.database.authTransaction((db) => db.prepare("INSERT INTO forge_task_templates (id, company_id, project_id, name, description, role_agents, supplemental_review, auto_approve_plan, delivery_target, run_project_tests, visual_evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.company_id, row.project_id, row.name, row.description, row.role_agents, row.supplemental_review, row.auto_approve_plan, row.delivery_target, row.run_project_tests, row.visual_evidence, row.created_at));
    } catch (error) {
      if (error instanceof Error && error.message.includes("forge_task_templates.project_id, forge_task_templates.name")) throw new TaskFailure("Template name is already in use", [finding("duplicate-template-name", "name", "A template with this name already exists in the project")], 409);
      throw error;
    }
    return publicTemplate(row);
  }

  delete(actorUserId: string, templateId: string): void {
    const template = this.database.authQuery((db) => db.prepare("SELECT * FROM forge_task_templates WHERE id = ?").get(templateId) as TaskTemplateRow | undefined);
    if (!template) throw new TaskFailure("Not found", [], 404);
    this.auth.requireCompanyAccess(actorUserId, template.company_id);
    this.database.authTransaction((db) => db.prepare("DELETE FROM forge_task_templates WHERE id = ?").run(templateId));
  }
}
