import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { turnResultSchema } from "../../turn-result-schemas.js";
import type { ForgeConfig } from "../../config.js";
import type { ForgeDatabase } from "../../database.js";
import { CliHerdrClient, type HerdrClient } from "../../herdr-client.js";
import { observeHerdrSessions } from "../../herdr-recovery.js";
import { json } from "../../task-utils.js";

const liveHerdrStatuses = new Set([
  "working",
  "running",
  "starting",
  "blocked",
  "awaiting_human",
  "awaiting_input",
  "awaiting-input",
]);
const DISPATCH_GRACE_MS = 3 * 60 * 1_000;

function isLiveHerdrStatus(status: string | null | undefined): boolean {
  return status !== undefined && status !== null && liveHerdrStatuses.has(status);
}

export type TaskTurnLiveness = { live: boolean; role?: string; agentName?: string };
export type AuthoritativeTaskTurnLiveness = { state: "live"; role?: string; agentName?: string } | { state: "stopped" } | { state: "unknown" };

export async function observeTaskTurnLiveness(
  database: ForgeDatabase,
  config: ForgeConfig,
  taskId: string,
  herdr: HerdrClient = new CliHerdrClient(),
): Promise<AuthoritativeTaskTurnLiveness> {
  try {
    const snapshot = await herdr.runtimeSnapshot();
    const observations = await observeHerdrSessions(database, herdr, taskId, snapshot);
    for (const observation of observations) {
      if (observation.classification === "active" && isLiveHerdrStatus(observation.lifecycleStatus)) return { state: "live", role: observation.role, ...(observation.agentName ? { agentName: observation.agentName } : {}) };
    }
    const local = await isTaskTurnLive(database, config, taskId, herdr);
    return local.live ? { state: "live", ...(local.role ? { role: local.role } : {}), ...(local.agentName ? { agentName: local.agentName } : {}) } : { state: "stopped" };
  } catch {
    return { state: "unknown" };
  }
}

export async function isTaskTurnLive(
  database: ForgeDatabase,
  config: ForgeConfig,
  taskId: string,
  herdr: HerdrClient = new CliHerdrClient(),
): Promise<TaskTurnLiveness> {
  const turn = database.authQuery((db) => db.prepare(`SELECT turn.result_relative_path AS resultRelativePath, turn.execution_role AS role, turn.ledger, turn.prompt_kind AS promptKind, turn.status, turn.updated_at AS updatedAt, COALESCE(agent.status, developer.status) AS executionStatus FROM forge_herdr_turns turn
    LEFT JOIN forge_agent_executions agent ON agent.id = turn.execution_id AND turn.ledger = 'agent'
    LEFT JOIN forge_developer_executions developer ON developer.id = turn.execution_id AND turn.ledger = 'developer'
    WHERE turn.task_id = ? AND turn.ledger = 'developer'
      AND turn.turn_id = (SELECT latest.turn_id FROM forge_herdr_turns latest WHERE latest.role_session_id = turn.role_session_id ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1)
      AND turn.status IN ('dispatching', 'waiting', 'blocked', 'awaiting_human', 'validating')
    LIMIT 1`).get(taskId) as { resultRelativePath: string; role: string; ledger: "agent" | "developer"; promptKind: string; status: string; updatedAt: string; executionStatus: string | null } | undefined);
  if (turn) {
    const runtimeRoot = resolve(config.runtimeRoot);
    const resultPath = resolve(runtimeRoot, turn.resultRelativePath);
    if (resultPath.startsWith(`${runtimeRoot}/`)) {
      try {
        const schema = turnResultSchema(turn.ledger, turn.promptKind);
        if (schema?.safeParse(json(await readFile(resultPath, "utf8"), null)).success) return { live: false };
      } catch {}
    }
    const updatedAt = Date.parse(turn.updatedAt);
    if (["dispatching", "waiting"].includes(turn.status)
      && ["starting", "running"].includes(turn.executionStatus ?? "")
      && Number.isFinite(updatedAt)
      && Date.now() - updatedAt <= DISPATCH_GRACE_MS) return { live: true, role: turn.role };
  }

  const observations = await observeHerdrSessions(database, herdr, taskId);
  for (const observation of observations) {
    if (observation.classification === "active" && isLiveHerdrStatus(observation.lifecycleStatus)) {
      return { live: true, role: observation.role, ...(observation.agentName ? { agentName: observation.agentName } : {}) };
    }
    if (observation.classification === "unverifiable" && observation.agentName) {
      try {
        const agent = await herdr.getAgent(observation.agentName);
        if (isLiveHerdrStatus(agent?.status)) return { live: true, role: observation.role, agentName: observation.agentName };
      } catch {}
    }
  }
  return { live: false };
}
