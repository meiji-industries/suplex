import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
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
import { Markdown, type MarkdownImageSource } from "../components/app/markdown.js";
import { TaskLeadPlan } from "../components/app/task-lead-plan.js";
import { invocationActorLabel } from "../components/app/task-invocations.js";
import { TaskProgress } from "../components/app/task-progress.js";
import { PhaseTimings } from "../components/app/phase-timings.js";
import { deliveryTargetLabel, taskIsProcessing, TaskStatus } from "../components/app/task-status.js";
import { DeveloperRecoveryStatus } from "../components/app/developer-recovery-status.js";
import { TaskAttentionCard } from "../components/app/task-attention-card.js";
import { DeliveryReviewPanel } from "../components/app/delivery-review-panel.js";
import type { DeveloperRecoveryAction } from "../components/app/developer-recovery-actions.js";
import { PlanBlockerResponseForm } from "../components/app/plan-blocker-response-form.js";
import { PlanDecisionForm } from "../components/app/plan-decision-form.js";
import { SupplementalReviewPanel } from "../components/app/supplemental-review-panel.js";
import { ProfileAvatar } from "../components/app/profile-avatar.js";
import { PullRequestCard as GithubPullRequestCard } from "../components/app/pull-request-card.js";
import { LivePaneDock, TaskChat } from "../components/app/task-chat/task-chat.js";
import { TaskBrowserProof } from "../components/app/task-browser-proof.js";
import { CopyButton } from "../components/app/copy-button.js";
import { COMMAND_LABELS } from "../lib/command-labels.js";
import { adminDate, relativeTime, type ApiAgent, type ApiCi, type ApiProject, type ApiTask, type ApiTaskBranchSync } from "../lib/view-shared.js";
import { isApiError, readJson, withCompany } from "../lib/api.js";
import { requestTaskArchive } from "../lib/archive-task.js";
import { useHerdrReachable } from "../lib/use-herdr-reachable.js";
import { invalidateTaskList } from "../lib/task-list.js";
import { navigate } from "../lib/navigation.js";
import type { IssueCommandSlug } from "../../commands/registry.js";
import { STEP_RETRY_COMMAND } from "../../issue-phases.js";
import { releaseFailureCopy } from "../../release-failures.js";
import { Archive, ArchiveRestore, Ellipsis, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

const DeveloperDiff = lazy(async () => await import("../components/app/developer-diff.js"));


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

export function branchSyncStatus(sync: Exclude<ApiTaskBranchSync, { available: false }>, baseBranch: string): string {
  return sync.conflictsWithBase ? `Conflicts with ${baseBranch}` : sync.behindBase > 0 ? `${sync.behindBase} commits behind ${baseBranch}` : `Up to date with ${baseBranch}`;
}

export function BranchSyncCard({ taskId, updatedAt, baseBranch, allowedCommands, busy, onRefresh, onAction }: { taskId: string; updatedAt: string; baseBranch: string; allowedCommands: ApiTask["allowedCommands"]; busy: boolean; onRefresh: () => Promise<void>; onAction: (path: TaskPlanAction) => Promise<void> }): ReactElement | null {
  const [sync, setSync] = useState<ApiTaskBranchSync | null>(null);
  const [error, setError] = useState("");
  const [pushing, setPushing] = useState(false);
  useEffect(() => {
    let ignore = false;
    void readJson<ApiTaskBranchSync>(`/api/tasks/${taskId}/branch-sync`).then((value) => { if (!ignore) { setSync(value); setError(""); } }).catch((reason: unknown) => {
      if (ignore) return;
      if (isApiError(reason, 404)) setSync({ available: false });
      else setError(reason instanceof Error ? reason.message : "Branch status could not be loaded");
    });
    return () => { ignore = true; };
  }, [taskId, updatedAt]);
  if (!sync) return null;
  if ("available" in sync) return sync.reason ? <Card data-task-branch-sync size="sm"><CardHeader><CardTitle><h3>Branch</h3></CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{sync.reason}</p></CardContent></Card> : null;
  const status = branchSyncStatus(sync, baseBranch);
  const pushStatus = !sync.remoteExists ? "Not on origin yet" : sync.ahead > 0 ? `${sync.ahead} commits to push` : null;
  const push = async (): Promise<void> => {
    setPushing(true); setError("");
    try {
      setSync(await readJson<ApiTaskBranchSync>(`/api/tasks/${taskId}/push-branch`, { method: "POST" }));
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Branch could not be pushed");
    } finally {
      setPushing(false);
    }
  };
  return <Card data-task-branch-sync size="sm">
    <CardHeader>
      <CardTitle><h3>Branch</h3></CardTitle>
      <CardDescription><code>{sync.branchName}</code></CardDescription>
      <CardAction><Button size="sm" onClick={() => void push()} disabled={busy || pushing || (sync.ahead === 0 && sync.remoteExists)}>{pushing ? "Pushing…" : "Push"}</Button></CardAction>
    </CardHeader>
    <CardContent>
      <p className="text-xs text-muted-foreground">{status}{pushStatus ? ` · ${pushStatus}` : ""}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {sync.conflictsWithBase && allowedCommands.includes("resolve_merge_conflict") ? <Button size="xs" onClick={() => void onAction("resolve-merge-conflict")} disabled={busy}>Resolve conflicts</Button> : null}
        {!sync.conflictsWithBase && sync.behindBase > 0 && allowedCommands.includes("retry_target_base_reconciliation") ? <Button size="xs" variant="outline" onClick={() => void onAction("retry-target-base-reconciliation")} disabled={busy}>Merge latest from {baseBranch}</Button> : null}
      </div>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </CardContent>
  </Card>;
}

export function WorktreeControls({ task, busy, onAction }: { task: ApiTask; busy: boolean; onAction: (path: TaskPlanAction) => Promise<void> }): ReactElement {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [openMessage, setOpenMessage] = useState<string>();
  const canDelete = task.allowedCommands.includes("delete_worktree");
  const canRecreate = task.allowedCommands.includes("recreate_worktree");
  const path = task.worktreePath;
  const openWorktree = async (app: "editor" | "terminal"): Promise<void> => {
    try {
      const result = await readJson<{ ok: boolean; error?: string }>(`/api/tasks/${encodeURIComponent(task.id)}/worktree/open`, { method: "POST", body: JSON.stringify({ app }) });
      setOpenMessage(result.ok ? "Opened on the Forge host." : result.error ?? "Could not open the worktree");
    } catch (error) {
      setOpenMessage(error instanceof Error ? error.message : "Could not open the worktree");
    }
  };
  return <div className="space-y-1"><dt className="text-muted-foreground">Worktree</dt><dd className="space-y-1">
    <div className="flex min-w-0 items-center gap-1">
      {task.worktreeState === "cleaned" ? <span>Worktree removed</span> : path ? <><CopyButton value={path} label="Copy worktree path" /><Button size="xs" variant="outline" onClick={() => void openWorktree("editor")} disabled={busy}>Open in editor</Button><Button size="xs" variant="outline" onClick={() => void openWorktree("terminal")} disabled={busy}>Open in terminal</Button><span className="min-w-0 flex-1 truncate font-mono" title={path}>{path.split("/").pop()}</span></> : <span>None</span>}
    </div>
    {openMessage ? <p className="text-[11px] text-muted-foreground" role="status">{openMessage}</p> : null}
    {canDelete || canRecreate ? <div className="flex flex-wrap gap-1">
      {canDelete ? <Button size="xs" variant="destructive" onClick={() => setDeleteOpen(true)} disabled={busy}>Delete worktree</Button> : null}
      {canRecreate ? <Button size="xs" variant="outline" onClick={() => void onAction("recreate-worktree")} disabled={busy}>Recreate worktree</Button> : null}
    </div> : null}
  </dd>
  <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete worktree?</AlertDialogTitle><AlertDialogDescription>Delete the local worktree? The branch and task history are kept.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void onAction("delete-worktree")}>Delete worktree</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}

