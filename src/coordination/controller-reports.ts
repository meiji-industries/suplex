import { runCommand } from "../platform/command-runner.js";
import type { TaskSession, TaskTurn } from "../tasks/control.js";
import { turnOutcome, type AdvisorRole, type VerificationRange, type WorkflowInput } from "./workflows.js";

export function turnWorkflowInput(session: TaskSession, turn: TaskTurn): WorkflowInput | null {
  return turn.workflowInput ?? session.workflowInput;
}

export function findAdvisorReport(sessions: TaskSession[], turns: TaskTurn[], reference: { turnId: string } | { sessionId: string }): { session: TaskSession; turn: TaskTurn; input: Extract<WorkflowInput, { kind: "advisor" }> } | null {
  const candidates = "turnId" in reference ? turns.filter(turn => turn.id === reference.turnId) : turns.filter(turn => turn.sessionId === reference.sessionId).reverse();
  for (const turn of candidates) {
    const session = sessions.find(candidate => candidate.id === turn.sessionId);
    if (!session?.advisorRole || turn.status !== "completed") continue;
    const input = turnWorkflowInput(session, turn);
    const outcome = turnOutcome(turn.terminalObservation).advisor;
    if (input?.kind === "advisor" && outcome?.result && outcome.role === session.advisorRole) return { session, turn, input };
  }
  return null;
}

export function resolveAdvisorReport(sessions: TaskSession[], turns: TaskTurn[], role: AdvisorRole, reference: { turnId: string } | { sessionId: string }): { session: TaskSession; turn: TaskTurn; input: Extract<WorkflowInput, { kind: "advisor" }> } | null {
  const report = findAdvisorReport(sessions, turns, reference);
  return report?.session.advisorRole === role && report.input.role === role ? report : null;
}

export function parseObservation(observation: string | null): { state: string | null; text: string | null; tools: unknown[] | null; toolsLimit: string | null; verificationRange: VerificationRange | null } {
  const outcome = turnOutcome(observation);
  try {
    const parsed = observation ? JSON.parse(observation) as { tools?: unknown[]; toolsLimit?: string | null; verificationRange?: VerificationRange } : {};
    return { state: outcome.state, text: outcome.text, tools: Array.isArray(parsed.tools) ? parsed.tools : null, toolsLimit: parsed.toolsLimit ?? null, verificationRange: parsed.verificationRange ?? null };
  } catch { return { state: outcome.state, text: outcome.text, tools: null, toolsLimit: null, verificationRange: null }; }
}

export function summarizeWorkerObservation(turn: TaskTurn): unknown {
  const parsed = parseObservation(turn.terminalObservation);
  return { turnId: turn.id, state: parsed.state, text: parsed.text, evidence: { operation: "read_worker_evidence", toolsStored: parsed.tools !== null, limitation: parsed.toolsLimit }, verificationRange: parsed.verificationRange };
}

export async function observeWorktree(path: string): Promise<unknown> {
  try {
    const [head, dirty] = await Promise.all([
      runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", path, "rev-parse", "HEAD"] }),
      runCommand({ taskId: null, stepId: null, command: "git", args: ["-C", path, "status", "--porcelain"] }),
    ]);
    return { headSha: head.stdout.trim(), dirty: dirty.stdout.trim().length > 0 };
  } catch (error) { return { state: "unknown", error: error instanceof Error ? error.message : "Git observation failed" }; }
}
