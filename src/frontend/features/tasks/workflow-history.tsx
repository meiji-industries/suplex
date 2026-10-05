import { z } from "zod";
import type { Task } from "../../contracts/tasks.js";
import { ADVISOR_LABELS, latestReview } from "./workflow-presentation.js";
import type { ReviewRecord } from "../../contracts/generated/ReviewRecord.js";
import { ReviewerResultSchema, RaterResultSchema } from "../../contracts/advisor-reports.js";
import type { TaskActivity } from "./task-work.js";
import { Badge } from "../../components/ui/badge.js";
import { Markdown } from "../../components/app/markdown.js";
import { CheckCircle2, ChevronRight, FileText, Gauge, XCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible } from "../../components/ui/collapsible.js";
import { Plan, PlanAction, PlanContent, PlanHeader, PlanTitle, PlanTrigger } from "../../components/ui/plan.js";

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
  else if (state.deliveryWait) items.push(state.deliveryWait.reason === "observation" ? "GitHub observation pending" : "CI pending");
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

function HistoryCard({ title, icon: Icon, badge, summary, meta, children }: {
  title: string;
  icon: LucideIcon;
  badge: ReactNode;
  summary: string;
  meta: ReactNode;
  children?: ReactNode;
}) {
  return <Plan>
    <PlanHeader>
      <div className="min-w-0 space-y-1">
        <PlanTitle><div className="flex flex-wrap items-center gap-2"><Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span>{title}</span>{badge}</div></PlanTitle>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {summary ? <p className="min-w-0 flex-1 truncate" title={summary}>{summary}</p> : null}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">{meta}</div>
        </div>
      </div>
      {children ? <PlanAction><PlanTrigger label={`Show details for ${title}`} /></PlanAction> : null}
    </PlanHeader>
    {children ? <PlanContent><div className="min-w-0 space-y-2 text-xs">{children}</div></PlanContent> : null}
  </Plan>;
}

const verificationLabels = { passed: "Passed", not_applicable: "Not applicable", missing: "Missing", failed: "Failed" };
const summaryLine = (text: string) => text.split("\n").find(line => line.trim())?.replace(/^#{1,6}\s+/, "").trim() ?? "";

function HistoryTime({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : null;
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
  if (!reviews.length && !planners.length) return null;
  return <Collapsible.Root data-workflow-history defaultOpen className="space-y-2 text-xs">
    <Collapsible.Trigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" aria-hidden="true" />Review history <span className="text-muted-foreground">{reviews.length || planners.length}</span></Collapsible.Trigger>
    <Collapsible.Panel><ol className="grid min-w-0 gap-2" aria-label="Review rounds">
      {reviews.map((record, index) => {
        const result = reviewResult(record);
        const round = reviews.filter((candidate, position) => candidate.role === record.role && position <= index).length;
        const report = reportText(activity, record.turnId);
        return <li key={record.turnId} className="min-w-0" data-review-round={record.role}>
          <HistoryCard title={`${ADVISOR_LABELS[record.role]} round ${round}`} icon={!result ? XCircle : result.role === "rater" ? Gauge : result.approved ? CheckCircle2 : XCircle}
            badge={<Badge variant={result ? "secondary" : "destructive"}>{resultLabel(result)}</Badge>}
            summary={result?.summary ?? record.invalidReason ?? ""}
            meta={<><code title={`${record.range.baseSha}..${record.range.headSha}`}>{short(record.range.baseSha)}..{short(record.range.headSha)}</code><HistoryTime value={record.recordedAt} />{result && result.blockingFindings.length > 0 ? <span>{result.blockingFindings.length} blocking {result.blockingFindings.length === 1 ? "finding" : "findings"}</span> : null}</>}>
            {result || record.invalidReason || report ? <>
              {result ? <><p>{result.summary}</p><p className="text-muted-foreground">Verification: {verificationLabels[result.verification]}</p><p className="text-muted-foreground">{result.verificationSummary}</p></> : record.invalidReason ? <p className="text-destructive">{record.invalidReason}</p> : null}
              {result?.blockingFindings.length ? <div className="space-y-1"><p className="font-medium">Blocking findings</p><ul className="list-disc pl-4 text-muted-foreground">{result.blockingFindings.map(finding => <li key={finding}>{finding}</li>)}</ul></div> : null}
              {report ? <Markdown source={report} /> : null}
            </> : null}
          </HistoryCard>
        </li>;
      })}
      {planners.map(({ session, turn }) => {
        const report = reportText(activity, turn.id);
        return <li key={turn.id} className="min-w-0" data-plan-report={session.advisorRole}>
          <HistoryCard title={session.label} icon={FileText} badge={<Badge variant={report ? "secondary" : "outline"}>{report ? "Report" : "No report yet"}</Badge>} summary={summaryLine(report)} meta={<HistoryTime value={turn.completedAt ?? turn.promptedAt} />}>
            {report ? <Markdown source={report} /> : null}
          </HistoryCard>
        </li>;
      })}
      {task.workflow === "competing_plans" ? builds.map(({ turn }) => turn.prompt.includes("Coordinator plan:") ? <li key={turn.id} className="min-w-0" data-synthesis-assignment>
        <HistoryCard title="Combined plan" icon={FileText} badge={<Badge variant="secondary">Assignment</Badge>} summary={summaryLine(turn.prompt.slice(turn.prompt.indexOf("Coordinator plan:") + "Coordinator plan:".length))} meta={<HistoryTime value={turn.promptedAt} />}>
          <Markdown source={turn.prompt} />
        </HistoryCard>
      </li> : null) : null}
    </ol></Collapsible.Panel>
  </Collapsible.Root>;
}
