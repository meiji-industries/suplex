import { ExternalLink, GitPullRequest, RefreshCw } from "lucide-react";
import { Badge } from "../ui/badge.js";
import { Button, buttonVariants } from "../ui/button.js";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card.js";
import { CopyButton } from "./copy-button.js";
import type { ApiTask } from "../../lib/view-shared.js";

function syncedAgo(observedAt: string | null): string {
  if (!observedAt) return "never";
  return `synced ${Math.max(0, Math.floor((Date.now() - Date.parse(observedAt)) / 1_000))}s ago`;
}

export function PullRequestCard({ task, busy, onRefresh, onMarkReady }: { task: ApiTask; busy: boolean; onRefresh: () => Promise<void>; onMarkReady: () => Promise<void> }): React.ReactElement | null {
  const pr = task.githubPullRequest;
  if (!pr?.exists || pr.number === null || !pr.url) return null;
  const title = task.release?.title ?? task.title;
  const status = pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : pr.isDraft ? "Draft" : "Open";
  const branchComparison = task.release ? `${task.release.headBranch} → ${task.release.baseBranch}` : null;
  const changeStatsAvailable = pr.changedFiles !== null && pr.changedFiles !== undefined && pr.additions !== null && pr.additions !== undefined && pr.deletions !== null && pr.deletions !== undefined;
  const checks = !pr.checks.total ? "Checks pending" : pr.checks.failing ? `Checks failing ${pr.checks.failing}/${pr.checks.total}` : pr.checks.successful === pr.checks.total ? `Checks ${pr.checks.successful}/${pr.checks.total} passed` : `Checks ${pr.checks.successful}/${pr.checks.total} running`;
  const details = `${checks} · ${pr.mergeable ? `Mergeability ${pr.mergeable.toLowerCase()}` : "Mergeability pending"} · Auto-merge ${pr.autoMergeEnabled ? "on" : "off"} · ${syncedAgo(pr.observedAt)}`;
  const waitingForMerge = task.phase === "manual_merge" && status !== "Merged";
  if (status === "Merged") return <Card data-pull-request-card size="sm" aria-label={`Pull request #${pr.number}`}>
    <CardHeader>
      <CardTitle><span className="min-w-0 break-words">{title} <a className="font-normal text-muted-foreground hover:underline" href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a></span></CardTitle>
      <CardDescription><span className="flex min-w-0 flex-nowrap items-center gap-2"><Badge variant="default" className="h-6 bg-violet-600 px-2.5 text-xs text-white"><GitPullRequest aria-hidden="true" />Merged</Badge>{branchComparison ? <><span className="min-w-0 truncate">merged into <code>{task.release!.baseBranch}</code> from <code>{task.release!.headBranch}</code></span><CopyButton value={branchComparison} /></> : null}</span></CardDescription>
    </CardHeader>
    <CardContent><div className="text-[11px] text-muted-foreground">{details}</div></CardContent>
  </Card>;
  return <Card data-pull-request-card data-waiting-for-merge={waitingForMerge || undefined} className={waitingForMerge ? "bg-emerald-50/60 ring-emerald-600/20 dark:bg-emerald-950/20" : undefined} size="sm" aria-label={`Pull request #${pr.number}`}>
    <CardHeader>
      <CardTitle><span className="min-w-0 break-words">{title}</span></CardTitle>
      <CardDescription><span className="flex items-center gap-1.5"><a className="inline-flex items-center gap-1.5 underline underline-offset-2" href={pr.url} target="_blank" rel="noreferrer"><GitPullRequest aria-hidden="true" className="size-4 shrink-0" />#{pr.number}</a><Badge variant={status === "Open" ? "outline" : "secondary"}>{status}</Badge></span></CardDescription>
    </CardHeader>
    <CardContent>
      {task.release ? <div className="flex min-w-0 items-center gap-1.5 text-xs">
        {pr.author ? <span className="flex min-w-0 items-center gap-1.5"><img className="size-5 shrink-0 rounded-full" src={pr.author.avatarUrl} alt="" /><span className="min-w-0 truncate">{pr.author.login}</span></span> : null}
        <code className="shrink-0 rounded bg-muted px-1.5">{task.release.baseBranch}</code>
        <span className="shrink-0 text-muted-foreground" aria-hidden="true">←</span>
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5" title={task.release.headBranch}>{task.release.headBranch}</code>
        <CopyButton value={task.release.headBranch} label="Copy head branch" />
        {changeStatsAvailable ? <span className="flex shrink-0 items-center gap-1.5 tabular-nums"><span className="text-muted-foreground">{pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}</span><span className="text-emerald-600 dark:text-emerald-400">+{pr.additions}</span><span className="text-red-600 dark:text-red-400">−{pr.deletions}</span></span> : null}
      </div> : null}
      <div className="text-[11px] text-muted-foreground">{details}</div>
    </CardContent>
    <CardFooter><div className="flex w-full items-center justify-end gap-2"><Button size="icon-xs" variant="ghost" aria-label="Refresh" title="Refresh" onClick={() => void onRefresh()} disabled={busy}><RefreshCw aria-hidden="true" /></Button><a className={buttonVariants({ variant: "ghost", size: "icon-xs" })} href={pr.url} target="_blank" rel="noreferrer" aria-label="Open pull request on GitHub" title="Open pull request on GitHub"><ExternalLink aria-hidden="true" /></a>{pr.state === "open" && pr.isDraft ? <Button size="sm" onClick={() => void onMarkReady()} disabled={busy}>{busy ? "Marking ready…" : "Ready for review"}</Button> : null}</div></CardFooter>
  </Card>;
}
