import { expect, test } from "vitest";

import { TaskArchiveService } from "../src/task-archive.js";

function fixture(phase: "backlog" | "cancelled" = "cancelled", dirty = false) {
  let archivedAt: string | null = null;
  let task = { id: "task", companyId: "company", phase, revision: 1, worktreeState: "present", allowedCommands: ["delete_worktree"], pendingAction: null };
  const commands: string[] = [];
  const tasks = {
    getTask: () => ({ ...task, archivedAt }),
    executeCommand: async (_actor: string, _taskId: string, command: string, input: { confirmDiscardDirty?: boolean }) => {
      commands.push(command);
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
  const first = await value.archive.archiveTask("user", "task");
  const second = await value.archive.archiveTask("user", "task");
  expect(first).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(value.commands).toEqual(["delete_worktree"]);
  expect(second).toEqual(first);
});

test("archives an active task after cancelling it", async () => {
  const value = fixture("backlog");
  await value.archive.archiveTask("user", "task");
  expect(value.commands).toEqual(["cancel_issue", "delete_worktree"]);
  expect(value.current()).toMatchObject({ phase: "cancelled", worktreeState: "cleaned", archivedAt: "2026-08-28T00:00:00.000Z" });
});

test("requires dirty worktree confirmation before archiving", async () => {
  const value = fixture("cancelled", true);
  const blocked = await value.archive.archiveTask("user", "task");
  const confirmed = await value.archive.archiveTask("user", "task", { confirmDiscardDirty: true });
  expect(blocked).toMatchObject({ status: "confirmation_required", dirtyFileCount: 2 });
  expect(confirmed).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(value.commands).toEqual(["delete_worktree", "delete_worktree"]);
});

test("unarchive restores visibility without recreating the worktree", async () => {
  const value = fixture();
  await value.archive.archiveTask("user", "task");
  const first = value.archive.unarchiveTask("user", "task");
  const second = value.archive.unarchiveTask("user", "task");
  expect(first).toMatchObject({ archivedAt: null, worktreeState: "cleaned" });
  expect(second).toEqual(first);
  expect(value.commands).toEqual(["delete_worktree"]);
});
