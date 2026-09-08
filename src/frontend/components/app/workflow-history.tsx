import { z } from "zod";
import type { Task } from "../../../task-contracts.js";
import { ADVISOR_LABELS, latestReview, type ReviewRecord } from "../../../workflows.js";
import type { TaskActivity } from "./task-work.js";
import { Badge } from "../ui/badge.js";
import { Markdown } from "./markdown.js";

const ObservationSchema = z.object({ text: z.string().optional() });
const short = (sha: string) => sha.slice(0, 10);

function reportText(activity: TaskActivity, turnId: string): string {
  const turn = activity.turns.find(turn => turn.id === turnId && turn.status === "completed");
  if (!turn?.result) return "";
  try { const parsed = ObservationSchema.safeParse(JSON.parse(turn.result)); return parsed.success ? parsed.data.text ?? "" : ""; }
  catch { return ""; }
}

function resultLabel(record: ReviewRecord): string {
  if (!record.result) return "Invalid";
  if (record.result.role === "rater") return `${record.result.rating}/10`;
  return record.result.approved ? "Approved" : "Not approved";
}

/** Compact status from known facts only: a rating is labeled with the revision it reviewed. */
export function WorkflowStatus({ task }: { task: Task }) {
  const state = task.workflowState;
  const role = task.workflow === "refine_pull_request" ? "rater" : task.workflow === "independent_review" ? "reviewer" : null;
  const latest = role ? latestReview(state.reviews, role) : undefined;
  const items: string[] = [];
  // Precedence: the observed endpoint decides. A workflow completion by itself is never evidence of a merge.
  if (state.completion?.kind === "external_merge") items.push("Merged externally", "Workflow verification incomplete");
  else if (task.pullRequest?.state === "merged") items.push("Merged");
  else if (task.status === "delivered" || state.completion?.kind === "workflow") items.push("Delivered");
  else if (state.deliveryWait?.reason === "merge_queue") items.push("Merge requested");
  else if (state.deliveryWait) items.push(state.deliveryWait.reason === "observation" ? "GitHub observation pending" : "CI pending");
  if (role) {
    if (!latest || !latest.result) items.push(latest ? `${ADVISOR_LABELS[role]} report invalid` : "Not rated");
    else {
      const stale = task.worktree && task.worktree.headSha !== latest.range.headSha;
      items.push(`${resultLabel(latest)} for ${short(latest.range.headSha)}`);
      if (stale && !state.completion) items.push("Review stale");
    }
  }
  return <span data-workflow-status className="flex flex-wrap gap-1">{items.map(item => <Badge key={item} variant={item === "Review stale" || item === "Workflow verification incomplete" ? "destructive" : "secondary"}>{item}</Badge>)}</span>;
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
  return <details data-workflow-history className="text-xs">
    <summary className="cursor-pointer font-medium">Review history <span className="text-muted-foreground">{reviews.length || planners.length}</span></summary>
    <ol className="mt-2 grid gap-2" aria-label="Review rounds">
      {reviews.map((record, index) => {
        const round = reviews.filter((candidate, position) => candidate.role === record.role && position <= index).length;
        return <li key={record.turnId} className="border-l-2 pl-3" data-review-round={record.role}>
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{ADVISOR_LABELS[record.role]} round {round}</span><Badge variant={record.result ? "secondary" : "destructive"}>{resultLabel(record)}</Badge><code className="text-muted-foreground" title={`${record.range.baseSha}..${record.range.headSha}`}>{short(record.range.baseSha)}..{short(record.range.headSha)}</code><time className="text-muted-foreground" dateTime={record.recordedAt}>{new Date(record.recordedAt).toLocaleString()}</time></div>
          {record.result ? <p className="text-muted-foreground">{record.result.summary}{record.result.blockingFindings.length ? ` · ${record.result.blockingFindings.length} blocking finding(s)` : ""} · verification {record.result.verification}</p> : <p className="text-destructive">{record.invalidReason}</p>}
          {record.result?.blockingFindings.length ? <ul className="list-disc pl-4 text-muted-foreground">{record.result.blockingFindings.map(finding => <li key={finding}>{finding}</li>)}</ul> : null}
          {reportText(activity, record.turnId) ? <details className="mt-1"><summary className="cursor-pointer text-muted-foreground">Full report and repair plan</summary><div className="mt-1"><Markdown source={reportText(activity, record.turnId)} /></div></details> : null}
        </li>;
      })}
      {planners.map(({ session, turn }) => <li key={turn.id} className="border-l-2 pl-3" data-plan-report={session.advisorRole}>
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{session.label}</span><Badge variant={reportText(activity, turn.id) ? "secondary" : "outline"}>{reportText(activity, turn.id) ? "Report" : "No report yet"}</Badge></div>
        {reportText(activity, turn.id) ? <details className="mt-1"><summary className="cursor-pointer text-muted-foreground">Full plan</summary><div className="mt-1"><Markdown source={reportText(activity, turn.id)} /></div></details> : null}
      </li>)}
      {task.workflow === "competing_plans" ? builds.map(({ turn }) => turn.prompt.includes("Coordinator plan:") ? <li key={turn.id} className="border-l-2 pl-3" data-synthesis-assignment><div className="flex items-center gap-2"><span className="font-medium">Worker</span><Badge variant="secondary">Combined plan</Badge></div><details className="mt-1"><summary className="cursor-pointer text-muted-foreground">Assignment</summary><div className="mt-1"><Markdown source={turn.prompt} /></div></details></li> : null) : null}
    </ol>
  </details>;
}
