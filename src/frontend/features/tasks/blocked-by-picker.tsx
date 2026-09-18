import { useEffect, useState, type ReactElement } from "react";
import type { Task } from "../../../tasks/contracts.js";
import { readJson } from "../../lib/api.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { TaskStatusIcon } from "./task-status.js";

export type BlockedByTaskSummary = Pick<Task, "id" | "title" | "status">;

/** Searchable picker that adds one Blocked by task: the project's active and backlog tasks, minus the excluded ones (the task itself and its current prerequisites). */
export function BlockedByPickerDialog({ open, onOpenChange, companyId, projectId, excludeTaskIds, onSelect, onError }: { open: boolean; onOpenChange: (open: boolean) => void; companyId: string; projectId: string; excludeTaskIds: string[]; onSelect: (task: BlockedByTaskSummary) => void; onError?: ((message: string) => void) | undefined }): ReactElement {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    void readJson<{ tasks: Task[] }>(`/api/companies/${companyId}/tasks`).then(result => {
      if (!cancelled) setTasks(result.tasks.filter(task => task.projectId === projectId && (task.status === "active" || task.status === "backlog") && !task.archivedAt));
    }).catch(error => { if (!cancelled) onError?.(error instanceof Error ? error.message : "Tasks are not available"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, companyId, onError]);
  const matchingTasks = tasks.filter(task => { if (excludeTaskIds.includes(task.id)) return false; const search = query.trim().toLowerCase(); return !search || task.title.toLowerCase().includes(search) || task.id.toLowerCase().includes(search); });
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[min(80vh,480px)] grid-cols-[minmax(0,1fr)] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
      <DialogHeader><DialogTitle>Blocked by...</DialogTitle></DialogHeader>
      <Input aria-label="Search tasks" autoFocus placeholder="Search by title or ID" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="flex min-w-0 flex-col gap-1">{loading ? <span className="text-xs text-muted-foreground">Loading tasks...</span> : matchingTasks.length ? matchingTasks.map(task => <Button key={task.id} type="button" variant="ghost" className="w-full min-w-0 justify-start gap-2 overflow-hidden" onClick={() => { onSelect({ id: task.id, title: task.title, status: task.status }); onOpenChange(false); }}><TaskStatusIcon status={task.status} pullRequestState={task.pullRequest?.state} /><span className="min-w-0 flex-1 truncate text-left">{task.title}</span><span className="shrink-0 text-muted-foreground">{task.id}</span></Button>) : <span className="text-xs text-muted-foreground">No matching active or backlog tasks.</span>}</div>
    </DialogContent>
  </Dialog>;
}
