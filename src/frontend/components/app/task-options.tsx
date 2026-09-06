import { useState } from "react";
import { Archive, ArchiveRestore, Copy, Ellipsis, RefreshCw, Square } from "lucide-react";
import type { Task } from "../../../task-contracts.js";
import { TaskArchiveResponseSchema } from "../../../http/contracts/tasks.js";
import { readJson, withCompany } from "../../lib/api.js";
import { navigate } from "../../lib/navigation.js";
import { duplicateTaskDraft, type NewTaskDraft } from "../../lib/duplicate-task-prefill.js";
import { NewTaskDialog } from "./new-task-dialog.js";
import { Button } from "../ui/button.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";

export function TaskOptions({ task, onChange, onError }: { task: Task; onChange: (task: Task) => void; onError: (error: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<NewTaskDraft | null>(null);
  const [archive, setArchive] = useState<{ kind: "confirm" } | { kind: "discard"; dirtyFileCount: number } | null>(null);
  const confirmArchive = async () => {
    if (busy || !archive) return;
    setBusy(true); onError("");
    try {
      const result = TaskArchiveResponseSchema.parse(await readJson<unknown>(`/api/tasks/${task.id}/archive`, { method: "POST", body: JSON.stringify({ confirmDiscardDirty: archive.kind === "discard" }) }));
      if (result.status === "confirmation_required") { setArchive({ kind: "discard", dirtyFileCount: result.dirtyFileCount }); return; }
      setArchive(null);
      onChange(result);
      navigate(withCompany("/tasks", task.companyId));
    } catch (error) {
      setArchive(null);
      onError(error instanceof Error ? error.message : "The task could not be archived.");
    } finally { setBusy(false); }
  };
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
    <DropdownMenuItem disabled={busy} onClick={() => void act("refresh")}><RefreshCw />Check current state</DropdownMenuItem>
    <DropdownMenuItem disabled={busy} onClick={() => void duplicate()}><Copy />Duplicate</DropdownMenuItem>
    {!terminal ? <DropdownMenuItem disabled={busy} onClick={() => void act("cancel")}><Square />Cancel task</DropdownMenuItem> : null}
    {terminal || task.status === "backlog" ? <DropdownMenuItem disabled={busy} onClick={() => task.archivedAt ? void act("unarchive") : setArchive({ kind: "confirm" })}>{task.archivedAt ? <ArchiveRestore /> : <Archive />}{task.archivedAt ? "Open from archive" : "Archive task"}</DropdownMenuItem> : null}
  </DropdownMenuContent></DropdownMenu>
    <AlertDialog open={archive !== null} onOpenChange={open => { if (!open && !busy) setArchive(null); }}>
      <AlertDialogContent><AlertDialogHeader>
        <AlertDialogTitle>{archive?.kind === "discard" ? `Discard ${archive.dirtyFileCount} uncommitted ${archive.dirtyFileCount === 1 ? "change" : "changes"} and archive?` : "Archive task?"}</AlertDialogTitle>
        <AlertDialogDescription>{archive?.kind === "discard" ? "These uncommitted changes will be deleted. Forge keeps the branch, commits, and task history." : "Forge removes the local worktree and hides the task. Forge keeps the branch, commits, and task history."}</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={busy} onClick={() => void confirmArchive()}>{busy ? "Archiving…" : archive?.kind === "discard" ? "Discard changes and archive" : "Archive task"}</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    {draft ? <NewTaskDialog open onOpenChange={open => { if (!open) setDraft(null); }} companyId={task.companyId} initialDraft={draft} onCreated={created => { setDraft(null); navigate(withCompany(`/tasks/${created.id}`, created.companyId)); }} /> : null}</>;
}
