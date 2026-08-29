import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ForgeDatabase } from "./database.js";
import { json } from "./task-utils.js";

type LegacyExecution = {
  id: string;
  taskId: string;
  sessionRef: string;
  sessionRole?: "planner" | "builder";
};

function roleForExecution(kind: "agent" | "developer", role: string): "planner" | "builder" | undefined {
  if (kind === "agent" && role === "planner") return "planner";
  if (kind === "developer" || role === "builder") return "builder";
  return undefined;
}

async function readLegacySession(runtimeRoot: string, sessionRef: string): Promise<string | null> {
  if (!/^session_[a-f0-9]{24}$/.test(sessionRef)) return null;
  const raw = await readFile(join(runtimeRoot, "sessions", `${sessionRef}.json`), "utf8").catch(() => null);
  const value = raw ? json(raw, {}) : {};
  return typeof (value as { sessionId?: unknown }).sessionId === "string"
    ? (value as { sessionId: string }).sessionId
    : null;
}

/** Backfill active file-session references before removing FileSessionStore. */
export async function migrateLegacyHerdrSessions(
  database: ForgeDatabase,
  runtimeRoot: string,
): Promise<{ inspected: number; migrated: number; unresolved: string[] }> {
  const rows = database.authQuery((db) => [
    ...(db.prepare("SELECT id, task_id AS taskId, session_ref AS sessionRef, role FROM forge_agent_executions WHERE status IN ('starting', 'running', 'cancelling') AND session_ref IS NOT NULL").all() as Array<Omit<LegacyExecution, "sessionRole"> & { role: string }>).map((row) => ({ ...row, sessionRole: roleForExecution("agent", row.role) })),
    ...(db.prepare("SELECT id, task_id AS taskId, session_ref AS sessionRef, 'builder' AS role FROM forge_developer_executions WHERE status IN ('starting', 'running', 'cancelling') AND session_ref IS NOT NULL").all() as Array<Omit<LegacyExecution, "sessionRole"> & { role: string }>).map((row) => ({ ...row, sessionRole: roleForExecution("developer", row.role) })),
  ]).filter((row) => /^session_[a-f0-9]{24}$/.test(row.sessionRef));
  const unresolved: string[] = [];
  const sessions: Array<LegacyExecution & { sessionRole: "planner" | "builder"; sessionId: string }> = [];
  for (const row of rows) {
    if (!row.sessionRole) {
      unresolved.push(row.id);
      continue;
    }
    const sessionId = await readLegacySession(runtimeRoot, row.sessionRef);
    if (!sessionId) {
      unresolved.push(row.id);
      continue;
    }
    sessions.push({ ...row, sessionRole: row.sessionRole, sessionId });
  }
  const sessionIdsByRole = new Map<string, Set<string>>();
  for (const row of sessions) {
    const key = `${row.taskId}:${row.sessionRole}`;
    const sessionIds = sessionIdsByRole.get(key) ?? new Set<string>();
    sessionIds.add(row.sessionId);
    sessionIdsByRole.set(key, sessionIds);
  }
  let migrated = 0;
  for (const row of sessions) {
    if (sessionIdsByRole.get(`${row.taskId}:${row.sessionRole}`)!.size > 1) {
      unresolved.push(row.id);
      continue;
    }
    const changed = database.authTransaction((db) => {
      const current = db.prepare("SELECT id, codex_session_id FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(row.taskId, row.sessionRole) as { id: string; codex_session_id: string | null } | undefined;
      if (current?.codex_session_id && current.codex_session_id !== row.sessionId) return undefined;
      if (current) {
        if (current.codex_session_id === row.sessionId) return false;
        db.prepare("UPDATE forge_herdr_role_sessions SET codex_session_id = ?, status = 'missing', updated_at = ? WHERE id = ?").run(row.sessionId, new Date().toISOString(), current.id);
        return true;
      }
      const id = `herdr_session_${row.taskId}_${row.sessionRole}`;
      db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, status, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 'codex', ?, 'missing', ?, ?)").run(id, row.taskId, row.sessionRole, row.sessionId, new Date().toISOString(), new Date().toISOString());
      return true;
    });
    if (changed === undefined) unresolved.push(row.id);
    else if (changed) migrated += 1;
  }
  return { inspected: rows.length, migrated, unresolved };
}
