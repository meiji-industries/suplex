import { z } from "zod";
import type { ForgeDatabase } from "./database.js";

export class CompanyHasLiveSessions extends Error {
  constructor() {
    super("Cancel active tasks and wait for their sessions to stop before clearing this company");
    this.name = "CompanyHasLiveSessions";
  }
}

export function wipeCompanyData(database: ForgeDatabase, companyId: string): void {
  database.authTransaction(db => {
    const live = db.prepare("SELECT 1 FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id WHERE t.company_id = ? AND (c.status IN ('active', 'waiting_human') OR EXISTS (SELECT 1 FROM forge_task_sessions s WHERE s.task_id = t.id AND s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL)) LIMIT 1").get(companyId);
    if (live) throw new CompanyHasLiveSessions();
    const agents = z.array(z.object({ id: z.string() })).parse(db.prepare("SELECT id FROM forge_external_agents WHERE company_id = ?").all(companyId));
    db.prepare("DELETE FROM forge_task_command_activity WHERE task_id IN (SELECT id FROM forge_tasks WHERE company_id = ?)").run(companyId);
    db.prepare("DELETE FROM forge_tasks WHERE company_id = ?").run(companyId);
    db.prepare("DELETE FROM forge_projects WHERE company_id = ?").run(companyId);
    db.prepare("DELETE FROM forge_artifacts WHERE company_id = ?").run(companyId);
    for (const agent of agents) {
      db.prepare("UPDATE forge_audit_events SET actor_agent_id = NULL WHERE actor_agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM forge_agents WHERE id = ?").run(agent.id);
    }
    db.prepare("UPDATE forge_companies SET status = 'active', issue_code = NULL, next_issue_number = 1 WHERE id = ?").run(companyId);
  });
}
