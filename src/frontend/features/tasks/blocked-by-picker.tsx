import { useEffect, useState, type ReactElement } from "react";
import type { Task } from "../../../tasks/contracts.js";
import { readJson } from "../../lib/api.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { TaskTitleLink } from "./task-status.js";

export type BlockedByTaskSummary = Pick<Task, "id" | "title" | "status">;

/** Searchable picker for a Blocked by reference: the project's active and backlog tasks, minus the task itself. A current reference links to its task and can be cleared. */
export function BlockedByPickerDialog({ open, onOpenChange, companyId, projectId, excludeTaskId, current, onSelect, onClear, onError }: { open: boolean; onOpenChange: (open: boolean) => void; companyId: string; projectId: string; excludeTaskId?: string | undefined; current?: BlockedByTaskSummary | null | undefined; onSelect: (task: BlockedByTaskSummary) => void; onClear?: (() => void) | undefined; onError?: ((message: string) => void) | undefined }): ReactElement {
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
      if (!cancelled) setTasks(result.tasks.filter(task => task.projectId === projectId && task.id !== excludeTaskId && (task.status === "active" || task.status === "backlog") && !task.archivedAt));
    }).catch(error => { if (!cancelled) onError?.(error instanceof Error ? error.message : "Tasks are not available"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, companyId, excludeTaskId, onError]);
  const matchingTasks = tasks.filter(task => { const search = query.trim().toLowerCase(); return !search || task.title.toLowerCase().includes(search) || task.id.toLowerCase().includes(search); });
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[min(80vh,480px)] overflow-y-auto">
      <DialogHeader><DialogTitle>Blocked by...</DialogTitle></DialogHeader>
      {current ? <div className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"><TaskTitleLink task={current} companyId={companyId} /><Button type="button" size="xs" variant="ghost" onClick={() => { onClear?.(); onOpenChange(false); }}>Clear</Button></div> : null}
      <Input aria-label="Search tasks" autoFocus placeholder="Search by title or ID" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="flex flex-col gap-1">{loading ? <span className="text-xs text-muted-foreground">Loading tasks...</span> : matchingTasks.length ? matchingTasks.map(task => <Button key={task.id} type="button" variant="ghost" onClick={() => { onSelect({ id: task.id, title: task.title, status: task.status }); onOpenChange(false); }}>{task.title}<span className="text-muted-foreground">{task.id}</span></Button>) : <span className="text-xs text-muted-foreground">No matching active or backlog tasks.</span>}</div>
    </DialogContent>
  </Dialog>;
}
