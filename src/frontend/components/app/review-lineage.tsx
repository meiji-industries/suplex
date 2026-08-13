import { Badge } from "../ui/badge.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { RevisionIdentity } from "./revision-identity.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";
import type { ReactElement } from "react";

type Lineage = TaskResponse["reviewLineage"];
type Review = NonNullable<Lineage["currentReview"]>;
type ReviewAttempt = Lineage["reviewAttempts"][number];
type RepairAttempt = Lineage["repairAttempts"][number];

function artifactLink(taskId: string, artifactId: string, label: string): ReactElement {
  return <a className="break-all text-primary underline underline-offset-2" href={`/api/tasks/${taskId}/review-artifacts/${artifactId}`} target="_blank" rel="noreferrer">{label}</a>;
}

function revisionValue(label: string, value: string | null, abbreviated: string | null): ReactElement | null {
  return value && abbreviated ? <span className="text-muted-foreground">{label}: <code title={value}>{abbreviated}</code></span> : null;
}

function reviewRow(taskId: string, review: Review, current: boolean): ReactElement {
  return (
    <li className="min-w-0 space-y-2 py-2" key={`review:${review.id}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={review.outcome === "blocking" ? "destructive" : "secondary"}>{review.outcome}</Badge>
        <span className="text-[11px] text-muted-foreground">Lead review</span>
        {current ? <Badge variant="outline">current</Badge> : null}
        {review.supersedesReviewId ? <span className="text-[11px] text-muted-foreground">supersedes {review.supersedesReviewId.slice(0, 12)}</span> : null}
        {review.successorReviewId ? <span className="text-[11px] text-muted-foreground">superseded by {review.successorReviewId.slice(0, 12)}</span> : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-[12px]">{review.summary}</p>
      <RevisionIdentity revision={review} />
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {artifactLink(taskId, review.opinionArtifactId, "opinion")}
        {artifactLink(taskId, review.evidenceArtifactId, "evidence")}
        <span className="text-muted-foreground">Lead continued: {review.leadSessionContinued ? "yes" : "no"}</span>
        <span className="text-muted-foreground">Developer continued: {review.developerSessionContinued ? "yes" : "no"}</span>
      </div>
    </li>
  );
}

function reviewAttemptRow(taskId: string, attempt: ReviewAttempt): ReactElement {
  return (
    <li className="min-w-0 space-y-1 border-l pl-2 py-2 text-[11px]" key={`attempt:${attempt.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={attempt.status === "completed" ? "secondary" : attempt.status === "blocked" ? "destructive" : "outline"}>{attempt.status}</Badge>
        <span className="text-muted-foreground">Lead review attempt</span>
        {attempt.code ? <span className="text-muted-foreground">{attempt.code}</span> : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{attempt.summary ?? "No blocker."}</p>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        {attempt.evidenceArtifactId ? artifactLink(taskId, attempt.evidenceArtifactId, "review evidence") : null}
      </div>
    </li>
  );
}

function repairRow(taskId: string, repair: RepairAttempt): ReactElement {
  return (
    <li className="min-w-0 space-y-1 border-l pl-2 py-2 text-[11px]" key={`repair:${repair.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={repair.status === "completed" ? "secondary" : "destructive"}>cycle {repair.cycle} · {repair.status}</Badge>
        <span className="text-muted-foreground">Developer repair</span>
        {repair.code ? <span className="text-muted-foreground">{repair.code}</span> : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{repair.summary ?? "Repair completed."}</p>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        {revisionValue("prior head", repair.priorCommit, repair.priorCommitAbbrev)}
        {revisionValue("prior tree", repair.priorTree, repair.priorTreeAbbrev)}
        {revisionValue("result head", repair.resultCommit, repair.resultCommitAbbrev)}
        {revisionValue("result tree", repair.resultTree, repair.resultTreeAbbrev)}
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        {repair.deliveryArtifactId ? artifactLink(taskId, repair.deliveryArtifactId, "repair report") : null}
        {repair.evidenceArtifactId ? artifactLink(taskId, repair.evidenceArtifactId, "evidence") : null}
      </div>
    </li>
  );
}

type LineageEvent =
  | { kind: "review"; createdAt: string; value: Review }
  | { kind: "attempt"; createdAt: string; value: ReviewAttempt }
  | { kind: "repair"; createdAt: string; value: RepairAttempt };

function eventRank(event: LineageEvent): number {
  if (event.kind === "attempt") return 0;
  if (event.kind === "repair") return 2;
  return event.value.supersedesReviewId ? 3 : 1;
}

export function ReviewLineage({ taskId, lineage }: { taskId: string; lineage: Lineage }): ReactElement {
  const reviews = [lineage.currentReview, ...lineage.priorReviews].filter((review): review is Review => Boolean(review));
  const events: LineageEvent[] = [
    ...reviews.map((review) => ({ kind: "review" as const, createdAt: review.createdAt, value: review })),
    ...lineage.reviewAttempts.map((attempt) => ({ kind: "attempt" as const, createdAt: attempt.createdAt, value: attempt })),
    ...lineage.repairAttempts.map((repair) => ({ kind: "repair" as const, createdAt: repair.createdAt, value: repair })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || eventRank(left) - eventRank(right) || (left.value.id.localeCompare(right.value.id)));

  return (
    <section className="min-w-0" aria-labelledby="review-lineage-heading">
      <Accordion>
        <AccordionItem value="review-lineage">
          <AccordionTrigger><span><span id="review-lineage-heading">Review lineage</span> · {lineage.reviewAttempts.length} attempts · {lineage.repairAttempts.length} repairs</span></AccordionTrigger>
          <AccordionContent>
            {events.length ? <ol className="min-w-0 divide-y">{events.map((event) => event.kind === "review" ? reviewRow(taskId, event.value, event.value.id === lineage.currentReview?.id) : event.kind === "attempt" ? reviewAttemptRow(taskId, event.value) : repairRow(taskId, event.value))}</ol> : <p className="text-[12px] text-muted-foreground">No completed review yet.</p>}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}
