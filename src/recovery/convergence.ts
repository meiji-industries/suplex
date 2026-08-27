import { sha256Hex } from "../temporal/deterministic-id.js";
import { attentionCardFor } from "./attention-card.js";

export type RecoveryAction = "advance" | "resume" | "retry" | "repair" | "attention" | "no_change";
export type FailureClass = "transient_infrastructure" | "rate_limited" | "credential_missing" | "code_failure" | "ci_failure" | "merge_conflict_mechanical" | "product_ambiguity" | "missing_delivery_evidence" | "worktree_missing_active" | "dirty_worktree" | "no_progress";
export const FAILURE_CLASS_ACTION: Record<FailureClass, "retry" | "repair" | "attention"> = { transient_infrastructure: "retry", rate_limited: "retry", code_failure: "repair", ci_failure: "repair", merge_conflict_mechanical: "repair", credential_missing: "attention", product_ambiguity: "attention", missing_delivery_evidence: "attention", worktree_missing_active: "attention", dirty_worktree: "attention", no_progress: "attention" };
export type TurnStatus = "created" | "dispatching" | "waiting" | "blocked" | "awaiting_human" | "validating" | "completed" | "correction_required" | "failed";
export interface DurableTaskFacts { taskId: string; phase: string; revision: number; terminal: boolean; cancelled: boolean; branchName: string | null; worktreePath: string | null; lastReviewedCommit: string | null; turn: null | { turnId: string; role: "lead" | "developer"; status: TurnStatus; resultPresent: boolean; resultValid: boolean; resumeRequestsSent: number }; failure: null | { class: FailureClass; signature: string; newCommitSinceFailure: boolean; newDiagnosticSinceFailure: boolean }; }
export interface LiveObservations { herdr: { session: "live_progress" | "live_idle" | "live_blocked" | "terminal" | "missing" | "unavailable"; stalledBeyondPolicy: boolean }; git: null | { worktreePresent: boolean; onRecordedBranch: boolean; dirty: boolean; headCommit: string | null }; github: null | { headSha: string | null; merged: boolean; closed: boolean; checks: "passed" | "failed" | "pending" | "none"; authenticated: boolean }; }
export interface AttentionChoice { id: string; label: string; description: string }
export interface AttentionAction { command: string; label: string; destructive?: boolean | undefined; requiresNote?: boolean | undefined }
export interface AttentionCard { kind: "github_credential" | "worktree_missing" | "missing_turn_outcome" | "product_decision" | "dirty_worktree_cleanup" | "no_progress" | "generic"; title: string; explanation: string; evidence: Array<{ kind: "artifact" | "url" | "text"; ref: string; label?: string | undefined }>; primaryAction: AttentionAction; secondaryAction?: AttentionAction | undefined; decision?: { choices: AttentionChoice[]; recommendedChoiceId: string; freeTextPrompt: string } | undefined; }
export interface RecoveryOutcome { action: RecoveryAction; idempotencyKey: string; evidence: string[]; reason: string; failureClass?: FailureClass; attention?: AttentionCard; }