export function NextAction({ value }: { value: string | null }): ReactElement {
  if (value === "Lead delivery review" || value?.startsWith("Fresh Lead delivery review")) return <>Forge is checking the completed work against the approved plan.</>;
  if (value === "Developer repair of blocking findings") return <>Developer needs to address required review feedback</>;
  const match = value?.match(/^Required checks are (?:still )?missing: (.+)$/);
  if (!match) return <>{value ?? "None"}</>;
  return <ul className="list-disc space-y-0.5 pl-4 text-[11px]">{(match[1] ?? "").split(", ").map((check) => <li key={check}>{check}</li>)}</ul>;
}

function executionControlLabel(value: boolean | undefined): string {
  return value === undefined ? "Not specified" : value ? "Enabled" : "Off";
}

function visualEvidenceLabel(value: "off" | "capture" | "required" | undefined): string {
  if (value === "required") return "Required";
  if (value === "capture") return "Capture";
  return value === "off" ? "Off" : "Not specified";
}

function supplementalReviewLabel(task: ApiTask): string {
  if (task.lastHandlerError?.command === "supplemental_review") return `Not completed — ${task.lastHandlerError.reason}`;
  return executionControlLabel(task.executionControls?.supplementalReview);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}


export type TaskPlanAction = Exclude<IssueCommandSlug, "revise-plan" | "continue-work" | "record-progress" | "resolve-decision-blocker"> | "reject-plan";
export type PlanRevisionInput = { reason: string };

export function taskAttentionAction(commands: ApiTask["commands"], command: string, note?: string, idempotencyKey?: string): { path: TaskPlanAction; note?: string; payload?: Record<string, unknown> } {
  const descriptor = commands.find((entry) => entry.name === command || entry.endpoint === command);
  const path = (descriptor?.endpoint ?? command.replaceAll("_", "-")) as TaskPlanAction;
  return {
    path,
    ...(note !== undefined ? { note } : {}),
    ...(descriptor?.idempotency === "required" ? { payload: { idempotencyKey: idempotencyKey ?? crypto.randomUUID() } } : {}),
  };
}

export function nextPullRequestReviewAction(allowedCommands: ApiTask["allowedCommands"]): TaskPlanAction | undefined {
  if (allowedCommands.includes("review_delivery")) return "review-delivery";
  if (allowedCommands.includes("final_review")) return "final-review";
  return undefined;
}

