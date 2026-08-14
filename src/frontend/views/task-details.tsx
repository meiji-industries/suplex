import { File } from "@pierre/diffs/react";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card.js";
import { Collapsible } from "../components/ui/collapsible.js";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { ApplicationFrame } from "../components/app/application-frame.js";
import { getWorkerHealthFailure, useSystemHealth } from "../components/app/system-health.js";
import { TaskActivity, TaskHistory } from "../components/app/task-history.js";
import DeveloperDiff, { useAppThemeType } from "../components/app/developer-diff.js";
import { TaskLeadPlan } from "../components/app/task-lead-plan.js";
import { invocationActorLabel } from "../components/app/task-invocations.js";
import { TaskProgress } from "../components/app/task-progress.js";
import { taskIsProcessing, taskPresentationPhase, TaskStatus } from "../components/app/task-status.js";
import { DeveloperRecoveryStatus } from "../components/app/developer-recovery-status.js";
import type { DeveloperRecoveryAction } from "../components/app/developer-recovery-actions.js";
import { MaterialitySummary } from "../components/app/materiality-summary.js";
import { CommitSha } from "../components/app/commit-sha.js";
import { PlanBlockerResponseForm } from "../components/app/plan-blocker-response-form.js";
import { PlanDecisionForm } from "../components/app/plan-decision-form.js";
import { PlanSubjectSummary } from "../components/app/plan-subject-summary.js";
import { SupplementalReviewPanel } from "../components/app/supplemental-review-panel.js";
import { ProfileAvatar } from "../components/app/profile-avatar.js";
import type { DeveloperExecutionEventView } from "../components/tasks/developer-evidence.js";
import { adminDate, type ApiAgent, type ApiCi, type ApiProject, type ApiTask } from "../lib/view-shared.js";
import { readJson, withCompany } from "../lib/api.js";
import type { IssueCommandSlug } from "../../commands/registry.js";
import { releaseFailureCopy } from "../../release-failures.js";
import { Check, Copy, Ellipsis, ExternalLink, GitPullRequest, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

type DevelopmentExecution = { id: string | null; status: string; startedAt: string; finishedAt: string | null; lastHeartbeatAt: string | null; currentStep: number | null };
type DevelopmentState = { status: string; execution: DevelopmentExecution | null };
type DeveloperEventState = { executionId: string | null; events: DeveloperExecutionEventView[]; terminalSteps: Record<number, "completed" | "blocked"> };

function NextAction({ value }: { value: string | null }): ReactElement {
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

function DevelopmentStatus({ state, now, inline = false }: { state: DevelopmentState; now: number; inline?: boolean }): ReactElement {
  const execution = state.execution;
  const active = ["starting", "running", "cancelling"].includes(state.status);
  const freshnessAt = execution?.lastHeartbeatAt ?? execution?.startedAt;
  const stale = active && Boolean(freshnessAt && now - Date.parse(freshnessAt) > 15_000);
  const label = stale ? "No recent heartbeat" : state.status === "starting" ? "In Progress" : state.status === "result_pending_claim" ? "Finishing development" : state.status === "running" ? "Running" : state.status === "cancelling" ? "Cancelling" : state.status === "queued" ? "Queued" : state.status === "rate_limited" ? "Rate limited" : state.status === "completed" ? "Completed" : state.status === "blocked" ? "Blocked" : state.status === "failed" ? "Failed" : state.status;
  const elapsed = execution ? formatDuration((execution.finishedAt ? Date.parse(execution.finishedAt) : now) - Date.parse(execution.startedAt)) : "—";
  const content = <><span className="flex items-center gap-1.5" role="status" aria-live="polite">{active && Boolean(execution?.lastHeartbeatAt) && !stale ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}<span>{label}</span>{execution?.currentStep ? <span className="text-muted-foreground">Step {execution.currentStep}</span> : null}</span><span className="tabular-nums text-muted-foreground">{elapsed}</span></>;
  return inline ? <span className="inline-flex items-center gap-x-3 text-xs font-normal">{content}</span> : <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{content}</div>;
}

function DevelopmentRun({ taskId, onStatus, onEvents, onRefresh, compact = false }: { taskId: string; onStatus: (status: string, execution: DevelopmentExecution | null) => void; onEvents: (executionId: string, events: DeveloperExecutionEventView[]) => void; onRefresh: () => Promise<void>; compact?: boolean }): ReactElement | null {
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
    const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/development-events`);
    stream.addEventListener("status", (message) => { try { const next = JSON.parse((message as MessageEvent<string>).data) as { status: string; execution: DevelopmentExecution | null }; const nextId = next.execution?.id ?? null; if (nextId !== executionId.current) setActivity([]); executionId.current = nextId; onStatus(next.status, next.execution); setState(next); } catch { /* Keep the last safe status. */ } });
    stream.addEventListener("progress", (message) => { try { const event = JSON.parse((message as MessageEvent<string>).data) as DeveloperExecutionEventView; setActivity((current) => [...current, event].slice(-20)); if (executionId.current) onEvents(executionId.current, [event]); } catch { /* Ignore malformed server events. */ } });
    return () => stream.close();
  }, [taskId, onEvents, onStatus]);
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
  return <section className="space-y-2 text-xs" data-development-run>{!compact ? <DevelopmentStatus state={state} now={now} /> : null}{visibleActivity.length ? <div className="space-y-1" data-developer-activity><h3 className="font-medium">Implementer activity</h3><ol className="space-y-1 text-[11px] text-muted-foreground">{visibleActivity.map((event, index) => <DeveloperActivityLine event={event} open={index === lastOutputIndex} key={event.eventId} />)}</ol></div> : null}</section>;
}

export type TaskPlanAction = Exclude<IssueCommandSlug, "revise-plan" | "continue-work" | "record-progress" | "resolve-decision-blocker"> | "reject-plan";
export type PlanRevisionInput = { worktreeDisposition: "reuse" | "new"; reason: string; exactBaseSha?: string };

export function nextPullRequestReviewAction(allowedCommands: ApiTask["allowedCommands"]): TaskPlanAction | undefined {
  if (allowedCommands.includes("review_delivery")) return "review-delivery";
  if (allowedCommands.includes("final_review")) return "final-review";
  return undefined;
}

function PublicationPreview({ release }: { release: NonNullable<ApiTask["release"]> | null | undefined }): ReactElement {
  const description = release?.bodyPreview?.trim() ?? "";
  const descriptionIsLong = description.length > 240 || description.split(/\r?\n/).length > 3;
  return <section data-task-publication-preview className="space-y-2 border-t pt-3">
    <h4 className="text-xs font-medium">What will be published?</h4>
    {release ? <dl className="space-y-2 text-[11px]">
      <div><dt className="text-muted-foreground">PR title</dt><dd className="break-words text-[12px]">{release.title}</dd></div>
      <div><dt className="text-muted-foreground">PR description</dt><dd className={descriptionIsLong ? "relative max-h-[3.75rem] overflow-hidden" : undefined}><p className="whitespace-pre-wrap break-words leading-5 text-[12px] text-muted-foreground">{description || "Description is not available."}</p>{descriptionIsLong ? <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent" /> : null}</dd></div>
      <div><dt className="text-muted-foreground">Target</dt><dd className="break-words"><code>{release.headBranch}</code> → <code>{release.baseBranch}</code> · {release.repository}</dd></div>
    </dl> : <p className="text-[12px] text-muted-foreground">Publication details are not available yet.</p>}
  </section>;
}

export function TaskActions({ task, project, busy, onStartPlanning, onPlanAction, onRevisePlan, onContinueWork, onOpenDiff }: { task: ApiTask; project?: ApiProject | undefined; busy: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>) => Promise<void>; onRevisePlan: (input: PlanRevisionInput) => Promise<void>; onContinueWork: (reason: string) => Promise<void>; onOpenDiff?: () => void }): ReactElement {
  const { snapshot: healthSnapshot } = useSystemHealth();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");
  const [worktreeDisposition, setWorktreeDisposition] = useState<"reuse" | "new">(task.developerExecution ? "reuse" : "new");
  const [exactBaseSha, setExactBaseSha] = useState("");
  const [continueOpen, setContinueOpen] = useState(false);
  const [continueReason, setContinueReason] = useState("");
  const disabled = busy || task.projection.status === "lagging" || Boolean(getWorkerHealthFailure(healthSnapshot));
  const canRevise = task.allowedCommands.includes("revise_plan");
  const canContinue = task.allowedCommands.includes("continue_work");
  const canReviewDelivery = task.allowedCommands.includes("review_delivery");
  const canPublishDraft = task.allowedCommands.includes("publish_draft");
  const canOpenDiff = task.developerExecution?.status === "completed";
  const resultCommit = task.developerExecution?.resultCommit;
  const supplementalCommand = task.commands.find((command) => command.name === "request_supplemental_review" && command.subject?.kind === "supplemental_review");
  const supplementalSubject = supplementalCommand?.subject?.kind === "supplemental_review" ? supplementalCommand.subject.value : undefined;
  const hasVisibleActions = Boolean(supplementalCommand) || canRevise || canContinue || task.allowedCommands.some((command) => !["cancel_issue", "approve_plan", "reject_plan", "request_plan_revision", "respond_plan_blocker", "resolve_decision_blocker"].includes(command));
  const recoveryOwnsActions = Boolean(task.developerRecovery && task.allowedCommands.some((command) => ["retry_development", "cancel_development", "verify_developer_ownership"].includes(command)));
  if (!hasVisibleActions || task.phase === "development" || recoveryOwnsActions) return <div data-task-actions />;
  return (
    <Card data-task-actions size="sm">
      <CardHeader>
        <CardTitle><h3>{canReviewDelivery ? "Review completed delivery" : task.pendingAction ?? "Next action"}</h3></CardTitle>
      </CardHeader>
      {canReviewDelivery ? <CardContent className="space-y-3" data-delivery-handoff>
        <div className="space-y-1">
          <h4 className="text-xs font-medium">What to do</h4>
          <p className="text-[12px] text-muted-foreground">Open Diffs and compare the diff with the task description and approved plan. Confirm the Developer verification evidence, then approve the delivery to continue to release or request changes to send it back.</p>
        </div>
        <dl className="grid min-w-0 gap-2 text-[11px] sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Repository</dt><dd className="break-all">{project?.repository ?? "Unavailable"}{project?.repositoryPath ? <><br /><code>{project.repositoryPath}</code></> : null}</dd></div>
          <div><dt className="text-muted-foreground">Worktree</dt><dd className="break-all"><code>{task.developerExecution?.worktreePath ?? "Unavailable"}</code></dd></div>
          <div><dt className="text-muted-foreground">Branch</dt><dd className="break-all"><code>{task.developerExecution?.branchName ?? "Unavailable"}</code></dd></div>
          <div><dt className="text-muted-foreground">Delivered commit</dt><dd>{resultCommit ? <CommitSha sha={resultCommit} abbreviated={`${resultCommit.slice(0, 12)}…`} repository={project?.repository} /> : "Not recorded"}</dd></div>
        </dl>
      </CardContent> : null}
      {canPublishDraft ? <CardContent className="space-y-3" data-task-publish-preview><PublicationPreview release={task.release} /></CardContent> : null}
      {(revisionOpen || continueOpen) ? <CardContent>
        {revisionOpen ? <form className="max-w-xl space-y-3 border-l-2 pl-3" onSubmit={(event) => { event.preventDefault(); void onRevisePlan({ worktreeDisposition, reason: revisionReason, ...(worktreeDisposition === "new" ? { exactBaseSha } : {}) }); }}>
          <Field><FieldLabel htmlFor="revision-reason">Why revise this plan?</FieldLabel><Textarea id="revision-reason" required value={revisionReason} onChange={(event) => setRevisionReason(event.target.value)} placeholder="Describe the changed requirement or observed problem." /></Field>
          <FieldSet><FieldLegend>Worktree</FieldLegend><FieldGroup>
            <label className="flex items-center gap-2 text-xs"><input name="worktree-disposition" type="radio" checked={worktreeDisposition === "reuse"} onChange={() => setWorktreeDisposition("reuse")} disabled={!task.developerExecution} /> Reuse the verified clean worktree {task.developerExecution ? <span className="text-muted-foreground">({task.developerExecution.branchName})</span> : <span className="text-muted-foreground">(unavailable)</span>}</label>
            <label className="flex items-center gap-2 text-xs"><input name="worktree-disposition" type="radio" checked={worktreeDisposition === "new"} onChange={() => setWorktreeDisposition("new")} /> Start from an exact base commit</label>
            {worktreeDisposition === "new" ? <Field><FieldLabel htmlFor="revision-base-sha">Exact base SHA</FieldLabel><Input id="revision-base-sha" required value={exactBaseSha} onChange={(event) => setExactBaseSha(event.target.value)} placeholder="40–64 character commit SHA" /></Field> : null}
          </FieldGroup></FieldSet>
          <Button type="submit" size="sm" disabled={disabled || !revisionReason.trim() || (worktreeDisposition === "reuse" && !task.developerExecution) || (worktreeDisposition === "new" && !exactBaseSha.trim())}>{busy ? "Submitting…" : "Submit revision"}</Button>
        </form> : null}
        {continueOpen ? <form className="max-w-xl space-y-3 border-l-2 pl-3" onSubmit={(event) => { event.preventDefault(); void onContinueWork(continueReason); }}><Field><FieldLabel htmlFor="continue-reason">Why continue this work?</FieldLabel><Textarea id="continue-reason" required value={continueReason} onChange={(event) => setContinueReason(event.target.value)} placeholder="Describe the next bounded outcome." /></Field><Button type="submit" size="sm" disabled={disabled || !continueReason.trim()}>{busy ? "Creating successor…" : "Create successor"}</Button></form> : null}
      </CardContent> : null}
      <CardFooter>
        <div className="flex w-full flex-wrap justify-end gap-2">
      {task.allowedCommands.includes("start_planning") ? <Button size="sm" onClick={() => void onStartPlanning()} disabled={disabled}>{busy ? "Planning…" : task.phase === "failed" ? "Retry planning" : "Start planning"}</Button> : null}
      {supplementalCommand && supplementalSubject ? <Button size="sm" variant="outline" onClick={() => void onPlanAction(supplementalCommand.endpoint as TaskPlanAction, undefined, { subject: supplementalSubject, idempotencyKey: crypto.randomUUID() })} disabled={disabled}>Request review</Button> : null}
      {task.allowedCommands.includes("start_development") ? <Button size="sm" onClick={() => void onPlanAction("start-development")} disabled={disabled}>{busy ? "Executing…" : "Start development"}</Button> : null}
      {!task.developerRecovery && task.allowedCommands.includes("retry_development") ? <Button size="sm" onClick={() => void onPlanAction("retry-development")} disabled={disabled}>{busy ? "Retrying…" : "Retry development"}</Button> : null}
      {!task.developerRecovery && task.allowedCommands.includes("cancel_development") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("cancel-development")} disabled={disabled}>Cancel development</Button> : null}
      {canReviewDelivery ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("reject-plan", "Member requested delivery changes")} disabled={disabled}>Request Changes</Button> : null}
      {(canReviewDelivery || canPublishDraft) && onOpenDiff ? <Button size="sm" variant="outline" onClick={onOpenDiff} disabled={disabled || !canOpenDiff}>Diff</Button> : null}
      {canReviewDelivery ? <Button size="sm" onClick={() => void onPlanAction("review-delivery")} disabled={disabled}>{busy ? "Reviewing…" : "Approve delivery"}</Button> : null}
      {task.allowedCommands.includes("repair_delivery") ? <Button size="sm" onClick={() => void onPlanAction("repair-delivery")} disabled={disabled}>{busy ? "Repairing…" : "Repair delivery"}</Button> : null}
      {task.allowedCommands.includes("record_delivery_decision") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("record-delivery-decision", "Member decision recorded")} disabled={disabled}>Record decision</Button> : null}
      {task.allowedCommands.includes("retry_capacity") ? <Button size="sm" onClick={() => void onPlanAction("retry-capacity")} disabled={disabled}>Retry capacity</Button> : null}
      {task.allowedCommands.includes("accept_delivery") ? <Button size="sm" onClick={() => void onPlanAction("accept-delivery")} disabled={disabled}>{busy ? "Publishing…" : "Publish"}</Button> : null}
      {task.allowedCommands.includes("publish_draft") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("publish-draft")} disabled={disabled}>{busy ? "Publishing…" : task.release?.status === "blocked" ? "Retry release" : "Publish Draft"}</Button> : null}
      {task.allowedCommands.includes("resolve_merge_conflict") ? <Button size="sm" onClick={() => void onPlanAction("resolve-merge-conflict")} disabled={disabled}>{busy ? "Resolving…" : "Resolve conflicts"}</Button> : null}
      {task.allowedCommands.includes("retry_target_base_reconciliation") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("retry-target-base-reconciliation")} disabled={disabled}>{busy ? "Retrying…" : "Retry reconciliation"}</Button> : null}
      {task.allowedCommands.includes("retry_forward_merge_verification") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("retry-forward-merge-verification")} disabled={disabled}>{busy ? "Verifying…" : "Retry verification"}</Button> : null}
      {task.allowedCommands.includes("reconcile_ci") ? <Button size="sm" onClick={() => void onPlanAction("reconcile-ci")} disabled={disabled}>{busy ? "Checking…" : "Check CI"}</Button> : null}
      {task.allowedCommands.includes("repair_ci") ? <Button size="sm" onClick={() => void onPlanAction("repair-ci")} disabled={disabled}>{busy ? "Repairing…" : "Repair CI"}</Button> : null}
      {task.allowedCommands.includes("final_review") ? <Button size="sm" onClick={() => void onPlanAction("final-review")} disabled={disabled}>{busy ? "Reviewing…" : "Final review"}</Button> : null}
      {task.allowedCommands.includes("request_delivery_changes") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("request-delivery-changes", "Member requested delivery changes")} disabled={disabled}>Request Changes</Button> : null}
      {task.allowedCommands.includes("reconcile_acceptance") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("reconcile-acceptance")} disabled={disabled}>{busy ? "Checking…" : "Reconcile ready state"}</Button> : null}
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
      <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground"><CommitSha sha={release.reviewedCommit.full} abbreviated={release.reviewedCommit.abbreviated} repository={release.repository} /><code title={release.reviewedTree.full}>{release.reviewedTree.abbreviated}</code></div>
      {release.pullRequestUrl ? <a className="text-xs underline underline-offset-2" href={release.pullRequestUrl} target="_blank" rel="noreferrer">Pull request #{release.pullRequestNumber}</a> : null}
      {release.failureSummary ? <Alert variant="destructive"><AlertDescription>{release.failureCode ? releaseFailureCopy[release.failureCode] ?? "Release publication is blocked." : release.failureSummary}{release.retryAt ? ` Retry after ${adminDate(release.retryAt)}.` : ""}</AlertDescription></Alert> : null}
      {release.operation ? <div className="text-[11px] text-muted-foreground">{release.operation.kind} · attempt {release.operation.attempt ?? "—"} · {release.operation.status}</div> : null}
      <Collapsible.Root>
        <Collapsible.Trigger className="text-xs underline underline-offset-2">Preview title and body</Collapsible.Trigger>
        <Collapsible.Panel className="mt-2 min-w-0 whitespace-pre-wrap break-words border-l pl-3 text-[11px] text-muted-foreground">{release.title}{release.bodyPreview ? `\n\n${release.bodyPreview}` : "\n\nBody is not available."}</Collapsible.Panel>
      </Collapsible.Root>
    </CardContent>
  </Card>;
}

function PullRequestCard({ task, busy, onMarkReady, onCheckCi }: { task: ApiTask; busy: boolean; onMarkReady: () => Promise<void>; onCheckCi?: () => Promise<void> }): ReactElement | null {
  const release = task.release;
  if (!release?.pullRequestUrl || release.pullRequestNumber === null) return null;
  const providerState = task.deliveryGate?.release.state;
  const status = providerState === "merged" ? "Merged" : providerState === "closed" ? "Closed" : providerState === "ready" || !release.isDraft ? "Open" : "Draft";
  const checks = task.ci?.outcome ?? task.ci?.status;
  const branchComparison = `${release.headBranch} → ${release.baseBranch}`;
  return <Card data-pull-request-card size="sm" aria-label={`Pull request #${release.pullRequestNumber}`}>
    <CardHeader>
      <CardTitle><span className="min-w-0 break-words">{release.title}</span></CardTitle>
      <CardDescription><span className="flex items-center gap-1.5"><a className="inline-flex items-center gap-1.5 underline underline-offset-2" href={release.pullRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest aria-hidden="true" className="size-4 shrink-0" />#{release.pullRequestNumber}</a><Badge variant={status === "Open" ? "outline" : "secondary"}>{status}</Badge></span></CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><code className="min-w-0 flex-1 truncate font-mono" title={branchComparison}>{branchComparison}</code><CopyBranchButton value={branchComparison} /></div>
      {checks ? <div className="text-xs"><span className="text-muted-foreground">Checks</span> · {checks.replaceAll("_", " ")}</div> : null}
    </CardContent>
    <CardFooter>
      <div className="flex w-full items-center gap-2">
        {release.isDraft ? <Button size="sm" onClick={() => void onMarkReady()} disabled={busy}>{busy ? "Ready…" : "Ready"}</Button> : null}
        {onCheckCi ? <Button size="sm" variant="outline" onClick={() => void onCheckCi()} disabled={busy}>{busy ? "Checking…" : "Check CI"}</Button> : null}
        <Button render={<a href={release.pullRequestUrl} target="_blank" rel="noreferrer" />} variant="outline" size="sm">Open PR<ExternalLink aria-hidden="true" /></Button>
      </div>
    </CardFooter>
  </Card>;
}

function CopyBranchButton({ value }: { value: string }): ReactElement {
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
  return <span className="shrink-0"><Button variant="ghost" size="icon-xs" aria-label="Copy branch comparison" title="Copy to clipboard" onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</Button>{copied ? <span className="pointer-events-none fixed bottom-4 right-4 z-50 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground" role="status" aria-live="polite">Copied to Clipboard</span> : null}</span>;
}

function CiDiagnostics({ task, ci }: { task: ApiTask; ci: ApiCi }): ReactElement {
  const latestAttempt = ci.attempts[0];
  return <div className="space-y-4" data-task-ci-diagnostics>
    <Card size="sm" aria-label="Exact-head CI">
      <CardHeader>
        <CardTitle><h3>Exact-head CI</h3></CardTitle>
        <CardDescription>{ci.repository} · PR #{ci.pullRequestNumber} · {ci.baseBranch} ← {ci.headBranch}</CardDescription>
        <CardAction><Badge variant={ci.outcome === "failed" ? "destructive" : "secondary"}>{ci.outcome ?? ci.status}</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <a className="text-xs underline" href={ci.pullRequestUrl} target="_blank" rel="noreferrer">Open pull request #{ci.pullRequestNumber}</a>
        <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2"><span>Expected <CommitSha sha={ci.expectedHeadSha} abbreviated={`${ci.expectedHeadSha.slice(0, 10)}…`} repository={ci.repository} /></span><span>Observed <CommitSha sha={latestAttempt?.observedHeadSha} abbreviated={latestAttempt?.observedHeadSha ? `${latestAttempt.observedHeadSha.slice(0, 10)}…` : "—"} repository={ci.repository} /></span><span>Revision {ci.policy.projectRevisionId.slice(0, 10)}… · policy {ci.policyHash.slice(0, 8)}…</span><span>{ci.baseBranch} → {ci.headBranch}</span></div>
      </CardContent>
    </Card>
    <Card size="sm" aria-label="CI run details">
      <CardHeader>
        <CardTitle><h3>Run details</h3></CardTitle>
        <CardDescription>Retry window, deadlines, ownership, and evidence</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><span>Next retry {ci.nextRetryAt ? adminDate(ci.nextRetryAt) : "—"}</span><span>Propagation {ci.propagationDeadline ? adminDate(ci.propagationDeadline) : "—"}</span><span>Overall deadline {ci.overallDeadline ? adminDate(ci.overallDeadline) : "—"}</span><span>Owner {ci.owner ?? "—"}</span></div>
        {ci.reason || latestAttempt?.summary ? <p className="break-words text-[12px]">{ci.reason ? `${ci.reason}: ` : ""}{latestAttempt?.summary ?? ""}</p> : null}
      </CardContent>
      <CardFooter>
        <div className="flex flex-wrap gap-2 text-[11px]">{latestAttempt?.evidenceArtifactId ? <a className="underline" href={`/api/tasks/${task.id}/artifacts/${latestAttempt.evidenceArtifactId}`}>CI evidence</a> : null}{ci.repairPlan ? <a className="underline" href={`/api/tasks/${task.id}/artifacts/${ci.repairPlan.planArtifactId}`}>Repair plan · {ci.repairPlan.status}</a> : null}<span>Analyst continuity {ci.leadSessionContinuity ? "verified" : "—"}</span><span>Implementer continuity {ci.developerSessionContinuity ? "verified" : "—"}</span></div>
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
        <CardDescription>{ci.policy.requiredChecks.length} required check{ci.policy.requiredChecks.length === 1 ? "" : "s"} · exact-head evaluation</CardDescription>
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
        <div><dt className="text-muted-foreground">Exact identity</dt><dd className="break-all">base <CommitSha sha={gate.release.baseSha} repository={gate.release.repository} /> · head <CommitSha sha={gate.release.headSha} repository={gate.release.repository} /> · tree <code title={gate.release.headTree}>{gate.release.headTree.slice(0, 8)}…</code></dd></div>
        <div><dt className="text-muted-foreground">CI</dt><dd>{gate.ci ? `${gate.ci.status}: ${gate.ci.summary}` : "Not recorded"}</dd>{gate.ci?.checks.length ? <ul className="mt-1 space-y-0.5 text-muted-foreground">{gate.ci.checks.map((check) => <li key={check.name}>{check.name}: {check.conclusion ?? check.status}</li>)}</ul> : null}</div>
        <div><dt className="text-muted-foreground">Final review</dt><dd>{gate.finalReview ? `${gate.finalReview.outcome}: ${gate.finalReview.summary}` : "Not recorded"}</dd>{gate.finalReview ? <div className="text-muted-foreground">Analyst session: <span className="break-all">{gate.finalReview.sessionRef}</span></div> : null}</div>
        <div><dt className="text-muted-foreground">Acceptance</dt><dd>{gate.acceptance ? `${gate.acceptance.decision}: ${gate.acceptance.status} by ${gate.acceptance.actorUserId}` : "Not recorded"}</dd>{gate.acceptance ? <div className="text-muted-foreground">decided {adminDate(gate.acceptance.decidedAt)}{gate.acceptance.readyAt ? ` · ready ${adminDate(gate.acceptance.readyAt)}` : ""}</div> : null}</div>
        <div><dt className="text-muted-foreground">Merge</dt><dd>{gate.merge.outcome ?? "Not observed"}{gate.merge.observationId ? ` · observation ${gate.merge.observationId}` : ""}{gate.merge.observedAt ? ` · observed ${adminDate(gate.merge.observedAt)}` : ""}{gate.merge.mergedAt ? ` · merged ${adminDate(gate.merge.mergedAt)}` : ""}{gate.merge.receiptId ? ` · receipt ${gate.merge.receiptId}` : ""}</dd></div>
        <div><dt className="text-muted-foreground">Deployment</dt><dd>Deployment: unknown / out of scope</dd></div>
        </dl>
        {gate.finalReview?.findings.length ? <div className="space-y-2">{gate.finalReview.findings.map((finding) => <div className="text-[11px]" key={finding.id}><span className="font-medium">{finding.severity}</span> · {finding.rationale}</div>)}</div> : null}
        <div className="flex flex-wrap gap-3 text-[11px]">
          {gate.finalReview ? <><a className="underline underline-offset-2" href={`/api/tasks/${task.id}/artifacts/${gate.finalReview.opinionArtifactId}`}>Review opinion</a><a className="underline underline-offset-2" href={`/api/tasks/${task.id}/artifacts/${gate.finalReview.evidenceArtifactId}`}>Review evidence</a></> : null}
          {gate.acceptance?.reasonArtifactId ? <a className="underline underline-offset-2" href={`/api/tasks/${task.id}/artifacts/${gate.acceptance.reasonArtifactId}`}>Decision reason</a> : null}
          {gate.acceptance?.evidenceArtifactId ? <a className="underline underline-offset-2" href={`/api/tasks/${task.id}/artifacts/${gate.acceptance.evidenceArtifactId}`}>Acceptance evidence</a> : null}
          {gate.merge.evidenceArtifactId ? <a className="underline underline-offset-2" href={`/api/tasks/${task.id}/artifacts/${gate.merge.evidenceArtifactId}`}>Merge evidence</a> : null}
          {gate.merge.receiptArtifactId ? <a className="underline underline-offset-2" href={`/api/tasks/${task.id}/artifacts/${gate.merge.receiptArtifactId}`}>Completion receipt</a> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function TaskOptions({ canCancel, busy, onCancel }: { canCancel: boolean; busy: boolean; onCancel: () => void }): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Task options" title="Task options" />}><Ellipsis /></DropdownMenuTrigger>
      <DropdownMenuContent align="start">{canCancel ? <DropdownMenuItem variant="destructive" disabled={busy} onClick={onCancel}>Cancel task</DropdownMenuItem> : null}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function PlanningRunCard({ task }: { task: ApiTask }): ReactElement | null {
  const invocation = [...task.agentInvocations].reverse().find((candidate) => candidate.role === "analyst" && ["starting", "running", "cancelling"].includes(candidate.status));
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
  const agentName = invocation?.agentName ?? task.capacity?.agentName ?? "Analyst agent";
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
  const update = async (role: "analyst" | "implementer" | "reviewer", agentId: string): Promise<void> => {
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
  return <section className="mb-6 space-y-3" aria-label="Task agents"><h3 className="text-xs font-semibold">Agents</h3>{(["analyst", "implementer", "reviewer"] as const).map((role) => { const label = role.slice(0, 1).toUpperCase() + role.slice(1); const selected = agents.find((agent) => agent.id === task.roleAgents[role]); const options = agents.filter((agent) => agent.role === role); return <div className="space-y-1" key={role}><div className="text-xs text-muted-foreground">{label}</div><DropdownMenu><DropdownMenuTrigger render={<Button id={`task-agent-${role}`} type="button" variant="secondary" size="xs" disabled={savingRole === role} aria-busy={savingRole === role} aria-label={`${label} agent: ${selected?.name ?? "Unassigned"}`} />}>{selected ? <><ProfileAvatar name={selected.name} seed={selected.avatarSeed} size="xs" />{selected.name}</> : "Unassigned"}</DropdownMenuTrigger><DropdownMenuContent align="start">{options.map((agent) => <DropdownMenuItem key={agent.id} onClick={() => { if (agent.id !== selected?.id) void update(role, agent.id); }}><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><span className="min-w-0 flex-1 truncate">{agent.name}</span>{agent.id === selected?.id ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>; })}{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}</section>;
}

export function TaskDetailsPage({ task, project, companyId, busy, error, isAdmin, onStartPlanning, onPlanAction, onRevisePlan, onContinueWork, onResolveDecisionBlocker, onMarkReady, onRefresh }: { task: ApiTask; project: ApiProject | undefined; companyId: string; busy: boolean; error: string; isAdmin: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>) => Promise<void>; onRevisePlan: (input: PlanRevisionInput) => Promise<void>; onContinueWork: (reason: string) => Promise<void>; onResolveDecisionBlocker: (answer: string) => Promise<void>; onMarkReady: () => Promise<void>; onRefresh: () => Promise<void> }): ReactElement {
  const approveCommand = task.commands.find((command) => command.name === "approve_plan" && command.subject?.kind === "plan_decision");
  const revisionCommand = task.commands.find((command) => command.name === "request_plan_revision" && command.subject?.kind === "plan_decision");
  const blockerCommand = task.commands.find((command) => command.name === "respond_plan_blocker" && command.subject?.kind === "plan_blocker");
  const visibleLeadPlan = task.leadOutput && (task.leadOutput.content.kind !== "decision_blocker" || !task.governance.blocker) ? task.leadOutput : undefined;
  const visibleLeadPlanRevision = visibleLeadPlan ? task.planHistory.find((plan) => plan.outputArtifactId === visibleLeadPlan.outputArtifactId)?.revision : undefined;
  const completedPlanningRevision = [...task.activity].reverse().find((entry) => entry.eventType === "planning_started" && entry.metadata.planningStage === "completed")?.revision;
  const exactApproveCommand = approveCommand?.subject?.kind === "plan_decision" ? { endpoint: approveCommand.endpoint, expectedRevision: approveCommand.expectedRevision, subject: approveCommand.subject.value } : undefined;
  const exactRevisionCommand = revisionCommand?.subject?.kind === "plan_decision" ? { endpoint: revisionCommand.endpoint, expectedRevision: revisionCommand.expectedRevision, subject: revisionCommand.subject.value } : undefined;
  const decisionControls = task.phase === "approval" && (exactApproveCommand || exactRevisionCommand) ? <PlanDecisionForm key={task.revision} {...(exactApproveCommand ? { approveCommand: exactApproveCommand } : {})} {...(exactRevisionCommand ? { revisionCommand: exactRevisionCommand } : {})} busy={busy} onSubmit={(payload) => onPlanAction(payload.command.endpoint as TaskPlanAction, payload.note, { subject: payload.command.subject, idempotencyKey: payload.idempotencyKey })} error={error} /> : null;
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
  const activityPlanRevision = completedPlanningRevision ?? visibleLeadPlanRevision;
  const activityPlan = !currentPlan && leadPlanProps && activityPlanRevision != null ? { revision: activityPlanRevision, content: <TaskLeadPlan {...leadPlanProps} collapsible /> } : undefined;
  const activityCount = task.activity.length + (activityPlan && task.activity.some((entry) => entry.revision === activityPlan.revision) ? 1 : 0);
  const activityContent = <>
    <TaskActivity taskId={task.id} timeline={task.activity} agentInvocations={task.agentInvocations} processing={task.capacity?.status === "active" ? task.capacity : undefined} collapsePlan={!['backlog', 'planning', 'approval'].includes(task.phase)} deliveryReviewTask={task} repository={project?.repository} developerAttempts={task.developerExecutionHistory} ci={task.ci} {...(activityPlan ? { revisionContent: activityPlan } : {})} />
    {task.images.length ? <section className="space-y-2"><h3 className="text-xs font-semibold">Attachments</h3><div className="flex flex-wrap gap-3">{task.images.map((image) => <a className="text-xs underline underline-offset-2" href={`/api/tasks/${task.id}/images/${image.artifactId}`} target="_blank" rel="noreferrer" key={image.artifactId}>{image.filename}</a>)}</div></section> : null}
    {task.governance.supplementalReview ? <SupplementalReviewPanel value={{ reviewerProfileId: task.governance.supplementalReview.reviewerProfile.name, opinion: task.governance.supplementalReview.opinion, concerns: task.governance.supplementalReview.concerns, requiredChanges: task.governance.supplementalReview.requiredChanges, leadResponse: task.governance.supplementalReview.leadResponse.text }} /> : null}
  </>;
  const hasChanges = task.developerExecution?.status === "completed";
  const hasChecks = Boolean(task.ci);
  const pullRequestInFlight = Boolean(task.release?.pullRequestUrl) && (["releasing", "ci_waiting", "final_review", "ready_reconciliation"].includes(task.phase) || task.phase === "delivery_blocked" && task.allowedCommands.includes("reconcile_ci"));
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
    {hasChanges ? <TabsContent value="diffs" keepMounted><div ref={diffPanelRef} data-task-diff-panel className="scroll-mt-24"><DeveloperDiff taskId={task.id} executionId={task.developerExecution!.id} onFileCount={setChangesFileCount} /></div></TabsContent> : null}
    {hasChecks ? <TabsContent value="checks"><CiPanel ci={task.ci!} /></TabsContent> : null}
  </>;
  return (
    <ApplicationFrame title={task.issueKey ? `${task.issueKey} · ${task.title}` : task.title} headerActions={<TaskOptions canCancel={task.allowedCommands.includes("cancel_issue")} busy={busy || task.projection.status === "lagging"} onCancel={() => void onPlanAction("cancel")} />}>
      <article data-task-detail className="min-w-0">
        <div data-task-body className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            <header className="px-4 pt-4 pb-3 sm:px-6 lg:px-10">
              <div data-task-header-content className="mx-auto max-w-4xl space-y-4">
                <h2 className="min-w-0 text-xl font-semibold tracking-tight">{task.title}</h2>
              </div>
            </header>
            <div data-task-content className="min-w-0 px-4 pt-4 pb-6 sm:px-6 lg:px-10">
              <div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-5">{task.description || "No description."}</pre>
                <div data-task-current className="sticky top-0 z-10 -mx-4 border-y border-border/70 bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
                  <div className="mx-auto max-w-4xl space-y-4">
                    <PlanningRunCard task={task} />
                    {pullRequestInFlight ? <div data-active-pull-request><PullRequestCard task={task} busy={busy} onMarkReady={onMarkReady} {...(task.allowedCommands.includes("reconcile_ci") ? { onCheckCi: () => onPlanAction("reconcile-ci") } : {})} /></div> : <TaskActions task={task} project={project} busy={busy} onStartPlanning={onStartPlanning} onPlanAction={onPlanAction} onRevisePlan={onRevisePlan} onContinueWork={onContinueWork} onOpenDiff={openDiff} />}
                    {task.developerRecovery ? <DeveloperRecoveryStatus taskId={task.id} recovery={task.developerRecovery} allowedCommands={task.allowedCommands} busy={busy} isAdmin={isAdmin} developmentStatus={developerLiveness ? <DevelopmentStatus state={developerLiveness} now={developmentNow} inline /> : undefined} onAction={async (action: DeveloperRecoveryAction) => onPlanAction(action)}><DevelopmentRun taskId={task.id} onStatus={handleDevelopmentStatus} onEvents={appendDeveloperEvents} onRefresh={onRefresh} compact /></DeveloperRecoveryStatus> : <DevelopmentRun taskId={task.id} onStatus={handleDevelopmentStatus} onEvents={appendDeveloperEvents} onRefresh={onRefresh} />}
                    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
                    {currentPlan ?? decisionControls}
                    {task.governance.blocker && blockerCommand?.subject?.kind === "plan_blocker" ? <PlanBlockerResponseForm blocker={task.governance.blocker} expectedRevision={blockerCommand.expectedRevision} busy={busy} onSubmit={(payload) => onPlanAction(blockerCommand.endpoint as TaskPlanAction, undefined, { subject: payload.subject, answer: payload.answer, idempotencyKey: payload.idempotencyKey, expectedWorkflowRevision: payload.expectedWorkflowRevision })} error={error} /> : task.governance.blocker ? <section className="space-y-1" data-plan-blocker><h3 className="text-xs font-semibold">{task.governance.blocker.header}</h3><p className="text-[13px]">{task.governance.blocker.question}</p><p className="text-[12px] text-muted-foreground">{task.governance.blocker.nextAction}</p></section> : null}
                    {task.leadOutput?.content.kind === "decision_blocker" && task.allowedCommands.includes("resolve_decision_blocker") ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void onResolveDecisionBlocker(answer); }}><FieldLabel htmlFor="decision-answer">Decision</FieldLabel><Textarea id="decision-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer the Analyst's question" maxLength={8000} /><Button size="sm" type="submit" disabled={busy || !answer.trim()}>{busy ? "Saving…" : "Resolve decision"}</Button></form> : null}
                  </div>
                </div>
                <Tabs data-task-work-tabs value={activeWorkTab} onValueChange={setActiveWorkTab}>
                  {workContent}
                  <TabsContent value="other" className="space-y-4">
                {hasChecks ? <CiDiagnostics task={task} ci={task.ci!} /> : null}
                {task.release ? <ReleasePanel task={task} /> : null}
                {task.targetBaseReconciliation.status ? <Card size="sm" aria-label="Target-base reconciliation">
                  <CardHeader>
                    <CardTitle><h3>Target-base reconciliation</h3></CardTitle>
                    <CardDescription>{task.targetBaseReconciliation.checkpoint ?? "checkpoint unavailable"}{task.targetBaseReconciliation.conflictFileCount !== null ? ` · ${task.targetBaseReconciliation.conflictFileCount} conflict files` : ""}</CardDescription>
                    <CardAction><Badge variant={task.targetBaseReconciliation.status === "blocked" ? "destructive" : "secondary"}>{task.targetBaseReconciliation.status}</Badge></CardAction>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid gap-1 text-[11px] sm:grid-cols-2"><div><dt className="text-muted-foreground">Expected base</dt><dd><CommitSha sha={task.targetBaseReconciliation.expectedBaseSha} repository={project?.repository} /></dd></div><div><dt className="text-muted-foreground">Observed base</dt><dd><CommitSha sha={task.targetBaseReconciliation.observedBaseSha} repository={project?.repository} /></dd></div><div><dt className="text-muted-foreground">Result</dt><dd><CommitSha sha={task.targetBaseReconciliation.resultHead} repository={project?.repository} /></dd></div><div><dt className="text-muted-foreground">Verification</dt><dd>{task.targetBaseReconciliation.verificationArtifact ? <a className="underline" href={`/api/tasks/${task.id}/reconciliation-artifacts/${task.targetBaseReconciliation.verificationArtifact.id}`} target="_blank" rel="noreferrer">Evidence</a> : "—"}</dd></div></dl>
                    {task.targetBaseReconciliation.releaseId && task.targetBaseReconciliation.pullRequestUrl ? <div className="text-[11px]"><a className="underline" href={task.targetBaseReconciliation.pullRequestUrl} target="_blank" rel="noreferrer">PR #{task.targetBaseReconciliation.pullRequestNumber}</a> · same PR continuity</div> : null}
                    {task.targetBaseReconciliation.summary ? <div className="text-[12px] text-muted-foreground">{task.targetBaseReconciliation.summary}</div> : null}
                  </CardContent>
                </Card> : null}
                <FinalGatePanel task={task} />
                <Card size="sm"><CardContent><TaskHistory task={task} companyId={companyId} repository={project?.repository} context={{
                  ...(task.governance.originalPlan ? { originalPlan: { current: task.governance.originalPlan.status === "current", content: <div className="space-y-4"><PlanSubjectSummary subject={task.governance.originalPlan.subject} current={task.governance.originalPlan.status === "current"} label="Original plan" createdAt={task.governance.originalPlan.createdAt} detailsOnly />{task.governance.finalPlan && task.governance.finalPlan.subject.outputId !== task.governance.originalPlan.subject.outputId ? <PlanSubjectSummary subject={task.governance.finalPlan.subject} current={task.governance.finalPlan.status === "current"} label={`Final plan v${task.governance.finalPlan.subject.finalVersion}`} createdAt={task.governance.finalPlan.createdAt} detailsOnly /> : null}{task.governance.previousPlans?.map((plan) => <PlanSubjectSummary key={plan.subject.outputId} subject={plan.subject} current={false} createdAt={plan.createdAt} detailsOnly />) ?? null}</div> } } : {}),
                  ...(task.governance.materiality ? { materiality: { routine: task.governance.materiality.categories.length === 0, content: <MaterialitySummary detailsOnly value={{ categories: task.governance.materiality.categories, artifactId: task.governance.materiality.evidenceArtifactId, artifactSha256: task.governance.materiality.evidenceArtifactSha256, evidence: task.governance.materiality.evidence.map((entry) => ({ category: entry.category, rationale: entry.rationale, evidenceRefs: entry.refs })) }} /> } } : {}),
                  ...(task.governance.decision ? { memberDecision: <section className="space-y-1" data-plan-decision><h3 className="text-xs font-semibold">Member decision</h3><div className="text-[13px]">{task.governance.decision.decision} · {task.governance.decision.actor.displayName}</div><p className="whitespace-pre-wrap text-[12px]">{task.governance.decision.note}</p></section> } : {}),
                }} /></CardContent></Card>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </div>
          <aside data-task-properties className="border-border border-t bg-muted/20 px-4 py-6 sm:px-6 lg:sticky lg:top-0 lg:h-fit lg:border-t-0 lg:border-l">
            <div className="mb-6 space-y-4"><TaskProgress phase={task.phase} allowedCommands={task.allowedCommands} createdAt={task.createdAt} updatedAt={task.updatedAt} timeline={task.timeline} agentInvocations={task.agentInvocations} activeCapacity={task.capacity?.status === "active" ? task.capacity : undefined} developerLiveness={developerLiveness} />{pullRequestInFlight ? null : <PullRequestCard task={task} busy={busy} onMarkReady={onMarkReady} />}</div>
            <TaskAgentAssignments task={task} onRefresh={onRefresh} />
            <h3 className="mb-5 text-xs font-semibold">Properties</h3>
            <dl className="space-y-4 text-xs">
              <div className="space-y-1"><dt className="text-muted-foreground">Status</dt><dd><Badge variant="secondary" data-status={task.phase}><TaskStatus phase={task.phase} presentationPhase={taskPresentationPhase({ phase: task.phase, releaseStatus: task.release?.status, ciOutcome: task.ci?.outcome })} processing={taskIsProcessing({ phase: task.phase, agentInvocations: task.agentInvocations, capacityStatus: task.capacity?.status })} /></Badge></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Project</dt><dd>{project?.name ?? "Unknown project"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Owner</dt><dd>{task.owner}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Next action</dt><dd><NextAction value={task.pendingAction} /></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Projection</dt><dd>{task.projection.status === "lagging" ? `Lagging r${task.projection.projectedRevision} → r${task.projection.authoritativeRevision}` : `Current · r${task.projection.projectedRevision}`}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Created</dt><dd>{adminDate(task.createdAt)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Updated</dt><dd>{adminDate(task.updatedAt)}</dd></div>
              {task.issueKey ? <div className="space-y-1"><dt className="text-muted-foreground">Issue key</dt><dd><code>{task.issueKey}</code></dd></div> : null}
              <div className="space-y-1"><dt className="text-muted-foreground">Task ID</dt><dd><code className="break-all text-[11px]">{task.id}</code></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Workflow</dt><dd><code className="break-all text-[11px]">{task.workflowId}</code></dd></div>
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
