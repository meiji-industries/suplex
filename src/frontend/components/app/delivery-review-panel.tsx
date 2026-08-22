import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";
import type { ReactElement } from "react";
import { Markdown } from "./markdown.js";

type Task = TaskResponse;

function reviewDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function completedRepairAttempt(task: Task, reviewId: string): number | undefined {
  return task.reviewLineage.repairAttempts
    .filter((attempt) => attempt.reviewId === reviewId && attempt.status === "completed")
    .reduce<number | undefined>((latest, attempt) => latest === undefined || attempt.cycle > latest ? attempt.cycle : latest, undefined);
}

export function DeliveryReviewPanel({ task }: { task: Task; repository?: string | undefined }): ReactElement | null {
  const review = task.reviewLineage.currentReview;
  const blockerCode = task.deliveryReviewBlockerCode ?? task.deliveryRepairBlockerCode;
  if (!review && !blockerCode && !task.reviewLineage.reviewAttempts.length && !task.reviewLineage.repairAttempts.length && !task.reviewLineage.priorReviews.length) return null;
  const blockerSummary = task.deliveryReviewBlockerSummary ?? task.deliveryRepairBlockerSummary;
  const findings = review ? [...review.findings].sort((left, right) => Number(right.severity === "blocking") - Number(left.severity === "blocking")) : [];
  return (
    <Card data-delivery-review-card size="sm">
      <CardHeader>
        <CardTitle id="delivery-review-heading">Delivery review</CardTitle>
      </CardHeader>
      <CardContent>
        <section className="space-y-3" aria-labelledby="delivery-review-heading">
          {review ? <>
            <Markdown source={review.summary} />
            {findings.length ? <ul className="space-y-2 text-[12px]" aria-label="Review findings">{findings.map((finding) => {
              const attempt = finding.disposition === "open" ? undefined : completedRepairAttempt(task, review.id);
              const addressed = finding.disposition !== "open";
              return <li className="flex min-w-0 items-start gap-2" key={finding.id}>
                <input aria-label={addressed ? "Finding addressed" : "Finding open"} checked={addressed} className="mt-0.5 size-3.5 shrink-0 accent-foreground" readOnly type="checkbox" />
                <div className="min-w-0"><Markdown source={finding.rationale} />{attempt !== undefined ? <span className="ml-1 text-muted-foreground">fixed in attempt {attempt}</span> : addressed ? <span className="ml-1 text-muted-foreground">accepted</span> : null}<code className="ml-2 break-all text-[11px] text-muted-foreground">{finding.evidenceRef}</code></div>
              </li>;
            })}</ul> : null}
          </> : blockerCode ? <div role="alert"><Markdown source={blockerSummary ?? blockerCode} /></div> : null}
          {task.reviewLineage.priorReviews.length ? <details className="text-[12px]"><summary className="cursor-pointer text-muted-foreground">Previous reviews ({task.reviewLineage.priorReviews.length})</summary><ul className="mt-2 space-y-2 border-l pl-3">{task.reviewLineage.priorReviews.map((priorReview) => <li key={priorReview.id}><Markdown source={priorReview.summary} /><time className="text-[11px] text-muted-foreground" dateTime={priorReview.createdAt}>{reviewDate(priorReview.createdAt)}</time></li>)}</ul></details> : null}
        </section>
      </CardContent>
    </Card>
  );
}