function RescueWorkflowDialog({ open, onOpenChange, onRescue }: { open: boolean; onOpenChange: (open: boolean) => void; onRescue?: (() => Promise<RescueReport>) | undefined }): ReactElement {
  return <AlertDialog open={open} onOpenChange={onOpenChange}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Retry workflow?</AlertDialogTitle><AlertDialogDescription>Restart this task's workflow from its last saved state and retry the current step.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { onOpenChange(false); if (onRescue) void onRescue(); }}>Retry workflow</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

function AgentElapsed({ task }: { task: ApiTask }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const active = [...(task.agentInvocations ?? [])].reverse().find((invocation) => ["starting", "running", "cancelling"].includes(invocation.status));
  const startedAt = active?.startedAt ?? task.capacity?.requestedAt ?? task.updatedAt;
  const elapsed = Date.parse(startedAt);
  return <>{active?.status === "cancelling" ? "Cancelling" : active ? "Running" : "Waiting"} · {formatDuration(Number.isNaN(elapsed) ? 0 : now - elapsed)}</>;
}

export function TaskActions({ task, busy, onStartPlanning, onPlanAction, onRevisePlan, onContinueWork, onOpenDiff, decisionControls, onRescue, onArchive, onDuplicate, onSaveTemplate, onFixInNewTask }: { task: ApiTask; busy: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>) => Promise<void>; onRevisePlan: (input: PlanRevisionInput) => Promise<void>; onContinueWork: (reason: string) => Promise<void>; onOpenDiff?: () => void; decisionControls?: ReactNode; onRescue?: (() => Promise<RescueReport>) | undefined; onArchive?: (() => void) | undefined; onDuplicate?: (() => void) | undefined; onSaveTemplate?: (() => void) | undefined; onFixInNewTask?: (() => Promise<void>) | undefined }): ReactElement {
  const { snapshot } = useSystemHealth();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");
  const [continueOpen, setContinueOpen] = useState(false);
  const [continueReason, setContinueReason] = useState("");
  const [rescueOpen, setRescueOpen] = useState(false);
  const disabled = busy || Boolean(getWorkerHealthFailure(snapshot));
  const allowed = (command: ApiTask["allowedCommands"][number]): boolean => task.allowedCommands.includes(command);
  const run = (command: ApiTask["allowedCommands"][number], actionNote?: string): void => {
    if (command === "start_planning") { void onStartPlanning(); return; }
    if (command === "revise_plan") { setRevisionOpen(true); return; }
    if (command === "continue_work") { setContinueOpen(true); return; }
    const action = taskAttentionAction(task.commands, command, actionNote);
    void onPlanAction(action.path, action.note, action.payload);
  };
  const retry = STEP_RETRY_COMMAND[task.step];
  const primaryCommands = task.blocked ? [task.attentionCard?.primaryAction.command, task.attentionCard?.secondaryAction?.command].filter((command) => command !== undefined) : task.owner === "human" && task.phase === "approval" ? ["approve_plan", "revise_plan"] : task.owner === "human" && task.phase === "reviewing" && allowed("repair_delivery") ? ["repair_delivery", "review_delivery"] : task.owner === "human" && task.phase === "reviewing" && allowed("review_delivery") ? ["review_delivery", "reject_plan"] : task.owner === "human" && task.phase === "shipping" && allowed("accept_delivery") ? ["accept_delivery"] : task.owner === "human" && task.phase === "shipping" && allowed("reconcile_merge") ? ["reconcile_merge"] : task.owner === "human" && task.phase === "backlog" ? ["start_planning"] : task.owner === "human" && retry && allowed(retry) ? [retry] : [];
  const menu = <DropdownMenu><DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={disabled}>More</Button>} /><DropdownMenuContent align="end">{task.allowedCommands.filter((command) => !primaryCommands.includes(command)).map((command) => <DropdownMenuItem key={command} disabled={disabled} onClick={() => run(command)}>{COMMAND_LABELS[command]}</DropdownMenuItem>)}{onOpenDiff && task.developerExecution?.status === "completed" ? <DropdownMenuItem disabled={disabled} onClick={onOpenDiff}>Show diff</DropdownMenuItem> : null}{onRescue ? <DropdownMenuItem disabled={disabled} onClick={() => setRescueOpen(true)}>Retry workflow</DropdownMenuItem> : null}<DropdownMenuItem disabled={disabled} onClick={onArchive}>Archive</DropdownMenuItem><DropdownMenuItem disabled={disabled} onClick={onDuplicate}>Duplicate</DropdownMenuItem><DropdownMenuItem disabled={disabled} onClick={onSaveTemplate}>Save as template</DropdownMenuItem><DropdownMenuItem disabled={disabled || !onFixInNewTask} onClick={() => { if (onFixInNewTask) void onFixInNewTask(); }}>Fix in a new task</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
  const footer = <CardFooter><div className="flex w-full justify-end">{menu}</div></CardFooter>;
  const rescue = <RescueWorkflowDialog open={rescueOpen} onOpenChange={setRescueOpen} onRescue={onRescue} />;
  if (task.blocked) return <Card data-task-actions data-task-blocked-card size="sm"><CardHeader><CardTitle><h3>{task.pendingAction}</h3></CardTitle>{task.lastHandlerError ? <CardDescription>Last {task.lastHandlerError.command} error: {task.lastHandlerError.reason}</CardDescription> : null}</CardHeader><CardContent>{task.attentionCard ? <TaskAttentionCard card={task.attentionCard} busy={disabled} onAction={async (command, note, idempotencyKey) => { const action = taskAttentionAction(task.commands, command, note, idempotencyKey); await onPlanAction(action.path, action.note, action.payload); }} /> : null}</CardContent>{footer}{rescue}</Card>;
  if (task.owner === "human") return <Card data-task-actions size="sm"><CardHeader><CardTitle><h3>{task.pendingAction}</h3></CardTitle></CardHeader><CardContent>{task.phase === "approval" ? <div className="flex flex-wrap gap-2">{decisionControls}<Button size="sm" variant="outline" disabled={disabled} onClick={() => setRevisionOpen(true)}>Request changes</Button></div> : task.phase === "reviewing" && allowed("repair_delivery") ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => run("repair_delivery")}>Run missing check</Button><Button size="sm" disabled={disabled} onClick={() => run("review_delivery", "Continued to review with verification incomplete")}>Continue to review</Button></div> : task.phase === "reviewing" && allowed("review_delivery") ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => void onPlanAction("reject-plan", "Member requested delivery changes")}>Request changes</Button><Button size="sm" disabled={disabled} onClick={() => run("review_delivery")}>Looks good</Button></div> : primaryCommands[0] ? <Button size="sm" disabled={disabled} onClick={() => run(primaryCommands[0] as ApiTask["allowedCommands"][number])}>{COMMAND_LABELS[primaryCommands[0] as ApiTask["allowedCommands"][number]]}</Button> : null}{revisionOpen ? <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void onRevisePlan({ reason: revisionReason }); }}><Field><FieldLabel htmlFor="revision-reason">Why revise this plan?</FieldLabel><Textarea id="revision-reason" required value={revisionReason} onChange={(event) => setRevisionReason(event.target.value)} placeholder="Describe the changed requirement or observed problem." /></Field><Button type="submit" size="sm" disabled={disabled || !revisionReason.trim()}>Submit revision</Button></form> : null}{continueOpen ? <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); void onContinueWork(continueReason); }}><Field><FieldLabel htmlFor="continue-reason">Why continue this work?</FieldLabel><Textarea id="continue-reason" required value={continueReason} onChange={(event) => setContinueReason(event.target.value)} placeholder="Describe the next outcome." /></Field><Button type="submit" size="sm" disabled={disabled || !continueReason.trim()}>Create successor</Button></form> : null}</CardContent>{footer}{rescue}</Card>;
  return <Card data-task-actions data-task-status-card size="sm"><CardHeader><CardTitle><h3>{task.pendingAction}</h3></CardTitle><CardDescription><AgentElapsed task={task} /></CardDescription></CardHeader>{footer}{rescue}</Card>;
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

