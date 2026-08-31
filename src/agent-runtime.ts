import type { ForgeDatabase } from "./database.js";
import { observeHerdrSessions, type HerdrSessionObservation } from "./herdr-recovery.js";
import { type HerdrClient, snapshotHerdrRuntime } from "./herdr-client.js";
import { classifyRecovery, type RuntimeDiagnosis } from "./recovery/convergence.js";

export interface AgentRuntimeProjection {
  agentId: string;
  taskId: string;
  role: "planner" | "builder" | "reviewer" | "integrator";
  diagnosis: RuntimeDiagnosis;
  detail: string;
}

type RuntimeRow = {
  agentId: string; taskId: string; sessionId: string; role: AgentRuntimeProjection["role"]; paneId: string | null;
  phase: string; revision: number; turnId: string | null; turnStatus: "created" | "dispatching" | "waiting" | "blocked" | "awaiting_human" | "validating" | "completed" | "correction_required" | "failed" | null; promptSentAt: string | null; resultHash: string | null;
};

function live(observation: HerdrSessionObservation | undefined, unavailable: boolean) {
  if (unavailable) return { session: "unavailable" as const, stalledBeyondPolicy: false };
  if (!observation || observation.classification === "missing" || observation.classification === "unbound") return { session: "missing" as const, stalledBeyondPolicy: false };
  if (observation.identityFailure) return { session: "identity_conflict" as const, stalledBeyondPolicy: false };
  if (observation.lifecycleStatus === "blocked") return { session: "live_blocked" as const, stalledBeyondPolicy: false };
  if (observation.lifecycleStatus === "idle") return { session: "live_idle" as const, stalledBeyondPolicy: false };
  if (observation.lifecycleStatus === "done" || observation.lifecycleStatus === "cancelled") return { session: "terminal" as const, stalledBeyondPolicy: false };
  return { session: "live_progress" as const, stalledBeyondPolicy: false };
}

export async function projectAgentRuntime(database: ForgeDatabase, herdr: HerdrClient, agentIds: readonly string[], companyIds?: readonly string[]): Promise<AgentRuntimeProjection[]> {
  if (!agentIds.length || companyIds?.length === 0) return [];
  const companyScope = companyIds ? ` AND task.company_id IN (${companyIds.map(() => "?").join(",")})` : "";
  const rows = database.authQuery((db) => db.prepare(`SELECT json_extract(task.role_agents_json, '$.' || session.session_role) AS agentId, task.id AS taskId, session.id AS sessionId, session.session_role AS role, session.pane_id AS paneId, projection.phase, projection.revision,
    turn.turn_id AS turnId, turn.status AS turnStatus, turn.prompt_sent_at AS promptSentAt, turn.result_sha256 AS resultHash
    FROM forge_herdr_role_sessions session
    JOIN forge_tasks task ON task.id = session.task_id
    JOIN forge_issue_projections projection ON projection.task_id = task.id
    LEFT JOIN forge_herdr_turns turn ON turn.role_session_id = session.id AND turn.turn_id = (SELECT latest.turn_id FROM forge_herdr_turns latest WHERE latest.role_session_id = session.id ORDER BY latest.created_at DESC, latest.correction_index DESC, latest.turn_id DESC LIMIT 1)
    WHERE session.is_current = 1 AND projection.phase NOT IN ('done', 'cancelled', 'failed')
      AND json_extract(task.role_agents_json, '$.' || session.session_role) IN (${agentIds.map(() => "?").join(",")})${companyScope}
    ORDER BY task.id, session.session_role`).all(...agentIds, ...(companyIds ?? [])) as RuntimeRow[]);
  let observations: HerdrSessionObservation[] = [];
  let unavailable = false;
  try {
    observations = await observeHerdrSessions(database, herdr, undefined, await snapshotHerdrRuntime(herdr));
  } catch {
    unavailable = true;
  }
  const bySession = new Map(observations.map((observation) => [observation.sessionId, observation]));
  return rows.map((row) => {
    const diagnosis = classifyRecovery({ taskId: row.taskId, phase: row.phase, revision: row.revision, terminal: false, cancelled: false, branchName: null, worktreePath: null, lastReviewedCommit: null, turn: row.turnId && row.turnStatus && row.promptSentAt ? { turnId: row.turnId, role: row.role, status: row.turnStatus, resultPresent: row.resultHash !== null, resultValid: row.resultHash !== null, resumeRequestsSent: 0 } : null, failure: null }, { herdr: live(bySession.get(row.sessionId), unavailable), git: null, github: null });
    return { agentId: row.agentId, taskId: row.taskId, role: row.role, diagnosis: diagnosis.diagnosis, detail: diagnosis.reason };
  });
}