function outcome(facts: DurableTaskFacts, live: LiveObservations, action: RecoveryAction, reason: string, evidence: string[], failureClass?: FailureClass, attention?: AttentionCard): RecoveryOutcome {
  const key = `${facts.taskId}|${facts.revision}|${action}|${facts.turn?.turnId ?? ""}|${live.git?.headCommit ?? ""}|${live.github?.headSha ?? ""}|${facts.failure?.signature ?? ""}`;
  return { action, idempotencyKey: sha256Hex(key), evidence, reason, ...(failureClass ? { failureClass } : {}), ...(attention ? { attention } : {}) };
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
    case "missing_delivery_evidence": return attentionCardFor({ kind: "missing_turn_outcome", role: facts.turn?.role || "developer", dirty: false, evidenceRef: failure.signature });
  }
}
export function classifyRecovery(facts: DurableTaskFacts, live: LiveObservations): RecoveryOutcome {
  if (facts.terminal || facts.cancelled) return outcome(facts, live, "no_change", "This task is terminal and remains history only.", ["task:terminal"]);
  if (facts.turn?.resultValid) return outcome(facts, live, "advance", "The current turn recorded a valid outcome.", [`turn:${facts.turn.turnId} result valid`]);
  if (facts.turn?.role === "developer" && live.git?.worktreePresent && live.git.onRecordedBranch && !live.git.dirty && live.git.headCommit && live.git.headCommit !== facts.lastReviewedCommit) return outcome(facts, live, "advance", "A clean Developer commit is ready for Lead review.", [`handoff:git ${live.git.headCommit}`]);
  if (facts.turn?.role === "lead" && (live.herdr.session === "terminal" || live.herdr.session === "live_idle") && facts.turn.resumeRequestsSent === 0) return outcome(facts, live, "resume", "Ask the existing Lead session to record its outcome.", ["herdr:lead idle"]);
  if (facts.turn && (live.herdr.session === "terminal" || live.herdr.session === "missing") && !facts.turn.resultValid && ((facts.turn.role === "developer" && (live.git?.dirty || !live.git?.headCommit || live.git.headCommit === facts.lastReviewedCommit)) || (facts.turn.role === "lead" && facts.turn.resumeRequestsSent >= 1))) {
    const dirty = Boolean(live.git?.dirty); return outcome(facts, live, "attention", dirty ? "The Developer turn ended with uncommitted changes." : "The turn ended without a durable outcome.", ["turn:outcome missing", ...(dirty ? ["git:dirty"] : [])], "missing_delivery_evidence", attentionCardFor({ kind: "missing_turn_outcome", role: facts.turn.role, dirty }));
  }
  if (live.git && !live.git.worktreePresent) return outcome(facts, live, "attention", "The active task worktree is missing.", ["git:worktree missing"], "worktree_missing_active", attentionCardFor({ kind: "worktree_missing", worktreePath: facts.worktreePath, branchName: facts.branchName }));
  if (live.github?.authenticated === false) return outcome(facts, live, "attention", "GitHub authentication is required to continue.", ["github:unauthenticated"], "credential_missing", attentionCardFor({ kind: "github_credential" }));
  if (facts.failure) {
    const repeatedRepair = !facts.failure.newCommitSinceFailure && !facts.failure.newDiagnosticSinceFailure && ["code_failure", "ci_failure", "merge_conflict_mechanical"].includes(facts.failure.class) && facts.failure.signature.length > 0;
    if (facts.failure.class === "no_progress" || repeatedRepair) { const failureClass: FailureClass = "no_progress"; return outcome(facts, live, "attention", "Automatic repair is not making progress.", [`failure:${facts.failure.signature}`], failureClass, attentionCardFor({ kind: "no_progress", failureClass: facts.failure.class, signature: facts.failure.signature })); }
    const action = FAILURE_CLASS_ACTION[facts.failure.class]; return outcome(facts, live, action, "The recorded failure determines the next recovery step.", [`failure:${facts.failure.signature}`], facts.failure.class, action === "attention" ? failureCard(facts) : undefined);
  }
  if (live.herdr.session === "live_progress" || live.herdr.session === "live_blocked") return outcome(facts, live, "no_change", "An agent session is active.", [`herdr:${live.herdr.session}`]);
  if (live.herdr.session === "live_idle") return outcome(facts, live, live.herdr.stalledBeyondPolicy ? "resume" : "no_change", live.herdr.stalledBeyondPolicy ? "The idle session exceeded the resume policy." : "The idle session is still within policy.", ["herdr:live_idle"]);
  if (live.herdr.session === "unavailable") return outcome(facts, live, "retry", "Herdr is temporarily unavailable.", ["herdr:unavailable"], "transient_infrastructure");
  return outcome(facts, live, "no_change", "No recovery action is currently needed.", [`herdr:${live.herdr.session}`]);
}