function TaskConfigurationCard({ task }: { task: ApiTask }): ReactElement {
  return <Card size="sm" aria-label="Configuration used">
    <CardHeader><CardTitle><h3>Configuration used</h3></CardTitle></CardHeader>
    <CardContent><dl className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><div><dt>Plan review</dt><dd className="text-foreground">{task.autoApprovePlan ? "Auto-approved" : "Needs your approval"}</dd></div><div><dt>Second review</dt><dd className="text-foreground">{task.lastHandlerError?.command === "supplemental_review" ? `Not completed — ${task.lastHandlerError.reason}` : task.executionControls?.supplementalReview === undefined ? "Not specified" : task.executionControls.supplementalReview ? "Requested" : "Off"}</dd></div><div><dt>Visual proof</dt><dd className="text-foreground">{visualEvidenceLabel(task.executionControls?.visualEvidence)}</dd></div></dl></CardContent>
  </Card>;
}

function DeliveryChecksCard({ task }: { task: ApiTask }): ReactElement {
  return <Card size="sm" aria-label="Delivery and checks">
    <CardHeader><CardTitle><h3>Delivery &amp; checks</h3></CardTitle></CardHeader>
    <CardContent><dl className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><div><dt>Delivery target</dt><dd className="text-foreground">{deliveryTargetLabel(task.deliveryTarget)}</dd></div><div><dt>Project tests</dt><dd className="text-foreground">{task.executionControls?.runProjectTests === undefined ? "Not specified" : task.executionControls.runProjectTests ? "Run" : "Skipped for this task"}</dd></div></dl></CardContent>
  </Card>;
}

function TaskOptions({ canArchive, canCancel, archived, busy, onArchive, onCancel, onSaveTemplate, onDuplicate, onUnarchive }: { canArchive: boolean; canCancel: boolean; archived: boolean; busy: boolean; onArchive: () => void; onCancel: () => void; onSaveTemplate: () => void; onDuplicate: () => void; onUnarchive: () => void }): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Task options" title="Task options" />}><Ellipsis /></DropdownMenuTrigger>
      <DropdownMenuContent align="start"><DropdownMenuItem disabled={busy} onClick={onSaveTemplate}>Save as template…</DropdownMenuItem><DropdownMenuItem disabled={busy} onClick={onDuplicate}>Duplicate…</DropdownMenuItem>{archived ? <DropdownMenuItem disabled={busy} onClick={onUnarchive}><ArchiveRestore />Unarchive</DropdownMenuItem> : <>{canArchive ? <DropdownMenuItem disabled={busy} onClick={onArchive}><Archive />Archive task</DropdownMenuItem> : null}{canCancel ? <DropdownMenuItem variant="destructive" disabled={busy} onClick={onCancel}>Cancel task</DropdownMenuItem> : null}</>}</DropdownMenuContent>
    </DropdownMenu>
  );
}

