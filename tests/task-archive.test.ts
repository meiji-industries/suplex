import { expect, test } from "vitest";

import { TaskArchiveService } from "../src/task-archive.js";
import { TaskFailure } from "../src/tasks.js";

function fixture(phase: "backlog" | "cancelled" = "cancelled", dirty = false, cleanupFailure = false) {
  let archivedAt: string | null = null;
  let task = { id: "task", companyId: "company", phase, revision: 1, worktreeState: "present", allowedCommands: [] as string[], pendingAction: null as string | null };
  const commands: string[] = [];
  const tasks = {
    getTask: () => ({ ...task, archivedAt }),
    executeCommand: async (_actor: string, _taskId: string, command: string, input: { confirmDiscardDirty?: boolean }) => {
      commands.push(command);
      if (command === "delete_worktree" && cleanupFailure) throw new TaskFailure("Forge does not own the requested worktree", [{ code: "illegal-command", field: "phase", message: "Cleanup failed" }], 409, task as never);
      if (command === "cancel_issue") task = { ...task, phase: "cancelled", revision: task.revision + 1, allowedCommands: ["delete_worktree"] };
      if (command === "delete_worktree" && dirty && !input.confirmDiscardDirty) return { ...task, pendingAction: "Worktree has 2 uncommitted changes" };
      if (command === "delete_worktree") task = { ...task, worktreeState: "cleaned", allowedCommands: [] };
      return { ...task, archivedAt };
    },
  };
  const database = { authTransaction: (callback: (db: { prepare: () => { run: (...args: string[]) => void } }) => void) => callback({ prepare: () => ({ run: (...args) => { archivedAt = args.length === 3 ? args[0] ?? null : null; } }) }) };
  return { archive: new TaskArchiveService(tasks as never, database as never, () => new Date("2026-08-28T00:00:00.000Z")), commands, current: () => ({ ...task, archivedAt }) };
}

test("archives a terminal task by deleting its worktree", async () => {
  const value = fixture();
  const first = await value.archive.archiveTask("user", "task", 1);
  const second = await value.archive.archiveTask("user", "task", 2);
  expect(first).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(value.commands).toEqual(["delete_worktree"]);
  expect(second).toEqual(first);
});

test("rejects an active task", async () => {
  const value = fixture("backlog");
  await expect(value.archive.archiveTask("user", "task", 1)).rejects.toMatchObject({ statusCode: 409, findings: [{ code: "illegal-command" }] });
  expect(value.commands).toEqual([]);
});

test("requires dirty worktree confirmation before archiving", async () => {
  const value = fixture("cancelled", true);
  const blocked = await value.archive.archiveTask("user", "task", 1);
  const confirmed = await value.archive.archiveTask("user", "task", 1, { confirmDiscardDirty: true });
  expect(blocked).toMatchObject({ status: "confirmation_required", dirtyFileCount: 2 });
  expect(confirmed).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(value.commands).toEqual(["delete_worktree", "delete_worktree"]);
});

test("does not archive when worktree cleanup fails", async () => {
  const value = fixture("cancelled", false, true);
  await expect(value.archive.archiveTask("user", "task", 1)).rejects.toMatchObject({ statusCode: 409, message: "Worktree could not be removed", findings: [{ code: "worktree-cleanup-failed" }] });
  expect(value.current().archivedAt).toBeNull();
});

test("unarchive restores visibility without recreating the worktree", async () => {
  const value = fixture();
  await value.archive.archiveTask("user", "task", 1);
  const first = value.archive.unarchiveTask("user", "task");
  const second = value.archive.unarchiveTask("user", "task");
  expect(first).toMatchObject({ archivedAt: null, worktreeState: "cleaned" });
  expect(second).toEqual(first);
  expect(value.commands).toEqual(["delete_worktree"]);
});
