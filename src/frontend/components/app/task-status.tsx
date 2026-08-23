import { CheckCircle2, CircleDashed, CircleDotDashed, CircleX, type LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

import { ACTIVE_PHASES, BLOCKED_PHASES, phaseLabel, type IssuePhase } from "../../../issue-phases.js";

const ACTIVE_INVOCATION_STATUSES = new Set(["starting", "running", "cancelling"]);
const BACKGROUND_PHASES = new Set<IssuePhase>(["releasing", "ci_waiting", "ready_reconciliation"]);
type DeliveryTarget = "local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged";

export function taskStatusLabel(phase: IssuePhase, deliveryTarget?: DeliveryTarget): string {
  if (phase === "done" && deliveryTarget === "pull_request_draft") return "Done · Draft PR";
  if (phase === "done" && deliveryTarget === "pull_request_ready") return "Done · PR ready";
  return phaseLabel(phase);
}

export function taskPresentationPhase({ phase, releaseStatus, ciOutcome, allowedCommands = [] }: { phase: IssuePhase; releaseStatus?: string | null | undefined; ciOutcome?: string | null | undefined; allowedCommands?: readonly string[] }): IssuePhase {
  if (phase === "delivery_blocked" && allowedCommands.includes("review_delivery")) return "reviewing_delivery";
  return phase === "delivery_blocked" && releaseStatus === "ready" && ciOutcome === "missing_required" ? "ci_waiting" : phase;
}

export function taskIsProcessing({ phase, agentInvocations = [], capacityStatus }: { phase: IssuePhase; agentInvocations?: ReadonlyArray<{ status: string }>; capacityStatus?: string | null | undefined }): boolean {
  if (BLOCKED_PHASES.has(phase) || ["cancelled", "done"].includes(phase)) return false;
  return BACKGROUND_PHASES.has(phase) || capacityStatus === "active" || agentInvocations.some((invocation) => ACTIVE_INVOCATION_STATUSES.has(invocation.status));
}

export function taskStatusAppearance(phase: IssuePhase): { icon: LucideIcon; iconClass: string; badge: "secondary" | "success-light" | "warning-light" | "destructive-light" | "primary-light" } {
  if (phase === "done") return { icon: CheckCircle2, iconClass: "text-emerald-500", badge: "success-light" };
  if (phase === "cancelled") return { icon: CircleX, iconClass: "text-foreground/70", badge: "secondary" };
  if (BLOCKED_PHASES.has(phase) || phase === "blocked") return { icon: CircleX, iconClass: "text-rose-500", badge: "destructive-light" };
  if (["development", "repair_required", "releasing", "merge_conflict_resolving", "ci_repair_required"].includes(phase)) return { icon: CircleDotDashed, iconClass: "text-amber-500", badge: "warning-light" };
  if (["approval", "ready_for_development", "delivery_ready", "reviewing_delivery", "delivery_reviewed", "final_review", "accepted", "ready_reconciliation", "manual_merge"].includes(phase)) return { icon: CircleDotDashed, iconClass: "text-blue-500", badge: "primary-light" };
  return { icon: ACTIVE_PHASES.has(phase) ? CircleDotDashed : CircleDashed, iconClass: "text-muted-foreground", badge: "secondary" };
}

export function TaskStatusIcon({ phase, processing = false }: { phase: IssuePhase; processing?: boolean }): ReactElement {
  const appearance = taskStatusAppearance(phase);
  const Icon = appearance.icon;
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${appearance.iconClass}${processing ? " animate-spin" : ""}`} />;
}

export function TaskStatus({ phase, presentationPhase = phase, processing = false, deliveryTarget }: { phase: IssuePhase; presentationPhase?: IssuePhase; processing?: boolean; deliveryTarget?: DeliveryTarget }): ReactElement {
  return <span data-task-status={phase} className="inline-flex items-center gap-1.5"><TaskStatusIcon phase={presentationPhase} processing={processing} /><span>{taskStatusLabel(presentationPhase, deliveryTarget)}</span></span>;
}
