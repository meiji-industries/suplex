import { useEffect, useState, type ReactElement } from "react";
import { CheckCircle2, CircleMinus, ExternalLink, GitMerge, GitPullRequest, LoaderCircle, XCircle } from "lucide-react";
import type { Task } from "../../../tasks/contracts.js";
import { supportsDeliveryTarget } from "../../../delivery/target-capabilities.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { readJson } from "../../lib/api.js";
import { checkRunLabel, checkRunName, checkRunStatus, useTaskChecks, type CheckRun, type CheckRunStatus } from "./lib/task-checks.js";

const runIcons = { passed: CheckCircle2, failed: XCircle, pending: LoaderCircle, skipped: CircleMinus, neutral: CircleMinus } satisfies Record<CheckRunStatus, typeof CheckCircle2>;
const runColors = { passed: "text-emerald-500", failed: "text-rose-500", pending: "text-amber-500", skipped: "text-muted-foreground", neutral: "text-muted-foreground" } satisfies Record<CheckRunStatus, string>;

function CheckRunRow({ run, now }: { run: CheckRun; now: number }): ReactElement {
  const status = checkRunStatus(run);
  const Icon = runIcons[status];
  const name = checkRunName(run);
  return <li className="flex items-center gap-2 px-3 py-1.5 text-xs">
    <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${runColors[status]}${status === "pending" ? " animate-spin" : ""}`} />
    {run.url ? <a href={run.url} target="_blank" rel="noreferrer" className="min-w-0 truncate underline-offset-2 hover:underline">{name}</a> : <span className="min-w-0 truncate">{name}</span>}
    <span className="ml-auto shrink-0 text-muted-foreground">{checkRunLabel(run, now)}</span>
  </li>;
}

export function TaskPullRequestCard({ task, onChange }: { task: Task; onChange: (task: Task) => void }): ReactElement | null {
  const pullRequest = task.pullRequest;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const { checks } = useTaskChecks(pullRequest ? task.id : null, pullRequest ? `${pullRequest.number}:${pullRequest.state}:${pullRequest.headSha}` : null);
  const merged = checks?.available ? checks.pullRequestState === "merged" : task.deliveryTarget === "merged" && task.status === "delivered";
  const observed = checks?.available ? checks.pullRequestState : null;
  const state = merged ? "Merged" : observed === "closed" ? "Closed" : observed === "draft" || !observed && task.deliveryTarget === "pull_request_draft" ? "Draft" : "Open";
  const runs = checks?.available ? checks.runs : [];
  const hasRunningCheck = runs.some((run) => checkRunStatus(run) === "pending" && Number.isFinite(Date.parse(run.startedAt ?? "")));
  useEffect(() => {
    if (!hasRunningCheck) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasRunningCheck]);
  const continuing = task.status === "active" && (task.deliveryTarget === "pull_request_ready" || task.deliveryTarget === "merged");
  const actionable = task.status === "delivered" && !task.archivedAt && !merged;
  const canPublish = actionable && task.deliveryTarget === "pull_request_draft" && observed !== "ready" && supportsDeliveryTarget(task.configuration.integration?.repository, "pull_request_ready");
  const canMerge = actionable && (task.deliveryTarget === "pull_request_draft" || task.deliveryTarget === "pull_request_ready") && supportsDeliveryTarget(task.configuration.integration?.repository, "merged");
  const continueDelivery = async (deliveryTarget: "pull_request_ready" | "merged") => {
    if (pending) return;
    setPending(true); setError("");
    try { onChange(await readJson<Task>(`/api/tasks/${task.id}/continue-delivery`, { method: "POST", body: JSON.stringify({ deliveryTarget }) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Forge could not continue delivery."); }
    finally { setPending(false); }
  };
  return <div data-active-pull-request className="rounded-md border">
    {pullRequest ? <a href={pullRequest.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 p-3 hover:bg-muted/30">
      {merged ? <GitMerge className="size-5 shrink-0 text-violet-500" /> : <GitPullRequest className="size-5 shrink-0 text-emerald-500" />}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{task.title}</span><span className="text-xs text-muted-foreground">{task.configuration.repository} #{pullRequest.number}</span></span>
      <Badge variant="secondary">{state}</Badge>
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
    </a> : <div className="flex items-center gap-3 p-3"><GitPullRequest className="size-5 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span><Badge variant="secondary">{state}</Badge></div>}
    {continuing || canPublish || canMerge ? <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
      {continuing ? <span className="text-xs text-muted-foreground">Coordinator continues delivery.</span> : null}
      {canPublish ? <Button size="sm" disabled={pending} onClick={() => void continueDelivery("pull_request_ready")}>Publish for review</Button> : null}
      {canMerge ? <Button size="sm" variant={canPublish ? "outline" : "default"} disabled={pending} onClick={() => void continueDelivery("merged")}>Continue to merge</Button> : null}
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </div> : null}
    {runs.length ? <ul aria-label="Pull request checks" className="border-t">{runs.map((run, index) => <CheckRunRow key={`${run.name}:${index}`} run={run} now={now} />)}</ul> : null}
  </div>;
}
