// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "sonner";
import type { Task } from "../src/frontend/contracts/tasks.js";
import { archiveTask } from "../src/frontend/features/tasks/lib/task-api.js";
import { ArchiveReviewDialog, ArchiveTaskDialog } from "../src/frontend/features/tasks/archive-task-dialog.js";
import { archiveToastId, closeArchiveReview, startTaskArchive } from "../src/frontend/features/tasks/lib/background-archive.js";

vi.mock("sonner", () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("../src/frontend/features/tasks/lib/task-api.js", () => ({
  archiveTask: vi.fn(),
  isArchiveConfirmation: (result: object) => "dirtyFilePaths" in result,
}));

type Settle<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Settle<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const archived = (id: string) => ({ id, archivedAt: "2026-10-07T00:00:00.000Z" }) as Task;
const requests = new Map<string, Settle<Awaited<ReturnType<typeof archiveTask>>>[]>();
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  requests.clear();
  vi.mocked(archiveTask).mockImplementation((taskId: string) => {
    const request = deferred<Awaited<ReturnType<typeof archiveTask>>>();
    requests.set(taskId, [...requests.get(taskId) ?? [], request]);
    return request.promise;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  // Settle every request so that the next test starts with no archive in flight.
  for (const list of requests.values()) for (const request of list) request.reject(new Error("done"));
  await flush();
  act(() => closeArchiveReview());
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const button = (name: string) => Array.from(document.querySelectorAll("button")).find(element => element.textContent === name);

test("the dialog closes before the archive request settles and the toast becomes a success", async () => {
  const onOpenChange = vi.fn();
  const onArchived = vi.fn();
  await act(async () => root.render(<ArchiveTaskDialog task={{ id: "close-fast", title: "Close fast", issueKey: "MEI-26" }} open onOpenChange={onOpenChange} onArchived={onArchived} />));
  await act(async () => button("Archive task")!.click());
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(archiveTask).toHaveBeenCalledExactlyOnceWith("close-fast", false);
  expect(toast.loading).toHaveBeenCalledWith('Archiving MEI-26', expect.objectContaining({ id: archiveToastId("close-fast") }));
  expect(onArchived).not.toHaveBeenCalled();

  // The component that started the archive is gone before the server answers.
  await act(async () => root.render(<></>));
  requests.get("close-fast")![0]!.resolve(archived("close-fast"));
  await flush();
  expect(toast.success).toHaveBeenCalledWith('Suplex archived "Close fast"', expect.objectContaining({ id: archiveToastId("close-fast") }));
  expect(onArchived).toHaveBeenCalledExactlyOnceWith(archived("close-fast"));
});

test("a failed archive shows the server message in the error toast", async () => {
  const onArchived = vi.fn();
  startTaskArchive({ id: "fails", title: "Fails" }, { onArchived });
  requests.get("fails")![0]!.reject(new Error("Archive cleanup is in progress"));
  await flush();
  expect(toast.error).toHaveBeenCalledWith('Suplex could not archive "Fails"', expect.objectContaining({ id: archiveToastId("fails"), description: "Archive cleanup is in progress" }));
  expect(onArchived).not.toHaveBeenCalled();
});

test("archives of different tasks run at the same time with their own toasts", async () => {
  expect(startTaskArchive({ id: "first", title: "First" })).toBe(true);
  expect(startTaskArchive({ id: "second", title: "Second" })).toBe(true);
  expect(archiveTask).toHaveBeenCalledWith("first", false);
  expect(archiveTask).toHaveBeenCalledWith("second", false);
  requests.get("second")![0]!.resolve(archived("second"));
  await flush();
  expect(toast.success).toHaveBeenCalledExactlyOnceWith('Suplex archived "Second"', expect.objectContaining({ id: archiveToastId("second") }));
  requests.get("first")![0]!.resolve(archived("first"));
  await flush();
  expect(toast.success).toHaveBeenCalledWith('Suplex archived "First"', expect.objectContaining({ id: archiveToastId("first") }));
});

test("a second start for a task in flight sends no request", async () => {
  expect(startTaskArchive({ id: "once" })).toBe(true);
  expect(startTaskArchive({ id: "once" })).toBe(false);
  expect(archiveTask).toHaveBeenCalledTimes(1);
  requests.get("once")![0]!.resolve(archived("once"));
  await flush();
  expect(toast.success).toHaveBeenCalledWith("Suplex archived the task", expect.anything());
  expect(startTaskArchive({ id: "once" })).toBe(true);
  expect(archiveTask).toHaveBeenCalledTimes(2);
});

test("uncommitted changes are discarded only after you review the files and confirm", async () => {
  const onArchived = vi.fn();
  await act(async () => root.render(<ArchiveReviewDialog />));
  startTaskArchive({ id: "dirty", title: "Dirty" }, { onArchived });
  requests.get("dirty")![0]!.resolve({ status: "confirmation_required", dirtyFileCount: 2, dirtyFilePaths: ["src/a.ts", "notes.md"] });
  await flush();
  expect(toast.warning).toHaveBeenCalledWith('"Dirty" has 2 uncommitted changes', expect.objectContaining({ id: archiveToastId("dirty") }));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  const review = () => (vi.mocked(toast.warning).mock.lastCall![1]!.action as unknown as { onClick: () => void }).onClick();

  await act(async () => review());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("Discard 2 uncommitted changes and archive?");
  expect(Array.from(dialog.querySelectorAll("li")).map(item => item.textContent)).toEqual(["src/a.ts", "notes.md"]);
  await act(async () => button("Cancel")!.click());
  await flush();
  expect(archiveTask).toHaveBeenCalledExactlyOnceWith("dirty", false);

  await act(async () => review());
  await act(async () => button("Discard changes and archive")!.click());
  expect(archiveTask).toHaveBeenLastCalledWith("dirty", true);
  expect(archiveTask).toHaveBeenCalledTimes(2);
  requests.get("dirty")![1]!.resolve(archived("dirty"));
  await flush();
  expect(onArchived).toHaveBeenCalledExactlyOnceWith(archived("dirty"));
});