type RescueReport = { steps: Array<{ name: string; outcome: "completed" | "skipped" | "failed"; detail: string }> };

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

function InlineTaskEditor({ field, value, onSave, imageSources }: { field: "title" | "description"; value: string; onSave: (value: string) => Promise<void>; imageSources?: MarkdownImageSource }): ReactElement {
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
    : <button type="button" data-task-description-editor aria-label="Edit task description" onClick={start} className="block w-full text-left font-sans"><Markdown source={value || "No description."} {...(imageSources ? { imageSources } : {})} /></button>;
}

type TaskPromptProvenance = { steps: Array<{ layer: string; mode: string; revision?: number }>; staleReplace: boolean; sha256: string };

function TaskPromptProvenanceRow({ taskId, overrides }: { taskId: string; overrides: string[] }): ReactElement {
  const [open, setOpen] = useState(false);
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<Record<string, TaskPromptProvenance>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || loadedTaskId === taskId) return;
    let cancelled = false;
    setLoadedTaskId(taskId);
    setLoadError(null);
    void readJson<{ provenance: Record<string, TaskPromptProvenance> }>(`/api/tasks/${encodeURIComponent(taskId)}/prompts`)
      .then((response) => { if (!cancelled) setProvenance(response.provenance); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "Prompt provenance could not be loaded"); });
    return () => { cancelled = true; };
  }, [loadedTaskId, open, taskId]);
  const summary = overrides.length ? `${overrides.length} project override${overrides.length === 1 ? "" : "s"}` : "defaults";
  return <Collapsible.Root open={open} onOpenChange={setOpen}>
    <Collapsible.Trigger aria-label={`Show pinned prompt provenance (${summary})`}>{summary}</Collapsible.Trigger>
    <Collapsible.Panel>
      {loadError ? <span role="alert">{loadError}</span> : loadedTaskId !== taskId ? <span>Loading pinned provenance…</span> : Object.entries(provenance).length ? <ul>{Object.entries(provenance).map(([templateId, prompt]) => <li key={templateId}><code>{templateId}</code>: {prompt.steps.map((step) => `${step.layer} ${step.mode}${step.revision === undefined ? "" : ` r${step.revision}`}`).join(" → ")} · <code title={prompt.sha256}>{prompt.sha256.slice(0, 12)}</code> · {prompt.staleReplace ? "stale replacement" : "current"}</li>)}</ul> : <span>No pinned provenance.</span>}
    </Collapsible.Panel>
  </Collapsible.Root>;
}

