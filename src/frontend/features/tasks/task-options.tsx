import { useState } from "react";
import { Archive, ArchiveRestore, Copy, Ellipsis, Pencil, RefreshCw, Square } from "lucide-react";
import { type Task } from "../../contracts/tasks.js";
import { readJson, withCompany } from "../../lib/api.js";
import { navigate } from "../../shell/navigation-state.js";
import { duplicateTaskDraft, type NewTaskDraft } from "./lib/duplicate-task-prefill.js";
import { ArchiveTaskDialog } from "./archive-task-dialog.js";
import { NewTaskDialog } from "./new-task-dialog.js";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";

export function TaskOptions({ task, onChange, onError }: { task: Task; onChange: (task: Task) => void; onError: (error: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<NewTaskDraft | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const duplicate = async () => {
    if (busy) return;
    setBusy(true); onError("");
    try { setDraft(await duplicateTaskDraft(task)); }
    catch (error) { onError(error instanceof Error ? error.message : "The task could not be copied."); }
    finally { setBusy(false); }
  };
  const terminal = task.status === "cancelled" || task.status === "delivered";
  const rename = async () => {
    if (busy) return;
    setBusy(true); onError("");
    try { onChange(await readJson<Task>(`/api/tasks/${task.id}/rename`, { method: "POST", body: JSON.stringify({ title }) })); setRenameOpen(false); }
    catch (error) { onError(error instanceof Error ? error.message : "The task could not be renamed."); }
    finally { setBusy(false); }
  };
  const act = async (action: "refresh" | "cancel" | "unarchive") => {
    if (busy) return;
    setBusy(true); onError("");
    try { onChange(await readJson<Task>(`/api/tasks/${task.id}/${action}`, { method: "POST" })); }
    catch (error) { onError(error instanceof Error ? error.message : "The action failed"); }
    finally { setBusy(false); }
  };
  return <><DropdownMenu><DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Task options" />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-max">
    <DropdownMenuItem disabled={busy} onClick={() => void act("refresh")}><RefreshCw />Refresh</DropdownMenuItem>
    <DropdownMenuItem disabled={busy} onClick={() => { setTitle(task.title); setRenameOpen(true); }}><Pencil />Rename</DropdownMenuItem>
    <DropdownMenuItem disabled={busy} onClick={() => void duplicate()}><Copy />Duplicate</DropdownMenuItem>
    {!terminal ? <DropdownMenuItem disabled={busy} onClick={() => void act("cancel")}><Square />Cancel task</DropdownMenuItem> : null}
     {terminal || task.status === "backlog" || task.status === "queued" ? <DropdownMenuItem disabled={busy} onClick={() => task.archivedAt ? void act("unarchive") : setArchiveOpen(true)}>{task.archivedAt ? <ArchiveRestore /> : <Archive />}{task.archivedAt ? "Open from archive" : "Archive task"}</DropdownMenuItem> : null}
   </DropdownMenuContent></DropdownMenu>
      <ArchiveTaskDialog task={task} open={archiveOpen} onOpenChange={setArchiveOpen} onArchived={archived => { onChange(archived); navigate(withCompany("/tasks", task.companyId)); }} onError={onError} />
      <Dialog open={renameOpen} onOpenChange={open => { if (!busy) setRenameOpen(open); }}><DialogContent showCloseButton={false}><DialogHeader><DialogTitle>Rename task</DialogTitle></DialogHeader><form className="grid gap-6" onSubmit={event => { event.preventDefault(); void rename(); }}><Input aria-label="Task title" autoFocus disabled={busy} value={title} onChange={event => setTitle(event.target.value)} required /><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setRenameOpen(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Renaming…" : "Rename"}</Button></DialogFooter></form></DialogContent></Dialog>
      {draft ? <NewTaskDialog open onOpenChange={open => { if (!open) setDraft(null); }} companyId={task.companyId} initialDraft={draft} onCreated={created => { setDraft(null); navigate(withCompany(`/tasks/${created.id}`, created.companyId)); }} /> : null}</>;
}
