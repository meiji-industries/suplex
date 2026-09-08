import { useState } from "react";
import { Archive, ArchiveRestore, Copy, Ellipsis, RefreshCw, Square } from "lucide-react";
import type { Task } from "../../../tasks/contracts.js";
import { readJson, withCompany } from "../../lib/api.js";
import { navigate } from "../../shell/navigation-state.js";
import { duplicateTaskDraft, type NewTaskDraft } from "./lib/duplicate-task-prefill.js";
import { ArchiveTaskDialog } from "./archive-task-dialog.js";
import { NewTaskDialog } from "./new-task-dialog.js";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";

export function TaskOptions({ task, onChange, onError }: { task: Task; onChange: (task: Task) => void; onError: (error: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<NewTaskDraft | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const duplicate = async () => {
    if (busy) return;
    setBusy(true); onError("");
    try { setDraft(await duplicateTaskDraft(task)); }
    catch (error) { onError(error instanceof Error ? error.message : "The task could not be copied."); }
    finally { setBusy(false); }
  };
  const terminal = task.status === "cancelled" || task.status === "delivered";
  const act = async (action: "refresh" | "cancel" | "unarchive") => {
    if (busy) return;
    setBusy(true); onError("");
    try { onChange(await readJson<Task>(`/api/tasks/${task.id}/${action}`, { method: "POST" })); }
    catch (error) { onError(error instanceof Error ? error.message : "The action failed"); }
    finally { setBusy(false); }
  };
  return <><DropdownMenu><DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Task options" />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-max">
    <DropdownMenuItem disabled={busy} onClick={() => void act("refresh")}><RefreshCw />Refresh</DropdownMenuItem>
    <DropdownMenuItem disabled={busy} onClick={() => void duplicate()}><Copy />Duplicate</DropdownMenuItem>
    {!terminal ? <DropdownMenuItem disabled={busy} onClick={() => void act("cancel")}><Square />Cancel task</DropdownMenuItem> : null}
     {terminal || task.status === "backlog" ? <DropdownMenuItem disabled={busy} onClick={() => task.archivedAt ? void act("unarchive") : setArchiveOpen(true)}>{task.archivedAt ? <ArchiveRestore /> : <Archive />}{task.archivedAt ? "Open from archive" : "Archive task"}</DropdownMenuItem> : null}
   </DropdownMenuContent></DropdownMenu>
     <ArchiveTaskDialog task={task} open={archiveOpen} onOpenChange={setArchiveOpen} onArchived={archived => { onChange(archived); navigate(withCompany("/tasks", task.companyId)); }} onError={onError} />
     {draft ? <NewTaskDialog open onOpenChange={open => { if (!open) setDraft(null); }} companyId={task.companyId} initialDraft={draft} onCreated={created => { setDraft(null); navigate(withCompany(`/tasks/${created.id}`, created.companyId)); }} /> : null}</>;
}
