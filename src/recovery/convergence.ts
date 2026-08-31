import { sha256Hex } from "../engine/deterministic-id.js";
import { attentionCardFor } from "./attention-card.js";

export type RecoveryAction = "advance" | "resume" | "retry" | "repair" | "attention" | "no_change";
export type RuntimeDiagnosis = "working" | "resting" | "blocked" | "result_missing" | "recovering_runtime" | "runtime_unavailable" | "identity_conflict" | "unknown";
export type FailureClass = "transient_infrastructure" | "rate_limited" | "credential_missing" | "code_failure" | "ci_failure" | "merge_conflict_mechanical" | "product_ambiguity" | "missing_delivery_evidence" | "worktree_missing_active" | "dirty_worktree" | "no_progress";
export const FAILURE_CLASS_ACTION: Record<FailureClass, "retry" | "repair" | "attention"> = { transient_infrastructure: "retry", rate_limited: "retry", code_failure: "repair", ci_failure: "repair", merge_conflict_mechanical: "repair", credential_missing: "attention", product_ambiguity: "attention", missing_delivery_evidence: "attention", worktree_missing_active: "attention", dirty_worktree: "attention", no_progress: "attention" };
export type TurnStatus = "created" | "dispatching" | "waiting" | "blocked" | "awaiting_human" | "validating" | "completed" | "correction_required" | "failed";
export interface DurableTaskFacts { taskId: string; phase: string; revision: number; terminal: boolean; cancelled: boolean; branchName: string | null; worktreePath: string | null; lastReviewedCommit: string | null; turn: null | { turnId: string; role: "planner" | "builder" | "reviewer" | "integrator"; status: TurnStatus; resultPresent: boolean; resultValid: boolean; resumeRequestsSent: number }; failure: null | { class: FailureClass; signature: string; newCommitSinceFailure: boolean; newDiagnosticSinceFailure: boolean }; }
export interface LiveObservations { herdr: { session: "live_progress" | "live_idle" | "live_blocked" | "terminal" | "missing" | "unavailable" | "identity_conflict"; stalledBeyondPolicy: boolean }; git: null | { worktreePresent: boolean; onRecordedBranch: boolean; dirty: boolean; headCommit: string | null }; github: null | { headSha: string | null; merged: boolean; closed: boolean; checks: "passed" | "failed" | "pending" | "none"; authenticated: boolean }; }
export interface AttentionChoice { id: string; label: string; description: string }
export interface AttentionAction { command: string; label: string; destructive?: boolean | undefined; requiresNote?: boolean | undefined }
export interface AttentionCard { kind: "github_credential" | "worktree_missing" | "missing_turn_outcome" | "product_decision" | "dirty_worktree_cleanup" | "no_progress" | "generic"; title: string; explanation: string; evidence: Array<{ kind: "artifact" | "url" | "text"; ref: string; label?: string | undefined }>; primaryAction: AttentionAction; secondaryAction?: AttentionAction | undefined; decision?: { choices: AttentionChoice[]; recommendedChoiceId: string; freeTextPrompt: string } | undefined; }
export interface RecoveryOutcome { diagnosis: RuntimeDiagnosis; action: RecoveryAction; idempotencyKey: string; evidence: string[]; reason: string; failureClass?: FailureClass; attention?: AttentionCard; }

function diagnosis(facts: DurableTaskFacts, live: LiveObservations): RuntimeDiagnosis {
  if (live.herdr.session === "identity_conflict") return "identity_conflict";
  if (live.herdr.session === "unavailable") return "runtime_unavailable";
  if (!facts.turn) {
    if (live.herdr.session === "live_progress") return "identity_conflict";
    if (live.herdr.session === "live_blocked") return "blocked";
    if (live.herdr.session === "live_idle" || live.herdr.session === "terminal") return "resting";
    return "unknown";
  }
  if (live.herdr.session === "live_blocked") return "blocked";
  if (live.herdr.session === "live_progress") return "working";
  if (live.herdr.session === "live_idle" || live.herdr.session === "terminal") return facts.turn.resultValid ? "working" : "result_missing";
  if (live.herdr.session === "missing") return "recovering_runtime";
  return "unknown";
}

