import type { ForgeDatabase } from "./database.js";
import { CliHerdrClient, snapshotAgents, type HerdrAgent, type HerdrClient } from "./herdr-client.js";

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
  agentSnapshot?: readonly HerdrAgent[],
): Promise<HerdrRecoveryOutcome[]> {
  const staleSessions = database.authQuery((db) => db.prepare(`SELECT session.id FROM forge_herdr_role_sessions session JOIN forge_issue_projections projection ON projection.task_id = session.task_id WHERE session.status NOT IN ('closed') AND projection.phase IN ('done', 'cancelled', 'failed') AND datetime(COALESCE(projection.state_changed_at, projection.updated_at)) < datetime('now', '-1 day')${taskId ? " AND session.task_id = ?" : ""}`).all(...(taskId ? [taskId] : [])) as Array<{ id: string }>);
  if (staleSessions.length) database.authTransaction((db) => {
    const close = db.prepare("UPDATE forge_herdr_role_sessions SET status = 'closed', updated_at = ? WHERE id = ? AND status <> 'closed'");
    for (const session of staleSessions) close.run(now(), session.id);
  });
  const sessions = database.authQuery((db) => db.prepare(`SELECT session.id, session.task_id AS taskId, session.agent_name AS agentName, session.codex_session_id AS codexSessionId, session.pane_id AS paneId, session.status FROM forge_herdr_role_sessions session JOIN forge_issue_projections projection ON projection.task_id = session.task_id WHERE session.status NOT IN ('closed') AND (projection.phase NOT IN ('done', 'cancelled', 'failed') OR datetime(COALESCE(projection.state_changed_at, projection.updated_at)) >= datetime('now', '-1 day'))${taskId ? " AND session.task_id = ?" : ""} ORDER BY session.task_id, session.id`).all(...(taskId ? [taskId] : [])) as Array<{ id: string; taskId: string; agentName: string | null; codexSessionId: string | null; paneId: string | null; status: string }>);
  const agents = agentSnapshot ?? (sessions.some((session) => session.agentName) ? await snapshotAgents(herdr) : []);
  const agentsByName = new Map(agents.map((live) => [live.name, live]));
  const outcomes: HerdrRecoveryOutcome[] = [];
  for (const session of sessions) {
    const live = session.agentName ? agentsByName.get(session.agentName) ?? null : null;
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
