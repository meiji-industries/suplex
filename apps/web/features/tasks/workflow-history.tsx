import { z } from "zod";
import type { Task } from "../../contracts/tasks.js";
import { ADVISOR_LABELS, latestReview } from "./workflow-presentation.js";
import type { ReviewRecord } from "../../contracts/generated/ReviewRecord.js";
import { ReviewerResultSchema, RaterResultSchema, REPAIR_RATING_TARGET } from "../../contracts/advisor-reports.js";
import { formatTurnDuration, type TaskActivity } from "./task-work.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Markdown } from "../../components/app/markdown.js";
import { CheckCircle2, ChevronRight, FileText, Gauge, XCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible } from "../../components/ui/collapsible.js";

const ObservationSchema = z.object({ text: z.string().optional() });
const short = (sha: string) => sha.slice(0, 10);

function reportText(activity: TaskActivity, turnId: string): string {
  const turn = activity.turns.find(turn => turn.id === turnId && turn.status === "completed");
  if (!turn?.result) return "";
  try { const parsed = ObservationSchema.safeParse(JSON.parse(turn.result)); return parsed.success ? parsed.data.text ?? "" : ""; }
  catch { return ""; }
}

function reviewResult(record: ReviewRecord) {
  const parsed = (record.role === "rater" ? RaterResultSchema : ReviewerResultSchema).safeParse(record.result);
  return parsed.success ? parsed.data : null;
}

function resultLabel(result: ReturnType<typeof reviewResult>): string {
  if (!result) return "Invalid";
  if (result.role === "rater") return `${result.rating}/10`;
  return result.approved ? "Approved" : "Not approved";
}

/** Compact status from known facts only: a rating is labeled with the revision it reviewed. */
export function WorkflowStatus({ task }: { task: Task }) {
  const state = task.workflowState;
  const role = task.workflow === "refine_pull_request" ? "rater" : task.workflow === "independent_review" ? "reviewer" : null;
  const latest = role ? latestReview(state.reviews, role) : undefined;
  const result = latest ? reviewResult(latest) : null;
  const items: string[] = [];
  // Precedence: the observed endpoint decides. A workflow completion by itself is never evidence of a merge.
  if (state.completion?.kind === "external_merge") items.push("Merged externally", "Workflow verification incomplete");
  else if (task.pullRequest?.state === "merged") items.push("Merged");
  else if (task.status === "delivered" || state.completion?.kind === "workflow") items.push("Delivered");
  else if (state.deliveryWait?.reason === "merge_queue") items.push("Merge requested");
  else if (state.deliveryWait && state.deliveryWait.reason !== "question") items.push(state.deliveryWait.reason === "observation" ? "GitHub observation pending" : "CI pending");
  if (task.workflow === "approve_then_build") items.push(state.planApproval?.approved ? "Plan approved" : "Plan not approved");
  if (role) {
    if (!latest || !result) items.push(latest ? `${ADVISOR_LABELS[role]} report invalid` : "Not rated");
    else {
      const stale = task.worktree && task.worktree.headSha !== latest.range.headSha;
      items.push(`${resultLabel(result)} for ${short(latest.range.headSha)}`);
      if (stale && !state.completion) items.push("Review stale");
    }
  }
  return <span data-workflow-status className="flex flex-wrap gap-1">{items.map(item => <Badge key={item} variant={item === "Review stale" || item === "Workflow verification incomplete" ? "destructive" : "secondary"}>{item}</Badge>)}</span>;
}

function HistoryRow({ title, icon: Icon, badge, timestamp, findings, children }: {
  title: string;
  icon: LucideIcon;
  badge: ReactNode;
  timestamp?: ReactNode;
  findings?: ReactNode;
  children?: ReactNode;
}) {
  return <Collapsible.Root>
    <div className="flex min-h-9 items-center gap-2 px-2 py-1">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 font-medium">{title}</span>
      {findings}
      <span className="min-w-0 flex-1 truncate text-right text-muted-foreground tabular-nums">{timestamp}</span>
      {badge}
      {children ? <Collapsible.Trigger data-slot="history-trigger" render={<Button type="button" variant="ghost" size="icon-xs" />}>
        <ChevronRight className="transition-transform group-aria-expanded/button:rotate-90" aria-hidden="true" />
        <span className="sr-only">Show details for {title}</span>
      </Collapsible.Trigger> : <span className="size-6 shrink-0" aria-hidden="true" />}
    </div>
    {children ? <Collapsible.Panel data-slot="history-content" className="border-t bg-muted/20 px-3 py-2">
      <div className="min-w-0 space-y-3 text-xs">{children}</div>
    </Collapsible.Panel> : null}
  </Collapsible.Root>;
}

const verificationLabels = { passed: "Passed", not_applicable: "Not applicable", pending: "Pending", missing: "Missing", failed: "Failed" };

