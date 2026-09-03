import type { AttentionCard, AttentionChoice, FailureClass } from "./convergence.js";
import { commandLabel, RESTART_LABELS } from "../frontend/lib/command-labels.js";

export type AttentionCondition =
  | { kind: "github_credential"; detail?: string }
  | { kind: "worktree_missing"; worktreePath: string | null; branchName: string | null }
  | { kind: "missing_turn_outcome"; role: "lead" | "developer"; dirty: boolean; evidenceRef?: string }
  | { kind: "product_decision"; question: string; choices: [AttentionChoice, AttentionChoice, ...AttentionChoice[]]; recommendedChoiceId: string; evidenceRef?: string }
  | { kind: "dirty_worktree_cleanup"; dirtyFileCount: number; worktreePath: string }
  | { kind: "no_progress"; failureClass: FailureClass; signature: string; evidenceRef?: string };

export interface AttentionBlocker {
  category?: unknown;
  summary?: unknown;
  actions?: unknown;
}

export interface AttentionCardContext {
  summary?: string | null;
  pendingAction?: string | null;
  actions?: Array<{ command: string; label: string; requiresNote?: boolean; destructive?: boolean }>;
  mergeDecision?: unknown;
}

function shortTitle(value: string): string {
  return value.trim().replaceAll("_", " ").slice(0, 80) || "Needs attention";
}

function withRestartLabel(card: AttentionCard): AttentionCard {
  return { ...card, primaryAction: { ...card.primaryAction, label: RESTART_LABELS[card.primaryAction.command] ?? commandLabel(card.primaryAction.command) } };
}

function genericCard(summary: string | null | undefined, context: AttentionCardContext): AttentionCard {
  const primary = context.actions?.find((action) => !action.destructive);
  const cancel = context.actions?.find((action) => action.command === "cancel_issue");
  const explanation = summary || context.pendingAction || "This task needs your input.";
  return { kind: "generic", title: shortTitle(context.pendingAction || "Needs attention"), explanation, evidence: [{ kind: "text", ref: explanation }], primaryAction: primary ? { command: primary.command, label: primary.label, ...(primary.requiresNote ? { requiresNote: true } : {}) } : { command: "continue_work", label: "Open the pane and answer" }, ...(cancel ? { secondaryAction: { command: cancel.command, label: cancel.label, destructive: true } } : {}) };
}

function decision(value: unknown): AttentionCondition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as { question?: unknown; choices?: unknown; recommendedChoiceId?: unknown };
  if (typeof input.question !== "string" || !Array.isArray(input.choices) || input.choices.length < 2 || typeof input.recommendedChoiceId !== "string") return undefined;
  const choices = input.choices.flatMap((choice): AttentionChoice[] => typeof choice === "object" && choice !== null && typeof (choice as { id?: unknown }).id === "string" && typeof (choice as { label?: unknown }).label === "string" && typeof (choice as { detail?: unknown }).detail === "string" ? [{ id: (choice as { id: string }).id, label: (choice as { label: string }).label, description: (choice as { detail: string }).detail }] : []);
  return choices.length >= 2 ? { kind: "product_decision", question: input.question, choices: choices as [AttentionChoice, AttentionChoice, ...AttentionChoice[]], recommendedChoiceId: input.recommendedChoiceId } : undefined;
}

