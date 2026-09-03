import type { ForgeDatabase } from "./database.js";

/**
 * Destructive company reset ("clear account"): deletes every company-scoped
 * row in FK-safe order and returns the company row to factory state (active,
 * no issue code, issue numbering reset).
 *
 * The delete order is derived from the live schema's foreign keys: rows are
 * removed children-first so every NO ACTION reference is gone before its
 * parent. forge_companies, forge_memberships, and forge_audit_events are
 * preserved — the account, its access, and its audit trail survive the wipe.
 */

type WipeScope = "company" | "task" | "project" | "overrides";

type WipeStep = { table: string; scope: WipeScope } | { sql: (companyId: string) => string };

const WIPE_STEPS: readonly WipeStep[] = [
  // Engine process-local rows for this company's workflows (no FKs; cleared
  // before the tasks rows they key on disappear).
  { sql: (id) => `DELETE FROM forge_engine_activities WHERE workflow_id IN (SELECT workflow_id FROM forge_tasks WHERE company_id = '${id}')` },
  { sql: (id) => `DELETE FROM forge_engine_commands WHERE workflow_id IN (SELECT workflow_id FROM forge_tasks WHERE company_id = '${id}')` },
  // Self-referential NO ACTION columns must be released before their rows.
  { sql: (id) => `UPDATE forge_herdr_turns SET correction_of_turn_id = NULL WHERE task_id IN (SELECT id FROM forge_tasks WHERE company_id = '${id}')` },
  { sql: (id) => `UPDATE forge_delivery_reviews SET supersedes_review_id = NULL WHERE company_id = '${id}'` },
  // Leaves first: these rows reference artifacts and/or later parents with
  // NO ACTION, so they must be gone before the parents they point at.
  { table: "forge_acceptance_attempts", scope: "company" },
  { table: "forge_ci_repair_plans", scope: "company" },
  { table: "forge_completion_receipts", scope: "company" },
  { table: "forge_decision_blocker_resolutions", scope: "company" },
  { table: "forge_delivery_decisions", scope: "company" },
  { table: "forge_delivery_findings", scope: "company" },
  { table: "forge_delivery_repairs", scope: "company" },
  { table: "forge_delivery_review_attempts", scope: "company" },
  { table: "forge_final_review_findings", scope: "company" },
  { table: "forge_final_reviews", scope: "company" },
  { table: "forge_herdr_task_tabs", scope: "task" },
  { table: "forge_herdr_turns", scope: "task" },
  { table: "forge_issue_projections", scope: "company" },
  { table: "forge_issue_timeline", scope: "company" },
  { table: "forge_issue_worktrees", scope: "company" },
  { table: "forge_merge_conflict_resolutions", scope: "company" },
  { table: "forge_merge_observations", scope: "company" },
  { table: "forge_operation_claims", scope: "task" },
  { table: "forge_plan_blocker_responses", scope: "company" },
  { table: "forge_plan_decisions", scope: "company" },
  { table: "forge_plan_reviews", scope: "company" },
  { table: "forge_plan_revision_requests", scope: "company" },
  { table: "forge_planner_notes", scope: "company" },
  { table: "forge_provider_operations", scope: "company" },
  { table: "forge_successor_intents", scope: "company" },
  { table: "forge_task_command_activity", scope: "task" },
  { table: "forge_task_configuration_backfill", scope: "task" },
  { table: "forge_task_template_seeds", scope: "project" },
  { table: "forge_task_templates", scope: "company" },
  { table: "forge_workflow_snapshots", scope: "company" },
  { table: "probe_workflows", scope: "company" },
  { table: "forge_releases", scope: "company" },
  { table: "forge_developer_executions", scope: "company" },
  { table: "forge_ci_runs", scope: "company" },
  { table: "forge_acceptances", scope: "company" },
  { table: "forge_delivery_reviews", scope: "company" },
  { table: "forge_agent_executions", scope: "company" },
  { table: "forge_forward_merges", scope: "company" },
  { table: "forge_task_creation_intents", scope: "company" },
  { table: "forge_herdr_role_sessions", scope: "task" },
  { table: "forge_tasks", scope: "company" },
  { table: "forge_prompt_override_revisions", scope: "overrides" },
  { table: "forge_prompt_overrides", scope: "project" },
  { table: "forge_external_agent_project_grants", scope: "project" },
  { table: "forge_external_agents", scope: "company" },
  { table: "forge_projects", scope: "company" },
  { table: "forge_artifacts", scope: "company" },
];

const SQL_BY_SCOPE: Record<WipeScope, (table: string) => string> = {
  company: (table) => `DELETE FROM ${table} WHERE company_id = ?`,
  task: (table) => `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM forge_tasks WHERE company_id = ?)`,
  project: (table) => `DELETE FROM ${table} WHERE project_id IN (SELECT id FROM forge_projects WHERE company_id = ?)`,
  overrides: (table) => `DELETE FROM ${table} WHERE override_id IN (SELECT id FROM forge_prompt_overrides WHERE project_id IN (SELECT id FROM forge_projects WHERE company_id = ?))`,
};

// Append-only guards on developer result events block the wipe's cascading
// delete of those rows (developer executions cascade them). The guard SQL is
// suspended for the duration of the transaction and restored before commit.
const APPEND_ONLY_TRIGGERS = ["forge_developer_execution_events_no_delete", "forge_developer_execution_events_no_update"] as const;

export function wipeCompanyData(database: ForgeDatabase, companyId: string): void {
  database.authTransaction((db) => {
    const triggerSql = new Map<string, string>();
    for (const name of APPEND_ONLY_TRIGGERS) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined;
      if (!row) continue;
      triggerSql.set(name, row.sql);
      db.prepare(`DROP TRIGGER ${name}`).run();
    }
    try {
      const agentIds = (db.prepare("SELECT id FROM forge_external_agents WHERE company_id = ?").all(companyId) as Array<{ id: string }>).map((row) => row.id);
      for (const step of WIPE_STEPS) {
        if ("sql" in step) {
          db.prepare(step.sql(companyId)).run();
        } else {
          db.prepare(SQL_BY_SCOPE[step.scope](step.table)).run(companyId);
        }
      }
      if (agentIds.length) {
        const placeholders = agentIds.map(() => "?").join(",");
        db.prepare(`UPDATE forge_audit_events SET actor_agent_id = NULL WHERE actor_agent_id IN (${placeholders})`).run(...agentIds);
        db.prepare(`DELETE FROM forge_agents WHERE kind = 'hermes' AND id IN (${placeholders})`).run(...agentIds);
      }
      db.prepare("UPDATE forge_companies SET status = 'active', issue_code = NULL, next_issue_number = 1 WHERE id = ?").run(companyId);
    } finally {
      for (const sql of triggerSql.values()) db.exec(sql);
    }
  });
}