import { File } from "@pierre/diffs/react";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button, buttonVariants } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.js";
import { Collapsible } from "../components/ui/collapsible.js";
import { Field, FieldLabel } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { ApplicationFrame } from "../components/app/application-frame.js";
import { getWorkerHealthFailure, useSystemHealth } from "../components/app/system-health.js";
import { TaskActivity } from "../components/app/task-history.js";
import DeveloperDiff, { useAppThemeType } from "../components/app/developer-diff.js";
import { TaskLeadPlan } from "../components/app/task-lead-plan.js";
import { invocationActorLabel, workflowOwnerLabel } from "../components/app/task-invocations.js";
import { TaskProgress } from "../components/app/task-progress.js";
import { taskIsProcessing, taskPresentationPhase, TaskStatus } from "../components/app/task-status.js";
import { DeveloperRecoveryStatus } from "../components/app/developer-recovery-status.js";
import type { DeveloperRecoveryAction } from "../components/app/developer-recovery-actions.js";
import { PlanBlockerResponseForm } from "../components/app/plan-blocker-response-form.js";
import { PlanDecisionForm } from "../components/app/plan-decision-form.js";
import { SupplementalReviewPanel } from "../components/app/supplemental-review-panel.js";
import { ProfileAvatar } from "../components/app/profile-avatar.js";
import { DeveloperEvidence, type DeveloperExecutionEventView } from "../components/tasks/developer-evidence.js";
import { adminDate, type ApiAgent, type ApiCi, type ApiProject, type ApiTask } from "../lib/view-shared.js";
import { readJson, withCompany } from "../lib/api.js";
import type { IssueCommandSlug } from "../../commands/registry.js";
import { BLOCKED_PHASES, phaseLabel } from "../../issue-phases.js";
import { releaseFailureCopy } from "../../release-failures.js";
import { Check, Copy, Ellipsis, ExternalLink, GitPullRequest, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

type DevelopmentExecution = { id: string | null; status: string; startedAt: string; finishedAt: string | null; lastHeartbeatAt: string | null; lastOutputAt?: string | null; currentStep: string | null };
type DevelopmentState = { status: string; execution: DevelopmentExecution | null };
type DeveloperEventState = { executionId: string | null; events: DeveloperExecutionEventView[]; terminalSteps: Record<number, "completed" | "blocked"> };
const noopExecutionStatus = (): void => {};

function TaskMediaRow({ taskId, images }: { taskId: string; images: ApiTask["images"] }): ReactElement {
  const [selectedImage, setSelectedImage] = useState<ApiTask["images"][number] | null>(null);
  const imageUrl = (artifactId: string): string => `/api/tasks/${taskId}/images/${artifactId}`;
  return <>
    <div className="flex flex-wrap gap-2" data-task-media-row aria-label="Task media">
      {images.map((image) => <button className="size-16 overflow-hidden rounded-md border border-border bg-muted/30 outline-none transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring" type="button" onClick={() => setSelectedImage(image)} aria-label={`Open ${image.filename}`} key={image.artifactId}>
        <img className="size-full object-cover" src={imageUrl(image.artifactId)} alt="" />
      </button>)}
    </div>
    <Dialog open={selectedImage !== null} onOpenChange={(open) => { if (!open) setSelectedImage(null); }}>
      <DialogContent className="w-[min(92vw,960px)] max-w-none gap-0 bg-black/95 p-2 text-white sm:max-w-[960px]" aria-label={selectedImage ? `Preview ${selectedImage.filename}` : "Image preview"}>
        <DialogHeader className="sr-only"><DialogTitle>{selectedImage?.filename}</DialogTitle></DialogHeader>
        {selectedImage ? <img className="max-h-[82vh] w-full object-contain" src={imageUrl(selectedImage.artifactId)} alt={selectedImage.filename} /> : null}
      </DialogContent>
    </Dialog>
  </>;
}

function NextAction({ value }: { value: string | null }): ReactElement {
  if (value === "Lead delivery review" || value?.startsWith("Fresh Lead delivery review")) return <>Forge is checking the completed work against the approved plan.</>;
  if (value === "Developer repair of blocking findings") return <>Developer needs to address required review feedback</>;
  const match = value?.match(/^Required checks are (?:still )?missing: (.+)$/);
  if (!match) return <>{value ?? "None"}</>;
  return <ul className="list-disc space-y-0.5 pl-4 text-[11px]">{(match[1] ?? "").split(", ").map((check) => <li key={check}>{check}</li>)}</ul>;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function DeveloperActivityLine({ event, open }: { event: DeveloperExecutionEventView; open: boolean }): ReactElement {
  const [headline, ...detail] = event.summary.split("\n");
  const label = event.kind === "agent_update" ? "Agent update: " : event.kind === "tool_call" ? "Tool call: " : "";
  return <li className="break-words"><span className={label ? "font-medium text-foreground" : undefined}>{label}</span>{headline}{detail.length ? <details className="mt-1" open={open}><summary className="cursor-pointer">{event.kind === "command_finished" || event.kind === "test_result" ? "Output" : "Details"}</summary><ShellOutput value={detail.join("\n")} /></details> : null}</li>;
}

function ShellOutput({ value }: { value: string }): ReactElement {
  const themeType = useAppThemeType();
  // ponytail: Detect terminal-native ANSI and git diffs; add formats only when real output proves the fallback insufficient.
  const file = useMemo(() => ({ name: "output", contents: value, lang: value.includes("\u001b[") ? "ansi" as const : /(^|\n)(diff --git |@@ -\d)/.test(value) ? "diff" as const : "shellsession" as const }), [value]);
  const options = useMemo(() => ({ disableFileHeader: true, disableLineNumbers: true, overflow: "wrap" as const, themeType }), [themeType]);
  return <div className="mt-1 max-h-48 overflow-auto" data-shell-output><File file={file} options={options} disableWorkerPool /></div>;
}

function DevelopmentStatus({ state, now, inline = false, activityLabel }: { state: DevelopmentState; now: number; inline?: boolean; activityLabel?: string }): ReactElement | null {
  if (state.status === "completed") return null;
  const execution = state.execution;
  const active = ["starting", "running", "cancelling"].includes(state.status);
  const freshnessAt = execution?.lastHeartbeatAt ?? execution?.startedAt;
  const stale = active && Boolean(freshnessAt && now - Date.parse(freshnessAt) > 15_000);
  const label = stale ? "No recent heartbeat" : state.status === "starting" ? "In Progress" : state.status === "result_pending_claim" ? "Finishing development" : state.status === "running" ? "Running" : state.status === "cancelling" ? "Cancelling" : state.status === "queued" ? "Queued" : state.status === "rate_limited" ? "Rate limited" : state.status === "completed" ? "Completed" : state.status === "blocked" ? "Blocked" : state.status === "failed" ? "Failed" : state.status;
  const elapsed = execution ? formatDuration((execution.finishedAt ? Date.parse(execution.finishedAt) : now) - Date.parse(execution.startedAt)) : "—";
  const outputAge = execution?.lastOutputAt ? formatDuration(now - Date.parse(execution.lastOutputAt)) : undefined;
  const heartbeatAge = execution?.lastHeartbeatAt ? formatDuration(now - Date.parse(execution.lastHeartbeatAt)) : undefined;
  const content = <><span className="flex items-center gap-1.5" role="status" aria-live="polite">{active && Boolean(execution?.lastHeartbeatAt) && !stale ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}<span>{label}</span></span><span className="tabular-nums text-muted-foreground">{elapsed}</span>{execution?.currentStep ? <span className="text-muted-foreground">{execution.currentStep}{heartbeatAge ? ` · heartbeat ${heartbeatAge} ago` : ""}</span> : null}{activityLabel && outputAge ? <span className="text-muted-foreground">Last {activityLabel.toLowerCase()} event {outputAge} ago</span> : null}</>;
  return inline ? <span className="inline-flex items-center gap-x-3 text-xs font-normal">{content}</span> : <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{content}</div>;
}

function LiveExecutionRun({ taskId, eventPath, activityLabel, onStatus = noopExecutionStatus, onEvents, onRefresh, compact = false }: { taskId: string; eventPath: "development-events" | "planning-events"; activityLabel: string; onStatus?: (status: string, execution: DevelopmentExecution | null) => void; onEvents?: (executionId: string, events: DeveloperExecutionEventView[]) => void; onRefresh: () => Promise<void>; compact?: boolean }): ReactElement | null {
  const [state, setState] = useState<DevelopmentState>({ status: "idle", execution: null });
  const [activity, setActivity] = useState<DeveloperExecutionEventView[]>([]);
  const [now, setNow] = useState(Date.now());
  const refreshed = useRef("");
  const executionId = useRef<string | null>(null);
  useEffect(() => {
    setState({ status: "idle", execution: null });
    setActivity([]);
    executionId.current = null;
    onStatus("idle", null);
    const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/${eventPath}`);
    stream.addEventListener("status", (message) => { try { const next = JSON.parse((message as MessageEvent<string>).data) as { status: string; execution: DevelopmentExecution | null }; const nextId = next.execution?.id ?? null; if (nextId !== executionId.current) setActivity([]); executionId.current = nextId; onStatus(next.status, next.execution); setState(next); } catch { /* Keep the last safe status. */ } });
    stream.addEventListener("progress", (message) => { try { const event = JSON.parse((message as MessageEvent<string>).data) as DeveloperExecutionEventView; setActivity((current) => [...current, event].slice(-20)); if (executionId.current) onEvents?.(executionId.current, [event]); } catch { /* Ignore malformed server events. */ } });
    return () => stream.close();
  }, [eventPath, taskId, onEvents, onStatus]);
  useEffect(() => {
    setNow(Date.now());
    if (compact || state.execution?.finishedAt || !["starting", "running", "cancelling"].includes(state.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [compact, state.execution?.id, state.execution?.finishedAt, state.status]);
  useEffect(() => {
    const key = state.execution?.id ? `${state.execution.id}:${["completed", "blocked", "failed", "result_pending_claim"].includes(state.status) ? state.status : "started"}` : "";
    if (!key || refreshed.current === key) return;
    refreshed.current = key;
    void onRefresh();
  }, [onRefresh, state.execution?.id, state.status]);
  if (!state.execution && state.status === "idle") return null;
  const visibleActivity = activity.filter((event) => !(event.kind === "command_started" || event.kind === "command_finished") || !event.summary.includes("forge-step"));
  const lastOutputIndex = visibleActivity.reduce((last, event, index) => event.summary.includes("\n") ? index : last, -1);
  return <section className="space-y-2 text-xs" data-development-run={eventPath === "development-events" ? "" : undefined} data-planning-activity={eventPath === "planning-events" ? "" : undefined}>{!compact ? <DevelopmentStatus state={state} now={now} {...(eventPath === "planning-events" ? { activityLabel } : {})} /> : null}{visibleActivity.length ? <div className="space-y-1" data-developer-activity={eventPath === "development-events" ? "" : undefined} data-agent-activity={eventPath === "planning-events" ? "" : undefined}><h3 className="font-medium">{activityLabel} activity</h3><ol className="space-y-1 text-[11px] text-muted-foreground">{visibleActivity.map((event, index) => <DeveloperActivityLine event={event} open={index === lastOutputIndex} key={event.eventId} />)}</ol></div> : null}</section>;
}

export type TaskPlanAction = Exclude<IssueCommandSlug, "revise-plan" | "continue-work" | "record-progress" | "resolve-decision-blocker"> | "reject-plan";
export type PlanRevisionInput = { reason: string };

export function nextPullRequestReviewAction(allowedCommands: ApiTask["allowedCommands"]): TaskPlanAction | undefined {
  if (allowedCommands.includes("review_delivery")) return "review-delivery";
  if (allowedCommands.includes("final_review")) return "final-review";
  return undefined;
}

function PublicationPreview({ release, planned, loading }: { release: NonNullable<ApiTask["release"]> | null | undefined; planned?: { pullRequestTitle: string; pullRequestDescription: string } | undefined; loading: boolean }): ReactElement {
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  if (loading && !release) return <section data-publication-preview-loading className="space-y-2 border-t pt-3">
    <div className="space-y-2"><Skeleton className="h-5 w-2/3" /><div className="space-y-1.5"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div></div>
  </section>;
  const title = release?.title ?? planned?.pullRequestTitle;
  const description = release?.bodyPreview?.trim() || planned?.pullRequestDescription || "";
  const descriptionIsLong = description.length > 240 || description.split(/\r?\n/).length > 3;
  return <section data-task-publication-preview className="space-y-2 border-t pt-3">
    {title ? <div className="space-y-2">
      <h5 className="flex items-start gap-2 break-words text-base font-semibold leading-6"><GitPullRequest aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{title}</h5>
      {descriptionIsLong ? <button type="button" data-publication-description aria-expanded={descriptionExpanded} aria-label={`${descriptionExpanded ? "Collapse" : "Expand"} PR description`} className={`relative block w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring${descriptionExpanded ? "" : " max-h-[3.75rem] overflow-hidden"}`} onClick={() => setDescriptionExpanded((expanded) => !expanded)}><span className="whitespace-pre-wrap break-words leading-5 text-[12px] text-muted-foreground">{description}</span>{descriptionExpanded ? null : <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent" />}</button> : <p className="whitespace-pre-wrap break-words leading-5 text-[12px] text-muted-foreground">{description || "Description is not available."}</p>}
      {release ? <p className="break-words text-[11px]"><code>{release.headBranch}</code> → <code>{release.baseBranch}</code> · {release.repository}</p> : null}
    </div> : <p className="text-[12px] text-muted-foreground">Publication details are not available yet.</p>}
  </section>;
}

export function TaskActions({ task, busy, onStartPlanning, onPlanAction, onRevisePlan, onContinueWork, onOpenDiff }: { task: ApiTask; busy: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>) => Promise<void>; onRevisePlan: (input: PlanRevisionInput) => Promise<void>; onContinueWork: (reason: string) => Promise<void>; onOpenDiff?: () => void }): ReactElement {
  const { snapshot: healthSnapshot } = useSystemHealth();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");
  const [continueOpen, setContinueOpen] = useState(false);
  const [continueReason, setContinueReason] = useState("");
  const disabled = busy || task.projection.status === "lagging" || Boolean(getWorkerHealthFailure(healthSnapshot));
  const canRevise = task.allowedCommands.includes("revise_plan");
  const canContinue = task.allowedCommands.includes("continue_work");
  const canReviewDelivery = task.allowedCommands.includes("review_delivery");
  const canRepairDelivery = task.allowedCommands.includes("repair_delivery");
  const canContinuePastReview = canRepairDelivery || task.allowedCommands.includes("record_delivery_decision");
  const canAcceptDelivery = task.allowedCommands.includes("accept_delivery");
  const canPublishDraft = task.allowedCommands.includes("publish_draft");
  const plannedPublication = task.leadOutput?.content.kind === "plan" ? task.leadOutput.content.gitPresentation ?? undefined : undefined;
  const canOpenDiff = task.developerExecution?.status === "completed";
  const worktreePath = task.developerExecution?.worktreePath;
  const verificationResults = task.developerExecution?.verificationResults ?? [];
  const deliveryAgent = [...(task.agentInvocations ?? [])].reverse().find((candidate) => candidate.role === "builder" && candidate.status === "completed");
  const repairInstruction = task.deliveryReview?.findings.find((finding) => finding.severity === "blocking" && finding.disposition === "open")?.repairInstruction ?? task.deliveryReview?.summary;
  const supplementalCommand = task.commands.find((command) => command.name === "request_supplemental_review");
  const hasVisibleActions = Boolean(supplementalCommand) || canRevise || canContinue || task.allowedCommands.some((command) => !["cancel_issue", "approve_plan", "reject_plan", "request_plan_revision", "respond_plan_blocker", "resolve_decision_blocker"].includes(command));
  const recoveryOwnsActions = Boolean(task.developerRecovery && task.allowedCommands.some((command) => ["retry_development", "cancel_development"].includes(command)));
  const isBlocked = BLOCKED_PHASES.has(task.phase);
  const presentationPhase = taskPresentationPhase({ phase: task.phase, releaseStatus: task.release?.status, ciOutcome: task.ci?.outcome, allowedCommands: task.allowedCommands });
  const awaitingDeliveryReview = canReviewDelivery && presentationPhase === "reviewing_delivery";
  const canRetryFinalReview = task.phase === "delivery_blocked" && task.allowedCommands.includes("final_review");
  if (!hasVisibleActions && task.phase === "planning") return <div data-task-actions />;
  if (!hasVisibleActions) {
    return <Card data-task-actions data-task-status-card size="sm" aria-label={`${phaseLabel(presentationPhase)} status`}>
      <CardHeader>
        <CardTitle><h3><TaskStatus phase={task.phase} presentationPhase={presentationPhase} processing={taskIsProcessing({ phase: task.phase, agentInvocations: task.agentInvocations, capacityStatus: task.capacity?.status })} /></h3></CardTitle>
        <CardDescription><NextAction value={task.pendingAction} /></CardDescription>
      </CardHeader>
    </Card>;
  }
  if (task.phase === "development" || recoveryOwnsActions) return <div data-task-actions />;
  return (
    <Card data-task-actions data-task-blocked-card={isBlocked && !awaitingDeliveryReview || undefined} size="sm">
      <CardHeader>
        <CardTitle><h3>{canReviewDelivery ? deliveryAgent?.agentName && deliveryAgent.avatarSeed ? <span className="inline-flex items-center gap-1.5"><ProfileAvatar name={deliveryAgent.agentName} seed={deliveryAgent.avatarSeed} size="xs" />{deliveryAgent.agentName} completed the approved work.</span> : "Completed the approved work" : canRetryFinalReview ? "Final review did not finish" : canRepairDelivery ? "More proof is needed" : canPublishDraft ? "Ready to Create Pull Request" : canAcceptDelivery ? "Ready to publish" : task.pendingAction ?? "Next action"}</h3></CardTitle>
        {canReviewDelivery ? <CardDescription>Ready for your review.</CardDescription> : canRetryFinalReview ? <CardDescription>Forge could not finish its last review. Try again, or choose Request Changes to send the work back.</CardDescription> : canRepairDelivery ? <CardDescription>{repairInstruction ? <>Missing verification: {repairInstruction}</> : "A required verification result is missing."}</CardDescription> : canAcceptDelivery ? <CardDescription>The work is ready. Publish makes the pull request available for review. Request Changes sends it back to the Developer.</CardDescription> : null}
        {isBlocked && task.lastHandlerError ? <CardDescription>Last {task.lastHandlerError.command} error: {task.lastHandlerError.reason}</CardDescription> : null}
        {isBlocked ? <CardAction>{awaitingDeliveryReview ? <TaskStatus phase={task.phase} presentationPhase={presentationPhase} /> : <Badge variant="destructive">{phaseLabel(task.phase)}</Badge>}</CardAction> : null}
      </CardHeader>
      {canReviewDelivery ? <CardContent className="space-y-3" data-delivery-handoff>
        <div className="text-[12px]">
          <p className="text-muted-foreground">Review the changes, then choose what happens next.</p>
        </div>
        <dl className="grid min-w-0 gap-x-6 gap-y-3 border-t pt-3 text-[11px] sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Branch</dt><dd className="break-all"><code>{task.developerExecution?.branchName ?? "Unavailable"}</code></dd></div>
          <div className="sm:col-span-2"><dt className="text-muted-foreground">Worktree</dt><dd className="flex min-w-0 items-start gap-1"><code className="min-w-0 break-all">{worktreePath ?? "Unavailable"}</code>{worktreePath ? <CopyBranchButton value={`cd ${worktreePath}`} label="Copy worktree command" /> : null}</dd></div>
          {verificationResults.length ? <div className="sm:col-span-2"><dt className="text-muted-foreground">Checks</dt><dd className="mt-1 space-y-1">{verificationResults.map((result) => <span className="block" key={result}>{result}</span>)}</dd></div> : null}
        </dl>
      </CardContent> : null}
      {canPublishDraft ? <CardContent className="space-y-3" data-task-publish-preview><PublicationPreview release={task.release} planned={plannedPublication} loading={busy} /></CardContent> : null}
      {(revisionOpen || continueOpen) ? <CardContent>
        {revisionOpen ? <form className="max-w-xl space-y-3 border-l-2 pl-3" onSubmit={(event) => { event.preventDefault(); void onRevisePlan({ reason: revisionReason }); }}>
          <Field><FieldLabel htmlFor="revision-reason">Why revise this plan?</FieldLabel><Textarea id="revision-reason" required value={revisionReason} onChange={(event) => setRevisionReason(event.target.value)} placeholder="Describe the changed requirement or observed problem." /></Field>
          <Button type="submit" size="sm" disabled={disabled || !revisionReason.trim()}>{busy ? "Submitting…" : "Submit revision"}</Button>
        </form> : null}
        {continueOpen ? <form className="max-w-xl space-y-3 border-l-2 pl-3" onSubmit={(event) => { event.preventDefault(); void onContinueWork(continueReason); }}><Field><FieldLabel htmlFor="continue-reason">Why continue this work?</FieldLabel><Textarea id="continue-reason" required value={continueReason} onChange={(event) => setContinueReason(event.target.value)} placeholder="Describe the next outcome." /></Field><Button type="submit" size="sm" disabled={disabled || !continueReason.trim()}>{busy ? "Creating successor…" : "Create successor"}</Button></form> : null}
      </CardContent> : null}
      <CardFooter>
        <div className="flex w-full flex-wrap justify-end gap-2 [&>[data-variant=default]]:order-1">
      {task.allowedCommands.includes("start_planning") ? <Button size="sm" onClick={() => void onStartPlanning()} disabled={disabled}>{busy ? "Planning…" : task.phase === "failed" ? "Retry planning" : "Start planning"}</Button> : null}
      {supplementalCommand ? <Button size="sm" variant="outline" onClick={() => void onPlanAction(supplementalCommand.endpoint as TaskPlanAction, undefined, { idempotencyKey: crypto.randomUUID() })} disabled={disabled}>Request review</Button> : null}
      {task.allowedCommands.includes("start_development") ? <Button size="sm" onClick={() => void onPlanAction("start-development")} disabled={disabled}>{busy ? "Executing…" : "Start development"}</Button> : null}
      {!task.developerRecovery && task.allowedCommands.includes("retry_development") ? <Button size="sm" onClick={() => void onPlanAction("retry-development")} disabled={disabled}>{busy ? "Retrying…" : "Retry development"}</Button> : null}
      {!task.developerRecovery && task.allowedCommands.includes("cancel_development") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("cancel-development")} disabled={disabled}>Cancel development</Button> : null}
      {(canReviewDelivery || canPublishDraft) && onOpenDiff ? <Button size="sm" variant="outline" onClick={onOpenDiff} disabled={disabled || !canOpenDiff}>Show Diff</Button> : null}
      {canReviewDelivery ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("reject-plan", "Member requested delivery changes")} disabled={disabled}>Request Changes</Button> : null}
      {canReviewDelivery ? <Button size="sm" onClick={() => void onPlanAction("review-delivery")} disabled={disabled}>{busy ? "Reviewing…" : "Looks Good"}</Button> : null}
      {canRepairDelivery ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("repair-delivery")} disabled={disabled}>{busy ? "Starting Developer…" : "Run missing check"}</Button> : null}
      {canContinuePastReview ? <Button size="sm" onClick={() => void onPlanAction("record-delivery-decision", "Member chose to continue despite incomplete verification.")} disabled={disabled}>{busy ? "Continuing…" : "Continue anyway"}</Button> : null}
      {task.allowedCommands.includes("retry_capacity") ? <Button size="sm" onClick={() => void onPlanAction("retry-capacity")} disabled={disabled}>Retry capacity</Button> : null}
      {canAcceptDelivery ? <Button size="sm" onClick={() => void onPlanAction("accept-delivery")} disabled={disabled}>{busy ? "Publishing…" : "Publish"}</Button> : null}
      {task.allowedCommands.includes("publish_draft") ? <Button size="sm" variant="default" onClick={() => void onPlanAction("publish-draft")} disabled={disabled}>{busy ? "Publishing…" : task.release?.status === "blocked" ? "Retry release" : "Draft Pull Request"}</Button> : null}
      {task.allowedCommands.includes("resolve_merge_conflict") ? <Button size="sm" onClick={() => void onPlanAction("resolve-merge-conflict")} disabled={disabled}>{busy ? "Resolving…" : "Resolve conflicts"}</Button> : null}
      {task.allowedCommands.includes("retry_target_base_reconciliation") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("retry-target-base-reconciliation")} disabled={disabled}>{busy ? "Retrying…" : "Retry reconciliation"}</Button> : null}
      {task.allowedCommands.includes("retry_forward_merge_verification") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("retry-forward-merge-verification")} disabled={disabled}>{busy ? "Verifying…" : "Retry verification"}</Button> : null}
      {task.allowedCommands.includes("reconcile_ci") ? <Button size="sm" onClick={() => void onPlanAction("reconcile-ci")} disabled={disabled}>{busy ? "Checking…" : "Check CI"}</Button> : null}
      {task.allowedCommands.includes("repair_ci") ? <Button size="sm" onClick={() => void onPlanAction("repair-ci")} disabled={disabled}>{busy ? "Repairing…" : "Repair CI"}</Button> : null}
      {task.allowedCommands.includes("request_delivery_changes") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("request-delivery-changes", "Member requested delivery changes")} disabled={disabled}>Request Changes</Button> : null}
      {task.allowedCommands.includes("final_review") ? <Button size="sm" onClick={() => void onPlanAction("final-review")} disabled={disabled}>{busy ? "Reviewing…" : "Final review"}</Button> : null}
      {task.allowedCommands.includes("reconcile_acceptance") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("reconcile-acceptance")} disabled={disabled}>{busy ? "Checking…" : "Check ready state"}</Button> : null}
      {task.allowedCommands.includes("reconcile_merge") ? <Button size="sm" onClick={() => void onPlanAction("reconcile-merge")} disabled={disabled}>{busy ? "Checking…" : "Check merge"}</Button> : null}
      {!task.developerRecovery && canRevise ? <Button size="sm" variant="outline" onClick={() => setRevisionOpen((open) => !open)} disabled={disabled}>{revisionOpen ? "Close revision" : "Revise plan"}</Button> : null}
      {canContinue ? <Button size="sm" variant="outline" onClick={() => setContinueOpen((open) => !open)} disabled={disabled}>{continueOpen ? "Close continuation" : "Continue work"}</Button> : null}
        </div>
      </CardFooter>
    </Card>
  );
}

function ReleasePanel({ task }: { task: ApiTask }): ReactElement | null {
  const release = task.release;
  if (!release) return null;
  const statusLabel = release.status === "draft" ? "Draft" : release.status === "ready" ? "Ready" : release.status === "reconciling" ? "Reconciling" : "Blocked";
  return <Card size="sm" aria-label="Draft publication">
    <CardHeader>
      <CardTitle><h3>Draft publication</h3></CardTitle>
      <CardDescription>{release.repository} · {release.baseBranch} ← {release.headBranch}</CardDescription>
      <CardAction><Badge variant={release.status === "blocked" ? "destructive" : "secondary"}>{statusLabel}</Badge></CardAction>
    </CardHeader>
    <CardContent>
      {release.pullRequestUrl ? <a className="text-xs underline underline-offset-2" href={release.pullRequestUrl} target="_blank" rel="noreferrer">Pull request #{release.pullRequestNumber}</a> : null}
      {release.failureSummary ? <Alert variant="destructive"><AlertDescription>{release.failureCode ? releaseFailureCopy[release.failureCode] ?? "Release publication is blocked." : release.failureSummary}{release.retryAt ? ` Retry after ${adminDate(release.retryAt)}.` : ""}</AlertDescription></Alert> : null}
      {release.operation ? <div className="text-[11px] text-muted-foreground">{release.operation.kind} · {release.operation.status}</div> : null}
      <Collapsible.Root>
        <Collapsible.Trigger className="text-xs underline underline-offset-2">Preview title and body</Collapsible.Trigger>
        <Collapsible.Panel className="mt-2 min-w-0 whitespace-pre-wrap break-words border-l pl-3 text-[11px] text-muted-foreground">{release.title}{release.bodyPreview ? `\n\n${release.bodyPreview}` : "\n\nBody is not available."}</Collapsible.Panel>
      </Collapsible.Root>
    </CardContent>
  </Card>;
}

function PullRequestCard({ task, busy, onMarkReady, onMerge, onCheckCi, onCheckMerge }: { task: ApiTask; busy: boolean; onMarkReady: () => Promise<void>; onMerge?: () => Promise<void>; onCheckCi?: () => Promise<void>; onCheckMerge?: () => Promise<void> }): ReactElement | null {
  const release = task.release;
  if (!release?.pullRequestUrl || release.pullRequestNumber === null) return null;
  const providerState = task.deliveryGate?.release.state;
  const status = providerState === "merged" ? "Merged" : providerState === "closed" ? "Closed" : providerState === "ready" || !release.isDraft ? "Open" : "Draft";
  const checks = task.ci?.outcome ?? task.ci?.status;
  const branchComparison = `${release.headBranch} → ${release.baseBranch}`;
  if (status === "Merged") return <Card data-pull-request-card size="sm" aria-label={`Pull request #${release.pullRequestNumber}`}>
    <CardHeader>
      <CardTitle><span className="min-w-0 break-words">{release.title} <a className="font-normal text-muted-foreground hover:underline" href={release.pullRequestUrl} target="_blank" rel="noreferrer">#{release.pullRequestNumber}</a></span></CardTitle>
      <CardDescription><span className="flex min-w-0 flex-nowrap items-center gap-2"><Badge variant="default" className="h-6 bg-violet-600 px-2.5 text-xs text-white"><GitPullRequest aria-hidden="true" />Merged</Badge><span className="min-w-0 truncate">merged into <code>{release.baseBranch}</code> from <code>{release.headBranch}</code></span><CopyBranchButton value={branchComparison} /></span></CardDescription>
    </CardHeader>
    {checks ? <CardContent><div className="text-xs"><span className="text-muted-foreground">Checks</span> · {checks.replaceAll("_", " ")}</div></CardContent> : null}
  </Card>;
  const waitingForMerge = task.phase === "manual_merge";
  return <Card data-pull-request-card data-waiting-for-merge={waitingForMerge || undefined} className={waitingForMerge ? "bg-emerald-50/60 ring-emerald-600/20 dark:bg-emerald-950/20" : undefined} size="sm" aria-label={`Pull request #${release.pullRequestNumber}`}>
    <CardHeader>
      <CardTitle><span className="min-w-0 break-words">{release.title}</span></CardTitle>
      <CardDescription><span className="flex items-center gap-1.5"><a className="inline-flex items-center gap-1.5 underline underline-offset-2" href={release.pullRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest aria-hidden="true" className="size-4 shrink-0" />#{release.pullRequestNumber}</a><Badge variant={status === "Open" ? "outline" : "secondary"}>{status}</Badge></span></CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><code className="min-w-0 flex-1 truncate font-mono" title={branchComparison}>{branchComparison}</code><CopyBranchButton value={branchComparison} /></div>
      {checks ? <div className="text-xs"><span className="text-muted-foreground">Checks</span> · {checks.replaceAll("_", " ")}</div> : null}
      {task.ci ? <div className="text-[11px] text-muted-foreground">Last checked {task.ci.attempts[0] ? adminDate(task.ci.attempts[0].createdAt) : "not yet"}{task.ci.nextRetryAt ? ` · next automatic check ${adminDate(task.ci.nextRetryAt)}` : ""}</div> : null}
    </CardContent>
    <CardFooter>
      <div className="flex w-full items-center justify-end gap-2">
        {onCheckCi ? <Button size="sm" variant="outline" onClick={() => void onCheckCi()} disabled={busy}>{busy ? "Checking…" : "Check CI"}</Button> : null}
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href={release.pullRequestUrl} target="_blank" rel="noreferrer">Open PR<ExternalLink aria-hidden="true" /></a>
        {release.isDraft ? <Button size="sm" onClick={() => void onMarkReady()} disabled={busy}>{busy ? "Marking ready…" : "Mark As Ready"}</Button> : null}
        {onMerge ? <Button size="sm" onClick={() => void onMerge()} disabled={busy}>{busy ? "Merging…" : "Merge"}</Button> : null}
        {onCheckMerge ? <Button size="sm" onClick={() => void onCheckMerge()} disabled={busy}>{busy ? "Checking…" : "Check merge"}</Button> : null}
      </div>
    </CardFooter>
  </Card>;
}

function CopyBranchButton({ value, label = "Copy branch comparison" }: { value: string; label?: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      const fallbackCopy = (): void => {
        const input = document.createElement("textarea");
        input.value = value;
        input.setAttribute("readonly", "true");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        const copiedByFallback = document.execCommand("copy");
        input.remove();
        if (!copiedByFallback) throw new Error("Clipboard write failed");
      };
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          fallbackCopy();
        }
      } else {
        fallbackCopy();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };
  return <span className="shrink-0"><Button variant="ghost" size="icon-xs" aria-label={label} title="Copy to clipboard" onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</Button>{copied ? <span className="pointer-events-none fixed bottom-4 right-4 z-50 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground" role="status" aria-live="polite">Copied to Clipboard</span> : null}</span>;
}

function CiDiagnostics({ ci }: { ci: ApiCi }): ReactElement {
  const latestAttempt = ci.attempts[0];
  return <div className="space-y-4" data-task-ci-diagnostics>
    <Card size="sm" aria-label="CI status">
      <CardHeader>
        <CardTitle><h3>CI status</h3></CardTitle>
        <CardDescription>{ci.repository} · PR #{ci.pullRequestNumber} · {ci.baseBranch} ← {ci.headBranch}</CardDescription>
        <CardAction><Badge variant={ci.outcome === "failed" ? "destructive" : "secondary"}>{ci.outcome ?? ci.status}</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <a className="text-xs underline" href={ci.pullRequestUrl} target="_blank" rel="noreferrer">Open pull request #{ci.pullRequestNumber}</a>
        <div className="text-[11px] text-muted-foreground">{ci.baseBranch} → {ci.headBranch}</div>
      </CardContent>
    </Card>
    <Card size="sm" aria-label="CI run details">
      <CardHeader>
        <CardTitle><h3>Run details</h3></CardTitle>
        <CardDescription>Retry window and deadlines</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><span>Next retry {ci.nextRetryAt ? adminDate(ci.nextRetryAt) : "—"}</span><span>Propagation {ci.propagationDeadline ? adminDate(ci.propagationDeadline) : "—"}</span><span>Overall deadline {ci.overallDeadline ? adminDate(ci.overallDeadline) : "—"}</span><span>Owner {ci.owner === "system" ? "Forge" : ci.owner === "integrator" ? "Integrator" : ci.owner ?? "—"}</span></div>
        {ci.reason || latestAttempt?.summary ? <p className="break-words text-[12px]">{ci.reason ? `${ci.reason}: ` : ""}{latestAttempt?.summary ?? ""}</p> : null}
      </CardContent>
      <CardFooter>
        <div className="flex flex-wrap gap-2 text-[11px]"><span>Planner session {ci.leadSessionContinuity ? "continued" : "—"}</span><span>Builder session {ci.developerSessionContinuity ? "continued" : "—"}</span></div>
      </CardFooter>
    </Card>
  </div>;
}

function CiPanel({ ci }: { ci: ApiCi }): ReactElement {
  const latestAttempt = ci.attempts[0];
  return <div className="space-y-4" data-task-ci>
    <Card size="sm" aria-label="Required checks">
      <CardHeader>
        <CardTitle><h3>Required checks</h3></CardTitle>
        <CardDescription>{ci.policy.requiredChecks.length} required check{ci.policy.requiredChecks.length === 1 ? "" : "s"}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">{ci.policy.requiredChecks.map((name) => { const check = latestAttempt?.checks.find((candidate) => candidate.name === name && candidate.selectedForEvaluation); return <div className="flex items-center justify-between gap-2 border-b py-1 text-[11px]" key={name}><span className="min-w-0 break-words">{name}</span><span className="shrink-0 text-muted-foreground">{check ? `${check.status}${check.conclusion ? ` · ${check.conclusion}` : ""}` : "missing"}</span></div>; })}</div>
      </CardContent>
    </Card>
  </div>;
}

function FinalGatePanel({ task }: { task: ApiTask }): ReactElement | null {
  const gate = task.deliveryGate;
  if (!gate) return null;
  return (
    <Card data-final-gate size="sm">
      <CardHeader>
        <CardTitle><h3>Final gate</h3></CardTitle>
        <CardAction><Badge variant={gate.release.state === "merged" ? "secondary" : gate.finalReview?.outcome === "blocking" ? "destructive" : "outline"}>{gate.release.state}</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Pull request</dt><dd><a className="underline underline-offset-2" href={gate.release.pullRequestUrl} target="_blank" rel="noreferrer">#{gate.release.pullRequestNumber}</a> · {gate.release.repository}</dd></div>
        <div><dt className="text-muted-foreground">CI</dt><dd>{gate.ci ? `${gate.ci.status}: ${gate.ci.summary}` : "Not recorded"}</dd>{gate.ci?.checks.length ? <ul className="mt-1 space-y-0.5 text-muted-foreground">{gate.ci.checks.map((check) => <li key={check.name}>{check.name}: {check.conclusion ?? check.status}</li>)}</ul> : null}</div>
        <div><dt className="text-muted-foreground">Final review</dt><dd>{gate.finalReview ? `${gate.finalReview.outcome}: ${gate.finalReview.summary}` : "Not recorded"}</dd></div>
        <div><dt className="text-muted-foreground">Acceptance</dt><dd>{gate.acceptance ? `${gate.acceptance.decision}: ${gate.acceptance.status}` : "Not recorded"}</dd>{gate.acceptance ? <div className="text-muted-foreground">decided {adminDate(gate.acceptance.decidedAt)}{gate.acceptance.readyAt ? ` · ready ${adminDate(gate.acceptance.readyAt)}` : ""}</div> : null}</div>
        <div><dt className="text-muted-foreground">Merge</dt><dd>{gate.merge.outcome ?? "Not observed"}{gate.merge.observedAt ? ` · observed ${adminDate(gate.merge.observedAt)}` : ""}{gate.merge.mergedAt ? ` · merged ${adminDate(gate.merge.mergedAt)}` : ""}</dd></div>
        <div><dt className="text-muted-foreground">Deployment</dt><dd>Deployment: unknown / out of scope</dd></div>
        </dl>
        {gate.finalReview?.findings.length ? <div className="space-y-2">{gate.finalReview.findings.map((finding) => <div className="text-[11px]" key={finding.id}><span className="font-medium">{finding.severity}</span> · {finding.rationale}</div>)}</div> : null}
      </CardContent>
    </Card>
  );
}

function deliveryTargetLabel(target: ApiTask["deliveryTarget"]): string {
  return target === "local_worktree" ? "Keep in worktree" : target === "remote_branch" ? "Push branch" : target === "pull_request_ready" ? "Ready for review" : target === "merged" ? "Fully merged" : "Draft pull request";
}

function TaskConfigurationCard({ task }: { task: ApiTask }): ReactElement {
  return <Card size="sm" aria-label="Configuration used">
    <CardHeader><CardTitle><h3>Configuration used</h3></CardTitle></CardHeader>
    <CardContent><dl className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><div><dt>Plan review</dt><dd className="text-foreground">{task.autoApprovePlan ? "Auto-approved" : "Needs your approval"}</dd></div><div><dt>Second review</dt><dd className="text-foreground">{task.executionControls.supplementalReview ? "Requested" : "Off"}</dd></div><div><dt>Visual proof</dt><dd className="text-foreground">{task.executionControls.visualEvidence === "required" ? "Required" : task.executionControls.visualEvidence === "capture" ? "Capture when useful" : "Off"}</dd></div></dl></CardContent>
  </Card>;
}

function DeliveryChecksCard({ task }: { task: ApiTask }): ReactElement {
  return <Card size="sm" aria-label="Delivery and checks">
    <CardHeader><CardTitle><h3>Delivery &amp; checks</h3></CardTitle></CardHeader>
    <CardContent><dl className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><div><dt>Delivery target</dt><dd className="text-foreground">{deliveryTargetLabel(task.deliveryTarget)}</dd></div><div><dt>Project tests</dt><dd className="text-foreground">{task.executionControls.runProjectTests ? "Run" : "Skipped for this task"}</dd></div></dl></CardContent>
  </Card>;
}

function ReviewersTakeCard({ task }: { task: ApiTask }): ReactElement {
  const review = task.governance.supplementalReview;
  return <Card size="sm" aria-label="Reviewer’s take">
    <CardHeader><CardTitle><h3>Reviewer’s take</h3></CardTitle></CardHeader>
    <CardContent>{review ? <SupplementalReviewPanel value={{ reviewer: { name: review.reviewerProfile.name }, verdict: review.verdict, summary: review.summary, concerns: review.concerns, plannerResponse: review.plannerResponse }} /> : <p className="text-[11px] text-muted-foreground">No second review was requested.</p>}</CardContent>
  </Card>;
}

function TaskOptions({ canCancel, busy, resyncBusy, onCancel, onDuplicate, onResync }: { canCancel: boolean; busy: boolean; resyncBusy: boolean; onCancel: () => void; onDuplicate: () => void; onResync: () => void }): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Task options" title="Task options" />}><Ellipsis /></DropdownMenuTrigger>
      {/* Resync stays enabled even while the projection is lagging — that's the state it exists to repair, so it can't share the lagging-gated `busy` flag the other items use. */}
      <DropdownMenuContent align="start"><DropdownMenuItem disabled={busy} onClick={onDuplicate}>Duplicate</DropdownMenuItem><DropdownMenuItem disabled={resyncBusy} onClick={onResync}>Resync</DropdownMenuItem>{canCancel ? <DropdownMenuItem variant="destructive" disabled={busy} onClick={onCancel}>Cancel task</DropdownMenuItem> : null}</DropdownMenuContent>
    </DropdownMenu>
  );
}

type RescueReport = { steps: Array<{ name: string; outcome: "completed" | "skipped" | "failed"; detail: string }> };
type Diagnostics = { workflow: { status: string; lastWorkflowTaskFailure: string | null; pendingWorkflowTaskAgeSeconds: number | null; buildId: string | null; currentBuildId: string | null }; executions: Array<{ id: string; kind: string; status: string; pid: number | null; terminal: boolean }>; capacityRequests: Array<{ id: string; status: string; executionId: string | null }>; leases: Array<{ executionId: string; status: string }> };

function RescueControls({ task, busy, onRescue }: { task: ApiTask; busy: boolean; onRescue: () => Promise<RescueReport> }): ReactElement | null {
  const [confirmOpen, setConfirmOpen] = useState(false); const [report, setReport] = useState<RescueReport | null>(null); const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null); const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  if (["done", "cancelled"].includes(task.phase)) return null;
  const run = async (): Promise<void> => { setConfirmOpen(false); setReport(await onRescue()); };
  const loadDiagnostics = (): void => { setDiagnosticsOpen((open) => !open); if (!diagnostics) void readJson<Diagnostics>(`/api/tasks/${encodeURIComponent(task.id)}/diagnostics`).then(setDiagnostics).catch(() => setDiagnostics(null)); };
  return <Card data-task-rescue size="sm" aria-label="Task recovery">
    <CardHeader>
      <CardTitle><h3>Task recovery</h3></CardTitle>
      <CardAction><div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmOpen(true)}>{busy ? "Rescuing…" : "Rescue"}</Button><Button size="sm" variant="ghost" onClick={loadDiagnostics} aria-expanded={diagnosticsOpen}>Diagnostics</Button></div></CardAction>
    </CardHeader>
    {report || diagnosticsOpen ? <CardContent>
      {report ? <div className="space-y-1 text-xs" data-rescue-report>{report.steps.map((step) => <div key={step.name}><span className="font-medium">{step.name}</span> · {step.outcome}: {step.detail}</div>)}</div> : null}
      {diagnosticsOpen ? <div className="border-l pl-3 text-xs" data-task-diagnostics>{diagnostics ? <><div>Workflow: {diagnostics.workflow.status}{diagnostics.workflow.pendingWorkflowTaskAgeSeconds !== null ? ` · pending ${diagnostics.workflow.pendingWorkflowTaskAgeSeconds}s` : ""}</div>{diagnostics.workflow.lastWorkflowTaskFailure ? <div>Last failure: {diagnostics.workflow.lastWorkflowTaskFailure}</div> : null}<div>Executions: {diagnostics.executions.map((entry) => `${entry.kind} ${entry.status}`).join(", ") || "none"}</div><div>Capacity: {diagnostics.capacityRequests.map((entry) => entry.status).join(", ") || "none"}</div><div>Leases: {diagnostics.leases.map((entry) => entry.status).join(", ") || "none"}</div></> : "Loading diagnostics…"}</div> : null}
    </CardContent> : null}
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Rescue this task?</AlertDialogTitle><AlertDialogDescription>Forge will re-dispatch the workflow to the current worker, release stale locks, and retry the current step.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void run()}>Rescue task</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </Card>;
}