export function attentionCardFromBlocker(blocker: AttentionBlocker | undefined, context: AttentionCardContext = {}): AttentionCard {
  const summary = typeof blocker?.summary === "string" && blocker.summary.trim() ? blocker.summary.trim() : context.summary || context.pendingAction;
  const category = typeof blocker?.category === "string" ? blocker.category : "";
  if (category === "member_authorization" && /startup|trust the contents of this directory/i.test(summary || "")) {
    const primary = context.actions?.find((action) => !action.destructive);
    const cancel = context.actions?.find((action) => action.command === "cancel_issue");
    const trust = /trust the contents of this directory/i.test(summary || "");
    const repository = (summary || "").match(/(?:repository root:?\s*|in\s+)(\/[^\s]+)/i)?.[1];
    return {
      kind: trust ? "github_credential" : "generic",
      title: trust ? "Codex needs this repository trusted" : "Agent is waiting at a startup prompt",
      explanation: trust
        ? `Codex is asking whether to trust ${repository || "this repository"}. Answer 'Yes, continue' in the agent pane (or add the repository to ~/.codex/config.toml), then retry.`
        : "The agent is waiting at a startup prompt. Answer it in the agent pane, then retry.",
      evidence: [{ kind: "text", ref: summary || "Agent is waiting at a startup prompt." }],
      primaryAction: primary ? { command: primary.command, label: primary.label, ...(primary.requiresNote ? { requiresNote: true } : {}) } : { command: "retry_development", label: "Retry the Builder turn" },
      ...(cancel ? { secondaryAction: { command: cancel.command, label: cancel.label, destructive: true } } : {}),
    };
  }
  if (category === "provider_authentication") return attentionCardFor({ kind: "github_credential", ...(summary ? { detail: summary } : {}) });
  if (/already checked out/i.test(summary || "")) {
    const cancel = context.actions?.find((action) => action.command === "cancel_issue");
    const retry = context.actions?.find((action) => action.command === "retry_development");
    return {
      kind: "generic",
      title: "Another task owns this branch",
      explanation: summary || "Another task already owns this branch.",
      evidence: [{ kind: "text", ref: summary || "Another task already owns this branch." }],
      primaryAction: cancel ? { command: cancel.command, label: "Cancel this duplicate task", destructive: true } : { command: "cancel_issue", label: "Cancel this duplicate task", destructive: true },
      secondaryAction: retry ? { command: retry.command, label: "Retry when the other task is complete" } : { command: "retry_development", label: "Retry when the other task is complete" },
    };
  }
  if (category === "member_decision") { const mergeDecision = decision(context.mergeDecision); if (mergeDecision) return attentionCardFor(mergeDecision); }
  if (category === "member_decision" || category === "provider_ambiguity") {
    const choices = Array.isArray(blocker?.actions) ? blocker.actions.flatMap((action, index): AttentionChoice[] => typeof action === "object" && action !== null && typeof (action as { label?: unknown }).label === "string" ? [{ id: typeof (action as { id?: unknown }).id === "string" ? (action as { id: string }).id : `choice-${index + 1}`, label: (action as { label: string }).label, description: typeof (action as { description?: unknown }).description === "string" ? (action as { description: string }).description : "Choose this behavior." }] : typeof action === "string" ? [{ id: `choice-${index + 1}`, label: action, description: "Choose this behavior." }] : []) : [];
    if (choices.length >= 2) return attentionCardFor({ kind: "product_decision", question: summary || "Choose how this issue should behave.", choices: choices as [AttentionChoice, AttentionChoice, ...AttentionChoice[]], recommendedChoiceId: choices[0]!.id });
  }
  if (context.actions?.some((action) => action.label === "Recreate the worktree and resume")) return attentionCardFor({ kind: "worktree_missing", worktreePath: null, branchName: null });
  if (context.actions?.some((action) => action.label === "Discard the changes and delete the worktree")) return attentionCardFor({ kind: "dirty_worktree_cleanup", dirtyFileCount: 1, worktreePath: "Recorded worktree" });
  const deliveryDecision = context.actions?.find((action) => action.command === "record_delivery_decision");
  if (category === "agent_exhausted" && deliveryDecision) {
    const cancel = context.actions?.find((action) => action.command === "cancel_issue");
    const explanation = "The review found blocking problems. The Builder made repairs but did not fix them. Read the review findings. Then accept the delivery as is, or cancel the task.";
    return {
      kind: "generic",
      title: "The review problems are not fixed",
      explanation,
      evidence: [{ kind: "text", ref: summary || explanation }],
      primaryAction: { command: deliveryDecision.command, label: deliveryDecision.label, ...(deliveryDecision.requiresNote ? { requiresNote: true } : {}) },
      ...(cancel ? { secondaryAction: { command: cancel.command, label: cancel.label, destructive: true } } : {}),
    };
  }
  if (summary?.startsWith("Automatic repair is not making progress") || summary?.startsWith("Automatic continuation is not making progress") || category === "agent_exhausted" || category === "verification_unrecoverable") return attentionCardFor({ kind: "no_progress", failureClass: "code_failure", signature: summary || "Automatic repair needs your input." });
  const resume = context.actions?.find((action) => action.label === "Resume the Builder turn" || action.label === "Resume the Planner turn");
  if (resume) return attentionCardFor({ kind: "missing_turn_outcome", role: resume.label.includes("Planner") ? "lead" : "developer", dirty: false });
  return genericCard(summary, context);
}

