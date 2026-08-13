import { Badge } from "../ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import { ReviewFindingRow } from "./review-finding-row.js";
import { ReviewLineage } from "./review-lineage.js";
import { RevisionIdentity } from "./revision-identity.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";
import type { ReactElement } from "react";

type Task = TaskResponse;

function artifactLink(taskId: string, artifactId: string, label: string): ReactElement {
  return <a className="break-all text-primary underline underline-offset-2" href={`/api/tasks/${taskId}/review-artifacts/${artifactId}`} target="_blank" rel="noreferrer">{label}</a>;
}

export function DeliveryReviewPanel({ task }: { task: Task }): ReactElement | null {
  const review = task.reviewLineage.currentReview;
  const blockerCode = task.deliveryReviewBlockerCode ?? task.deliveryRepairBlockerCode;
  if (!review && !blockerCode && !task.reviewLineage.reviewAttempts.length && !task.reviewLineage.repairAttempts.length && !task.reviewLineage.priorReviews.length) return null;
  const blockerSummary = task.deliveryReviewBlockerSummary ?? task.deliveryRepairBlockerSummary;
  const blockerArtifactId = task.deliveryReviewBlockerEvidenceArtifactId ?? task.deliveryRepairBlockerEvidenceArtifactId;
  return (
    <Card data-delivery-review-card size="sm" className="min-w-0 gap-0">
      <CardHeader className="border-b py-2">
        <CardTitle className="flex items-center justify-between gap-2 text-xs">
          <span id="delivery-review-heading">Delivery review</span>
          {review ? <Badge variant={review.outcome === "blocking" ? "destructive" : "secondary"}>{review.outcome}</Badge> : blockerCode ? <Badge variant="destructive">blocked</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="gap-3 py-3">
        <section className="min-w-0 space-y-3" aria-labelledby="delivery-review-heading">
          {blockerCode ? <div className="min-w-0 space-y-1 border-l-2 border-destructive pl-2 text-[12px]" role="alert"><div className="font-medium">{blockerCode}</div><p className="whitespace-pre-wrap break-words text-muted-foreground">{blockerSummary}</p>{blockerArtifactId ? artifactLink(task.id, blockerArtifactId, "blocker evidence") : null}<div className="text-[11px] text-muted-foreground">Owner: {task.owner} · Allowed: {task.allowedCommands.join(", ") || "none"}</div></div> : null}
          {review ? <><p className="whitespace-pre-wrap break-words text-[13px]">{review.summary}</p><RevisionIdentity revision={review} /><div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px]">{artifactLink(task.id, review.opinionArtifactId, "opinion")}{artifactLink(task.id, review.evidenceArtifactId, "evidence")}</div><div className="min-w-0 divide-y border-y">{review.findings.map((finding) => <ReviewFindingRow finding={finding} key={finding.id} />)}</div></> : null}
          <ReviewLineage taskId={task.id} lineage={task.reviewLineage} />
        </section>
      </CardContent>
    </Card>
  );
}
