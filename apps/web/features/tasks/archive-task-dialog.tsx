import { closeArchiveReview, confirmArchiveReview, startTaskCleanup, useArchiveReview, type ArchiveTarget, type CleanupKind } from "./lib/background-archive.js";
import type { ReactElement } from "react";
import type { Task } from "../../contracts/tasks.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";

const copy: Record<CleanupKind, { title: string; description: string; action: string; discard: string; discardAction: string }> = {
  archive: {
    title: "Archive task?",
    description: "Suplex removes the local worktree and hides the task. Suplex keeps the branch, commits, and task history.",
    action: "Archive task",
    discard: "and archive?",
    discardAction: "Discard changes and archive",
  },
  backlog: {
    title: "Send task to backlog?",
    description: "Suplex stops the agents, removes the worktree, and moves the task to the top of Backlog. Suplex keeps the old branch, commits, and task history.",
    action: "Send to backlog",
    discard: "and send the task to the backlog?",
    discardAction: "Discard changes and send to backlog",
  },
};

/** Confirms an archive or backlog request, closes, and leaves the request to run in the background. */
export function ArchiveTaskDialog({ task, open, onOpenChange, onArchived, kind = "archive" }: {
  task: ArchiveTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchived: (task: Task) => void;
  kind?: CleanupKind;
}): ReactElement {
  const confirm = (): void => {
    onOpenChange(false);
    void startTaskCleanup(kind, { id: task.id, ...(task.title ? { title: task.title } : {}), issueKey: task.issueKey ?? null }, { onArchived });
  };
  return <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{copy[kind].title}</AlertDialogTitle>
      <AlertDialogDescription>{copy[kind].description}</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={confirm}>{copy[kind].action}</AlertDialogAction>
    </AlertDialogFooter></AlertDialogContent>
  </AlertDialog>;
}

/** Shows the uncommitted changes of a background archive or backlog request. The app mounts it once, so it works after the page that started the request is gone. */
export function ArchiveReviewDialog(): ReactElement {
  const review = useArchiveReview();
  const kind = review?.kind ?? "archive";
  return <AlertDialog open={review !== null} onOpenChange={nextOpen => { if (!nextOpen) closeArchiveReview(); }}>
    <AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{review ? `Discard ${review.dirtyFileCount} uncommitted ${review.dirtyFileCount === 1 ? "change" : "changes"} ${copy[kind].discard}` : copy[kind].title}</AlertDialogTitle>
      <AlertDialogDescription>These uncommitted changes will be deleted. Suplex keeps the branch, commits, and task history.</AlertDialogDescription>
    </AlertDialogHeader>
    <ScrollArea aria-label="Uncommitted files" className="max-h-64">
      <ul className="space-y-1 pr-3 text-xs" role="list">
        {review?.dirtyFilePaths.map(path => <li className="break-all font-mono" key={path}>{path}</li>)}
      </ul>
    </ScrollArea>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={() => { if (review) confirmArchiveReview(review); }}>{copy[kind].discardAction}</AlertDialogAction>
    </AlertDialogFooter></AlertDialogContent>
  </AlertDialog>;
}