export function attentionCardFor(condition: AttentionCondition, overrides?: Partial<AttentionCard>): AttentionCard {
  const card = (() => {
    switch (condition.kind) {
      case "github_credential": return { kind: condition.kind, title: "GitHub sign-in is necessary", explanation: condition.detail || "Forge needs permission to continue the GitHub step.", evidence: [{ kind: "text" as const, ref: condition.detail || "GitHub authentication is not available." }], primaryAction: { command: "reconcile_ci", label: "Sign in to GitHub and retry" } };
      case "worktree_missing": return { kind: condition.kind, title: "The local worktree is missing", explanation: "The local worktree for this task is not available.", evidence: [{ kind: "text" as const, ref: condition.worktreePath || condition.branchName || "Forge did not find the recorded worktree." }], primaryAction: { command: "recreate_worktree", label: "Recreate the worktree and resume" } };
      case "missing_turn_outcome": { const role = condition.role === "lead" ? "Planner" : "Builder"; return { kind: condition.kind, title: `${role} turn ended without an outcome`, explanation: condition.dirty ? "The Builder turn ended with uncommitted changes that you must review." : `The ${role} turn ended before recording an outcome.`, evidence: [{ kind: "text" as const, ref: condition.evidenceRef || (condition.dirty ? "Uncommitted changes remain in the worktree." : "Forge did not record a valid turn outcome.") }], primaryAction: { command: condition.role === "developer" ? "retry_development" : "continue_work", label: `Resume the ${role} turn` }, secondaryAction: { command: "cancel_issue", label: "Cancel the task", destructive: true } }; }
      case "product_decision": return { kind: condition.kind, title: "A decision is necessary", explanation: condition.question, evidence: [{ kind: "text" as const, ref: condition.evidenceRef || condition.question }], primaryAction: { command: "send_planner_note", label: "Select a behavior", requiresNote: true }, decision: { choices: condition.choices, recommendedChoiceId: condition.recommendedChoiceId, freeTextPrompt: "Add more information for the Planner (optional)." } };
      case "dirty_worktree_cleanup": return { kind: condition.kind, title: "Discard the uncommitted changes?", explanation: `${condition.dirtyFileCount} uncommitted ${condition.dirtyFileCount === 1 ? "file needs" : "files need"} a decision before cleanup.`, evidence: [{ kind: "artifact" as const, ref: condition.worktreePath, label: "Worktree" }], primaryAction: { command: "delete_worktree", label: "Discard the changes and delete the worktree", destructive: true }, secondaryAction: { command: "continue_work", label: "Keep the worktree" } };
      case "no_progress": { const merge = condition.failureClass === "merge_conflict_mechanical"; return { kind: condition.kind, title: "Automatic repair does not make progress", explanation: "The same repair problem occurred again. There is no new evidence of progress.", evidence: [{ kind: "text" as const, ref: condition.evidenceRef || condition.signature || "The repair occurred again with no new progress." }], primaryAction: merge ? { command: "resolve_merge_conflict", label: "Resume the conflict resolution" } : { command: "retry_development", label: "Resume the Builder turn" }, secondaryAction: { command: "cancel_issue", label: "Cancel the task", destructive: true } }; }
    }
  })();
  return withRestartLabel({ ...card, ...overrides });
}
