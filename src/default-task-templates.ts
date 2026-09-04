import type { Database } from "better-sqlite3";

import type { DeliveryTarget, VisualEvidence } from "./tasks.js";
import type { RoleAssignments } from "./projects.js";
import type { ForgeDatabase } from "./database.js";
import { id, json } from "./task-utils.js";

export const DEFAULT_TASK_TEMPLATES: ReadonlyArray<{
  name: string;
  description: string;
  deliveryTarget: DeliveryTarget;
  supplementalReview: boolean;
  autoApprovePlan: boolean;
  runProjectTests: boolean;
  visualEvidence: VisualEvidence;
}> = [{
  name: "Ship Check",
  description: `Please review this for production readiness from 1-10, where 9 means safe to
merge and deploy: correctness, security, data-loss, compatibility, and
operational safety are satisfied and only advisory polish remains. A score
below 9 needs at least one concrete, evidence-backed blocking gap; don't
dock for preference, PR breadth, or problems already present on the base
branch. Never propose splitting, squashing, or reorganizing the PR — its
scope is fixed; the plan only adds work.

What would it take to get it to a 9/10? Then draft a markdown plan in great
detail so I can hand it to sub-agents with no prior context. Don't run
tests or linters when reviewing — read-only please. Be clear and specific so
the other agent can implement it verbatim; each step should be one concern
with its own verification command, ordered so partial progress still leaves
a coherent committed worktree. Don't assume the next agent uses the same
harness or model. I will ask you to check their work later, so specify the
report format you want back — it must include the verbatim summary lines of
every verification command and classify each failure as fixed / pre-existing
on base (with proof) / unresolved.`,
  deliveryTarget: "pull_request_ready",
  supplementalReview: false,
  autoApprovePlan: false,
  runProjectTests: true,
  visualEvidence: "off",
}];

export function seedDefaultTaskTemplates(db: Database, project: { id: string; companyId: string; roleAgents: RoleAssignments }): number {
  const now = new Date().toISOString();
  let inserted = 0;
  for (const template of DEFAULT_TASK_TEMPLATES) {
    const marker = db.prepare("SELECT 1 FROM forge_task_template_seeds WHERE project_id = ? AND template_name = ?").get(project.id, template.name);
    if (marker) continue;
    const result = db.prepare("INSERT OR IGNORE INTO forge_task_templates (id, company_id, project_id, name, description, role_agents, supplemental_review, auto_approve_plan, delivery_target, run_project_tests, visual_evidence, source_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)").run(id("template"), project.companyId, project.id, template.name, template.description, JSON.stringify(project.roleAgents), Number(template.supplementalReview), Number(template.autoApprovePlan), template.deliveryTarget, Number(template.runProjectTests), template.visualEvidence, now);
    db.prepare("INSERT OR IGNORE INTO forge_task_template_seeds (project_id, template_name, seeded_at) VALUES (?, ?, ?)").run(project.id, template.name, now);
    inserted += result.changes;
  }
  return inserted;
}

export function backfillDefaultTaskTemplates(database: ForgeDatabase): number {
  return database.authTransaction((db) => {
    const projects = db.prepare("SELECT id, company_id, role_defaults_json FROM forge_projects").all() as Array<{ id: string; company_id: string; role_defaults_json: string }>;
    return projects.reduce((inserted, project) => inserted + seedDefaultTaskTemplates(db, { id: project.id, companyId: project.company_id, roleAgents: json<RoleAssignments>(project.role_defaults_json, {}) }), 0);
  });
}
