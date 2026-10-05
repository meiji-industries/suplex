import { GitPullRequest } from "lucide-react";
import { listPullRequestSources, listTasks, type PullRequestSource } from "./lib/task-api.js";
import { useEffect, useState, type ReactElement } from "react";
import type { TaskListTask } from "../../contracts/task-responses.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { TaskStatusIcon } from "./task-status.js";

export type BlockedByTaskSummary = TaskListTask["blockedBy"][number];
export type BlockedBySelection = { kind: "task"; task: BlockedByTaskSummary } | { kind: "pull_request"; pullRequest: PullRequestSource };
type PickerTab = BlockedBySelection["kind"];

/** Searchable picker that adds one Blocked by entry. The Tasks tab lists the project's backlog, queued, active, and Answer necessary tasks; the Pull requests tab lists its open pull requests. Excluded tasks (the task itself and its current prerequisites) and pull request numbers are not offered. */
export function BlockedByPickerDialog({ open, onOpenChange, companyId, projectId, excludeTaskIds, excludePullRequestNumbers, onSelect, onError }: { open: boolean; onOpenChange: (open: boolean) => void; companyId: string; projectId: string; excludeTaskIds: string[]; excludePullRequestNumbers: number[]; onSelect: (selection: BlockedBySelection) => void; onError?: ((message: string) => void) | undefined }): ReactElement {
  const [tab, setTab] = useState<PickerTab>("task");
  const [tasks, setTasks] = useState<TaskListTask[]>([]);
  const [pullRequests, setPullRequests] = useState<{ available: boolean; sources: PullRequestSource[] }>({ available: true, sources: [] });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (open) setQuery("");
    else setTab("task");
  }, [open]);
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setLoading(true);
    const loaded = tab === "task"
      ? listTasks(companyId).then(result => {
        if (!cancelled) setTasks(result.filter(task => task.projectId === projectId && ["backlog", "queued", "active", "waiting_human"].includes(task.status) && !task.archivedAt));
      }).catch(error => { if (!cancelled) onError?.(error instanceof Error ? error.message : "Tasks are not available"); })
      : listPullRequestSources(projectId).then(result => { if (!cancelled) setPullRequests(result); }).catch(() => { if (!cancelled) setPullRequests({ available: false, sources: [] }); });
    void loaded.finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, tab, projectId, companyId, onError]);
  const search = query.trim().toLowerCase();
  const select = (selection: BlockedBySelection): void => { onSelect(selection); onOpenChange(false); };
  const matchingTasks = tasks.filter(task => !excludeTaskIds.includes(task.id) && (!search || task.title.toLowerCase().includes(search) || task.id.toLowerCase().includes(search)));
  const matchingPullRequests = pullRequests.sources.filter(pullRequest => !excludePullRequestNumbers.includes(pullRequest.number) && (!search || `#${pullRequest.number} ${pullRequest.title} ${pullRequest.author} ${pullRequest.headBranch}`.toLowerCase().includes(search)));
  const rows = tab === "task"
    ? matchingTasks.length ? matchingTasks.map(task => <Button key={task.id} type="button" variant="ghost" className="w-full min-w-0 justify-start gap-2 overflow-hidden" onClick={() => select({ kind: "task", task: { id: task.id, title: task.title, status: task.status } })}><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /><span className="min-w-0 flex-1 truncate text-left">{task.title}</span></Button>) : <span className="text-xs text-muted-foreground">No matching backlog, queued, active, or Answer necessary tasks.</span>
    : !pullRequests.available ? <span className="text-xs text-muted-foreground">Pull requests are not available.</span>
    : matchingPullRequests.length ? matchingPullRequests.map(pullRequest => <Button key={pullRequest.number} type="button" variant="ghost" className="w-full min-w-0 justify-start gap-2 overflow-hidden" onClick={() => select({ kind: "pull_request", pullRequest })}><GitPullRequest /><span className="min-w-0 flex-1 truncate text-left">#{pullRequest.number} {pullRequest.title}</span><span className="max-w-40 truncate text-xs text-muted-foreground">{pullRequest.author} · {pullRequest.headBranch} → {pullRequest.baseBranch}</span></Button>) : <span className="text-xs text-muted-foreground">No pull requests found.</span>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[min(80vh,480px)] grid-cols-[minmax(0,1fr)] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
      <DialogHeader><DialogTitle>Blocked by...</DialogTitle></DialogHeader>
      <Tabs value={tab} onValueChange={next => setTab(next as PickerTab)}>
        <TabsList variant="pill"><TabsTrigger value="task">Tasks</TabsTrigger><TabsTrigger value="pull_request">Pull requests</TabsTrigger></TabsList>
      </Tabs>
      <Input aria-label={tab === "task" ? "Search tasks" : "Search pull requests"} autoFocus placeholder={tab === "task" ? "Search by title or ID" : "Search by number, title, author, or branch"} value={query} onChange={event => setQuery(event.target.value)} />
      <div className="flex min-w-0 flex-col gap-1">{loading ? <span className="text-xs text-muted-foreground">{tab === "task" ? "Loading tasks..." : "Loading pull requests..."}</span> : rows}</div>
    </DialogContent>
  </Dialog>;
}
