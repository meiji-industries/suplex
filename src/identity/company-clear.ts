import { z } from "zod";
import type { SuplexDatabase } from "../platform/database.js";

export class CompanyHasLiveSessions extends Error {
  constructor() {
    super("Cancel active tasks and wait for their sessions to stop before clearing this company");
    this.name = "CompanyHasLiveSessions";
  }
}

export function wipeCompanyData(database: SuplexDatabase, companyId: string): void {
  database.authTransaction(db => {
    const live = db.prepare("SELECT 1 FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE t.company_id = ? AND (c.status IN ('active', 'waiting_human') OR EXISTS (SELECT 1 FROM suplex_task_sessions s WHERE s.task_id = t.id AND s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL)) LIMIT 1").get(companyId);
    if (live) throw new CompanyHasLiveSessions();
    const agents = z.array(z.object({ id: z.string() })).parse(db.prepare("SELECT id FROM suplex_external_agents WHERE company_id = ?").all(companyId));
    db.prepare("DELETE FROM suplex_task_command_activity WHERE task_id IN (SELECT id FROM suplex_tasks WHERE company_id = ?)").run(companyId);
    db.prepare("DELETE FROM suplex_tasks WHERE company_id = ?").run(companyId);
    db.prepare("DELETE FROM suplex_avatars WHERE owner_id IN (SELECT id FROM suplex_projects WHERE company_id = ?)").run(companyId);
    db.prepare("DELETE FROM suplex_projects WHERE company_id = ?").run(companyId);
    db.prepare("DELETE FROM suplex_artifacts WHERE company_id = ?").run(companyId);
    for (const agent of agents) {
      db.prepare("UPDATE suplex_audit_events SET actor_agent_id = NULL WHERE actor_agent_id = ?").run(agent.id);
      db.prepare("DELETE FROM suplex_agents WHERE id = ?").run(agent.id);
      db.prepare("DELETE FROM suplex_avatars WHERE owner_id = ?").run(agent.id);
    }
    db.prepare("UPDATE suplex_companies SET status = 'active', issue_code = NULL, next_issue_number = 1 WHERE id = ?").run(companyId);
  });
}
