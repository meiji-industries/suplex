import { useSyncExternalStore } from "react";
import { toast, type ExternalToast } from "sonner";
import type { Task } from "../../../contracts/tasks.js";
import { archiveTask, isArchiveConfirmation } from "./task-api.js";

export type ArchiveTarget = { id: string; title?: string; issueKey?: string | null };
export type ArchiveReview = { task: ArchiveTarget; dirtyFileCount: number; dirtyFilePaths: string[]; onArchived?: (task: Task) => void };

// Archive requests belong to the tab, not to the dialog or page that started them.
// The server finishes cleanup even when this tab stops waiting for the response.
const archiving = new Set<string>();
const listeners = new Set<() => void>();
let review: ArchiveReview | null = null;

const setReview = (next: ArchiveReview | null): void => {
  review = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const archiveToastId = (taskId: string): string => `archive-task:${taskId}`;

// One toast per task. Sonner merges an update into the earlier toast, so clear the fields of the earlier state.
// A zero duration selects the Toaster default.
const toastOptions = (taskId: string, options: ExternalToast = {}): ExternalToast =>
  ({ id: archiveToastId(taskId), description: null, action: null, duration: 0, closeButton: false, ...options });

const taskName = (task: ArchiveTarget): string => task.title ? `"${task.title}"` : "the task";

/** Starts an archive request in the background. Returns false when this tab already archives the task. */
export function startTaskArchive(task: ArchiveTarget, { discardDirty = false, onArchived }: { discardDirty?: boolean; onArchived?: (task: Task) => void } = {}): boolean {
  if (archiving.has(task.id)) return false;
  archiving.add(task.id);
  if (review?.task.id === task.id) setReview(null);
  // The loading toast shows a spinner.
  toast.loading(`Archiving ${task.issueKey ?? taskName(task)}`, toastOptions(task.id));
  void runArchive(task, discardDirty, onArchived).finally(() => archiving.delete(task.id));
  return true;
}

async function runArchive(task: ArchiveTarget, discardDirty: boolean, onArchived?: (task: Task) => void): Promise<void> {
  let result: Awaited<ReturnType<typeof archiveTask>>;
  try {
    result = await archiveTask(task.id, discardDirty);
  } catch (error) {
    toast.error(`Suplex could not archive ${taskName(task)}`, toastOptions(task.id, { description: error instanceof Error ? error.message : null, duration: Infinity, closeButton: true }));
    return;
  }
  if (isArchiveConfirmation(result)) {
    // Suplex discards uncommitted changes only after you review the file list and confirm.
    const pending: ArchiveReview = { task, dirtyFileCount: result.dirtyFileCount, dirtyFilePaths: result.dirtyFilePaths, ...(onArchived ? { onArchived } : {}) };
    const changes = `${result.dirtyFileCount} uncommitted ${result.dirtyFileCount === 1 ? "change" : "changes"}`;
    toast.warning(task.title ? `"${task.title}" has ${changes}` : `The task has ${changes}`, toastOptions(task.id, {
      description: "Suplex did not archive the task. Review the changes before you discard them.",
      duration: Infinity,
      action: { label: "Review", onClick: () => setReview(pending) },
    }));
    return;
  }
  toast.success(`Suplex archived ${taskName(task)}`, toastOptions(task.id));
  onArchived?.(result);
}

export function useArchiveReview(): ArchiveReview | null {
  return useSyncExternalStore(subscribe, () => review, () => null);
}

export function closeArchiveReview(): void {
  setReview(null);
}

/** Starts the discard request for the change list that you reviewed. */
export function confirmArchiveReview(confirmed: ArchiveReview): void {
  if (review === confirmed) setReview(null);
  startTaskArchive(confirmed.task, { discardDirty: true, ...(confirmed.onArchived ? { onArchived: confirmed.onArchived } : {}) });
}
