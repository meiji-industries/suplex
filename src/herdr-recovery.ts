import type { ForgeDatabase } from "./database.js";
import { RootController } from "./root-controller.js";
import { OpenCodeTaskRuntime } from "./opencode-task-runtime.js";
import { TaskControlStore } from "./root-session-store.js";
import { DeliveryOperations } from "./delivery-operations.js";
import {
  CliHerdrClient,
  snapshotHerdrRuntime,
  type HerdrAgent,
  type HerdrClient,
  type HerdrRuntimeSnapshot,
  type Pane,
} from "./herdr-client.js";

export type HerdrSessionClassification = "active" | "missing" | "unbound" | "failed" | "unverifiable";

export interface HerdrSessionObservation {
  sessionId: string;
  taskId: string;
  role: "planner" | "builder" | "reviewer" | "integrator";
  paneId: string | null;
  liveAgent: HerdrAgent | null;
  livePane: Pane | null;
  agentName: string | null;
  nativeSessionId: string | null;
  lifecycleStatus: string | null;
  classification: HerdrSessionClassification;
  identityFailure: "binding-token-conflict" | "task-tab-conflict" | null;
}

export interface HerdrRecoveryOutcome {
  sessionId: string;
  taskId: string;
  status: HerdrSessionClassification | "closed";
}

type RoleSession = {
  id: string;
  taskId: string;
  role: HerdrSessionObservation["role"];
  paneId: string | null;
};

const terminal = new Set(["done", "cancelled"]);
const now = () => new Date().toISOString();

function observableSessions(database: ForgeDatabase, taskId?: string): RoleSession[] {
  return database.authQuery((db) => db.prepare(`SELECT session.id, session.task_id AS taskId, session.session_role AS role, session.pane_id AS paneId
    FROM forge_herdr_role_sessions session
    JOIN forge_issue_projections projection ON projection.task_id = session.task_id
    WHERE session.is_current = 1
      AND (projection.phase NOT IN ('done', 'cancelled', 'failed') OR datetime(COALESCE(projection.state_changed_at, projection.updated_at)) >= datetime('now', '-1 day'))
      ${taskId ? "AND session.task_id = ?" : ""}
    ORDER BY session.task_id, session.id`).all(...(taskId ? [taskId] : [])) as RoleSession[]);
}

function recordedTabs(database: ForgeDatabase, sessions: readonly RoleSession[]): Map<string, Set<string>> {
  if (!sessions.length) return new Map();
  const taskIds = [...new Set(sessions.map((session) => session.taskId))];
  const rows = database.authQuery((db) => db.prepare(`SELECT task_id AS taskId, tab_id AS tabId FROM forge_herdr_task_tabs WHERE task_id IN (${taskIds.map(() => "?").join(", ")}) AND tab_id IS NOT NULL`).all(...taskIds) as Array<{ taskId: string; tabId: string }>);
  const byTask = new Map<string, Set<string>>();
  for (const row of rows) {
    const tabs = byTask.get(row.taskId) ?? new Set<string>();
    tabs.add(row.tabId);
    byTask.set(row.taskId, tabs);
  }
  return byTask;
}

/**
 * Joins one live Herdr snapshot to Forge's durable pane bindings. Observation is
 * deliberately read-only: the historical liveness columns are not authority.
 */
export async function observeHerdrSessions(
  database: ForgeDatabase,
  herdr: HerdrClient = new CliHerdrClient(),
  taskId?: string,
  runtimeSnapshot?: HerdrRuntimeSnapshot,
): Promise<HerdrSessionObservation[]> {
  const sessions = observableSessions(database, taskId);
  if (!sessions.length) return [];
  let snapshot: HerdrRuntimeSnapshot;
  try {
    snapshot = runtimeSnapshot ?? (sessions.some((session) => session.paneId)
      ? await snapshotHerdrRuntime(herdr)
      : { agents: [], panes: [] });
  } catch {
    return sessions.map((session) => ({ sessionId: session.id, taskId: session.taskId, role: session.role, paneId: session.paneId, liveAgent: null, livePane: null, agentName: null, nativeSessionId: null, lifecycleStatus: null, classification: "unverifiable" as const, identityFailure: null }));
  }
  const panesById = new Map(snapshot.panes.map((pane) => [pane.paneId, pane]));
  const agentsByPane = new Map(snapshot.agents.map((agent) => [agent.paneId, agent]));
  const tabsByTask = recordedTabs(database, sessions);

  return sessions.map((session) => {
    if (!session.paneId) {
      return {
        sessionId: session.id,
        taskId: session.taskId,
        role: session.role,
        paneId: null,
        liveAgent: null,
        livePane: null,
        agentName: null,
        nativeSessionId: null,
        lifecycleStatus: null,
        classification: "unbound" as const,
        identityFailure: null,
      };
    }

    const livePane = panesById.get(session.paneId) ?? null;
    const liveAgent = agentsByPane.get(session.paneId) ?? null;
    const bindingToken = livePane?.tokens?.forge_binding_id;
    const liveTabId = liveAgent?.tabId ?? livePane?.tabId;
    const taskTabs = tabsByTask.get(session.taskId);
    const identityFailure = bindingToken !== undefined && bindingToken !== session.id
      ? "binding-token-conflict" as const
      : liveTabId && taskTabs?.size && !taskTabs.has(liveTabId)
        ? "task-tab-conflict" as const
        : null;
    const agentName = liveAgent?.name ?? livePane?.agent ?? null;
    const nativeSessionId = liveAgent?.agentSession ?? livePane?.agentSession ?? null;
    const lifecycleStatus = liveAgent?.status ?? livePane?.agentStatus ?? livePane?.status ?? null;
    const processPresent = liveAgent !== null || Boolean(livePane?.agent);

    return {
      sessionId: session.id,
      taskId: session.taskId,
      role: session.role,
      paneId: session.paneId,
      liveAgent,
      livePane,
      agentName,
      nativeSessionId,
      lifecycleStatus,
      classification: identityFailure ? "failed" : processPresent ? "active" : "missing",
      identityFailure,
    };
  });
}

