import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { TaskTemplateService } from "../src/task-templates.js";

test("task templates preserve task presets and reject duplicate names", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-template-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const auth = { requireCompanyAccess: () => ({}) };
  const tasks = { getTask: () => ({ companyId: "company-1", projectId: "project-1", description: "Template description", source: { kind: "pull_request" as const, number: 42, url: "https://github.com/acme/project/pull/42", headBranch: "feature/template", baseBranch: "main" }, roleAgents: { planner: "planner-1", builder: "builder-1", reviewer: "reviewer-1", integrator: "integrator-1" }, supplementalReview: true, autoApprovePlan: true, deliveryTarget: "pull_request_ready", executionControls: { runProjectTests: true, visualEvidence: "required" } }) };
  database.authQuery((db) => db.pragma("foreign_keys = OFF"));
  database.authTransaction((db) => db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', '/tmp/project', '/tmp/worktrees', 'acme/project', 'main', 'main', '', '', '[]', '{}', 'active', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z')").run());
  const templates = new TaskTemplateService(database, auth as never, tasks as never);
  try {
    const template = templates.createFromTask("user-1", "task-1", "  Release preset  ");
    expect(template).toMatchObject({ projectId: "project-1", name: "Release preset", description: "Template description", source: { kind: "pull_request", number: 42 }, roleAgents: tasks.getTask().roleAgents, supplementalReview: true, autoApprovePlan: true, deliveryTarget: "pull_request_ready", runProjectTests: true, visualEvidence: "required" });
    expect(templates.list("user-1", "project-1")).toEqual([template]);
    let duplicate: unknown; try { templates.createFromTask("user-1", "task-1", "Release preset"); } catch (error) { duplicate = error; } expect(duplicate).toMatchObject({ statusCode: 409 });
    templates.delete("user-1", template.id);
    expect(templates.list("user-1", "project-1")).toEqual([]);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