/** How long the turn took, or when it was recorded if the turn's times are not known. */
function HistoryTime({ value, turn }: { value: string | null; turn: TaskActivity["turns"][number] | undefined }) {
  if (!value) return null;
  const duration = turn?.promptedAt && turn.completedAt ? Date.parse(turn.completedAt) - Date.parse(turn.promptedAt) : NaN;
  const date = new Date(value);
  return <time dateTime={value} title={date.toLocaleString()}>{duration >= 0 ? formatTurnDuration(duration) : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>;
}

/** Review rounds, invalid attempts, and the candidate plans behind a build, each opening its full native report. */
export function WorkflowHistory({ task, activity }: { task: Task; activity: TaskActivity }) {
  const reviews = task.workflowState.reviews;
  const planners = activity.turns.flatMap(turn => {
    const session = activity.sessions.find(candidate => candidate.id === turn.sessionId);
    return session?.advisorRole === "planner_a" || session?.advisorRole === "planner_b" ? [{ session, turn }] : [];
  });
  const builds = activity.turns.flatMap(turn => {
    const session = activity.sessions.find(candidate => candidate.id === turn.sessionId);
    return session?.kind === "worker" && !session.advisorRole ? [{ session, turn }] : [];
  });
  const approvedPlan = task.workflowState.planApproval?.approved;
  if (!reviews.length && !planners.length && !approvedPlan) return null;
  return <ol data-workflow-history className="grid min-w-0 divide-y overflow-hidden rounded-md border text-xs" aria-label="Review rounds">
      {reviews.map((record, index) => {
        const result = reviewResult(record);
        const round = reviews.filter((candidate, position) => candidate.role === record.role && position <= index).length;
        const report = reportText(activity, record.turnId);
        return <li key={record.turnId} className="min-w-0" data-review-round={record.role}>
          <HistoryRow title={`${ADVISOR_LABELS[record.role]} round ${round}`} icon={!result ? XCircle : result.role === "rater" ? Gauge : result.approved ? CheckCircle2 : XCircle}
            badge={<Badge variant={result ? "secondary" : "destructive"}>{resultLabel(result)}</Badge>}
            timestamp={<HistoryTime value={record.recordedAt} turn={activity.turns.find(turn => turn.id === record.turnId)} />}
            findings={result && result.blockingFindings.length > 0 ? <Badge variant="destructive">{result.blockingFindings.length} blocking {result.blockingFindings.length === 1 ? "finding" : "findings"}</Badge>
              : result && (result.role === "rater" ? result.rating >= REPAIR_RATING_TARGET : result.approved) ? <Badge variant="green">Passed</Badge> : null}>
            {result || record.invalidReason || report ? <>
              {result ? <>
                <section data-review-section="summary"><p className="mb-1 font-medium">Summary</p><Markdown source={result.summary} /></section>
                <section data-review-section="verification"><div className="mb-1 flex items-center gap-2"><p className="font-medium">Verification</p><Badge variant="outline">{verificationLabels[result.verification]}</Badge></div><Markdown source={result.verificationSummary} /></section>
              </> : record.invalidReason ? <p className="text-destructive">{record.invalidReason}</p> : null}
              {result?.blockingFindings.length ? <section data-review-section="findings"><p className="mb-1 font-medium">Blocking findings</p><ul className="space-y-2 pl-4 text-muted-foreground">{result.blockingFindings.map(finding => <li key={finding} className="list-disc"><Markdown source={finding} /></li>)}</ul></section> : null}
              {report ? <Markdown source={report} /> : null}
            </> : null}
          </HistoryRow>
        </li>;
      })}
      {planners.map(({ session, turn }) => {
        const report = reportText(activity, turn.id);
        return <li key={turn.id} className="min-w-0" data-plan-report={session.advisorRole}>
          <HistoryRow title={session.label} icon={FileText} badge={<Badge variant={report ? "secondary" : "outline"}>{report ? "Report" : "No report yet"}</Badge>} timestamp={<HistoryTime value={turn.completedAt ?? turn.promptedAt} turn={turn} />}>
            {report ? <Markdown source={report} /> : null}
          </HistoryRow>
        </li>;
      })}
      {approvedPlan ? <li className="min-w-0" data-approved-plan>
        <HistoryRow title="You" icon={CheckCircle2} badge={<Badge variant="secondary">Approved plan</Badge>}>
          <Markdown source={approvedPlan} />
        </HistoryRow>
      </li> : null}
      {task.workflow === "competing_plans" ? builds.map(({ turn }) => turn.assignment?.plan ? <li key={turn.id} className="min-w-0" data-synthesis-assignment>
        <HistoryRow title="Combined plan" icon={FileText} badge={<Badge variant="secondary">Assignment</Badge>} timestamp={<HistoryTime value={turn.promptedAt} turn={turn} />}>
          <Markdown source={turn.assignment.plan} />
        </HistoryRow>
      </li> : null) : null}
    </ol>;
}
