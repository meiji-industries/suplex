import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Collapsible } from "../components/ui/collapsible.js";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { ApplicationFrame } from "../components/app/application-frame.js";
import { TaskHistory } from "../components/app/task-history.js";
import { TaskLeadPlan } from "../components/app/task-lead-plan.js";
import { TaskProgress } from "../components/app/task-progress.js";
import { TaskStatus } from "../components/app/task-status.js";
import { DeliveryReviewPanel } from "../components/app/delivery-review-panel.js";
import { DeveloperRecoveryStatus } from "../components/app/developer-recovery-status.js";
import type { DeveloperRecoveryAction } from "../components/app/developer-recovery-actions.js";
import { MaterialitySummary } from "../components/app/materiality-summary.js";
import { PlanBlockerResponseForm } from "../components/app/plan-blocker-response-form.js";
import { PlanDecisionForm } from "../components/app/plan-decision-form.js";
import { PlanSubjectSummary } from "../components/app/plan-subject-summary.js";
import { SupplementalReviewPanel } from "../components/app/supplemental-review-panel.js";
import { DeveloperEvidence, type DeveloperExecutionEventView } from "../components/tasks/developer-evidence.js";
import { adminDate, relativeTime, type ApiCi, type ApiProject, type ApiRelease, type ApiTask } from "../lib/view-shared.js";
import { readJson, withCompany } from "../lib/api.js";
import type { IssueCommandSlug } from "../../commands/registry.js";
import { releaseFailureCopy } from "../../release-failures.js";
import { Ellipsis, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";

const DeveloperDiff = lazy(() => import("../components/app/developer-diff.js"));

export type TaskPlanAction = Exclude<IssueCommandSlug, "revise-plan" | "continue-work" | "record-progress" | "resolve-decision-blocker"> | "reject-plan";
export type PlanRevisionInput = { worktreeDisposition: "reuse" | "new"; reason: string; exactBaseSha?: string };

function TaskActions({ task, busy, onStartPlanning, onPlanAction, onRevisePlan, onContinueWork }: { task: ApiTask; busy: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>) => Promise<void>; onRevisePlan: (input: PlanRevisionInput) => Promise<void>; onContinueWork: (reason: string) => Promise<void> }): ReactElement {
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");
  const [worktreeDisposition, setWorktreeDisposition] = useState<"reuse" | "new">(task.developerExecution ? "reuse" : "new");
  const [exactBaseSha, setExactBaseSha] = useState("");
  const [continueOpen, setContinueOpen] = useState(false);
  const [continueReason, setContinueReason] = useState("");
  const disabled = busy || task.projection.status === "lagging";
  const canRevise = task.allowedCommands.includes("revise_plan");
  const canContinue = task.allowedCommands.includes("continue_work");
  const supplementalCommand = task.commands.find((command) => command.name === "request_supplemental_review" && command.subject?.kind === "supplemental_review");
  const supplementalSubject = supplementalCommand?.subject?.kind === "supplemental_review" ? supplementalCommand.subject.value : undefined;
  return (
    <div data-task-actions className="space-y-3">
      <div className="flex flex-wrap justify-end gap-2">
      {task.allowedCommands.includes("start_planning") ? <Button size="sm" onClick={() => void onStartPlanning()} disabled={disabled}>{busy ? "Planning…" : task.phase === "failed" ? "Retry planning" : "Start planning"}</Button> : null}
      {supplementalCommand && supplementalSubject ? <Button size="sm" variant="outline" onClick={() => void onPlanAction(supplementalCommand.endpoint as TaskPlanAction, undefined, { subject: supplementalSubject, idempotencyKey: crypto.randomUUID() })} disabled={disabled}>Request review</Button> : null}
      {task.allowedCommands.includes("start_development") ? <Button size="sm" onClick={() => void onPlanAction("start-development")} disabled={disabled}>{busy ? "Executing…" : "Start development"}</Button> : null}
      {!task.developerRecovery && task.allowedCommands.includes("retry_development") ? <Button size="sm" onClick={() => void onPlanAction("retry-development")} disabled={disabled}>{busy ? "Retrying…" : "Retry development"}</Button> : null}
      {!task.developerRecovery && task.allowedCommands.includes("cancel_development") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("cancel-development")} disabled={disabled}>Cancel development</Button> : null}
      {task.allowedCommands.includes("review_delivery") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("reject-plan", "Member requested delivery changes")} disabled={disabled}>Request changes</Button> : null}
      {task.allowedCommands.includes("review_delivery") ? <Button size="sm" onClick={() => void onPlanAction("review-delivery")} disabled={disabled}>{busy ? "Reviewing…" : "LGTM"}</Button> : null}
      {task.allowedCommands.includes("repair_delivery") ? <Button size="sm" onClick={() => void onPlanAction("repair-delivery")} disabled={disabled}>{busy ? "Repairing…" : "Repair delivery"}</Button> : null}
      {task.allowedCommands.includes("record_delivery_decision") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("record-delivery-decision", "Member decision recorded")} disabled={disabled}>Record decision</Button> : null}
      {task.allowedCommands.includes("retry_capacity") ? <Button size="sm" onClick={() => void onPlanAction("retry-capacity")} disabled={disabled}>Retry capacity</Button> : null}
      {task.allowedCommands.includes("publish_draft") ? <Button size="sm" onClick={() => void onPlanAction("publish-draft")} disabled={disabled}>{busy ? "Publishing…" : task.release?.status === "blocked" ? "Retry release" : "Publish draft"}</Button> : null}
      {task.allowedCommands.includes("resolve_merge_conflict") ? <Button size="sm" onClick={() => void onPlanAction("resolve-merge-conflict")} disabled={disabled}>{busy ? "Resolving…" : "Resolve conflicts"}</Button> : null}
      {task.allowedCommands.includes("retry_target_base_reconciliation") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("retry-target-base-reconciliation")} disabled={disabled}>{busy ? "Retrying…" : "Retry reconciliation"}</Button> : null}
      {task.allowedCommands.includes("retry_forward_merge_verification") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("retry-forward-merge-verification")} disabled={disabled}>{busy ? "Verifying…" : "Retry verification"}</Button> : null}
      {task.allowedCommands.includes("reconcile_ci") ? <Button size="sm" onClick={() => void onPlanAction("reconcile-ci")} disabled={disabled}>{busy ? "Checking…" : "Check CI"}</Button> : null}
      {task.allowedCommands.includes("repair_ci") ? <Button size="sm" onClick={() => void onPlanAction("repair-ci")} disabled={disabled}>{busy ? "Repairing…" : "Repair CI"}</Button> : null}
      {task.allowedCommands.includes("final_review") ? <Button size="sm" onClick={() => void onPlanAction("final-review")} disabled={disabled}>{busy ? "Reviewing…" : "Final review"}</Button> : null}
      {task.allowedCommands.includes("request_delivery_changes") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("request-delivery-changes", "Member requested delivery changes")} disabled={disabled}>Request changes</Button> : null}
      {task.allowedCommands.includes("accept_delivery") ? <Button size="sm" onClick={() => void onPlanAction("accept-delivery")} disabled={disabled}>{busy ? "Accepting…" : "Accept delivery"}</Button> : null}
      {task.allowedCommands.includes("reconcile_acceptance") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("reconcile-acceptance")} disabled={disabled}>{busy ? "Checking…" : "Reconcile ready state"}</Button> : null}
      {task.allowedCommands.includes("reconcile_merge") ? <Button size="sm" onClick={() => void onPlanAction("reconcile-merge")} disabled={disabled}>{busy ? "Checking…" : "Check merge"}</Button> : null}
      {task.allowedCommands.includes("cancel_issue") ? <Button size="sm" variant="outline" onClick={() => void onPlanAction("cancel")} disabled={disabled}>Cancel</Button> : null}
      {canRevise ? <Button size="sm" variant="outline" onClick={() => setRevisionOpen((open) => !open)} disabled={disabled}>{revisionOpen ? "Close revision" : "Revise plan"}</Button> : null}
      {canContinue ? <Button size="sm" variant="outline" onClick={() => setContinueOpen((open) => !open)} disabled={disabled}>{continueOpen ? "Close continuation" : "Continue work"}</Button> : null}
      </div>
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
    </div>
  );
}

