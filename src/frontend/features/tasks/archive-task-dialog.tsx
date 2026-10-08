import { closeArchiveReview, confirmArchiveReview, startTaskArchive, useArchiveReview, type ArchiveTarget } from "./lib/background-archive.js";
import type { ReactElement } from "react";
import type { Task } from "../../contracts/tasks.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";

/** Confirms an archive, closes, and leaves the request to run in the background. */
export function ArchiveTaskDialog({ task, open, onOpenChange, onArchived }: {
  task: ArchiveTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchived: (task: Task) => void;
}): ReactElement {
  const confirmArchive = (): void => {
    onOpenChange(false);
    startTaskArchive({ id: task.id, ...(task.title ? { title: task.title } : {}), issueKey: task.issueKey ?? null }, { onArchived });
  };
  return <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>Archive task?</AlertDialogTitle>
      <AlertDialogDescription>Suplex removes the local worktree and hides the task. Suplex keeps the branch, commits, and task history.</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={confirmArchive}>Archive task</AlertDialogAction>
    </AlertDialogFooter></AlertDialogContent>
  </AlertDialog>;
}

/** Shows the uncommitted changes of a background archive. The app mounts it once, so it works after the page that started the archive is gone. */
export function ArchiveReviewDialog(): ReactElement {
  const review = useArchiveReview();
  return <AlertDialog open={review !== null} onOpenChange={nextOpen => { if (!nextOpen) closeArchiveReview(); }}>
    <AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{review ? `Discard ${review.dirtyFileCount} uncommitted ${review.dirtyFileCount === 1 ? "change" : "changes"} and archive?` : "Archive task?"}</AlertDialogTitle>
      <AlertDialogDescription>These uncommitted changes will be deleted. Suplex keeps the branch, commits, and task history.</AlertDialogDescription>
    </AlertDialogHeader>
    <ScrollArea aria-label="Uncommitted files" className="max-h-64">
      <ul className="space-y-1 pr-3 text-xs" role="list">
        {review?.dirtyFilePaths.map(path => <li className="break-all font-mono" key={path}>{path}</li>)}
      </ul>
    </ScrollArea>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={() => { if (review) confirmArchiveReview(review); }}>Discard changes and archive</AlertDialogAction>
    </AlertDialogFooter></AlertDialogContent>
  </AlertDialog>;
}