function PlanningRunCard({ task }: { task: ApiTask }): ReactElement | null {
  const invocation = [...task.agentInvocations].reverse().find((candidate) => candidate.role === "planner" && ["starting", "running", "cancelling"].includes(candidate.status));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (task.phase !== "planning") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [task.phase, invocation?.id]);
  if (task.phase !== "planning") return null;
  const planningStartedAt = [...task.timeline].reverse().find((event) => event.metadata.phase === "planning")?.createdAt;
  const startedAt = invocation?.startedAt ?? task.capacity?.requestedAt ?? planningStartedAt;
  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000)) : 0;
  const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : elapsedSeconds < 3_600 ? `${Math.floor(elapsedSeconds / 60)}m` : `${Math.floor(elapsedSeconds / 3_600)}h ${Math.floor(elapsedSeconds % 3_600 / 60)}m`;
  const status = task.capacity?.status === "queued" ? `Queued${task.capacity.position ? ` · ${task.capacity.position}` : ""}` : task.capacity?.status === "rate_limited" ? "Waiting" : invocation?.status === "cancelling" ? "Cancelling" : invocation || task.capacity?.status === "active" ? "Running" : elapsedSeconds >= 10 ? "Waiting to start" : "Starting";
  const agentName = invocation?.agentName ?? task.capacity?.agentName ?? "Planner agent";
  return (
    <Card data-planning-run size="sm" aria-label="Planning run">
      <CardHeader>
        <CardTitle>Planning run</CardTitle>
        <CardDescription><span className="flex items-center gap-2">{invocation?.avatarSeed ? <ProfileAvatar name={agentName} seed={invocation.avatarSeed} /> : task.capacity?.avatarSeed ? <ProfileAvatar name={agentName} seed={task.capacity.avatarSeed} /> : null}<span>{invocation ? invocationActorLabel(invocation) : agentName} · attempt {invocation?.attempt ?? 1}{invocation?.sessionPresent ? " · session connected" : ""}</span></span></CardDescription>
        <CardAction><Badge variant="secondary">{status}</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 text-xs lg:grid-cols-4">
          <div><dt className="text-muted-foreground">Model</dt><dd>{invocation?.model ?? "Resolving…"}</dd></div>
          <div><dt className="text-muted-foreground">Reasoning</dt><dd>{invocation?.reasoningLevel ?? "Resolving…"}</dd></div>
          <div><dt className="text-muted-foreground">Priority</dt><dd>{invocation?.servicePriority ?? "Resolving…"}</dd></div>
          <div><dt className="text-muted-foreground">Elapsed</dt><dd className="tabular-nums">{elapsed}</dd></div>
        </dl>
      </CardContent>
    </Card>
  );
}