function ReleasePanel({ release }: { release: ApiRelease }): ReactElement {
  const copy = (value: string): void => { void navigator.clipboard?.writeText(value); };
  const statusLabel = release.status === "draft" ? "Draft" : release.status === "reconciling" ? "Reconciling" : "Blocked";
  return <section className="space-y-2" aria-label="Draft publication">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">Draft publication</h3><Badge variant={release.status === "blocked" ? "destructive" : "secondary"}>{statusLabel}</Badge></div>
    <div className="text-[13px]">{release.repository} · {release.baseBranch} ← {release.headBranch}</div>
    <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground"><Button variant="ghost" size="sm" title={release.reviewedCommit.full} aria-label={`Copy reviewed commit ${release.reviewedCommit.full}`} onClick={() => copy(release.reviewedCommit.full)}>{release.reviewedCommit.abbreviated}</Button><Button variant="ghost" size="sm" title={release.reviewedTree.full} aria-label={`Copy reviewed tree ${release.reviewedTree.full}`} onClick={() => copy(release.reviewedTree.full)}>{release.reviewedTree.abbreviated}</Button></div>
    {release.pullRequestUrl ? <a className="text-xs underline underline-offset-2" href={release.pullRequestUrl} target="_blank" rel="noreferrer">Pull request #{release.pullRequestNumber}</a> : null}
    {release.failureSummary ? <Alert variant="destructive"><AlertDescription>{release.failureCode ? releaseFailureCopy[release.failureCode] ?? "Release publication is blocked." : release.failureSummary}{release.retryAt ? ` Retry after ${adminDate(release.retryAt)}.` : ""}</AlertDescription></Alert> : null}
    {release.operation ? <div className="text-[11px] text-muted-foreground">{release.operation.kind} · attempt {release.operation.attempt ?? "—"} · {release.operation.status}</div> : null}
    <Collapsible.Root>
      <Collapsible.Trigger className="text-xs underline underline-offset-2">Preview title and body</Collapsible.Trigger>
      <Collapsible.Panel className="mt-2 min-w-0 whitespace-pre-wrap break-words border-l pl-3 text-[11px] text-muted-foreground">{release.title}{release.bodyPreview ? `\n\n${release.bodyPreview}` : "\n\nBody is not available."}</Collapsible.Panel>
    </Collapsible.Root>
  </section>;
}

function CiPanel({ task, ci }: { task: ApiTask; ci: ApiCi }): ReactElement {
  const latestAttempt = ci.attempts[0];
  return <section className="space-y-3 border-y py-3" data-task-ci>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">Exact-head CI</h3><div className="flex items-center gap-2"><Badge variant={ci.outcome === "failed" ? "destructive" : "secondary"}>{ci.outcome ?? ci.status}</Badge><a className="text-xs underline" href={ci.pullRequestUrl} target="_blank" rel="noreferrer">PR #{ci.pullRequestNumber}</a></div></div>
    <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2"><span title={ci.expectedHeadSha}>Expected {ci.expectedHeadSha.slice(0, 10)}…</span><span title={latestAttempt?.observedHeadSha ?? undefined}>Observed {latestAttempt?.observedHeadSha ? `${latestAttempt.observedHeadSha.slice(0, 10)}…` : "—"}</span><span>Revision {ci.policy.projectRevisionId.slice(0, 10)}… · policy {ci.policyHash.slice(0, 8)}…</span><span>{ci.baseBranch} → {ci.headBranch} · {ci.repository}</span></div>
    <div className="space-y-1"><div className="text-[11px] font-medium">Required checks</div>{ci.policy.requiredChecks.map((name) => { const check = latestAttempt?.checks.find((candidate) => candidate.name === name && candidate.selectedForEvaluation); return <div className="flex items-center justify-between gap-2 border-b py-1 text-[11px]" key={name}><span className="min-w-0 break-words">{name}</span><span className="shrink-0 text-muted-foreground">{check ? `${check.status}${check.conclusion ? ` · ${check.conclusion}` : ""}` : "missing"}</span></div>; })}</div>
    <div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><span>Next retry {ci.nextRetryAt ? adminDate(ci.nextRetryAt) : "—"}</span><span>Propagation {ci.propagationDeadline ? adminDate(ci.propagationDeadline) : "—"}</span><span>Overall deadline {ci.overallDeadline ? adminDate(ci.overallDeadline) : "—"}</span><span>Owner {ci.owner ?? "—"}</span></div>
    {ci.reason || latestAttempt?.summary ? <p className="break-words text-[12px]">{ci.reason ? `${ci.reason}: ` : ""}{latestAttempt?.summary ?? ""}</p> : null}
    <div className="flex flex-wrap gap-2 text-[11px]">{latestAttempt?.evidenceArtifactId ? <a className="underline" href={`/api/tasks/${task.id}/artifacts/${latestAttempt.evidenceArtifactId}`}>CI evidence</a> : null}{ci.repairPlan ? <a className="underline" href={`/api/tasks/${task.id}/artifacts/${ci.repairPlan.planArtifactId}`}>Repair plan · {ci.repairPlan.status}</a> : null}<span>Lead continuity {ci.leadSessionContinuity ? "verified" : "—"}</span><span>Developer continuity {ci.developerSessionContinuity ? "verified" : "—"}</span></div>
  </section>;
}

function FinalGatePanel({ task }: { task: ApiTask }): ReactElement | null {
  const gate = task.deliveryGate;
  if (!gate) return null;
  return (
    <section data-final-gate className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold">Final gate</h3>
        <Badge variant={gate.release.state === "merged" ? "secondary" : gate.finalReview?.outcome === "blocking" ? "destructive" : "outline"}>{gate.release.state}</Badge>
      </div>
      <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Pull request</dt><dd><a className="underline underline-offset-2" href={gate.release.pullRequestUrl} target="_blank" rel="noreferrer">#{gate.release.pullRequestNumber}</a> · {gate.release.repository}</dd></div>
        <div><dt className="text-muted-foreground">Exact identity</dt><dd className="break-all"><span title={gate.release.baseSha}>base {gate.release.baseSha.slice(0, 8)}…</span> · <span title={gate.release.headSha}>head {gate.release.headSha.slice(0, 8)}…</span> · <span title={gate.release.headTree}>tree {gate.release.headTree.slice(0, 8)}…</span></dd></div>
        <div><dt className="text-muted-foreground">CI</dt><dd>{gate.ci ? `${gate.ci.status}: ${gate.ci.summary}` : "Not recorded"}</dd>{gate.ci?.checks.length ? <ul className="mt-1 space-y-0.5 text-muted-foreground">{gate.ci.checks.map((check) => <li key={check.name}>{check.name}: {check.conclusion ?? check.status}</li>)}</ul> : null}</div>
        <div><dt className="text-muted-foreground">Final review</dt><dd>{gate.finalReview ? `${gate.finalReview.outcome}: ${gate.finalReview.summary}` : "Not recorded"}</dd>{gate.finalReview ? <div className="text-muted-foreground">Lead session: <span className="break-all">{gate.finalReview.sessionRef}</span></div> : null}</div>
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
    </section>
  );
}

function TaskOptions(): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Task options" title="Task options" />}><Ellipsis /></DropdownMenuTrigger>
      <DropdownMenuContent align="start"><DropdownMenuItem disabled>Coming soon</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  );
}