function outcome(facts: DurableTaskFacts, live: LiveObservations, action: RecoveryAction, reason: string, evidence: string[], failureClass?: FailureClass, attention?: AttentionCard): RecoveryOutcome {
  const key = `${facts.taskId}|${facts.revision}|${action}|${facts.turn?.turnId ?? ""}|${live.git?.headCommit ?? ""}|${live.github?.headSha ?? ""}|${facts.failure?.signature ?? ""}`;
  return { diagnosis: diagnosis(facts, live), action, idempotencyKey: sha256Hex(key), evidence, reason, ...(failureClass ? { failureClass } : {}), ...(attention ? { attention } : {}) };
}
function failureCard(facts: DurableTaskFacts): AttentionCard {
  const failure = facts.failure!;
  switch (failure.class) {
    case "credential_missing": return attentionCardFor({ kind: "github_credential", detail: failure.signature });
    case "product_ambiguity": return attentionCardFor({ kind: "product_decision", question: failure.signature || "Choose how this issue should behave.", choices: [{ id: "continue", label: "Continue", description: "Use the current approach." }, { id: "revise", label: "Revise", description: "Use a different approach." }], recommendedChoiceId: "continue" });
    case "dirty_worktree": return attentionCardFor({ kind: "dirty_worktree_cleanup", dirtyFileCount: 1, worktreePath: facts.worktreePath || "Recorded worktree" });
    case "worktree_missing_active": return attentionCardFor({ kind: "worktree_missing", worktreePath: facts.worktreePath, branchName: facts.branchName });
    case "no_progress": return attentionCardFor({ kind: "no_progress", failureClass: failure.class, signature: failure.signature });
    case "transient_infrastructure":
    case "rate_limited":
    case "code_failure":
    case "ci_failure":
    case "merge_conflict_mechanical":
    case "missing_delivery_evidence": return attentionCardFor({ kind: "missing_turn_outcome", role: facts.turn?.role === "builder" || facts.turn?.role === "integrator" ? "developer" : "lead", dirty: false, evidenceRef: failure.signature });
  }
}
export function classifyRecovery(facts: DurableTaskFacts, live: LiveObservations): RecoveryOutcome {
  if (facts.terminal || facts.cancelled) return outcome(facts, live, "no_change", "This task is terminal and remains history only.", ["task:terminal"]);
  if (facts.turn?.resultValid) return outcome(facts, live, "advance", "The current turn recorded a valid outcome.", [`turn:${facts.turn.turnId} result valid`]);
  if (!facts.turn && live.herdr.session === "live_progress") return outcome(facts, live, "attention", "A live runtime has no pending Forge turn. Forge will not adopt it automatically.", ["herdr:orphan"], "missing_delivery_evidence");
  if (live.herdr.session === "identity_conflict") return outcome(facts, live, "attention", "The observed runtime does not match its Forge binding. Forge will not adopt it automatically.", ["herdr:identity conflict"], "missing_delivery_evidence");
  if (facts.turn && live.herdr.session === "live_blocked") return outcome(facts, live, "attention", "The agent is blocked and needs human input.", ["herdr:blocked"]);
  if ((facts.turn?.role === "builder" || facts.turn?.role === "integrator") && live.git?.worktreePresent && live.git.onRecordedBranch && !live.git.dirty && live.git.headCommit && live.git.headCommit !== facts.lastReviewedCommit) return outcome(facts, live, "advance", "A clean Developer commit is ready for Lead review.", [`handoff:git ${live.git.headCommit}`]);
  if (facts.turn && (live.herdr.session === "terminal" || live.herdr.session === "live_idle") && !facts.turn.resultValid) {
    const dirty = Boolean(live.git?.dirty);
    return outcome(facts, live, "attention", "STE100: The agent stopped before recording the required result. Forge is waiting for a recorded result.", ["turn:outcome missing", ...(dirty ? ["git:dirty"] : [])], "missing_delivery_evidence", attentionCardFor({ kind: "missing_turn_outcome", role: facts.turn.role === "builder" || facts.turn.role === "integrator" ? "developer" : "lead", dirty }));
  }
  if (facts.turn && live.herdr.session === "missing") return outcome(facts, live, "resume", "The exact Forge-bound runtime is missing and will be recreated idempotently.", ["herdr:binding missing"]);
  if (live.git && !live.git.worktreePresent) return outcome(facts, live, "attention", "The active task worktree is missing.", ["git:worktree missing"], "worktree_missing_active", attentionCardFor({ kind: "worktree_missing", worktreePath: facts.worktreePath, branchName: facts.branchName }));
  if (live.github?.authenticated === false) return outcome(facts, live, "attention", "GitHub authentication is required to continue.", ["github:unauthenticated"], "credential_missing", attentionCardFor({ kind: "github_credential" }));
  if (facts.failure) {
    const repeatedRepair = !facts.failure.newCommitSinceFailure && !facts.failure.newDiagnosticSinceFailure && ["code_failure", "ci_failure", "merge_conflict_mechanical"].includes(facts.failure.class) && facts.failure.signature.length > 0;
    if (facts.failure.class === "no_progress" || repeatedRepair) { const failureClass: FailureClass = "no_progress"; return outcome(facts, live, "attention", "Automatic repair is not making progress.", [`failure:${facts.failure.signature}`], failureClass, attentionCardFor({ kind: "no_progress", failureClass: facts.failure.class, signature: facts.failure.signature })); }
    const action = FAILURE_CLASS_ACTION[facts.failure.class]; return outcome(facts, live, action, "The recorded failure determines the next recovery step.", [`failure:${facts.failure.signature}`], facts.failure.class, action === "attention" ? failureCard(facts) : undefined);
  }
  if (live.herdr.session === "live_progress" || live.herdr.session === "live_blocked" || live.herdr.session === "live_idle") return outcome(facts, live, "no_change", "The observed runtime needs no recovery action.", [`herdr:${live.herdr.session}`]);
  if (live.herdr.session === "unavailable") return outcome(facts, live, "retry", "Herdr is temporarily unavailable; Forge will retry observation only.", ["herdr:unavailable"], "transient_infrastructure");
  return outcome(facts, live, "no_change", "No recovery action is currently needed.", [`herdr:${live.herdr.session}`]);
}