function TaskAgentAssignments({ task, onRefresh }: { task: ApiTask; onRefresh: () => Promise<void> }): ReactElement {
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [error, setError] = useState("");
  const [savingRole, setSavingRole] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void readJson<{ agents: ApiAgent[] }>("/api/agents").then((response) => { if (active) setAgents(response.agents); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Agents could not be loaded"); });
    return () => { active = false; };
  }, []);
  const update = async (role: "planner" | "builder" | "reviewer" | "integrator", agentId: string): Promise<void> => {
    setSavingRole(role);
    setError("");
    try {
      await readJson<ApiTask>(`/api/tasks/${encodeURIComponent(task.id)}/agents`, { method: "PATCH", body: JSON.stringify({ [role]: agentId }) });
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent assignment could not be saved");
    } finally {
      setSavingRole(null);
    }
  };
  return <section className="mb-6 space-y-3" aria-label="Task agents"><h3 className="text-xs font-semibold">Agents</h3>{(["planner", "reviewer", "builder", "integrator"] as const).map((role) => { const label = role.slice(0, 1).toUpperCase() + role.slice(1); const selected = agents.find((agent) => agent.id === task.roleAgents[role]); const options = agents.filter((agent) => agent.role === role); return <div className="space-y-1" key={role}><div className="text-xs text-muted-foreground">{label}</div><DropdownMenu><DropdownMenuTrigger render={<Button id={`task-agent-${role}`} type="button" variant="secondary" size="xs" disabled={savingRole === role} aria-busy={savingRole === role} aria-label={`${label} agent: ${selected?.name ?? "Unassigned"}`} />}>{selected ? <><ProfileAvatar name={selected.name} seed={selected.avatarSeed} size="xs" />{selected.name}</> : "Unassigned"}</DropdownMenuTrigger><DropdownMenuContent align="start">{options.map((agent) => <DropdownMenuItem key={agent.id} onClick={() => { if (agent.id !== selected?.id) void update(role, agent.id); }}><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><span className="min-w-0 flex-1 truncate">{agent.name}</span>{agent.id === selected?.id ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>; })}{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}</section>;
}

function InlineTaskEditor({ field, value, onSave }: { field: "title" | "description"; value: string; onSave: (value: string) => Promise<void> }): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const skipBlur = useRef(false);
  useEffect(() => { if (!editing) setDraft(value); }, [editing, value]);
  const cancel = (): void => { skipBlur.current = true; setDraft(value); setEditing(false); };
  const save = async (): Promise<void> => {
    if (skipBlur.current) { skipBlur.current = false; return; }
    const next = draft.trim();
    if (next === value) { setEditing(false); return; }
    if (!next || saving) return;
    setSaving(true);
    try { await onSave(next); setEditing(false); } finally { setSaving(false); }
  };
  const start = (): void => { skipBlur.current = false; setDraft(value); setEditing(true); };
  if (editing) {
    const common = { autoFocus: true, value: draft, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value), onBlur: () => void save(), onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } else if (field === "title" && event.key === "Enter" || field === "description" && event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.blur(); }, disabled: saving };
    return field === "title" ? <Input aria-label="Task title" {...common} className="h-8 px-1 text-xl font-semibold tracking-tight" /> : <Textarea aria-label="Task description" {...common} className="min-h-24 resize-y px-1 text-[13px] leading-5" />;
  }
  return field === "title"
    ? <button type="button" data-task-title-editor aria-label="Edit task title" onClick={start} className="block min-w-0 text-left text-xl font-semibold tracking-tight">{value}</button>
    : <button type="button" data-task-description-editor aria-label="Edit task description" onClick={start} className="block w-full whitespace-pre-wrap text-left font-sans text-[13px] leading-5">{value || "No description."}</button>;
}