function PlanningRunCard({ task }: { task: ApiTask }): ReactElement | null {
  const invocation = [...task.agentInvocations].reverse().find((candidate) => candidate.role === "lead" && ["starting", "running", "cancelling"].includes(candidate.status));
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
  const agentName = invocation?.profileName ?? task.capacity?.profileName ?? "Lead agent";
  return (
    <Card data-planning-run size="sm" aria-label="Planning run">
      <CardHeader>
        <CardTitle>Planning run</CardTitle>
        <CardDescription>{agentName} · Lead · attempt {invocation?.attempt ?? 1}{invocation?.sessionPresent ? " · session connected" : ""}</CardDescription>
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

export function TaskDetailsPage({ task, project, companyId, busy, error, isAdmin, onStartPlanning, onPlanAction, onRevisePlan, onContinueWork, onResolveDecisionBlocker }: { task: ApiTask; project: ApiProject | undefined; companyId: string; busy: boolean; error: string; isAdmin: boolean; onStartPlanning: () => Promise<void>; onPlanAction: (path: TaskPlanAction, note?: string, payload?: Record<string, unknown>) => Promise<void>; onRevisePlan: (input: PlanRevisionInput) => Promise<void>; onContinueWork: (reason: string) => Promise<void>; onResolveDecisionBlocker: (answer: string) => Promise<void> }): ReactElement {
  const approveCommand = task.commands.find((command) => command.name === "approve_plan" && command.subject?.kind === "plan_decision");
  const revisionCommand = task.commands.find((command) => command.name === "request_plan_revision" && command.subject?.kind === "plan_decision");
  const blockerCommand = task.commands.find((command) => command.name === "respond_plan_blocker" && command.subject?.kind === "plan_blocker");
  const [decisionName, setDecisionName] = useState<"approve_plan" | "request_plan_revision">("approve_plan");
  const decisionCommand = decisionName === "request_plan_revision" ? revisionCommand ?? approveCommand : approveCommand ?? revisionCommand;
  const [developerEvents, setDeveloperEvents] = useState<DeveloperExecutionEventView[]>([]);
  useEffect(() => {
    let active = true;
    if (!task.developerExecution) { setDeveloperEvents([]); return () => { active = false; }; }
    void readJson<{ events: DeveloperExecutionEventView[] }>(`/api/tasks/${encodeURIComponent(task.id)}/developer-executions/${encodeURIComponent(task.developerExecution.id)}/events`).then((result) => { if (active) setDeveloperEvents(result.events); }).catch(() => { if (active) setDeveloperEvents([]); });
    return () => { active = false; };
  }, [task.id, task.developerExecution?.id, task.developerExecution?.currentStep, task.developerExecution?.status]);
  const [answer, setAnswer] = useState("");
  useEffect(() => { setAnswer(""); }, [task.id, task.revision]);
  return (
    <ApplicationFrame title={task.issueKey ? `${task.issueKey} · ${task.title}` : task.title} headerActions={<TaskOptions />}>
      <article data-task-detail className="min-w-0">
        <div data-task-body className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            <header className="px-4 pt-4 pb-3 sm:px-6 lg:px-10">
              <div data-task-header-content className="mx-auto max-w-4xl space-y-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2"><h2 className="text-xl font-semibold tracking-tight">{task.title}</h2><Badge variant="secondary" data-status={task.phase}><TaskStatus phase={task.phase} /></Badge></div>
                <TaskActions task={task} busy={busy} onStartPlanning={onStartPlanning} onPlanAction={onPlanAction} onRevisePlan={onRevisePlan} onContinueWork={onContinueWork} />
                {approveCommand && revisionCommand ? <Field><FieldLabel htmlFor="plan-decision-action">Decision</FieldLabel><Select value={decisionName} onValueChange={(value) => { if (value === "approve_plan" || value === "request_plan_revision") setDecisionName(value); }}><SelectTrigger id="plan-decision-action"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="approve_plan">Approve plan</SelectItem><SelectItem value="request_plan_revision">Request plan revision</SelectItem></SelectContent></Select></Field> : null}
                {decisionCommand?.subject?.kind === "plan_decision" ? <PlanDecisionForm key={decisionCommand.name} command={{ endpoint: decisionCommand.endpoint, expectedRevision: decisionCommand.expectedRevision, subject: decisionCommand.subject.value }} actionLabel={decisionCommand.label} busy={busy} onSubmit={(payload) => onPlanAction(decisionCommand.endpoint as TaskPlanAction, payload.note, { subject: payload.subject, idempotencyKey: payload.idempotencyKey })} error={error} /> : null}
                <DeveloperRecoveryStatus taskId={task.id} recovery={task.developerRecovery} allowedCommands={task.allowedCommands} busy={busy} isAdmin={isAdmin} onAction={async (action: DeveloperRecoveryAction) => onPlanAction(action === "cancel-issue" ? "cancel" : action)} />
                {task.capacity ? <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{task.capacity.status === "active" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}<span>{task.capacity.status === "queued" ? `Queued${task.capacity.position ? ` · position ${task.capacity.position}` : ""}` : task.capacity.status === "rate_limited" ? `Waiting for profile reset${task.capacity.retryAt ? ` · ${relativeTime(task.capacity.retryAt)}` : ""}` : task.capacity.status === "active" ? `Running · ${task.capacity.profileName}` : task.capacity.status === "exhausted" ? "Capacity exhausted" : "Ownership needs verification"}</span></div> : null}
                {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
              </div>
            </header>
            <div data-task-content className="min-w-0 px-4 pt-4 pb-6 sm:px-6 lg:px-10">
              <div data-task-content-inner className="mx-auto max-w-4xl space-y-7">
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-5">{task.description || "No description."}</pre>
                <TaskProgress phase={task.phase} allowedCommands={task.allowedCommands} createdAt={task.createdAt} updatedAt={task.updatedAt} timeline={task.timeline} />
                <PlanningRunCard task={task} />
                {task.images.length ? <section className="space-y-2"><h3 className="text-xs font-semibold">Attachments</h3><div className="flex flex-wrap gap-3">{task.images.map((image) => <a className="text-xs underline underline-offset-2" href={`/api/tasks/${task.id}/images/${image.artifactId}`} target="_blank" rel="noreferrer" key={image.artifactId}>{image.filename}</a>)}</div></section> : null}
                {task.leadOutput && (task.leadOutput.content.kind !== "decision_blocker" || !task.governance.blocker) ? <TaskLeadPlan output={task.leadOutput} planRevision={task.planRevision} planMaterial={task.planMaterial} materialCategories={task.materialCategories ?? []} /> : null}
                {task.governance.originalPlan ? <PlanSubjectSummary subject={task.governance.originalPlan.subject} current={task.governance.originalPlan.status === "current"} label="Original plan" createdAt={task.governance.originalPlan.createdAt} /> : null}
                {task.governance.finalPlan && task.governance.finalPlan.subject.outputId !== task.governance.originalPlan?.subject.outputId ? <PlanSubjectSummary subject={task.governance.finalPlan.subject} current={task.governance.finalPlan.status === "current"} label={`Final plan v${task.governance.finalPlan.subject.finalVersion}`} createdAt={task.governance.finalPlan.createdAt} /> : null}
                {task.governance.previousPlans?.map((plan) => <PlanSubjectSummary key={plan.subject.outputId} subject={plan.subject} current={false} createdAt={plan.createdAt} />) ?? null}
                {task.governance.materiality ? <MaterialitySummary value={{ categories: task.governance.materiality.categories, artifactId: task.governance.materiality.evidenceArtifactId, artifactSha256: task.governance.materiality.evidenceArtifactSha256, evidence: task.governance.materiality.evidence.map((entry) => ({ category: entry.category, rationale: entry.rationale, evidenceRefs: entry.refs })) }} /> : null}
                {task.governance.supplementalReview ? <SupplementalReviewPanel value={{ reviewerProfileId: task.governance.supplementalReview.reviewerProfile.name, opinion: task.governance.supplementalReview.opinion, concerns: task.governance.supplementalReview.concerns, requiredChanges: task.governance.supplementalReview.requiredChanges, leadResponse: task.governance.supplementalReview.leadResponse.text }} /> : null}
                {task.governance.decision ? <section className="space-y-1" data-plan-decision><h3 className="text-xs font-semibold">Member decision</h3><div className="text-[13px]">{task.governance.decision.decision} · {task.governance.decision.actor.displayName}</div><p className="whitespace-pre-wrap text-[12px]">{task.governance.decision.note}</p></section> : null}
                {task.governance.blocker && blockerCommand?.subject?.kind === "plan_blocker" ? <PlanBlockerResponseForm blocker={task.governance.blocker} expectedRevision={blockerCommand.expectedRevision} busy={busy} onSubmit={(payload) => onPlanAction(blockerCommand.endpoint as TaskPlanAction, undefined, { subject: payload.subject, answer: payload.answer, idempotencyKey: payload.idempotencyKey, expectedWorkflowRevision: payload.expectedWorkflowRevision })} error={error} /> : task.governance.blocker ? <section className="space-y-1" data-plan-blocker><h3 className="text-xs font-semibold">{task.governance.blocker.header}</h3><p className="text-[13px]">{task.governance.blocker.question}</p><p className="text-[12px] text-muted-foreground">{task.governance.blocker.nextAction}</p></section> : null}
                {task.leadOutput?.content.kind === "decision_blocker" && task.allowedCommands.includes("resolve_decision_blocker") ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void onResolveDecisionBlocker(answer); }}><FieldLabel htmlFor="decision-answer">Decision</FieldLabel><Textarea id="decision-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer the Lead's question" maxLength={8000} /><Button size="sm" type="submit" disabled={busy || !answer.trim()}>{busy ? "Saving…" : "Resolve decision"}</Button></form> : null}
                {task.developerExecution ? <div className="space-y-4"><DeveloperEvidence taskId={task.id} execution={task.developerExecution} events={developerEvents} />{task.developerExecution.status === "completed" ? <Suspense fallback={<Skeleton className="h-40 w-full" />}><DeveloperDiff taskId={task.id} executionId={task.developerExecution.id} /></Suspense> : null}</div> : null}
                <DeliveryReviewPanel task={task} />
                {task.ci ? <CiPanel task={task} ci={task.ci} /> : null}
                {task.release ? <ReleasePanel release={task.release} /> : null}
                {task.targetBaseReconciliation.status ? <section className="space-y-2"><div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold">Target-base reconciliation</h3><Badge variant={task.targetBaseReconciliation.status === "blocked" ? "destructive" : "secondary"}>{task.targetBaseReconciliation.status}</Badge></div><div className="text-[11px] text-muted-foreground">{task.targetBaseReconciliation.checkpoint ?? "checkpoint unavailable"}{task.targetBaseReconciliation.conflictFileCount !== null ? ` · ${task.targetBaseReconciliation.conflictFileCount} conflict files` : ""}</div><dl className="grid gap-1 text-[11px] sm:grid-cols-2"><div><dt className="text-muted-foreground">Expected base</dt><dd><code>{task.targetBaseReconciliation.expectedBaseSha?.slice(0, 12) ?? "—"}</code></dd></div><div><dt className="text-muted-foreground">Observed base</dt><dd><code>{task.targetBaseReconciliation.observedBaseSha?.slice(0, 12) ?? "—"}</code></dd></div><div><dt className="text-muted-foreground">Result</dt><dd><code>{task.targetBaseReconciliation.resultHead?.slice(0, 12) ?? "—"}</code></dd></div><div><dt className="text-muted-foreground">Verification</dt><dd>{task.targetBaseReconciliation.verificationArtifact ? <a className="underline" href={`/api/tasks/${task.id}/reconciliation-artifacts/${task.targetBaseReconciliation.verificationArtifact.id}`} target="_blank" rel="noreferrer">Evidence</a> : "—"}</dd></div></dl>{task.targetBaseReconciliation.releaseId && task.targetBaseReconciliation.pullRequestUrl ? <div className="text-[11px]"><a className="underline" href={task.targetBaseReconciliation.pullRequestUrl} target="_blank" rel="noreferrer">PR #{task.targetBaseReconciliation.pullRequestNumber}</a> · same PR continuity</div> : null}{task.targetBaseReconciliation.summary ? <div className="text-[12px] text-muted-foreground">{task.targetBaseReconciliation.summary}</div> : null}</section> : null}
                <FinalGatePanel task={task} />
                <TaskHistory task={task} companyId={companyId} />
              </div>
            </div>
          </div>
          <aside data-task-properties className="border-border border-t bg-muted/20 px-4 py-6 sm:px-6 lg:sticky lg:top-0 lg:h-fit lg:border-t-0 lg:border-l">
            <h3 className="mb-5 text-xs font-semibold">Properties</h3>
            <dl className="space-y-4 text-xs">
              <div className="space-y-1"><dt className="text-muted-foreground">Status</dt><dd><Badge variant="secondary" data-status={task.phase}><TaskStatus phase={task.phase} /></Badge></dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Project</dt><dd>{project?.name ?? "Unknown project"}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Owner</dt><dd>{task.owner}</dd></div>
              <div className="space-y-1"><dt className="text-muted-foreground">Next action</dt><dd>{task.pendingAction ?? "None"}</dd></div>
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
