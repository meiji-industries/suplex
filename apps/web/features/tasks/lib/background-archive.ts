import { useSyncExternalStore } from "react";
import { toast, type ExternalToast } from "sonner";
import type { Task } from "../../../contracts/tasks.js";
import { archiveTask, isArchiveConfirmation, sendTaskToBacklog } from "./task-api.js";

/** Archive hides the task. Backlog returns it to the top of Backlog as fresh work. Both remove the worktree. */
export type CleanupKind = "archive" | "backlog";
export type ArchiveTarget = { id: string; title?: string; issueKey?: string | null };
export type ArchiveReview = { kind: CleanupKind; task: ArchiveTarget; dirtyFileCount: number; dirtyFilePaths: string[]; onArchived?: (task: Task) => void };

const taskName = (task: ArchiveTarget): string => task.title ? `"${task.title}"` : "the task";

const copy: Record<CleanupKind, {
  request: typeof archiveTask;
  running: (name: string) => string;
  done: (name: string) => string;
  failed: (name: string) => string;
  held: string;
}> = {
  archive: {
    request: (taskId, discardDirty) => archiveTask(taskId, discardDirty),
    running: name => `Archiving ${name}`,
    done: name => `Suplex archived ${name}`,
    failed: name => `Suplex could not archive ${name}`,
    held: "Suplex did not archive the task. Review the changes before you discard them.",
  },
  backlog: {
    request: (taskId, discardDirty) => sendTaskToBacklog(taskId, discardDirty),
    running: name => `Sending ${name} to the backlog`,
    done: name => `Suplex sent ${name} to the backlog`,
    failed: name => `Suplex could not send ${name} to the backlog`,
    held: "Suplex did not send the task to the backlog. Review the changes before you discard them.",
  },
};

// Archive and backlog requests belong to the tab, not to the dialog or page that started them.
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

type CleanupOptions = { discardDirty?: boolean; onArchived?: (task: Task) => void };

/**
 * Starts an archive or backlog request in the background. Returns null when this tab already cleans up the task.
 * Otherwise the promise gives the changed task, or null when the request failed or needs your review.
 */
export function startTaskCleanup(kind: CleanupKind, task: ArchiveTarget, { discardDirty = false, onArchived }: CleanupOptions = {}): Promise<Task | null> | null {
  if (archiving.has(task.id)) return null;
  archiving.add(task.id);
  if (review?.task.id === task.id) setReview(null);
  // The loading toast shows a spinner.
  toast.loading(copy[kind].running(task.issueKey ?? taskName(task)), toastOptions(task.id));
  return runCleanup(kind, task, discardDirty, onArchived).finally(() => archiving.delete(task.id));
}

/** Starts an archive request in the background. Returns false when this tab already archives the task. */
export function startTaskArchive(task: ArchiveTarget, options: CleanupOptions = {}): boolean {
  return startTaskCleanup("archive", task, options) !== null;
}

async function runCleanup(kind: CleanupKind, task: ArchiveTarget, discardDirty: boolean, onArchived?: (task: Task) => void): Promise<Task | null> {
  let result: Awaited<ReturnType<typeof archiveTask>>;
  try {
    result = await copy[kind].request(task.id, discardDirty);
  } catch (error) {
    toast.error(copy[kind].failed(taskName(task)), toastOptions(task.id, { description: error instanceof Error ? error.message : null, duration: Infinity, closeButton: true }));
    return null;
  }
  if (isArchiveConfirmation(result)) {
    // Suplex discards uncommitted changes only after you review the file list and confirm.
    const pending: ArchiveReview = { kind, task, dirtyFileCount: result.dirtyFileCount, dirtyFilePaths: result.dirtyFilePaths, ...(onArchived ? { onArchived } : {}) };
    const changes = `${result.dirtyFileCount} uncommitted ${result.dirtyFileCount === 1 ? "change" : "changes"}`;
    toast.warning(task.title ? `"${task.title}" has ${changes}` : `The task has ${changes}`, toastOptions(task.id, {
      description: copy[kind].held,
      duration: Infinity,
      action: { label: "Review", onClick: () => setReview(pending) },
    }));
    return null;
  }
  toast.success(copy[kind].done(taskName(task)), toastOptions(task.id));
  onArchived?.(result);
  return result;
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
  void startTaskCleanup(confirmed.kind, confirmed.task, { discardDirty: true, ...(confirmed.onArchived ? { onArchived: confirmed.onArchived } : {}) });
}