export function TaskDetailsPage({ task, project, companyId: _companyId, busy, error, isAdmin, onStartPlanning, onPlanAction, onRevisePlan, onContinueWork, onResolveDecisionBlocker, onMarkReady, onMerge, onDuplicate, onUpdateDetails, onRefresh, onRescue }: { task: ApiTask; project: ApiProject | undefined; companyId: string; busy: boolean; error: string; isAdmin: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>) => Promise<void>; onRevisePlan: (input: PlanRevisionInput) => Promise<void>; onContinueWork: (reason: string) => Promise<void>; onResolveDecisionBlocker: (answer: string) => Promise<void>; onMarkReady: () => Promise<void>; onMerge: () => Promise<void>; onDuplicate: () => Promise<void>; onUpdateDetails: (input: { title?: string; description?: string }) => Promise<void>; onRefresh: () => Promise<void>; onRescue: () => Promise<RescueReport> }): ReactElement {
  const approveCommand = task.commands.find((command) => command.name === "approve_plan");
  const revisionCommand = task.commands.find((command) => command.name === "request_plan_revision");
  const blockerCommand = task.commands.find((command) => command.name === "respond_plan_blocker");
  const visibleLeadPlan = task.leadOutput && (task.leadOutput.content.kind !== "decision_blocker" || !task.governance.blocker) ? task.leadOutput : undefined;
  const exactApproveCommand = approveCommand ? { endpoint: approveCommand.endpoint, expectedRevision: approveCommand.expectedRevision } : undefined;
  const exactRevisionCommand = revisionCommand ? { endpoint: revisionCommand.endpoint, expectedRevision: revisionCommand.expectedRevision } : undefined;
  const decisionControls = task.phase === "approval" && (exactApproveCommand || exactRevisionCommand) ? <PlanDecisionForm key={task.revision} {...(exactApproveCommand ? { approveCommand: exactApproveCommand } : {})} {...(exactRevisionCommand ? { revisionCommand: exactRevisionCommand } : {})} busy={busy} onSubmit={(payload) => onPlanAction(payload.command.endpoint as TaskPlanAction, payload.note, { idempotencyKey: payload.idempotencyKey })} error={error} /> : null;
  const [developerEventState, setDeveloperEventState] = useState<DeveloperEventState>({ executionId: null, events: [], terminalSteps: {} });
  const [developerLiveness, setDeveloperLiveness] = useState<(DevelopmentState & { lastHeartbeatAt: string | null }) | undefined>();
  const [developmentNow, setDevelopmentNow] = useState(Date.now());
  useEffect(() => {
    setDeveloperEventState({ executionId: null, events: [], terminalSteps: {} });
    setDeveloperLiveness(undefined);
  }, [task.id]);
  const handleDevelopmentStatus = useCallback((status: string, execution: DevelopmentExecution | null): void => {
    const executionId = execution?.id ?? null;
    setDeveloperEventState((current) => current.executionId === executionId ? current : { executionId, events: [], terminalSteps: {} });
    setDeveloperLiveness(execution ? { status, execution, lastHeartbeatAt: execution.lastHeartbeatAt } : undefined);
  }, []);
  useEffect(() => {
    setDevelopmentNow(Date.now());
    const execution = developerLiveness?.execution;
    if (!execution || execution.finishedAt || !["starting", "running", "cancelling"].includes(developerLiveness?.status ?? "")) return;
    const timer = window.setInterval(() => setDevelopmentNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [developerLiveness?.execution?.id, developerLiveness?.execution?.finishedAt, developerLiveness?.status]);
  const appendDeveloperEvents = useCallback((executionId: string, events: DeveloperExecutionEventView[]): void => setDeveloperEventState((current) => {
    const selected = current.executionId === executionId ? current : { executionId, events: [], terminalSteps: {} };
    const terminalSteps = { ...selected.terminalSteps };
    for (const event of events) if (event.stepNumber !== null && ["step_completed", "step_blocked"].includes(event.kind)) terminalSteps[event.stepNumber] = event.kind === "step_completed" ? "completed" : "blocked";
    return { executionId, terminalSteps, events: [...selected.events, ...events].filter((event, index, all) => all.findIndex((candidate) => candidate.eventId === event.eventId) === index).slice(-100) };
  }), []);
  const [answer, setAnswer] = useState("");
  useEffect(() => { setAnswer(""); }, [task.id, task.revision]);
  const [changesFileCount, setChangesFileCount] = useState<number | undefined>(undefined);
  useEffect(() => { setChangesFileCount(undefined); }, [task.id, task.developerExecution?.id]);
  const [activeWorkTab, setActiveWorkTab] = useState("activity");
  const [diffScrollRequest, setDiffScrollRequest] = useState(0);
  const diffPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!diffScrollRequest) return;
    const frame = window.requestAnimationFrame(() => diffPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [diffScrollRequest]);
  const openDiff = useCallback(() => {
    setActiveWorkTab("diffs");
    setDiffScrollRequest((request) => request + 1);
  }, []);
  const leadPlanProps = visibleLeadPlan ? { output: visibleLeadPlan, ...(decisionControls ? { decisionControls } : {}), ...(task.developerExecution ? { stepProgress: { taskId: task.id, execution: task.developerExecution, repository: project?.repository, events: developerEventState.executionId === task.developerExecution.id ? developerEventState.events : [], terminalSteps: developerEventState.executionId === task.developerExecution.id ? developerEventState.terminalSteps : {} } } : {}) } : undefined;
  const leadPlan = leadPlanProps ? <TaskLeadPlan {...leadPlanProps} /> : undefined;
  const currentPlan = decisionControls && leadPlan ? leadPlan : undefined;
  const activityCount = task.activity.length;
  const activityContent = <>
    <TaskActivity taskId={task.id} timeline={task.activity} release={task.release} ci={task.ci} onViewChanges={openDiff} />
  </>;
  const developerExecution = task.developerExecution;
  const hasChanges = developerExecution !== undefined;
  const pollDeveloperDiff = ["development", "repair_required", "ci_repairing"].includes(task.phase);
  const hasChecks = Boolean(task.ci);
  const pullRequestInMain = Boolean(task.release?.pullRequestUrl && task.release.pullRequestNumber !== null) && (["releasing", "ci_waiting", "final_review", "ready_reconciliation", "manual_merge", "done"].includes(task.phase) || task.phase === "delivery_blocked" && task.allowedCommands.includes("reconcile_ci"));
  const workContent = <>
    <TabsList variant="line" className="mb-4 w-full justify-start rounded-none border-b border-border p-0">
      <TabsTrigger value="activity">Activity <Badge variant="secondary" className="size-5 rounded-full px-0 text-[10px]">{activityCount}</Badge></TabsTrigger>
      <TabsTrigger value="diffs" disabled={!hasChanges} aria-label="Diffs">
        Diffs
        {hasChanges && changesFileCount != null && changesFileCount > 0 ? <Badge variant="secondary" className="size-5 rounded-full px-0 text-[10px]">{changesFileCount}</Badge> : null}
      </TabsTrigger>
      <TabsTrigger value="checks" disabled={!hasChecks}>Checks</TabsTrigger>
      <TabsTrigger value="other">Other</TabsTrigger>
    </TabsList>
    <TabsContent value="activity" className="space-y-7">{activityContent}</TabsContent>
    {hasChanges ? <TabsContent value="diffs" keepMounted><div ref={diffPanelRef} data-task-diff-panel className="scroll-mt-24"><DeveloperDiff taskId={task.id} executionId={task.developerExecution!.id} poll={pollDeveloperDiff} onFileCount={setChangesFileCount} /></div></TabsContent> : null}
    {hasChecks ? <TabsContent value="checks"><CiPanel ci={task.ci!} /></TabsContent> : null}
  </>;
  return (
    <ApplicationFrame title={task.issueKey ? `${task.issueKey} · ${task.title}` : task.title} headerActions={<TaskOptions canCancel={task.allowedCommands.includes("cancel_issue")} busy={busy || task.projection.status === "lagging"} resyncBusy={busy} onCancel={() => void onPlanAction("cancel")} onDuplicate={() => void onDuplicate()} onResync={() => void onPlanAction("resync-projection")} />}>
      <article data-task-detail className="min-w-0">
        <div data-task-body className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            <header className="px-4 pt-4 pb-3 sm:px-6 lg:px-10">
              <div data-task-header-content className="mx-auto max-w-4xl space-y-4">
                <h2 className="min-w-0"><InlineTaskEditor field="title" value={task.title} onSave={async (title) => onUpdateDetails({ title })} /></h2>
              </div>
            </header>
            <div data-task-content className="min-w-0 px-4 pt-4 pb-6 sm:px-6 lg:px-10">
              <div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
                <InlineTaskEditor field="description" value={task.description} onSave={async (description) => onUpdateDetails({ description })} />
                {task.images.length ? <TaskMediaRow taskId={task.id} images={task.images} /> : null}
                <div data-task-current className="-mx-4 border-y border-border/70 bg-background px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
                  <div className="mx-auto max-w-4xl space-y-4">
                    <PlanningRunCard task={task} />
                    {task.phase === "planning" ? <LiveExecutionRun taskId={task.id} eventPath="planning-events" activityLabel="Planner" onRefresh={onRefresh} /> : null}
                    {pullRequestInMain ? <div data-active-pull-request><PullRequestCard task={task} busy={busy} onMarkReady={onMarkReady} {...(task.allowedCommands.includes("reconcile_ci") ? { onCheckCi: () => onPlanAction("reconcile-ci") } : {})} {...(task.allowedCommands.includes("reconcile_merge") ? { onMerge, onCheckMerge: () => onPlanAction("reconcile-merge") } : {})} /></div> : <TaskActions task={task} busy={busy} onStartPlanning={onStartPlanning} onPlanAction={onPlanAction} onRevisePlan={onRevisePlan} onContinueWork={onContinueWork} onOpenDiff={openDiff} />}
                    <RescueControls task={task} busy={busy} onRescue={onRescue} />
                    {task.developerRecovery ? <DeveloperRecoveryStatus taskId={task.id} recovery={task.developerRecovery} allowedCommands={task.allowedCommands} busy={busy} isAdmin={isAdmin} developmentStatus={developerLiveness ? <DevelopmentStatus state={developerLiveness} now={developmentNow} inline /> : undefined} onAction={async (action: DeveloperRecoveryAction) => onPlanAction(action)}><LiveExecutionRun taskId={task.id} eventPath="development-events" activityLabel="Builder" onStatus={handleDevelopmentStatus} onEvents={appendDeveloperEvents} onRefresh={onRefresh} compact /></DeveloperRecoveryStatus> : <LiveExecutionRun taskId={task.id} eventPath="development-events" activityLabel="Builder" onStatus={handleDevelopmentStatus} onEvents={appendDeveloperEvents} onRefresh={onRefresh} />}
                    {task.developerExecution ? <DeveloperEvidence execution={task.developerExecution} onViewChanges={openDiff} /> : null}
                    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
                    {currentPlan ?? decisionControls}
                    {task.governance.blocker && blockerCommand ? <PlanBlockerResponseForm blocker={task.governance.blocker} expectedRevision={blockerCommand.expectedRevision} busy={busy} onSubmit={(payload) => onPlanAction(blockerCommand.endpoint as TaskPlanAction, undefined, { answer: payload.answer, idempotencyKey: payload.idempotencyKey, expectedWorkflowRevision: payload.expectedWorkflowRevision })} error={error} /> : task.governance.blocker ? <section className="space-y-1" data-plan-blocker><h3 className="text-xs font-semibold">{task.governance.blocker.header}</h3><p className="text-[13px]">{task.governance.blocker.question}</p><p className="text-[12px] text-muted-foreground">{task.governance.blocker.nextAction}</p></section> : null}
                    {task.leadOutput?.content.kind === "decision_blocker" && task.allowedCommands.includes("resolve_decision_blocker") ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void onResolveDecisionBlocker(answer); }}><FieldLabel htmlFor="decision-answer">Decision</FieldLabel><Textarea id="decision-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer the Planner's question" maxLength={8000} /><Button size="sm" type="submit" disabled={busy || !answer.trim()}>{busy ? "Saving…" : "Resolve decision"}</Button></form> : null}
                  </div>
                </div>
                <Tabs data-task-work-tabs value={activeWorkTab} onValueChange={setActiveWorkTab}>
                  {workContent}
                  <TabsContent value="other" className="space-y-4">
                <TaskConfigurationCard task={task} />
                <DeliveryChecksCard task={task} />
                <ReviewersTakeCard task={task} />
                {hasChecks ? <CiDiagnostics ci={task.ci!} /> : null}
                {task.release ? <ReleasePanel task={task} /> : null}
                {task.targetBaseReconciliation.status ? <Card size="sm" aria-label="Target-base reconciliation">
                  <CardHeader>
                    <CardTitle><h3>Target-base reconciliation</h3></CardTitle>
                    <CardDescription>{task.targetBaseReconciliation.checkpoint ?? "checkpoint unavailable"}{task.targetBaseReconciliation.conflictFileCount !== null ? ` · ${task.targetBaseReconciliation.conflictFileCount} conflict files` : ""}</CardDescription>
                    <CardAction><Badge variant={task.targetBaseReconciliation.status === "blocked" ? "destructive" : "secondary"}>{task.targetBaseReconciliation.status}</Badge></CardAction>
                  </CardHeader>
                  <CardContent>
                    {task.targetBaseReconciliation.releaseId && task.targetBaseReconciliation.pullRequestUrl ? <div className="text-[11px]"><a className="underline" href={task.targetBaseReconciliation.pullRequestUrl} target="_blank" rel="noreferrer">Open pull request</a></div> : null}
                    {task.targetBaseReconciliation.summary ? <div className="text-[12px] text-muted-foreground">{task.targetBaseReconciliation.summary}</div> : null}
                  </CardContent>
                </Card> : null}
                <FinalGatePanel task={task} />
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </div>
          <aside data-task-properties className="border-border border-t bg-muted/20 px-4 py-6 sm:px-6 lg:sticky lg:top-0 lg:h-fit lg:border-t-0 lg:border-l">
            <div className="mb-6 space-y-4">{pullRequestInMain ? null : <PullRequestCard task={task} busy={busy} onMarkReady={onMarkReady} />}<TaskProgress phase={task.phase} allowedCommands={task.allowedCommands} createdAt={task.createdAt} updatedAt={task.updatedAt} timeline={task.timeline} agentInvocations={task.agentInvocations} activeCapacity={task.capacity?.status === "active" ? task.capacity : undefined} developerLiveness={developerLiveness} /></div>
            <TaskAgentAssignments task={task} onRefresh={onRefresh} />
            <h3 className="mb-5 text-xs font-semibold">Properties</h3>
            <dl className="space-y-4 text-xs">
              <div className="space-y-1"><dt className="text-muted-foreground">Status</dt><dd><Badge variant="secondary" data-status={task.phase}><TaskStatus phase={task.phase} presentationPhase={taskPresentationPhase({ phase: task.phase, releaseStatus: task.release?.status, ciOutcome: task.ci?.outcome, allowedCommands: task.allowedCommands })} processing={taskIsProcessing({ phase: task.phase, agentInvocations: task.agentInvocations, capacityStatus: task.capacity?.status })} /></Badge></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Project</dt><dd>{project?.name ?? "Unknown project"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Owner</dt><dd>{workflowOwnerLabel(task)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Plan review</dt><dd>{task.autoApprovePlan ? "Auto-approved" : "Needs your approval"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Next action</dt><dd><NextAction value={task.pendingAction} /></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Sync</dt><dd>{task.projection.status === "lagging" ? "Updating" : "Up to date"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Created</dt><dd>{adminDate(task.createdAt)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Updated</dt><dd>{adminDate(task.updatedAt)}</dd></div>
              {task.issueKey ? <div className="space-y-1"><dt className="text-muted-foreground">Issue key</dt><dd><code>{task.issueKey}</code></dd></div> : null}
            </dl>
          </aside>
        </div>
      </article>
    </ApplicationFrame>
  );
}

export function TaskDetailsSkeleton(): ReactElement {
  return <ApplicationFrame title="Task"><div data-task-detail-loading className="grid gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_260px] lg:px-10" aria-busy="true" aria-label="Loading task"><div className="space-y-4"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-3/4" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div><div className="space-y-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-3/4" /></div></div></ApplicationFrame>;
}

export function TaskDetailsNotFound({ companyId, returnTo = "tasks" }: { companyId: string; returnTo?: "tasks" | "board" }): ReactElement {
  return <ApplicationFrame title="Task not found"><div className="space-y-3 px-4 py-8 sm:px-6 lg:px-10"><p className="text-xs text-muted-foreground">Task not found for this company.</p><a className="text-xs underline underline-offset-2" href={withCompany(`/${returnTo}`, companyId)}>Back to {returnTo === "board" ? "Board" : "Tasks"}</a></div></ApplicationFrame>;
}
