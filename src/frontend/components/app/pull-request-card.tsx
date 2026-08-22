import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "../ui/button.js";
import type { ApiTask } from "../../lib/view-shared.js";

function syncedAgo(observedAt: string | null): string {
  if (!observedAt) return "synced just now";
  return `synced ${Math.max(0, Math.floor((Date.now() - Date.parse(observedAt)) / 1_000))}s ago`;
}

export function PullRequestCard({ task, busy, onRefresh }: { task: ApiTask; busy: boolean; onRefresh: () => Promise<void> }): React.ReactElement | null {
  const pr = task.githubPullRequest;
  if (!pr?.exists || pr.number === null || !pr.url) return null;
  const checks = pr.checks.total ? `Checks ${pr.checks.successful}/${pr.checks.total} ${pr.checks.successful === pr.checks.total ? "passed" : "running"}` : "Checks pending";
  const review = pr.state === "merged" ? "Merged" : pr.isDraft ? "Draft" : "Ready for review";
  return <section data-pull-request-card aria-label={`Pull request #${pr.number}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-y border-border/70 py-2 text-xs">
    <a className="font-medium underline underline-offset-2" href={pr.url} target="_blank" rel="noreferrer">#{pr.number} · {review}<ExternalLink aria-hidden="true" className="ml-1 inline size-3" /></a>
    <span className="text-muted-foreground">· {checks} · {pr.state === "open" ? "Mergeable" : "Merge status pending"} · Auto-merge {pr.autoMergeEnabled ? "on" : "off"} · {syncedAgo(pr.observedAt)}</span>
    <span className="ml-auto"><Button size="sm" variant="outline" onClick={() => void onRefresh()} disabled={busy}><RefreshCw aria-hidden="true" />Refresh</Button></span>
  </section>;
}
