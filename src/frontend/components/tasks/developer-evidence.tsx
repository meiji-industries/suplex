import { Badge } from "../ui/badge.js";
import type { ReactElement } from "react";

export interface DeveloperExecutionView {
  id: string;
  status: string;
  attempt: number;
  branchName: string;
  currentStep?: number | null | undefined;
  targetBaseSha: string;
  startingCommit?: string | null | undefined;
  startingTree?: string | null | undefined;
  resultCommit?: string | null | undefined;
  resultTree?: string | null | undefined;
  dirtyState?: string | null | undefined;
  boundaryMode?: string | null | undefined;
  providerObservation?: "matching" | "different" | "unavailable" | undefined;
  verificationCommands?: Array<{ stepNumber: number; commands: string[] }> | undefined;
  manifestArtifactId?: string | null | undefined;
  rawReportArtifactId?: string | null | undefined;
  reconciliationArtifactId?: string | null | undefined;
  beforeProviderArtifactId?: string | null | undefined;
  afterProviderArtifactId?: string | null | undefined;
  evidenceArtifactId?: string | null | undefined;
  failureCode?: string | null | undefined;
  failureSummary?: string | null | undefined;
}

export interface DeveloperExecutionEventView {
  eventId: string;
  sequence: number;
  kind: string;
  stepNumber: number | null;
  occurredAt: string;
  summary: string;
  exitCode: number | null;
  artifactId: string | null;
}

function shortHash(value: string | null | undefined): string {
  return value ? `${value.slice(0, 8)}…` : "—";
}

function artifactHref(taskId: string, artifactId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/developer-artifacts/${encodeURIComponent(artifactId)}`;
}

export function DevelopmentStatus({ execution }: { execution: DeveloperExecutionView }): ReactElement {
  const reconciled = execution.status === "completed" && Boolean(execution.reconciliationArtifactId);
  return (
    <section className="space-y-3" data-developer-status>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">Developer execution</h3><Badge variant={reconciled ? "secondary" : execution.status === "blocked" || execution.status === "failed" ? "destructive" : "outline"}>{reconciled ? "reconciled" : execution.status}</Badge></div>
      <div className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div><span className="text-muted-foreground">Attempt</span><div>{execution.attempt}</div></div>
        <div><span className="text-muted-foreground">Confirmed step</span><div>{execution.currentStep ?? "none"}</div></div>
        <div className="min-w-0"><span className="text-muted-foreground">Branch</span><code className="block break-all">{execution.branchName}</code></div>
        <div><span className="text-muted-foreground">Boundary</span><div>{(execution.boundaryMode ?? "owner_controlled_observed") === "owner_controlled_observed" ? "Owner-controlled local execution; provider state observed" : execution.boundaryMode}</div></div>
        <div><span className="text-muted-foreground">Starting commit/tree</span><code className="block break-all">{shortHash(execution.startingCommit ?? execution.targetBaseSha)} / {shortHash(execution.startingTree)}</code></div>
        <div><span className="text-muted-foreground">Final commit/tree</span><code className="block break-all">{shortHash(execution.resultCommit)} / {shortHash(execution.resultTree)}</code></div>
        <div><span className="text-muted-foreground">Worktree</span><div>{execution.dirtyState ?? "not reconciled"}</div></div>
        <div><span className="text-muted-foreground">Provider observation</span><div>{execution.providerObservation ?? "unavailable"}</div></div>
      </div>
      {execution.failureSummary ? <p className="text-xs text-destructive">{execution.failureCode ? `${execution.failureCode}: ` : ""}{execution.failureSummary}</p> : null}
    </section>
  );
}

export function PlanStepProgress({ execution, events }: { execution: DeveloperExecutionView; events: DeveloperExecutionEventView[] }): ReactElement {
  const terminal = new Map<number, string>();
  for (const event of events) if (event.stepNumber !== null && ["step_completed", "step_blocked"].includes(event.kind)) terminal.set(event.stepNumber, event.kind === "step_completed" ? "completed" : "blocked");
  return (
    <section className="space-y-2" data-plan-step-progress>
      <h3 className="text-xs font-semibold">Plan step progress</h3>
      {execution.verificationCommands?.length ? <ol className="grid gap-2 text-xs">{execution.verificationCommands.map((step) => <li className="grid gap-1 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-3" key={step.stepNumber}><div className="font-medium">Step {step.stepNumber} · {terminal.get(step.stepNumber) ?? (execution.currentStep === step.stepNumber ? "active" : "pending")}</div><div className="min-w-0 break-words text-muted-foreground">{step.commands.length ? step.commands.join(" · ") : "No required command"}</div></li>)}</ol> : <p className="text-xs text-muted-foreground">No immutable verification commands were recorded.</p>}
    </section>
  );
}

export function VerificationReceiptList({ events }: { events: DeveloperExecutionEventView[] }): ReactElement {
  const receipts = events.filter((event) => ["command_finished", "test_result", "file_change", "step_blocked"].includes(event.kind));
  return (
    <section className="space-y-2" data-verification-receipts>
      <h3 className="text-xs font-semibold">Verification receipts</h3>
      {receipts.length ? <div className="grid gap-1">{receipts.map((event) => <div className="grid min-h-8 min-w-0 items-center gap-1 border-l-2 border-border pl-2 text-xs sm:grid-cols-[4rem_4rem_minmax(0,1fr)_3rem] sm:gap-2" key={event.eventId}><span>#{event.sequence}</span><span>step {event.stepNumber ?? "—"}</span><code className="break-words whitespace-pre-wrap">{event.summary}</code><span className={event.exitCode !== null && event.exitCode !== 0 ? "font-medium text-destructive" : "text-muted-foreground"}>{event.kind === "step_blocked" ? "blocked" : event.kind === "file_change" ? "changed" : event.exitCode === null ? "—" : `exit ${event.exitCode}`}</span></div>)}</div> : <p className="text-xs text-muted-foreground">No command receipts yet.</p>}
    </section>
  );
}

export function DeliveryReportPanel({ taskId, execution }: { taskId: string; execution: DeveloperExecutionView }): ReactElement {
  const links = [
    ["Manifest", execution.manifestArtifactId],
    ["Raw delivery", execution.rawReportArtifactId],
    ["Before provider", execution.beforeProviderArtifactId],
    ["After provider", execution.afterProviderArtifactId],
    ["Reconciliation", execution.reconciliationArtifactId],
  ] as const;
  return (
    <section className="space-y-2" data-delivery-report>
      <h3 className="text-xs font-semibold">Delivery evidence</h3>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">{links.map(([label, artifactId]) => artifactId ? <a className="underline underline-offset-2" href={artifactHref(taskId, artifactId)} target="_blank" rel="noreferrer" key={label}>{label}</a> : null)}</div>
    </section>
  );
}

export function DeveloperEvidence({ taskId, execution, events }: { taskId: string; execution: DeveloperExecutionView; events: DeveloperExecutionEventView[] }): ReactElement {
  return <div className="space-y-5"><DevelopmentStatus execution={execution} /><PlanStepProgress execution={execution} events={events} /><VerificationReceiptList events={events} /><DeliveryReportPanel taskId={taskId} execution={execution} /></div>;
}
