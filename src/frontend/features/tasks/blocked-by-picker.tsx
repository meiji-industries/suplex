import { useEffect, useState, type ReactElement } from "react";
import type { Task } from "../../../tasks/contracts.js";
import { readJson } from "../../lib/api.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";

export type BlockedByTaskSummary = Pick<Task, "id" | "title" | "status">;

/** Searchable picker for a Blocked by reference: the project's active and backlog tasks, minus the task itself. */
export function BlockedByPickerDialog({ open, onOpenChange, companyId, projectId, excludeTaskId, onSelect, onError }: { open: boolean; onOpenChange: (open: boolean) => void; companyId: string; projectId: string; excludeTaskId?: string | undefined; onSelect: (task: BlockedByTaskSummary) => void; onError?: ((message: string) => void) | undefined }): ReactElement {
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
      <Input aria-label="Search tasks" autoFocus placeholder="Search by title or ID" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="flex flex-col gap-1">{loading ? <span className="text-xs text-muted-foreground">Loading tasks...</span> : matchingTasks.length ? matchingTasks.map(task => <Button key={task.id} type="button" variant="ghost" onClick={() => { onSelect({ id: task.id, title: task.title, status: task.status }); onOpenChange(false); }}>{task.title}<span className="text-muted-foreground">{task.id}</span></Button>) : <span className="text-xs text-muted-foreground">No matching active or backlog tasks.</span>}</div>
    </DialogContent>
  </Dialog>;
}
