import { Check, CheckCircle2, CircleDashed, CircleDotDashed, CircleX, type LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

import { ACTIVE_PHASES, PHASE_LABELS, type IssuePhase } from "../../../issue-phases.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.js";

export const ACTIVE_INVOCATION_STATUSES = new Set(["starting", "running", "cancelling"]);
const BACKGROUND_PHASES = new Set<IssuePhase>(["shipping"]);
type DeliveryTarget = "local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged";
type PullRequestState = "draft" | "ready" | "open" | "closed" | "merged" | null;
type LiveStatus = { role: string; status: string };

export function deliveryTargetLabel(deliveryTarget?: DeliveryTarget): string {
  if (deliveryTarget === "local_worktree") return "Keep in worktree";
  if (deliveryTarget === "remote_branch") return "Push branch";
  if (deliveryTarget === "pull_request_draft") return "Draft pull request";
  if (deliveryTarget === "pull_request_ready") return "Ready for review";
  if (deliveryTarget === "merged") return "Merge to base";
  return "Not specified";
}

export function taskStatusLabel(phase: IssuePhase, pendingAction?: string | null): string {
  return ACTIVE_PHASES.has(phase) && pendingAction ? `${PHASE_LABELS[phase]} · ${pendingAction}` : PHASE_LABELS[phase];
}

export function taskIsProcessing({ phase, blocked = false, agentInvocations = [], capacityStatus }: { phase: IssuePhase; blocked?: boolean; agentInvocations?: ReadonlyArray<{ status: string }>; capacityStatus?: string | null | undefined }): boolean {
  if (blocked || ["cancelled", "done"].includes(phase)) return false;
  return BACKGROUND_PHASES.has(phase) || capacityStatus === "active" || agentInvocations.some((invocation) => ACTIVE_INVOCATION_STATUSES.has(invocation.status));
}

export function taskStatusAppearance(phase: IssuePhase, blocked = false): { icon: LucideIcon; iconClass: string; badge: "secondary" | "success-light" | "warning-light" | "destructive-light" | "primary-light" } {
  if (blocked) return { icon: CircleX, iconClass: "text-rose-500", badge: "destructive-light" };
  if (phase === "done") return { icon: CheckCircle2, iconClass: "text-emerald-500", badge: "success-light" };
  if (phase === "cancelled") return { icon: CircleX, iconClass: "text-foreground/70", badge: "secondary" };
  if (["building", "shipping"].includes(phase)) return { icon: CircleDotDashed, iconClass: "text-amber-500", badge: "warning-light" };
  if (["approval", "planning", "reviewing"].includes(phase)) return { icon: CircleDotDashed, iconClass: "text-blue-500", badge: "primary-light" };
  return { icon: ACTIVE_PHASES.has(phase) ? CircleDotDashed : CircleDashed, iconClass: "text-muted-foreground", badge: "secondary" };
}

export function TaskStatusIcon({ phase, blocked = false, processing = false, pullRequestState }: { phase: IssuePhase; blocked?: boolean; processing?: boolean; pullRequestState?: PullRequestState | undefined }): ReactElement {
  if (phase === "done" && pullRequestState === "merged") return <span data-task-status-icon="merged" className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-500"><Check aria-hidden="true" className="size-2.5 text-white" strokeWidth={3} /></span>;
  const appearance = taskStatusAppearance(phase, blocked);
  const Icon = appearance.icon;
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${appearance.iconClass}${processing ? " animate-spin" : ""}`} />;
}

export function LiveStatusDot({ liveStatus }: { liveStatus: ReadonlyArray<LiveStatus> }): ReactElement | null {
  const status = liveStatus.some((entry) => entry.status === "failed") ? "failed" : liveStatus.some((entry) => entry.status === "blocked" || entry.status === "awaiting_human") ? "blocked" : liveStatus.some((entry) => entry.status === "working") ? "working" : undefined;
  if (!status) return null;
  const className = status === "working" ? "bg-emerald-500 animate-pulse" : status === "blocked" ? "bg-amber-500" : "bg-rose-500";
  return <Tooltip><TooltipTrigger render={<span data-live-status-dot={status} aria-label={liveStatus.map((entry) => `${entry.role}: ${entry.status}`).join(", ")} className={`inline-flex size-2 shrink-0 rounded-full ${className}`} />} /><TooltipContent>{liveStatus.map((entry) => <span className="block" key={`${entry.role}:${entry.status}`}>{`${entry.role.charAt(0).toUpperCase()}${entry.role.slice(1)}: ${entry.status}`}</span>)}</TooltipContent></Tooltip>;
}

export function TaskStatus({ phase, blocked = false, pendingAction, processing = false, deliveryTarget, pullRequestState }: { phase: IssuePhase; blocked?: boolean; pendingAction?: string | null; processing?: boolean; deliveryTarget?: DeliveryTarget; pullRequestState?: PullRequestState | undefined }): ReactElement {
  void deliveryTarget;
  return <span data-task-status={phase} className="inline-flex items-center gap-1.5"><TaskStatusIcon phase={phase} blocked={blocked} processing={processing} pullRequestState={pullRequestState} /><span>{taskStatusLabel(phase, pendingAction)}</span></span>;
}