function closeStaleTerminalSessions(database: ForgeDatabase, taskId?: string): void {
  const sessions = database.authQuery((db) => db.prepare(`SELECT session.id FROM forge_herdr_role_sessions session
    JOIN forge_issue_projections projection ON projection.task_id = session.task_id
    WHERE session.status <> 'closed'
      AND projection.phase IN ('done', 'cancelled', 'failed')
      AND datetime(COALESCE(projection.state_changed_at, projection.updated_at)) < datetime('now', '-1 day')
      ${taskId ? "AND session.task_id = ?" : ""}`).all(...(taskId ? [taskId] : [])) as Array<{ id: string }>);
  if (!sessions.length) return;
  database.authTransaction((db) => {
    const close = db.prepare("UPDATE forge_herdr_role_sessions SET status = 'closed', updated_at = ? WHERE id = ? AND status <> 'closed'");
    for (const session of sessions) close.run(now(), session.id);
  });
}

function normalizeSnapshot(snapshot: HerdrRuntimeSnapshot | readonly HerdrAgent[] | undefined): HerdrRuntimeSnapshot | undefined {
  if (!snapshot) return undefined;
  if (!Array.isArray(snapshot)) return snapshot as HerdrRuntimeSnapshot;
  const agents = snapshot as readonly HerdrAgent[];
  return {
    agents: [...agents],
    panes: agents.map((agent) => ({ ...agent, paneId: agent.paneId })),
  };
}

/** Compatibility wrapper that adds only Forge-owned terminal cleanup. */
export async function reconcileHerdrSessions(
  database: ForgeDatabase,
  herdr: HerdrClient = new CliHerdrClient(),
  taskId?: string,
  runtimeSnapshot?: HerdrRuntimeSnapshot | readonly HerdrAgent[],
): Promise<HerdrRecoveryOutcome[]> {
  closeStaleTerminalSessions(database, taskId);
  const observations = await observeHerdrSessions(database, herdr, taskId, normalizeSnapshot(runtimeSnapshot));
  const outcomes: HerdrRecoveryOutcome[] = observations.map((observation) => ({
    sessionId: observation.sessionId,
    taskId: observation.taskId,
    status: observation.classification,
  }));
  const tabs = database.authQuery((db) => db.prepare(`SELECT tab.task_id AS taskId, tab.tab_id AS tabId, projection.phase
    FROM forge_herdr_task_tabs tab
    JOIN forge_issue_projections projection ON projection.task_id = tab.task_id
    WHERE tab.state = 'open'${taskId ? " AND tab.task_id = ?" : ""}`).all(...(taskId ? [taskId] : [])) as Array<{ taskId: string; tabId: string | null; phase: string }>);
  for (const tab of tabs) {
    if (!tab.tabId || !terminal.has(tab.phase)) continue;
    if (await herdr.getTab(tab.tabId)) await herdr.closeTab(tab.tabId);
    database.authTransaction((db) => db.prepare("UPDATE forge_herdr_task_tabs SET state = 'closed', closed_at = ?, updated_at = ? WHERE task_id = ?").run(now(), now(), tab.taskId));
    outcomes.push({ sessionId: `tab:${tab.taskId}`, taskId: tab.taskId, status: "closed" });
  }
  return outcomes;
}

/** Recover Root-owned tasks separately from the legacy role-session subsystem. */
export async function recoverTaskControls(database: ForgeDatabase, herdr: HerdrClient = new CliHerdrClient()): Promise<number> {
  const taskIds = database.authQuery((db) => db.prepare("SELECT task_id FROM forge_task_controls WHERE status IN ('active', 'waiting_human')").all() as Array<{ task_id: string }>);
  const store = new TaskControlStore(database);
  const controller = new RootController(store, new OpenCodeTaskRuntime(database.filename(), herdr));
  const delivery = new DeliveryOperations(store);
  const failures: unknown[] = [];
  for (const row of taskIds) {
    try {
      await delivery.observe(row.task_id);
    } catch (error) {
      failures.push(error);
    }
    try {
      if (store.get(row.task_id).status === "active") await controller.recover(row.task_id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Some task controls could not be recovered");
  return taskIds.length;
}
