import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Collapsible } from "../ui/collapsible.js";
import { CommitSha } from "../app/commit-sha.js";
import type { ReactElement } from "react";
import type { DeveloperExecutionEventResponse, TaskResponse } from "../../../http/contracts/tasks.js";

export type DeveloperExecutionView = NonNullable<TaskResponse["developerExecution"]>;
export type DeveloperExecutionEventView = DeveloperExecutionEventResponse;

function artifactHref(taskId: string, artifactId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/developer-artifacts/${encodeURIComponent(artifactId)}`;
}

export function DevelopmentStatus({ execution, repository }: { execution: DeveloperExecutionView; repository?: string | undefined }): ReactElement {
  const reconciled = execution.status === "completed" && Boolean(execution.reconciliationArtifactId);
  return (
    <section className="space-y-3" data-developer-status>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">Implementer execution</h3><Badge variant={reconciled ? "secondary" : execution.status === "blocked" || execution.status === "failed" ? "destructive" : "outline"}>{reconciled ? "reconciled" : execution.status}</Badge></div>
      <div className="min-w-0 truncate text-xs text-muted-foreground">Attempt {execution.attempt} · <code title={execution.branchName}>{execution.branchName}</code></div>
      {execution.failureSummary ? <p className="text-xs text-destructive">{execution.failureCode ? `${execution.failureCode}: ` : ""}{execution.failureSummary}</p> : null}
      <Collapsible.Root>
        <Collapsible.Trigger render={<Button variant="ghost" size="sm" />}>Execution details</Collapsible.Trigger>
        <Collapsible.Panel><div className="grid gap-x-4 gap-y-2 pt-2 text-xs sm:grid-cols-2">
          <div><span className="text-muted-foreground">Boundary</span><div>{(execution.boundaryMode ?? "owner_controlled_observed") === "owner_controlled_observed" ? "Owner-controlled local execution; provider state observed" : execution.boundaryMode}</div></div>
          <div><span className="text-muted-foreground">Starting commit/tree</span><div className="break-all"><CommitSha sha={execution.startingCommit ?? execution.targetBaseSha} repository={repository} /> / <code>{execution.startingTree ? `${execution.startingTree.slice(0, 8)}…` : "—"}</code></div></div>
          <div><span className="text-muted-foreground">Final commit/tree</span><div className="break-all"><CommitSha sha={execution.resultCommit} repository={repository} /> / <code>{execution.resultTree ? `${execution.resultTree.slice(0, 8)}…` : "—"}</code></div></div>
          <div><span className="text-muted-foreground">Worktree</span><div>{execution.dirtyState ?? "not reconciled"}</div></div>
          <div><span className="text-muted-foreground">Provider observation</span><div>{execution.providerObservation ?? "unavailable"}</div></div>
        </div></Collapsible.Panel>
      </Collapsible.Root>
    </section>
  );
}

export function DeliveryReportPanel({ taskId, execution }: { taskId: string; execution: DeveloperExecutionView }): ReactElement | null {
  const links = [
    ["Manifest", execution.manifestArtifactId],
    ["Raw delivery", execution.rawReportArtifactId],
    ["Before provider", execution.beforeProviderArtifactId],
    ["After provider", execution.afterProviderArtifactId],
    ["Reconciliation", execution.reconciliationArtifactId],
  ] as const;
  if (!links.some(([, artifactId]) => artifactId)) return null;
  return (
    <section className="space-y-2" data-delivery-report>
      <h3 className="text-xs font-semibold">Delivery evidence</h3>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">{links.map(([label, artifactId]) => artifactId ? <a className="underline underline-offset-2" href={artifactHref(taskId, artifactId)} target="_blank" rel="noreferrer" key={label}>{label}</a> : null)}</div>
    </section>
  );
}

export function DeveloperEvidence({ taskId, execution, repository }: { taskId: string; execution: DeveloperExecutionView; repository?: string | undefined }): ReactElement {
  return <div className="space-y-5" data-developer-evidence><DevelopmentStatus execution={execution} repository={repository} /><DeliveryReportPanel taskId={taskId} execution={execution} /></div>;
}
