import type { ReactElement } from "react";
import { CheckCircle2, CircleMinus, ExternalLink, GitMerge, GitPullRequest, LoaderCircle, XCircle } from "lucide-react";
import type { Task } from "../../../tasks/contracts.js";
import { Badge } from "../../components/ui/badge.js";
import { checkRunLabel, checkRunName, checkRunStatus, useTaskChecks, type CheckRun, type CheckRunStatus } from "./lib/task-checks.js";

const runIcons = { passed: CheckCircle2, failed: XCircle, pending: LoaderCircle, skipped: CircleMinus, neutral: CircleMinus } satisfies Record<CheckRunStatus, typeof CheckCircle2>;
const runColors = { passed: "text-emerald-500", failed: "text-rose-500", pending: "text-amber-500", skipped: "text-muted-foreground", neutral: "text-muted-foreground" } satisfies Record<CheckRunStatus, string>;

function CheckRunRow({ run }: { run: CheckRun }): ReactElement {
  const status = checkRunStatus(run);
  const Icon = runIcons[status];
  const name = checkRunName(run);
  return <li className="flex items-center gap-2 px-3 py-1.5 text-xs">
    <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${runColors[status]}${status === "pending" ? " animate-spin" : ""}`} />
    {run.url ? <a href={run.url} target="_blank" rel="noreferrer" className="min-w-0 truncate underline-offset-2 hover:underline">{name}</a> : <span className="min-w-0 truncate">{name}</span>}
    <span className="ml-auto shrink-0 text-muted-foreground">{checkRunLabel(run)}</span>
  </li>;
}

export function TaskPullRequestCard({ task }: { task: Task }): ReactElement | null {
  const pullRequest = task.pullRequest;
  const { checks } = useTaskChecks(pullRequest && pullRequest.state !== "merged" ? task.id : null, pullRequest ? `${pullRequest.number}:${pullRequest.headSha}:${pullRequest.state}` : null);
  if (!pullRequest) return null;
  const merged = pullRequest.state === "merged" || checks?.pullRequestState === "merged";
  const observed = checks?.available ? checks.pullRequestState : null;
  const state = merged ? "Merged" : observed === "closed" || pullRequest.state === "closed" ? "Closed" : observed === "draft" ? "Draft" : "Open";
  const runs = checks?.available ? checks.runs : [];
  return <div data-active-pull-request className="rounded-md border">
    <a href={pullRequest.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 p-3 hover:bg-muted/30">
      {merged ? <GitMerge className="size-5 shrink-0 text-violet-500" /> : <GitPullRequest className="size-5 shrink-0 text-emerald-500" />}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{task.title}</span><span className="text-xs text-muted-foreground">{task.configuration.repository} #{pullRequest.number}</span></span>
      <Badge variant="secondary">{state}</Badge>
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
    {runs.length ? <ul aria-label="Pull request checks" className="border-t">{runs.map((run, index) => <CheckRunRow key={`${run.name}:${index}`} run={run} />)}</ul> : null}
  </div>;
}
