import type { ForgeDatabase } from "./database.js";
import { CliHerdrClient, type HerdrClient } from "./herdr-client.js";

export interface HerdrRecoveryOutcome {
  sessionId: string;
  taskId: string;
  status: "active" | "missing" | "unbound" | "failed" | "closed";
}

const terminal = new Set(["done", "cancelled"]);
const now = () => new Date().toISOString();

/** Reconciles durable handles with Herdr. Process ids are intentionally absent. */
export async function reconcileHerdrSessions(
  database: ForgeDatabase,
  herdr: HerdrClient = new CliHerdrClient(),
  taskId?: string,
): Promise<HerdrRecoveryOutcome[]> {
  const sessions = database.authQuery((db) => db.prepare(`SELECT id, task_id AS taskId, agent_name AS agentName, codex_session_id AS codexSessionId, pane_id AS paneId, status FROM forge_herdr_role_sessions WHERE status NOT IN ('closed')${taskId ? " AND task_id = ?" : ""} ORDER BY task_id, id`).all(...(taskId ? [taskId] : [])) as Array<{ id: string; taskId: string; agentName: string | null; codexSessionId: string | null; paneId: string | null; status: string }>);
  const outcomes: HerdrRecoveryOutcome[] = [];
  for (const session of sessions) {
    const live = session.agentName ? await herdr.getAgent(session.agentName) : null;
    if (live) {
      const conflict = (session.paneId && session.paneId !== live.paneId)
        || (session.paneId && live.tabId && !(await tabOwnsPane(database, session.taskId, live.tabId)));
      const status = conflict ? "failed" : "active";
      database.authTransaction((db) => db.prepare("UPDATE forge_herdr_role_sessions SET status = ?, last_agent_status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?").run(conflict ? "failed" : live.status === "working" ? "working" : live.status === "blocked" ? "blocked" : "ready", live.status ?? null, now(), now(), session.id));
      outcomes.push({ sessionId: session.id, taskId: session.taskId, status });
      continue;
    }
    const status = session.codexSessionId ? "missing" : "unbound";
    database.authTransaction((db) => db.prepare("UPDATE forge_herdr_role_sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), session.id));
    outcomes.push({ sessionId: session.id, taskId: session.taskId, status });
  }
  const tabs = database.authQuery((db) => db.prepare(`SELECT tab.task_id AS taskId, tab.tab_id AS tabId, projection.phase FROM forge_herdr_task_tabs tab JOIN forge_issue_projections projection ON projection.task_id = tab.task_id WHERE tab.state = 'open'${taskId ? " AND tab.task_id = ?" : ""}`).all(...(taskId ? [taskId] : [])) as Array<{ taskId: string; tabId: string | null; phase: string }>);
  for (const tab of tabs) {
    if (!tab.tabId || !terminal.has(tab.phase)) continue;
    if (await herdr.getTab(tab.tabId)) await herdr.closeTab(tab.tabId);
    database.authTransaction((db) => db.prepare("UPDATE forge_herdr_task_tabs SET state = 'closed', closed_at = ?, updated_at = ? WHERE task_id = ?").run(now(), now(), tab.taskId));
    outcomes.push({ sessionId: `tab:${tab.taskId}`, taskId: tab.taskId, status: "closed" });
  }
  return outcomes;
}

async function tabOwnsPane(database: ForgeDatabase, taskId: string, tabId: string): Promise<boolean> {
  return database.authQuery((db) => Boolean(db.prepare("SELECT 1 FROM forge_herdr_task_tabs WHERE task_id = ? AND tab_id = ?").get(taskId, tabId)));
}
