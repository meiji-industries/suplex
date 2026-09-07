import { useEffect, useState, type ReactElement } from "react";
import type { Task } from "../../../task-contracts.js";
import { TaskArchiveResponseSchema } from "../../../http/contracts/tasks.js";
import { readJson } from "../../lib/api.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog.js";
import { ScrollArea } from "../ui/scroll-area.js";

type ArchiveConfirmation = { kind: "confirm" } | { kind: "discard"; dirtyFileCount: number; dirtyFilePaths: string[] };

export function ArchiveTaskDialog({ task, open, onOpenChange, onArchived, onError }: {
  task: Pick<Task, "id">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchived: (task: Task) => void;
  onError: (error: string) => void;
}): ReactElement {
  const [confirmation, setConfirmation] = useState<ArchiveConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const current = open ? confirmation ?? { kind: "confirm" as const } : null;

  useEffect(() => {
    setConfirmation(open ? { kind: "confirm" } : null);
  }, [open]);

  const confirmArchive = async (): Promise<void> => {
    if (busy || !current) return;
    setBusy(true);
    onError("");
    try {
      const result = TaskArchiveResponseSchema.parse(await readJson<unknown>(`/api/tasks/${task.id}/archive`, { method: "POST", body: JSON.stringify({ confirmDiscardDirty: current.kind === "discard" }) }));
      if (result.status === "confirmation_required") {
        setConfirmation({ kind: "discard", dirtyFileCount: result.dirtyFileCount, dirtyFilePaths: result.dirtyFilePaths });
        return;
      }
      setConfirmation(null);
      onOpenChange(false);
      onArchived(result);
    } catch (error) {
      setConfirmation(null);
      onOpenChange(false);
      onError(error instanceof Error ? error.message : "The task could not be archived.");
    } finally {
      setBusy(false);
    }
  };

  return <AlertDialog open={current !== null} onOpenChange={nextOpen => { if (!nextOpen && !busy) { setConfirmation(null); onOpenChange(false); } }}>
    <AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{current?.kind === "discard" ? `Discard ${current.dirtyFileCount} uncommitted ${current.dirtyFileCount === 1 ? "change" : "changes"} and archive?` : "Archive task?"}</AlertDialogTitle>
      <AlertDialogDescription>{current?.kind === "discard" ? "These uncommitted changes will be deleted. Forge keeps the branch, commits, and task history." : "Forge removes the local worktree and hides the task. Forge keeps the branch, commits, and task history."}</AlertDialogDescription>
    </AlertDialogHeader>
    {current?.kind === "discard" ? <ScrollArea aria-label="Uncommitted files" className="max-h-64">
      <ul className="space-y-1 pr-3 text-xs" role="list">
        {current.dirtyFilePaths.map(path => <li className="break-all font-mono" key={path}>{path}</li>)}
      </ul>
    </ScrollArea> : null}
    <AlertDialogFooter>
      <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
      <AlertDialogAction disabled={busy} onClick={() => void confirmArchive()}>{busy ? "Archiving…" : current?.kind === "discard" ? "Discard changes and archive" : "Archive task"}</AlertDialogAction>
    </AlertDialogFooter></AlertDialogContent>
  </AlertDialog>;
}