export function TaskDetailsPage({ task, project, companyId, busy, error, isAdmin, onStartPlanning, onPlanAction, onRevisePlan, onContinueWork, onResolveDecisionBlocker, onMarkReady, onMerge: _onMerge, onDuplicate, onFixInNewTask, onSaveTemplate = async () => {}, onUpdateDetails, onRefresh, onRescue, returnTo = "tasks" }: { task: ApiTask; project: ApiProject | undefined; companyId: string; busy: boolean; error: string; isAdmin: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>) => Promise<void>; onRevisePlan: (input: PlanRevisionInput) => Promise<void>; onContinueWork: (reason: string) => Promise<void>; onResolveDecisionBlocker: (answer: string) => Promise<void>; onMarkReady: () => Promise<void>; onMerge: () => Promise<void>; onDuplicate: () => Promise<void>; onFixInNewTask?: () => Promise<void>; onSaveTemplate?: () => Promise<void>; onUpdateDetails: (input: { title?: string; description?: string }) => Promise<void>; onRefresh: () => Promise<void>; onRescue: () => Promise<RescueReport>; returnTo?: "tasks" | "board" }): ReactElement {
  const herdrReachable = useHerdrReachable();
  const [syncing, setSyncing] = useState(false);
  const observedAtRef = useRef(task.githubPullRequest?.observedAt ?? null);
  observedAtRef.current = task.githubPullRequest?.observedAt ?? null;
  const syncNow = async (): Promise<void> => {
    const before = observedAtRef.current;
    setSyncing(true);
    try {
      // The refresh only queues the GitHub observation; poll until it lands (or give up after ~20s).
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await onRefresh();
        if (observedAtRef.current !== before) return;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally { setSyncing(false); }
  };
  const approveCommand = task.commands.find((command) => command.name === "approve_plan");
  const tellPlannerCommand = task.commands.find((command) => command.name === "send_planner_note");
  const blockerCommand = task.commands.find((command) => command.name === "respond_plan_blocker");
  const visibleLeadPlan = task.leadOutput && (task.leadOutput.content.kind !== "decision_blocker" || !task.governance.blocker) ? task.leadOutput : undefined;
  const exactApproveCommand = approveCommand ? { endpoint: approveCommand.endpoint, expectedRevision: approveCommand.expectedRevision } : undefined;
  const decisionControls = task.phase === "approval" && exactApproveCommand ? <PlanDecisionForm key={task.revision} approveCommand={exactApproveCommand} busy={busy} onSubmit={(payload) => onPlanAction(payload.command.endpoint as TaskPlanAction, payload.note)} error={error} /> : null;
  const [answer, setAnswer] = useState("");
  useEffect(() => { setAnswer(""); }, [task.id, task.revision]);
  const [archiveDialog, setArchiveDialog] = useState<"initial" | number | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveTask = async (confirmDiscardDirty = false): Promise<void> => {
    setArchiveBusy(true);
    try {
      const outcome = await requestTaskArchive({ taskId: task.id, companyId, expectedRevision: task.revision, confirmDiscardDirty, returnTo });
      if (outcome.status === "confirmation_required") { setArchiveDialog(outcome.dirtyFileCount); return; }
      setArchiveDialog(null);
      invalidateTaskList(companyId);
      navigate(outcome.redirectPath);
    } catch (reason) {
      setArchiveDialog(null);
      throw reason;
    } finally { setArchiveBusy(false); }
  };
  const unarchiveTask = async (): Promise<void> => {
    setArchiveBusy(true);
    try { await readJson<ApiTask>(`/api/tasks/${encodeURIComponent(task.id)}/unarchive`, { method: "POST" }); await onRefresh(); }
    finally { setArchiveBusy(false); }
  };
  const [changesFileCount, setChangesFileCount] = useState<number | undefined>(undefined);
  useEffect(() => { setChangesFileCount(undefined); }, [task.id, task.developerExecution?.id]);
  const [activeWorkTab, setActiveWorkTab] = useState("chat");
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
  const leadPlan = visibleLeadPlan ? <TaskLeadPlan output={visibleLeadPlan} /> : undefined;
  const activityCount = task.activity.length;
  const activityContent = <>
    <PhaseTimings activity={task.activity} phase={task.phase} updatedAt={task.updatedAt} />
    <TaskActivity taskId={task.id} timeline={task.activity} agentInvocations={task.agentInvocations} release={task.release} ci={task.ci} githubPullRequest={task.githubPullRequest} deliveryTarget={task.deliveryTarget} onViewChanges={openDiff} />
  </>;
  const developerExecution = task.developerExecution;
  const hasChanges = developerExecution !== undefined;
  const pollDeveloperDiff = ["development", "repair_required", "ci_repairing"].includes(task.step);
  const hasChecks = Boolean(task.ci);
  const pullRequestInMain = Boolean(task.githubPullRequest?.exists && task.githubPullRequest.number !== null && task.githubPullRequest.url);
  const showLastHandlerError = Boolean(task.lastHandlerError && (task.blocked || Date.parse(task.lastHandlerError.at) > Date.parse(task.updatedAt) - 60 * 60 * 1_000));
  const workContent = <>
    <TabsList variant="line" className="mb-4 w-full justify-start rounded-none border-b border-border p-0">
      <TabsTrigger value="chat">Chat</TabsTrigger>
      <TabsTrigger value="activity">Activity <Badge variant="secondary" className="size-5 rounded-full px-0 text-[10px]">{activityCount}</Badge></TabsTrigger>
      <TabsTrigger value="diffs" disabled={!hasChanges} aria-label="Diffs">
        Diffs
        {hasChanges && changesFileCount != null && changesFileCount > 0 ? <Badge variant="secondary" className="size-5 rounded-full px-0 text-[10px]">{changesFileCount}</Badge> : null}
      </TabsTrigger>
      <TabsTrigger value="checks" disabled={!hasChecks}>Checks</TabsTrigger>
      <TabsTrigger value="other">Other</TabsTrigger>
    </TabsList>
    <TabsContent value="chat"><TaskChat task={task} busy={busy} pullRequestBusy={busy} onRefresh={onRefresh} onMarkReady={onMarkReady} onRepairCi={async () => onPlanAction("repair-ci")} onOpenDiff={openDiff} plannerAvailable={Boolean(tellPlannerCommand)} onSendPlannerNote={async (note, commandId) => onPlanAction("tell-planner", note, { commandId })} /></TabsContent>
    <TabsContent value="activity" className="space-y-7">{activityContent}</TabsContent>
    {hasChanges ? <TabsContent value="diffs" keepMounted><div ref={diffPanelRef} data-task-diff-panel className="scroll-mt-24"><Suspense fallback={<Skeleton className="h-48 w-full" />}><DeveloperDiff taskId={task.id} executionId={task.developerExecution!.id} poll={pollDeveloperDiff} onFileCount={setChangesFileCount} /></Suspense></div></TabsContent> : null}
    {hasChecks ? <TabsContent value="checks"><CiPanel ci={task.ci!} /></TabsContent> : null}
  </>;
  return <>
    <ApplicationFrame title={task.issueKey ? `${task.issueKey} · ${task.title}` : task.title} headerActions={<TaskOptions canArchive={["done", "cancelled", "failed"].includes(task.phase) && task.worktreeState !== "cleaned"} canCancel={task.allowedCommands.includes("cancel_issue")} archived={Boolean(task.archivedAt)} busy={busy || archiveBusy} onArchive={() => setArchiveDialog("initial")} onCancel={() => void onPlanAction("cancel")} onSaveTemplate={() => void onSaveTemplate()} onDuplicate={() => void onDuplicate()} onUnarchive={() => void unarchiveTask()} />}>
      <article data-task-detail className="min-w-0">
        <div data-task-body className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            <header className="px-4 pt-4 pb-3 sm:px-6 lg:px-10">
              <div data-task-header-content className="mx-auto max-w-4xl space-y-4">
                <h2 className="min-w-0"><InlineTaskEditor field="title" value={task.title} onSave={async (title) => onUpdateDetails({ title })} />{task.archivedAt || (["done", "cancelled", "failed"].includes(task.phase) && task.worktreeState === "cleaned") ? <Badge variant="secondary">Archived</Badge> : null}</h2>
              </div>
            </header>
            <div data-task-content className="min-w-0 px-4 pt-4 pb-6 sm:px-6 lg:px-10">
              <div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
                {herdrReachable === false ? <Alert><AlertDescription>Herdr is not running on the Forge host</AlertDescription></Alert> : null}
                <InlineTaskEditor field="description" value={task.description} onSave={async (description) => onUpdateDetails({ description })} imageSources={Object.fromEntries(task.images.map((image) => [image.filename, `/api/tasks/${task.id}/images/${image.artifactId}`]))} />
                {task.images.length ? <TaskMediaRow taskId={task.id} images={task.images} /> : null}
                <div data-task-current className="-mx-4 border-y border-border/70 bg-background px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
                  <div className="mx-auto max-w-4xl space-y-4">
                    <PlanningRunCard task={task} />
                    {showLastHandlerError ? <Alert variant="destructive"><AlertDescription>Last action failed: {task.lastHandlerError!.reason} ({relativeTime(task.lastHandlerError!.at)})</AlertDescription></Alert> : null}
                    {pullRequestInMain ? <div data-active-pull-request><GithubPullRequestCard task={task} busy={busy} onRefresh={onRefresh} onMarkReady={onMarkReady} onRepairCi={async () => onPlanAction("repair-ci")} /></div> : null}
                    <TaskActions task={task} busy={busy} onStartPlanning={onStartPlanning} onPlanAction={onPlanAction} onRevisePlan={onRevisePlan} onContinueWork={onContinueWork} onOpenDiff={openDiff} decisionControls={decisionControls} onRescue={onRescue} onArchive={() => setArchiveDialog("initial")} onDuplicate={() => void onDuplicate()} onSaveTemplate={() => void onSaveTemplate()} onFixInNewTask={onFixInNewTask} />
                    {task.attentionCard && task.owner === "human" && !task.blocked && !task.developerRecovery ? <TaskAttentionCard card={task.attentionCard} busy={busy} onAction={async (command, note, idempotencyKey) => { const action = taskAttentionAction(task.commands, command, note, idempotencyKey); await onPlanAction(action.path, action.note, action.payload); }} /> : null}
                    {task.blocked ? <DeliveryReviewPanel task={task} /> : null}
                    {task.developerRecovery ? <DeveloperRecoveryStatus recovery={task.developerRecovery} executionStatus={task.developerExecution?.status} allowedCommands={task.allowedCommands} busy={busy} isAdmin={isAdmin} {...(task.attentionCard ? { attentionCard: task.attentionCard } : {})} onAction={async (command: DeveloperRecoveryAction, note, idempotencyKey) => { const action = taskAttentionAction(task.commands, command, note, idempotencyKey); await onPlanAction(action.path, action.note, action.payload); }} /> : null}
                    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
                    {leadPlan}
                    {task.governance.supplementalReview ? <Card data-task-second-review size="sm" aria-label="Second review">
                      <CardContent>
                        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold"><span className="font-semibold">Second review: {task.governance.supplementalReview.verdict === "approve" ? "Approved" : "Revise"}</span></h3><span className="text-[11px] text-muted-foreground">{task.governance.supplementalReview.reviewerProfile.name}</span></div>
                        <SupplementalReviewPanel hideHeader value={{ reviewer: { name: task.governance.supplementalReview.reviewerProfile.name }, verdict: task.governance.supplementalReview.verdict, summary: task.governance.supplementalReview.summary, concerns: task.governance.supplementalReview.concerns, plannerResponse: task.governance.supplementalReview.plannerResponse }} />
                      </CardContent>
                    </Card> : null}
                    {task.governance.blocker && blockerCommand ? <PlanBlockerResponseForm blocker={task.governance.blocker} expectedRevision={blockerCommand.expectedRevision} busy={busy} onSubmit={(payload) => onPlanAction(blockerCommand.endpoint as TaskPlanAction, undefined, { answer: payload.answer, idempotencyKey: payload.idempotencyKey, expectedWorkflowRevision: payload.expectedWorkflowRevision })} error={error} /> : task.governance.blocker ? <section className="space-y-1" data-plan-blocker><h3 className="text-xs font-semibold">{task.governance.blocker.header}</h3><p className="text-[13px]">{task.governance.blocker.question}</p><p className="text-[12px] text-muted-foreground">{task.governance.blocker.nextAction}</p></section> : null}
                    {task.leadOutput?.content.kind === "decision_blocker" && task.allowedCommands.includes("resolve_decision_blocker") ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void onResolveDecisionBlocker(answer); }}><FieldLabel htmlFor="decision-answer">Decision</FieldLabel><Textarea id="decision-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer the Planner's question" maxLength={8000} /><Button size="sm" type="submit" disabled={busy || !answer.trim()}>{busy ? "Saving…" : "Resolve decision"}</Button></form> : null}
                  </div>
                </div>
                <Tabs data-task-work-tabs value={activeWorkTab} onValueChange={setActiveWorkTab}>
                  {workContent}
                  <TabsContent value="other" className="space-y-4">
                <TaskConfigurationCard task={task} />
                <TaskBrowserProof task={task} />
                <DeliveryChecksCard task={task} />
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
            {activeWorkTab === "chat" ? <LivePaneDock task={task} onRestart={async (command) => {
              if (command) {
                const action = taskAttentionAction(task.commands, command);
                await onPlanAction(action.path, action.note, action.payload);
                return;
              }
              await onRescue();
            }} /> : null}
          </div>
          <aside data-task-properties className="border-border border-t bg-muted/20 px-4 py-6 sm:px-6 lg:sticky lg:top-0 lg:h-fit lg:border-t-0 lg:border-l">
            <div className="mb-6 space-y-4">{pullRequestInMain ? null : <GithubPullRequestCard task={task} busy={busy} onRefresh={onRefresh} onMarkReady={onMarkReady} onRepairCi={async () => onPlanAction("repair-ci")} />}<BranchSyncCard taskId={task.id} updatedAt={task.updatedAt} baseBranch={project?.baseBranch ?? "base"} allowedCommands={task.allowedCommands} busy={busy} onRefresh={onRefresh} onAction={(path) => onPlanAction(path)} /><TaskProgress phase={task.phase} blocked={task.blocked} createdAt={task.createdAt} updatedAt={task.updatedAt} timeline={task.timeline} agentInvocations={task.agentInvocations} activeCapacity={task.capacity?.status === "active" ? task.capacity : undefined} /></div>
            <TaskAgentAssignments task={task} onRefresh={onRefresh} />
            <h3 className="mb-5 text-xs font-semibold">Properties</h3>
            <dl className="space-y-4 text-xs">
              <div className="space-y-1"><dt className="text-muted-foreground">Status</dt><dd><Badge variant="secondary" data-status={task.phase}><TaskStatus phase={task.phase} blocked={task.blocked} pendingAction={task.pendingAction} processing={taskIsProcessing({ phase: task.phase, blocked: task.blocked, agentInvocations: task.agentInvocations, capacityStatus: task.capacity?.status })} deliveryTarget={task.deliveryTarget} pullRequestState={task.githubPullRequest?.state} /></Badge></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Project</dt><dd>{project?.name ?? "Unknown project"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Approval</dt><dd>{task.autoApprovePlan ? "auto" : "required"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Prompts</dt><dd title={task.prompts.overrides.join("\n") || undefined}><TaskPromptProvenanceRow taskId={task.id} overrides={task.prompts.overrides} /></dd></div>
              <WorktreeControls task={task} busy={busy} onAction={async (path) => onPlanAction(path)} />
              <div className="space-y-1"><dt className="text-muted-foreground">Delivery</dt><dd>{deliveryTargetLabel(task.deliveryTarget)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Plan review</dt><dd>{task.autoApprovePlan ? "Auto-approved" : "Needs your approval"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Run project tests</dt><dd>{executionControlLabel(task.executionControls?.runProjectTests)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Second review</dt><dd>{supplementalReviewLabel(task)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Screenshots</dt><dd>{visualEvidenceLabel(task.executionControls?.visualEvidence)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Next action</dt><dd><NextAction value={task.pendingAction} /></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Sync</dt><dd className="flex items-center gap-1"><Button size="icon-xs" variant="ghost" aria-label="Refresh" title="Refresh" onClick={() => void syncNow()} disabled={busy || syncing}><RefreshCw aria-hidden="true" className={syncing ? "size-3 animate-spin" : "size-3"} /></Button>{syncing ? "In progress" : task.githubPullRequest?.observedAt ? `synced ${Math.max(0, Math.floor((Date.now() - Date.parse(task.githubPullRequest.observedAt)) / 1_000))}s ago` : "never"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Created</dt><dd>{adminDate(task.createdAt)}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Updated</dt><dd>{adminDate(task.updatedAt)}</dd></div>
              {task.issueKey ? <div className="space-y-1"><dt className="text-muted-foreground">Issue key</dt><dd><code>{task.issueKey}</code></dd></div> : null}
            </dl>
          </aside>
        </div>
      </article>
    </ApplicationFrame>
      <AlertDialog open={archiveDialog !== null} onOpenChange={(open) => { if (!open && !archiveBusy) setArchiveDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{typeof archiveDialog === "number" ? `Discard ${archiveDialog} uncommitted changes and archive?` : "Archive task?"}</AlertDialogTitle>
            {archiveDialog === "initial" ? <AlertDialogDescription>Archive this task? Work stops, the local worktree is deleted, and the task is hidden. The branch and history are kept.</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={archiveBusy} onClick={(event) => { event.preventDefault(); void archiveTask(typeof archiveDialog === "number"); }}>{archiveBusy ? "Archiving…" : "Archive task"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  </>;
}

export function TaskDetailsSkeleton(): ReactElement {
  return <ApplicationFrame title="Task"><div data-task-detail-loading className="grid gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_260px] lg:px-10" aria-busy="true" aria-label="Loading task"><div className="space-y-4"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-3/4" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div><div className="space-y-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-3/4" /></div></div></ApplicationFrame>;
}

export function TaskDetailsNotFound({ companyId, returnTo = "tasks" }: { companyId: string; returnTo?: "tasks" | "board" }): ReactElement {
  return <ApplicationFrame title="Task not found"><div className="space-y-3 px-4 py-8 sm:px-6 lg:px-10"><p className="text-xs text-muted-foreground">Task not found for this company.</p><a className="text-xs underline underline-offset-2" href={withCompany(`/${returnTo}`, companyId)}>Back to {returnTo === "board" ? "Board" : "Tasks"}</a></div></ApplicationFrame>;
}
